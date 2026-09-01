/**
 * 学習インサイトのAI抽出
 *
 * 生徒グループの会話履歴をClaudeが読み、以下を構造化して student_insights に保存する:
 * - 勉強計画・教材ごとの進捗（教材名・合計量・現在の到達・単位・締切）
 * - 模試の結果（模試名・日付・科目別点数）
 * - 計画全体の短い要約
 *
 * 抽出は読み取り専用。LINEへの送信は一切行わない。
 * 再抽出は対象メッセージ数が変わった生徒のみ（毎朝の定時実行でコストを抑える）。
 */
import type { Env } from "./types";
import type { StudentRow } from "./queries";

const DEFAULT_MODEL = "claude-haiku-4-5";
// 抽出に使う直近メッセージ数と1件あたりの最大文字数（トークン節約）
const MAX_MESSAGES = 250;
const MAX_CHARS_PER_MESSAGE = 300;

export interface PlanMaterial {
  subject: string; // 科目（数学・英語など）
  name: string; // 教材名
  total: number | null; // 合計量（ページ・問題数など）
  done: number | null; // 現在の到達
  unit: string | null; // 単位（ページ / 問 / 章 / 枚 など）
  deadline: string | null; // YYYY-MM-DD
  note: string | null; // 数値化できない場合の状況メモ
}

export interface ExamResult {
  name: string; // 模試名
  date: string | null; // YYYY-MM-DD（不明なら null）
  scores: { subject: string; score: number; max: number | null }[];
  note: string | null;
}

export interface InsightData {
  summary: string | null;
  materials: PlanMaterial[];
  exams: ExamResult[];
}

