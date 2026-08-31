/**
 * 定時分析ジョブ（フェーズ2: F2-1〜F2-5）
 *
 * - F2-1 日報チェック: SQLで生徒側の最終発言日を判定（体験中2日 / 塾生3日で検出）
 * - F2-2 未回答検出: 直近24時間の会話をClaudeが読み、両方向の未回答質問を検出（24時間以内の回答を徹底するため）
 * - F2-3 全体ダイジェスト: Slackへ全生徒サマリを送信
 * - F2-4 週次報告チェック: 月曜朝のみ、講師グループの【生徒名】投稿を照合
 * - F2-5 個別指導後の共有チェック: 指導リンク（Zoom/Google Meet）の投稿を「実施」とみなし、
 *        実施後に講師側から全体グループへの共有投稿があるかを確認する
 *
 * 通知は sendToGroup()（講師系グループのみ許可）と sendSlack() だけを使う。
 */
import type { Env } from "./types";
import { sendToGroup, sendSlack } from "./send";
import {
  type StudentRow,
  lastStudentSideMessage,
  lessonShareStatus,
  reportGapThreshold,
  jstDayDiff,
  LESSON_LOOKBACK_DAYS,
} from "./queries";

const JST_MS = 9 * 3600_000;
const DEFAULT_MODEL = "claude-haiku-4-5";
// 同じ生徒×同じ種別のアラートを再通知しない時間（時）。1日2回の実行で朝晩二重に催促しない
const ALERT_COOLDOWN_HOURS = 20;
// 未回答検出の対象期間（時）。24時間以内の回答を徹底したいので24時間
const UNANSWERED_WINDOW_HOURS = 24;

export interface UnansweredItem {
  direction: "student_to_staff" | "staff_to_student";
  asked_by: string;
  asked_at: string; // "MM/DD HH:mm"（JST）
  question: string;
}

export interface StudentAnalysis {
  student_id: number;
  name: string;
  status: string;
  teacher_name: string | null;
  last_student_message_at: string | null; // ISO UTC
  report_gap_days: number | null;
  report_stalled: boolean;
  unanswered: UnansweredItem[];
  ai_analyzed: boolean;
  /** 直近の個別指導リンク（Zoom/Google Meet）の投稿日時。直近14日でなければnull */
  last_lesson_link_at: string | null;
  /** 指導後の共有投稿があるか。null = 判定対象外（リンクなし or 実施直後で共有待ち） */
  lesson_share_ok: boolean | null;
  notes: string[];
}

export interface AnalysisResult {
  ran_at: string;
  notify: boolean;
  weekly_check: boolean;
  students: StudentAnalysis[];
  weekly_report_missing: { student: string; teacher: string | null }[];
  sent_alerts: { student: string; kind: string; to_group: string; ok: boolean; reason?: string }[];
  digest_text: string;
  slack: { ok: boolean; reason?: string } | null;
}

