/**
 * 今週のグループLINEよい対応（チューター共有用）
 *
 * 個別指導ではなく、生徒グループLINEでの質問・報告への返しを対象にする。
 * 点数・順位はつけない。真似できる具体例だけをリスト化する。
 */
import type { Env } from "./types";
import type { StudentRow } from "./queries";
import { STAFF_NAME_PATTERNS } from "./queries";
import { sendSlack } from "./send";

const DEFAULT_MODEL = "claude-haiku-4-5";
const LOOKBACK_DAYS = 7;
const MAX_PAIRS_PER_STUDENT = 3;
const MAX_PAIRS_TO_MODEL = 40;
const MIN_REPLY_CHARS = 40;
const HIGHLIGHT_EXCLUDE = ["学習進捗サポート", "白谷塾", "ローカルメディ"];

export interface HighlightItem {
  tutor: string;
  student: string;
  date: string; // YYYY-MM-DD
  student_excerpt: string;
  reply_excerpt: string;
  why: string;
}

export interface WeeklyHighlights {
  week_start: string;
  week_end: string;
  items: HighlightItem[];
  share_text: string;
  created_at: string | null;
}

interface Candidate {
  student: string;
  tutor_guess: string;
  date: string;
  student_excerpt: string;
  reply_excerpt: string;
}

export async function runWeeklyHighlights(
  env: Env,
  opts: { notify: boolean }
): Promise<{ ok: boolean; count: number; slack?: { ok: boolean; reason?: string }; detail?: string }> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, count: 0, detail: "APIキー未設定" };

  const now = new Date();
  const { weekStart, weekEnd, sinceIso } = weekRange(now);

  const students = (
    await env.DB.prepare(
      `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name, monitor_mode
       FROM students WHERE status IN ('trial', 'enrolled') AND student_group_id IS NOT NULL
       ORDER BY name`
    ).all<StudentRow>()
  ).results;

  const candidates: Candidate[] = [];
  for (const s of students) {
    const pairs = await collectPairs(env, s, sinceIso);
    candidates.push(...pairs);
    if (candidates.length >= MAX_PAIRS_TO_MODEL) break;
  }

  if (candidates.length === 0) {
    const empty: WeeklyHighlights = {
      week_start: weekStart,
      week_end: weekEnd,
      items: [],
      share_text: shareText(weekStart, weekEnd, []),
      created_at: null,
    };
    await saveHighlights(env, empty);
    return { ok: true, count: 0, detail: "候補なし" };
  }

  const items = await pickHighlights(env, candidates, weekStart, weekEnd);
  const createdAt = new Date().toISOString();
  const result: WeeklyHighlights = {
    week_start: weekStart,
    week_end: weekEnd,
    items,
    share_text: shareText(weekStart, weekEnd, items),
    created_at: createdAt,
  };
  await saveHighlights(env, result);

  let slack: { ok: boolean; reason?: string } | undefined;
  if (opts.notify && items.length > 0) {
    slack = await sendSlack(env, result.share_text);
  }
  return { ok: true, count: items.length, slack };
}

export async function getLatestHighlights(env: Env): Promise<WeeklyHighlights | null> {
  const row = await env.DB.prepare(
    `SELECT week_start, week_end, items_json, share_text, created_at
     FROM weekly_highlights ORDER BY week_start DESC LIMIT 1`
  ).first<{
    week_start: string; week_end: string; items_json: string; share_text: string; created_at: string;
  }>();
  if (!row) return null;
  let items: HighlightItem[] = [];
  try {
    items = JSON.parse(row.items_json) as HighlightItem[];
  } catch {
    items = [];
  }
  return {
    week_start: row.week_start,
    week_end: row.week_end,
    items,
    share_text: row.share_text,
    created_at: row.created_at,
  };
}

