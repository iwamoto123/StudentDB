/**
 * ダッシュボード（フェーズ3: F3-1〜F3-4）
 *
 * 認証: dashboard_users のトークンをアクセスキーとしてURLで配布する。
 * /dashboard?key=<token> で開くとクッキーに保存され、以後はキーなしで開ける。
 * role=admin は全生徒、role=teacher は担当生徒のみ閲覧できる（F3-3）。
 * 閲覧専用であり、LINEへの送信機能はダッシュボードには存在しない。
 */
import type { Env } from "./types";
import {
  type StudentRow,
  lastStudentSideMessage,
  lessonShareStatus,
  studentSideMessageDays,
  reportGapThreshold,
  jstDayDiff,
  LESSON_LOOKBACK_DAYS,
  skipsDailyReport,
  skipProgressReason,
  skipsAllMonitoring,
} from "./queries";
import { DASHBOARD_HTML } from "./dashboard-html";
import { getInsights } from "./insights";
import { getLatestHighlights } from "./highlights";

type DashStudentRow = StudentRow & { target_university: string | null };

interface DashUser {
  token: string;
  name: string;
  role: "admin" | "teacher";
  teacher_name: string | null;
}

const COOKIE_NAME = "dash";
const CALENDAR_DAYS = 84; // 日報カレンダーの表示期間（12週）

const ALERT_KIND_LABELS: Record<string, string> = {
  no_report: "日報停止アラート",
  unanswered_by_student: "生徒側の未返信",
  unanswered_by_teacher: "未回答の質問",
  unanswered_report: "日報への未返信",
  no_lesson: "個別指導未実施",
  weekly_report_missing: "週次報告未提出",
};