export async function runAnalysis(
  env: Env,
  opts: { notify: boolean; weekly: boolean }
): Promise<AnalysisResult> {
  const now = new Date();
  const students = (
    await env.DB.prepare(
      `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name
       FROM students WHERE status IN ('trial', 'enrolled') ORDER BY name`
    ).all<StudentRow>()
  ).results;

  const analyses: StudentAnalysis[] = [];
  for (const s of students) {
    analyses.push(await analyzeStudent(env, s, now));
  }

  const weeklyMissing = opts.weekly ? await checkWeeklyReports(env, students, now) : [];

  // ---- 通知（講師グループへの対応依頼） ----
  const sentAlerts: AnalysisResult["sent_alerts"] = [];
  if (opts.notify) {
    for (const a of analyses) {
      const student = students.find((s) => s.id === a.student_id)!;
      if (!student.teacher_group_id) continue;

      if (a.report_stalled) {
        const lastJst = a.last_student_message_at ? jstShort(a.last_student_message_at) : "記録なし";
        const text =
          `【対応依頼】${a.name}さんの日報・ご報告が${a.report_gap_days}日止まっています（最終: ${lastJst}）。\n` +
          `グループでの声かけをお願いします。\n\n※学習進捗サポートの自動通知です`;
        await notifyOnce(env, student, "no_report", text, sentAlerts);
      }

      const byStudent = a.unanswered.filter((u) => u.direction === "staff_to_student");
      if (byStudent.length > 0) {
        const lines = byStudent.map((u) => `・${u.asked_at} ${u.asked_by}「${u.question}」`).join("\n");
        const text =
          `【確認】${a.name}さんのグループで、こちらからの質問に返信がありません。\n${lines}\n` +
          `様子の確認をお願いします。\n\n※学習進捗サポートの自動通知です`;
        await notifyOnce(env, student, "unanswered_by_student", text, sentAlerts);
      }

      const byTeacher = a.unanswered.filter((u) => u.direction === "student_to_staff");
      if (byTeacher.length > 0) {
        const lines = byTeacher.map((u) => `・${u.asked_at} ${u.asked_by}さん「${u.question}」`).join("\n");
        const text =
          `【対応依頼】${a.name}さんのグループに未回答の質問があります。\n${lines}\n` +
          `ご回答をお願いします。\n\n※学習進捗サポートの自動通知です`;
        await notifyOnce(env, student, "unanswered_by_teacher", text, sentAlerts);
      }
    }
  }

  // ---- 全体ダイジェスト（Slack） ----
  const digestText = buildDigest(analyses, weeklyMissing, sentAlerts, now, opts.weekly);
  const slack = opts.notify ? await sendSlack(env, digestText) : null;

  return {
    ran_at: now.toISOString(),
    notify: opts.notify,
    weekly_check: opts.weekly,
    students: analyses,
    weekly_report_missing: weeklyMissing,
    sent_alerts: sentAlerts,
    digest_text: digestText,
    slack,
  };
}

// ---------- 生徒1人分の分析 ----------

async function analyzeStudent(env: Env, s: StudentRow, now: Date): Promise<StudentAnalysis> {
  const a: StudentAnalysis = {
    student_id: s.id,
    name: s.name,
    status: s.status,
    teacher_name: s.teacher_name,
    last_student_message_at: null,
    report_gap_days: null,
    report_stalled: false,
    unanswered: [],
    ai_analyzed: false,
    last_lesson_link_at: null,
    lesson_share_ok: null,
    notes: [],
  };

  if (!s.student_group_id) {
    a.notes.push("生徒グループ未紐付け");
    return a;
  }

  // F2-1: 生徒側（スタッフ・講師以外）の最終発言（判定ロジックはqueries.tsに集約）
  const last = await lastStudentSideMessage(env, s);
  const threshold = reportGapThreshold(s.status);
  if (last) {
    a.last_student_message_at = last.sent_at;
    a.report_gap_days = jstDayDiff(new Date(last.sent_at), now);
    a.report_stalled = a.report_gap_days >= threshold;
  } else {
    a.report_gap_days = null;
    a.report_stalled = true;
    a.notes.push("生徒側の発言が1件もありません");
  }

  // F2-5: 個別指導後の共有チェック（queries.tsに集約）
  const lesson = await lessonShareStatus(env, s, now);
  a.last_lesson_link_at = lesson.last_lesson_link_at;
  a.lesson_share_ok = lesson.lesson_share_ok;

  // F2-2: 未回答検出（Claude）。対象期間に会話がなければスキップ
  const windowStart = new Date(now.getTime() - UNANSWERED_WINDOW_HOURS * 3600_000).toISOString();
  const recent = (
    await env.DB.prepare(
      `SELECT sent_at, display_name, message_type, text FROM messages
       WHERE group_id = ? AND sent_at >= ? AND message_type <> 'system'
       ORDER BY sent_at ASC LIMIT 200`
    ).bind(s.student_group_id, windowStart).all<{
      sent_at: string; display_name: string | null; message_type: string; text: string | null;
    }>()
  ).results;

  if (recent.length > 0) {
    const detected = await detectUnanswered(env, s, recent, now);
    if (detected === null) {
      a.notes.push("AI分析なし（APIキー未設定またはエラー）");
    } else {
      a.ai_analyzed = true;
      a.unanswered = detected;
    }
  }

  return a;
}