async function saveHighlights(env: Env, h: WeeklyHighlights): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO weekly_highlights (week_start, week_end, items_json, share_text, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(week_start) DO UPDATE SET
       week_end = excluded.week_end,
       items_json = excluded.items_json,
       share_text = excluded.share_text,
       created_at = excluded.created_at`
  ).bind(h.week_start, h.week_end, JSON.stringify(h.items), h.share_text).run();
}

async function collectPairs(env: Env, s: StudentRow, sinceIso: string): Promise<Candidate[]> {
  if (!s.student_group_id) return [];
  const rows = (
    await env.DB.prepare(
      `SELECT sent_at, display_name, text FROM messages
       WHERE group_id = ? AND sent_at >= ? AND message_type = 'text' AND text IS NOT NULL
       ORDER BY sent_at ASC LIMIT 400`
    ).bind(s.student_group_id, sinceIso).all<{ sent_at: string; display_name: string | null; text: string }>()
  ).results;

  const teacherGroupNames = await teacherGroupDisplayNames(env, s.teacher_group_id);
  const out: Candidate[] = [];

  for (let i = 0; i < rows.length; i++) {
    if (out.length >= MAX_PAIRS_PER_STUDENT) break;
    const m = rows[i];
    if (!m.text || isStaff(m.display_name, s, teacherGroupNames)) continue;
    // 次の24時間以内の講師側の返しを探す
    const until = new Date(new Date(m.sent_at).getTime() + 24 * 3600_000).toISOString();
    for (let j = i + 1; j < rows.length; j++) {
      const r = rows[j];
      if (r.sent_at > until) break;
      if (!isStaff(r.display_name, s, teacherGroupNames)) continue;
      if (isExcludedTutor(r.display_name)) continue;
      if ((r.text ?? "").length < MIN_REPLY_CHARS) continue;
      out.push({
        student: s.name,
        tutor_guess: r.display_name ?? s.teacher_name ?? "講師",
        date: jstDay(m.sent_at),
        student_excerpt: clip(m.text, 80),
        reply_excerpt: clip(r.text, 160),
      });
      break;
    }
  }
  return out;
}

async function teacherGroupDisplayNames(env: Env, teacherGroupId: string | null): Promise<Set<string>> {
  const names = new Set<string>();
  if (!teacherGroupId) return names;
  const rows = (
    await env.DB.prepare(
      `SELECT DISTINCT display_name FROM messages WHERE group_id = ? AND display_name IS NOT NULL`
    ).bind(teacherGroupId).all<{ display_name: string }>()
  ).results;
  for (const r of rows) names.add(r.display_name);
  return names;
}

function isStaff(name: string | null, s: StudentRow, teacherGroupNames: Set<string>): boolean {
  if (!name) return false;
  if (STAFF_NAME_PATTERNS.some((p) => name.includes(p))) return true;
  if (s.teacher_name && name.startsWith(s.teacher_name.slice(0, 2))) return true;
  return teacherGroupNames.has(name);
}

function isExcludedTutor(name: string | null): boolean {
  if (!name) return true;
  return HIGHLIGHT_EXCLUDE.some((p) => name.includes(p));
}

async function pickHighlights(
  env: Env,
  candidates: Candidate[],
  weekStart: string,
  weekEnd: string
): Promise<HighlightItem[]> {
  const list = candidates.slice(0, MAX_PAIRS_TO_MODEL);
  const lines = list
    .map(
      (c, i) =>
        `${i + 1}. ${c.date} 生徒:${c.student} 返し:${c.tutor_guess}\n  生徒「${c.student_excerpt}」\n  講師「${c.reply_excerpt}」`
    )
    .join("\n");

  const prompt = `あなたは学習塾のチューター育成担当です。
以下は直近1週間の「生徒グループLINE」における、生徒・保護者の発言とその後の講師の返しの候補です。
個別指導（Zoom/Meet）そのものは対象外です。グループLINE上の質問・日報へのアクションだけを見てください。

熱意が伝わる返しを最大10件選んでください。基準は次です。
- 質問や不安に具体的に答えている
- 日報を受けて次にやる一手を出している
- 保護者・生徒が安心できる温度で、かつ放置していない
- 「了解です」だけの短い返しは選ばない
- 同じ講師ばかりに偏らない（多様性を優先）
- 候補にない内容は作らない
- 順位や点数はつけない

次のJSONのみを出力してください:
{"items":[{"tutor":"表示名","student":"生徒名","date":"YYYY-MM-DD","student_excerpt":"40字以内","reply_excerpt":"80字以内","why":"よかった点を30字以内"}]}

週: ${weekStart} 〜 ${weekEnd}

候補:
${lines}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 2500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    console.error("highlights anthropic", res.status, await res.text());
    return [];
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  const parsed = JSON.parse(jsonMatch[0]) as { items?: HighlightItem[] };
  return (parsed.items ?? []).filter((it) => it && it.tutor && it.student && it.why).slice(0, 10);
}

function shareText(weekStart: string, weekEnd: string, items: HighlightItem[]): string {
  const L: string[] = [];
  L.push(`【今週のグループLINEで熱意が伝わった対応】${fmtMd(weekStart)}〜${fmtMd(weekEnd)}`);
  L.push("");
  L.push("個別指導ではなく、グループLINEでの質問・報告への返しです。");
  L.push("点数や順位はありません。よい型を共有するためのリストです。");
  L.push("");
  if (items.length === 0) {
    L.push("今週、リストアップできる具体例は見つかりませんでした。");
    return L.join("\n");
  }
  items.forEach((it, i) => {
    L.push(`${i + 1}. ${it.tutor} → ${it.student}さん（${fmtMd(it.date)}）`);
    L.push(`　生徒: ${it.student_excerpt}`);
    L.push(`　対応: ${it.reply_excerpt}`);
    L.push(`　よかった点: ${it.why}`);
    L.push("");
  });
  L.push("このままコピーしてチューターにシェアできます。");
  return L.join("\n");
}

function weekRange(now: Date): { weekStart: string; weekEnd: string; sinceIso: string } {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400_000);
  return {
    weekStart: jstDay(since.toISOString()),
    weekEnd: jstDay(now.toISOString()),
    sinceIso: since.toISOString(),
  };
}

function jstDay(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

function fmtMd(ymd: string): string {
  const p = ymd.split("-");
  if (p.length !== 3) return ymd;
  return `${Number(p[1])}/${Number(p[2])}`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}