export async function handleDashboard(request: Request, env: Env, url: URL): Promise<Response> {
  // アクセスキー付きURL → クッキーを設定してキーなしURLへリダイレクト（URL共有時のキー漏れ防止）
  if (url.pathname === "/dashboard") {
    const key = url.searchParams.get("key");
    if (key) {
      const user = await findUser(env, key);
      if (!user) return unauthorizedPage();
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/dashboard",
          "Set-Cookie": `${COOKIE_NAME}=${key}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
        },
      });
    }
    const user = await getUser(env, request);
    if (!user) return unauthorizedPage();
    return new Response(DASHBOARD_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // ---- API ----
  const user = await getUser(env, request);
  if (!user) return json({ error: "unauthorized" }, 401);

  if (request.method === "GET" && url.pathname === "/api/me") {
    return json({ name: user.name, role: user.role, teacher_name: user.teacher_name });
  }

  if (request.method === "GET" && url.pathname === "/api/overview") {
    return json(await buildOverview(env, user));
  }

  if (request.method === "GET" && url.pathname === "/api/student") {
    const id = Number(url.searchParams.get("id"));
    if (!id) return json({ error: "id required" }, 400);
    const student = await getStudentForUser(env, user, id);
    if (!student) return json({ error: "not found" }, 404);
    return json(await buildStudentDetail(env, student));
  }

  if (request.method === "GET" && url.pathname === "/api/alerts") {
    const params: (string | number)[] = [];
    let where = "";
    if (user.role === "teacher") {
      where = "WHERE s.teacher_name = ?";
      params.push(user.teacher_name ?? "");
    }
    const rows = await env.DB.prepare(
      `SELECT a.id, a.kind, a.detail, a.resolved, a.created_at, s.id AS student_id, s.name AS student_name
       FROM alerts a JOIN students s ON s.id = a.student_id
       ${where}
       ORDER BY a.created_at DESC LIMIT 200`
    ).bind(...params).all();
    return json(rows.results);
  }

  if (request.method === "POST" && url.pathname === "/api/alerts/resolve") {
    const b = (await request.json()) as { id?: number; resolved?: boolean };
    if (!b.id) return json({ error: "id required" }, 400);
    // 講師は担当生徒のアラートのみ更新できる
    const row = await env.DB.prepare(
      `SELECT a.id FROM alerts a JOIN students s ON s.id = a.student_id
       WHERE a.id = ? ${user.role === "teacher" ? "AND s.teacher_name = ?" : ""}`
    ).bind(...(user.role === "teacher" ? [b.id, user.teacher_name ?? ""] : [b.id])).first();
    if (!row) return json({ error: "not found" }, 404);
    await env.DB.prepare(`UPDATE alerts SET resolved = ? WHERE id = ?`)
      .bind(b.resolved === false ? 0 : 1, b.id).run();
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/highlights") {
    return json((await getLatestHighlights(env)) ?? { items: [], share_text: "", week_start: null, week_end: null });
  }

  return json({ error: "not found" }, 404);
}

// ---------- 認証 ----------

async function getUser(env: Env, request: Request): Promise<DashUser | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return findUser(env, match[1]);
}

async function findUser(env: Env, token: string): Promise<DashUser | null> {
  const row = await env.DB.prepare(
    `SELECT token, name, role, teacher_name FROM dashboard_users WHERE token = ? AND active = 1`
  ).bind(token).first<DashUser>();
  return row ?? null;
}

function unauthorizedPage(): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>学習進捗ダッシュボード</title>
<body style="font-family:-apple-system,'Hiragino Sans',sans-serif;display:flex;justify-content:center;padding-top:80px;color:#333">
<div style="text-align:center"><h2 style="color:#2e6a9e">学習進捗ダッシュボード</h2>
<p>アクセスキーが必要です。配布されたURL（/dashboard?key=…）から開いてください。</p></div></body>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// ---------- データ組み立て ----------

async function getStudentsForUser(env: Env, user: DashUser): Promise<DashStudentRow[]> {
  if (user.role === "teacher") {
    return (
      await env.DB.prepare(
        `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name, target_university, monitor_mode
         FROM students WHERE status IN ('trial','enrolled') AND teacher_name = ? ORDER BY name`
      ).bind(user.teacher_name ?? "").all<DashStudentRow>()
    ).results;
  }
  return (
    await env.DB.prepare(
      `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name, target_university, monitor_mode
       FROM students WHERE status IN ('trial','enrolled') ORDER BY name`
    ).all<DashStudentRow>()
  ).results;
}

async function getStudentForUser(env: Env, user: DashUser, id: number): Promise<DashStudentRow | null> {
  const s = await env.DB.prepare(
    `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name, target_university, monitor_mode
     FROM students WHERE id = ?`
  ).bind(id).first<DashStudentRow>();
  if (!s) return null;
  if (user.role === "teacher" && s.teacher_name !== user.teacher_name) return null;
  return s;
}

async function buildOverview(env: Env, user: DashUser) {
  const now = new Date();
  const students = await getStudentsForUser(env, user);
  const items = [];
  for (const s of students) {
    const last = await lastStudentSideMessage(env, s);
    const gap = last ? jstDayDiff(new Date(last.sent_at), now) : null;
    const threshold = reportGapThreshold(s.status);
    const skipAll = skipsAllMonitoring(s);
    const skipReport = skipsDailyReport(s);
    const stalled = skipReport ? false : last ? (gap as number) >= threshold : true;

    const lesson = skipReport
      ? { last_lesson_link_at: null as string | null, lesson_share_ok: null as boolean | null }
      : await lessonShareStatus(env, s, now);

    const openAlertKinds = (
      await env.DB.prepare(
        `SELECT kind, COUNT(*) AS n FROM alerts WHERE student_id = ? AND resolved = 0 GROUP BY kind`
      ).bind(s.id).all<{ kind: string; n: number }>()
    ).results;
    const visibleAlertKinds = skipAll
      ? []
      : skipReport
        ? openAlertKinds.filter((k) => k.kind !== "no_report" && k.kind !== "weekly_report_missing" && k.kind !== "no_lesson" && k.kind !== "unanswered_report")
        : openAlertKinds;
    const open = visibleAlertKinds.reduce((sum, k) => sum + k.n, 0);

    let state: "順調" | "要観察" | "要対応" = "順調";
    if (!skipAll && (stalled || open > 0)) state = "要対応";
    else if (!skipReport && ((gap !== null && gap === threshold - 1) || lesson.lesson_share_ok === false)) state = "要観察";

    // 状態の理由（一覧・要対応タブで一目でわかるように）
    const reasons: string[] = [];
    if (skipAll) {
      reasons.push(skipProgressReason(s) ?? "監視対象外");
    } else if (skipReport) {
      reasons.push(skipProgressReason(s) ?? "日報監視なし");
    } else if (!last) {
      reasons.push("生徒側の発言記録なし");
    } else if (stalled) {
      reasons.push(`日報${gap}日停止`);
    } else if (gap !== null && gap === threshold - 1) {
      reasons.push(`日報${gap}日経過（明日で停止判定）`);
    }
    for (const k of visibleAlertKinds) {
      if (k.kind === "no_report" && (stalled || !last)) continue;
      reasons.push(`${ALERT_KIND_LABELS[k.kind] ?? k.kind}${k.n > 1 ? k.n + "件" : ""}が未対応`);
    }
    if (lesson.lesson_share_ok === false) reasons.push("個別指導後の共有なし");

    items.push({
      id: s.id,
      name: s.name,
      business: s.business,
      status: s.status,
      teacher_name: s.teacher_name,
      target_university: s.target_university,
      monitor_mode: s.monitor_mode || "daily",
      state,
      state_reasons: reasons,
      threshold,
      last_report_at: last?.sent_at ?? null,
      report_gap_days: skipReport ? null : gap,
      open_alerts: open,
      last_lesson_link_at: lesson.last_lesson_link_at,
      lesson_share_ok: lesson.lesson_share_ok,
      unmapped: !s.student_group_id,
    });
  }
  return { generated_at: now.toISOString(), students: items };
}

async function buildStudentDetail(env: Env, s: DashStudentRow) {
  const now = new Date();
  const sinceCal = new Date(now.getTime() - CALENDAR_DAYS * 86400_000).toISOString();

  const reportDays = await studentSideMessageDays(env, s, sinceCal);
  const last = await lastStudentSideMessage(env, s);
  const lesson = await lessonShareStatus(env, s, now);

  const messages = s.student_group_id
    ? (
        await env.DB.prepare(
          `SELECT sent_at, display_name, message_type, substr(text, 1, 300) AS text
           FROM messages WHERE group_id = ? AND message_type <> 'system'
           ORDER BY sent_at DESC LIMIT 40`
        ).bind(s.student_group_id).all()
      ).results
    : [];

  const lessons = s.student_group_id
    ? (
        await env.DB.prepare(
          `SELECT sent_at, display_name FROM messages
           WHERE group_id = ? AND (text LIKE '%zoom.us%' OR text LIKE '%meet.google.com%')
           ORDER BY sent_at DESC LIMIT 15`
        ).bind(s.student_group_id).all()
      ).results
    : [];

  const alerts = (
    await env.DB.prepare(
      `SELECT id, kind, detail, resolved, created_at FROM alerts WHERE student_id = ? ORDER BY created_at DESC LIMIT 50`
    ).bind(s.id).all()
  ).results;

  const insights = await getInsights(env, s.id);

  return {
    student: {
      id: s.id,
      name: s.name,
      business: s.business,
      status: s.status,
      teacher_name: s.teacher_name,
      target_university: s.target_university,
      monitor_mode: s.monitor_mode || "daily",
      threshold: reportGapThreshold(s.status),
      unmapped: !s.student_group_id,
    },
    insights,
    calendar_days: CALENDAR_DAYS,
    lesson_lookback_days: LESSON_LOOKBACK_DAYS,
    last_report_at: last?.sent_at ?? null,
    report_days: reportDays,
    lesson,
    lessons,
    messages,
    alerts,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