// ---------- F2-2: Claudeによる未回答検出 ----------

async function detectUnanswered(
  env: Env,
  s: StudentRow,
  messages: { sent_at: string; display_name: string | null; message_type: string; text: string | null }[],
  now: Date
): Promise<UnansweredItem[] | null> {
  if (!env.ANTHROPIC_API_KEY) return null;

  const lines = messages
    .map((m) => {
      const body = m.message_type === "text" ? (m.text ?? "") : `[${m.message_type}]`;
      return `${jstShort(m.sent_at, true)} ${m.display_name ?? "(不明)"}: ${body}`;
    })
    .join("\n");

  const prompt = `あなたは学習塾のグループLINEを監視するアシスタントです。
以下は生徒「${s.name}」のグループLINEの直近24時間の会話です（日本時間）。
参加者: 生徒本人・保護者・担当講師（${s.teacher_name ?? "不明"}）・塾スタッフ（岩本・酒井）。
現在時刻: ${jstShort(now.toISOString(), true)}

未回答の質問・依頼を検出してください。
- direction="staff_to_student": 講師・スタッフからの質問や依頼に、生徒・保護者が12時間以上応答していない
- direction="student_to_staff": 生徒・保護者からの質問に、講師・スタッフが6時間以上応答していない
- 挨拶・報告・スタンプなど応答不要のものは含めない
- 質問の後に話題が変わっていても、実質的に答えられていれば未回答としない
- 判断に迷うものは含めない（誤検知より見逃しのほうがまし）

次のJSONのみを出力してください（未回答がなければ空配列）:
{"unanswered":[{"direction":"student_to_staff","asked_by":"表示名","asked_at":"MM/DD HH:mm","question":"質問の要約(40字以内)"}]}

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
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      console.error(`anthropic api ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = data.content.find((c) => c.type === "text")?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as { unanswered?: UnansweredItem[] };
    return (parsed.unanswered ?? []).filter(
      (u) => u.direction === "student_to_staff" || u.direction === "staff_to_student"
    );
  } catch (e) {
    console.error("detectUnanswered failed", e);
    return null;
  }
}

// ---------- F2-4: 講師週次報告チェック（月曜朝のみ） ----------

async function checkWeeklyReports(
  env: Env,
  students: StudentRow[],
  now: Date
): Promise<{ student: string; teacher: string | null }[]> {
  const missing: { student: string; teacher: string | null }[] = [];
  const since = new Date(now.getTime() - 8 * 86400_000).toISOString();

  for (const s of students) {
    if (!s.teacher_group_id) continue;
    // 週次報告は1行目が【生徒名】で始まる。名前の表記ゆれに備えてフルネームと下2文字の両方で探す
    const nameTail = s.name.slice(-2);
    const found = await env.DB.prepare(
      `SELECT 1 FROM messages
       WHERE group_id = ? AND sent_at >= ? AND text LIKE '【%'
         AND (text LIKE ? OR text LIKE ?)
       LIMIT 1`
    )
      .bind(s.teacher_group_id, since, `%${s.name}%`, `%${nameTail}%`)
      .first();
    if (!found) missing.push({ student: s.name, teacher: s.teacher_name });
  }
  return missing;
}

// ---------- 通知（重複抑止つき） ----------

async function notifyOnce(
  env: Env,
  student: StudentRow,
  kind: string,
  text: string,
  sentAlerts: AnalysisResult["sent_alerts"]
): Promise<void> {
  const recent = await env.DB.prepare(
    `SELECT 1 FROM alerts
     WHERE student_id = ? AND kind = ? AND created_at >= datetime('now', ?)
     LIMIT 1`
  ).bind(student.id, kind, `-${ALERT_COOLDOWN_HOURS} hours`).first();
  if (recent) return;

  const result = await sendToGroup(env, student.teacher_group_id!, `alert_${kind}`, text);
  await env.DB.prepare(
    `INSERT INTO alerts (student_id, kind, detail, notified_group_id) VALUES (?, ?, ?, ?)`
  ).bind(student.id, kind, text, result.ok ? student.teacher_group_id : null).run();

  sentAlerts.push({
    student: student.name,
    kind,
    to_group: student.teacher_group_id!,
    ok: result.ok,
    reason: result.reason,
  });
}

