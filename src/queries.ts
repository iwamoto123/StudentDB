/**
 * 分析・ダッシュボードで共用するクエリ
 *
 * 「生徒側の発言」の判定ロジックはここに集約する:
 * スタッフ名パターン（岩本・酒井など）に一致せず、担当講師名でも始まらず、
 * 講師グループの発言者名にも含まれない表示名を生徒・保護者とみなす。
 */
import type { Env } from "./types";

export const STAFF_NAME_PATTERNS = ["岩本", "酒井", "酒谷", "白谷塾", "ローカルメディ", "学習進捗サポート"];

export interface StudentRow {
  id: number;
  name: string;
  business: string;
  status: string;
  student_group_id: string | null;
  teacher_group_id: string | null;
  teacher_name: string | null;
  /** daily（既定）= 日報監視する / monthly = 月1面談などで日報・進捗を見ない */
  monitor_mode?: string | null;
}

export function isMonthlyMonitor(s: { monitor_mode?: string | null }): boolean {
  return s.monitor_mode === "monthly";
}

/** 生徒側の発言に絞るWHERE句（display_name参照）とバインド値 */
function studentSideFilter(s: StudentRow): { sql: string; binds: (string | null)[] } {
  const staffClauses = STAFF_NAME_PATTERNS.map(() => `display_name NOT LIKE ?`).join(" AND ");
  const teacherPrefix = s.teacher_name ? s.teacher_name.slice(0, 2) : null;
  return {
    sql: `display_name IS NOT NULL
      AND message_type <> 'system'
      AND ${staffClauses}
      AND (? IS NULL OR display_name NOT LIKE ? || '%')
      AND display_name NOT IN (
        SELECT DISTINCT display_name FROM messages WHERE group_id = ? AND display_name IS NOT NULL
      )`,
    binds: [
      ...STAFF_NAME_PATTERNS.map((p) => `%${p}%`),
      teacherPrefix,
      teacherPrefix ?? "",
      s.teacher_group_id ?? "",
    ],
  };
}

/** スタッフ・講師側の発言に絞るWHERE句とバインド値（指導後の共有チェック用） */
function staffSideFilter(s: StudentRow): { sql: string; binds: (string | null)[] } {
  const staffOrClauses = STAFF_NAME_PATTERNS.map(() => `display_name LIKE ?`).join(" OR ");
  const teacherPrefix = s.teacher_name ? s.teacher_name.slice(0, 2) : null;
  return {
    sql: `(${staffOrClauses}
      OR (? IS NOT NULL AND display_name LIKE ? || '%')
      OR display_name IN (SELECT DISTINCT display_name FROM messages WHERE group_id = ? AND display_name IS NOT NULL))`,
    binds: [
      ...STAFF_NAME_PATTERNS.map((p) => `%${p}%`),
      teacherPrefix,
      teacherPrefix ?? "",
      s.teacher_group_id ?? "",
    ],
  };
}

/** 生徒側（スタッフ・講師以外）の最終発言 */
export async function lastStudentSideMessage(
  env: Env,
  s: StudentRow
): Promise<{ sent_at: string; display_name: string } | null> {
  if (!s.student_group_id) return null;
  const f = studentSideFilter(s);
  const row = await env.DB.prepare(
    `SELECT sent_at, display_name FROM messages
     WHERE group_id = ? AND ${f.sql}
     ORDER BY sent_at DESC LIMIT 1`
  ).bind(s.student_group_id, ...f.binds).first<{ sent_at: string; display_name: string }>();
  return row ?? null;
}

/** 生徒側の発言があったJST日付の一覧（日報カレンダー用） */
export async function studentSideMessageDays(
  env: Env,
  s: StudentRow,
  sinceIso: string
): Promise<{ day: string; count: number }[]> {
  if (!s.student_group_id) return [];
  const f = studentSideFilter(s);
  const rows = await env.DB.prepare(
    `SELECT date(sent_at, '+9 hours') AS day, COUNT(*) AS count FROM messages
     WHERE group_id = ? AND sent_at >= ? AND ${f.sql}
     GROUP BY day ORDER BY day`
  ).bind(s.student_group_id, sinceIso, ...f.binds).all<{ day: string; count: number }>();
  return rows.results;
}

// 個別指導リンクの検索期間（日）と、指導後の共有チェックのパラメータ
export const LESSON_LOOKBACK_DAYS = 14;
export const LESSON_SHARE_GRACE_DAYS = 2;
export const LESSON_SHARE_SEARCH_DAYS = 4;
export const LESSON_SHARE_MIN_CHARS = 80;

/**
 * 個別指導後の共有チェック。
 * 直近のリンク（Zoom/Google Meet）投稿を「指導実施」とみなし、実施から2日以上経っているのに
 * スタッフ側からの共有投稿（80字以上）が無ければ lesson_share_ok = false
 */
export async function lessonShareStatus(
  env: Env,
  s: StudentRow,
  now: Date
): Promise<{ last_lesson_link_at: string | null; lesson_share_ok: boolean | null }> {
  if (!s.student_group_id) return { last_lesson_link_at: null, lesson_share_ok: null };

  const link = await env.DB.prepare(
    `SELECT sent_at FROM messages
     WHERE group_id = ? AND sent_at >= ?
       AND (text LIKE '%zoom.us%' OR text LIKE '%meet.google.com%')
     ORDER BY sent_at DESC LIMIT 1`
  )
    .bind(s.student_group_id, new Date(now.getTime() - LESSON_LOOKBACK_DAYS * 86400_000).toISOString())
    .first<{ sent_at: string }>();

  if (!link) return { last_lesson_link_at: null, lesson_share_ok: null };

  const daysSinceLesson = jstDayDiff(new Date(link.sent_at), now);
  if (daysSinceLesson < LESSON_SHARE_GRACE_DAYS) {
    // 実施から日が浅い場合は共有待ちとして判定しない
    return { last_lesson_link_at: link.sent_at, lesson_share_ok: null };
  }

  const f = staffSideFilter(s);
  const shareSearchEnd = new Date(
    new Date(link.sent_at).getTime() + LESSON_SHARE_SEARCH_DAYS * 86400_000
  ).toISOString();
  const share = await env.DB.prepare(
    `SELECT 1 FROM messages
     WHERE group_id = ? AND sent_at > ? AND sent_at <= ?
       AND message_type = 'text' AND length(text) >= ?
       AND ${f.sql}
     LIMIT 1`
  ).bind(s.student_group_id, link.sent_at, shareSearchEnd, LESSON_SHARE_MIN_CHARS, ...f.binds).first();

  return { last_lesson_link_at: link.sent_at, lesson_share_ok: !!share };
}

/** 日報停止の検出しきい値（日）。体験中2日 / 塾生3日 */
export function reportGapThreshold(status: string): number {
  return status === "trial" ? 2 : 3;
}

/** JSTのカレンダー日付での差（bがaの何日後か） */
export function jstDayDiff(a: Date, b: Date): number {
  const JST_MS = 9 * 3600_000;
  const dayA = Math.floor((a.getTime() + JST_MS) / 86400_000);
  const dayB = Math.floor((b.getTime() + JST_MS) / 86400_000);
  return dayB - dayA;
}