/** 1人分を抽出して保存。skipIfUnchanged=true なら対象メッセージ数が前回と同じときスキップ */
export async function extractStudentInsights(
  env: Env,
  s: StudentRow,
  opts: { skipIfUnchanged?: boolean } = {}
): Promise<{ status: "ok" | "skipped" | "no_messages" | "error"; detail?: string }> {
  if (!s.student_group_id) return { status: "no_messages", detail: "グループ未紐付け" };
  if (!env.ANTHROPIC_API_KEY) return { status: "error", detail: "APIキー未設定" };

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND message_type = 'text'`
  ).bind(s.student_group_id).first<{ n: number }>();
  const messageCount = countRow?.n ?? 0;
  if (messageCount === 0) return { status: "no_messages" };

  if (opts.skipIfUnchanged) {
    const prev = await env.DB.prepare(
      `SELECT message_count FROM student_insights WHERE student_id = ?`
    ).bind(s.id).first<{ message_count: number }>();
    if (prev && prev.message_count === messageCount) return { status: "skipped" };
  }

  const allRows = (
    await env.DB.prepare(
      `SELECT sent_at, display_name, text FROM messages
       WHERE group_id = ? AND message_type = 'text' AND text IS NOT NULL
       ORDER BY sent_at DESC LIMIT ?`
    ).bind(s.student_group_id, MAX_MESSAGES).all<{
      sent_at: string; display_name: string | null; text: string;
    }>()
  ).results.reverse();

  // コンテキスト超過（400）のときはメッセージ数を半分にして再試行する
  let rows = allRows;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await callExtraction(env, s, rows, messageCount);
    if (result.status !== "context_too_long") return result;
    if (rows.length <= 30) return { status: "error", detail: "会話が長すぎて抽出できません" };
    rows = rows.slice(Math.floor(rows.length / 2));
  }
  return { status: "error", detail: "再試行の上限に達しました" };
}

async function callExtraction(
  env: Env,
  s: StudentRow,
  rows: { sent_at: string; display_name: string | null; text: string }[],
  messageCount: number
): Promise<{ status: "ok" | "error"; detail?: string } | { status: "context_too_long"; detail?: string }> {
  const lines = rows
    .map((m) => `${jstDate(m.sent_at)} ${m.display_name ?? "(不明)"}: ${safeTruncate(m.text, MAX_CHARS_PER_MESSAGE)}`)
    .join("\n");

  const prompt = `あなたは学習塾のグループLINEから学習データを抽出するアシスタントです。
以下は生徒「${s.name}」のグループLINEの会話履歴です（日本時間・古い順）。
参加者: 生徒本人・保護者・担当講師（${s.teacher_name ?? "不明"}）・塾スタッフ（岩本・酒井）。

次の3つを抽出してください。

1. materials: 勉強計画に含まれる参考書・教材ごとの進捗
   - name: 教材名（会話に出てくる表記のまま。略称でよい）
   - subject: 科目（数学/英語/国語/理科/化学/物理/生物/社会/日本史/世界史/地理/情報/小論文/その他）
   - total: その教材の合計量（数値）。会話から分からなければ null
   - done: 現在までに終えた量（数値）。日々の報告を累積して最新の到達点を推定する。分からなければ null
   - unit: 量の単位（ページ/問/章/講/枚/周 など）。分からなければ null
   - deadline: 「いつまでに終える」の日付があれば YYYY-MM-DD。なければ null
   - note: 数値化できない場合の状況（例「毎日3題ペースで継続中」）。40字以内。なければ null
   - 計画として言及された教材のみ。1回だけ話題に出た教材は含めない
   - 同じ教材の表記ゆれは1つにまとめる

2. exams: 模試・共通テスト系の結果報告
   - name: 模試名（例「第2回全統共通テスト模試」）
   - date: 受験日または報告日 YYYY-MM-DD（不明なら null）
   - scores: [{"subject":"科目","score":点数,"max":満点(不明ならnull)}]
   - note: 判定や本人コメントの要約。40字以内。なければ null
   - 点数の報告がないものは含めない

3. summary: この生徒の勉強計画の全体像を1〜2文で（60字以内）。計画の言及がなければ null

会話に出てこない内容は絶対に作らないでください。確信が持てない数値は null にしてください。

次のJSONのみを出力してください:
{"summary":"...","materials":[...],"exams":[...]}

会話:
${lines}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`anthropic api ${res.status}`, body);
      if (res.status === 400 && /too long|too many tokens|prompt is too/i.test(body)) {
        return { status: "context_too_long" };
      }
      return { status: "error", detail: `anthropic api ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = data.content.find((c) => c.type === "text")?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { status: "error", detail: "JSONが返らなかった" };

    const parsed = JSON.parse(jsonMatch[0]) as {
      summary?: string | null;
      materials?: PlanMaterial[];
      exams?: ExamResult[];
    };
    const materials = (parsed.materials ?? []).filter((m) => m && m.name);
    const exams = (parsed.exams ?? []).filter((e) => e && e.name && Array.isArray(e.scores));

    await env.DB.prepare(
      `INSERT INTO student_insights (student_id, plan_json, exams_json, summary, message_count, extracted_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(student_id) DO UPDATE SET
         plan_json = excluded.plan_json,
         exams_json = excluded.exams_json,
         summary = excluded.summary,
         message_count = excluded.message_count,
         extracted_at = excluded.extracted_at`
    ).bind(
      s.id,
      JSON.stringify(materials),
      JSON.stringify(exams),
      parsed.summary ?? null,
      messageCount
    ).run();

    return { status: "ok", detail: `教材${materials.length}件 / 模試${exams.length}件` };
  } catch (e) {
    console.error("extractStudentInsights failed", s.name, e);
    return { status: "error", detail: String(e) };
  }
}

/** 全生徒（在籍中）の抽出。デフォルトはメッセージ数が変わった生徒のみ */
export async function refreshAllInsights(
  env: Env,
  opts: { force?: boolean } = {}
): Promise<{ student: string; status: string; detail?: string }[]> {
  const students = (
    await env.DB.prepare(
      `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name
       FROM students WHERE status IN ('trial', 'enrolled') AND student_group_id IS NOT NULL
       ORDER BY name`
    ).all<StudentRow>()
  ).results;

  const results: { student: string; status: string; detail?: string }[] = [];
  for (const s of students) {
    const r = await extractStudentInsights(env, s, { skipIfUnchanged: !opts.force });
    results.push({ student: s.name, status: r.status, detail: r.detail });
  }
  return results;
}

/** 保存済みインサイトの取得（ダッシュボード用） */
export async function getInsights(env: Env, studentId: number): Promise<{
  summary: string | null;
  materials: PlanMaterial[];
  exams: ExamResult[];
  extracted_at: string | null;
} | null> {
  const row = await env.DB.prepare(
    `SELECT plan_json, exams_json, summary, extracted_at FROM student_insights WHERE student_id = ?`
  ).bind(studentId).first<{
    plan_json: string | null; exams_json: string | null; summary: string | null; extracted_at: string | null;
  }>();
  if (!row) return null;
  return {
    summary: row.summary,
    materials: safeParse<PlanMaterial[]>(row.plan_json) ?? [],
    exams: safeParse<ExamResult[]>(row.exams_json) ?? [],
    extracted_at: row.extracted_at,
  };
}

function safeParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** 絵文字（サロゲートペア）を途中で切らないように短縮し、孤立サロゲートも除去する */
function safeTruncate(s: string, n: number): string {
  return s
    .slice(0, n)
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, "")
    .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

function jstDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}