// ---------- ダイジェスト生成 ----------

function buildDigest(
  analyses: StudentAnalysis[],
  weeklyMissing: { student: string; teacher: string | null }[],
  sentAlerts: AnalysisResult["sent_alerts"],
  now: Date,
  weekly: boolean
): string {
  const stalled = analyses.filter((a) => a.report_stalled);
  const withUnanswered = analyses.filter((a) => a.unanswered.length > 0);
  const noShare = analyses.filter((a) => a.lesson_share_ok === false);
  const noLessonLink = analyses.filter((a) => a.last_lesson_link_at === null);
  const ok = analyses.filter((a) => !a.report_stalled && a.unanswered.length === 0);

  const L: string[] = [];
  L.push(`LINE進捗ダイジェスト ${jstShort(now.toISOString(), true)}`);
  L.push(`対象${analyses.length}名: 順調${ok.length} / 日報停止${stalled.length} / 未回答の質問${withUnanswered.length}`);

  L.push("");
  L.push("■ 日報停止");
  if (stalled.length === 0) L.push("・なし");
  for (const a of stalled) {
    const lastStr = a.last_student_message_at ? `最終 ${jstShort(a.last_student_message_at)}` : "生徒側の発言なし";
    const gapStr = a.report_gap_days !== null ? `${a.report_gap_days}日` : "-";
    const alerted = sentAlerts.some((x) => x.student === a.name && x.kind === "no_report" && x.ok);
    L.push(`・${a.name}さん（${gapStr}・${lastStr}・担当 ${a.teacher_name ?? "未設定"}）${alerted ? "→ 講師グループへ依頼済み" : ""}`);
  }

  L.push("");
  L.push("■ 未回答の質問");
  if (withUnanswered.length === 0) L.push("・なし");
  for (const a of withUnanswered) {
    for (const u of a.unanswered) {
      const dir = u.direction === "student_to_staff" ? "講師側が未回答" : "生徒側が未返信";
      L.push(`・${a.name}さん: ${u.asked_at} ${u.asked_by}「${u.question}」（${dir}）`);
    }
  }

  L.push("");
  L.push("■ 個別指導後の共有なし（実施から2日以上、グループへの報告が見当たらない）");
  if (noShare.length === 0) L.push("・なし");
  for (const a of noShare) {
    L.push(`・${a.name}さん（${jstShort(a.last_lesson_link_at!)}実施分・担当 ${a.teacher_name ?? "未設定"}）`);
  }

  L.push("");
  L.push(`■ 個別指導リンク未検出（直近${LESSON_LOOKBACK_DAYS}日）`);
  if (noLessonLink.length === 0) L.push("・なし");
  for (const a of noLessonLink) L.push(`・${a.name}さん（担当 ${a.teacher_name ?? "未設定"}）`);

  if (weekly) {
    L.push("");
    L.push("■ 講師週次報告 未提出（前週分）");
    if (weeklyMissing.length === 0) L.push("・なし");
    for (const w of weeklyMissing) L.push(`・${w.teacher ?? "担当未設定"}先生（${w.student}さん分）`);
  }

  const notAnalyzed = analyses.filter((a) => a.notes.length > 0);
  if (notAnalyzed.length > 0) {
    L.push("");
    L.push("■ 備考");
    for (const a of notAnalyzed) L.push(`・${a.name}さん: ${a.notes.join(" / ")}`);
  }

  return L.join("\n");
}

// ---------- 日時ユーティリティ ----------

/** ISO UTC → "M/D" または "MM/DD HH:mm"（JST） */
function jstShort(iso: string, withTime = false): string {
  const d = new Date(new Date(iso).getTime() + JST_MS);
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  if (!withTime) return md;
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${md} ${hm}`;
}
