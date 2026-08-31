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
} from "./queries";
import { DASHBOARD_HTML } from "./dashboard-html";

interface DashUser {
  token: string;
  name: string;
  role: "admin" | "teacher";
  teacher_name: string | null;
}

const COOKIE_NAME = "dash";
const CALENDAR_DAYS = 84; // 日報カレンダーの表示期間（12週）

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

async function getStudentsForUser(env: Env, user: DashUser): Promise<StudentRow[]> {
  if (user.role === "teacher") {
    return (
      await env.DB.prepare(
        `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name
         FROM students WHERE status IN ('trial','enrolled') AND teacher_name = ? ORDER BY name`
      ).bind(user.teacher_name ?? "").all<StudentRow>()
    ).results;
  }
  return (
    await env.DB.prepare(
      `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name
       FROM students WHERE status IN ('trial','enrolled') ORDER BY name`
    ).all<StudentRow>()
  ).results;
}

async function getStudentForUser(env: Env, user: DashUser, id: number): Promise<StudentRow | null> {
  const s = await env.DB.prepare(
    `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name
     FROM students WHERE id = ?`
  ).bind(id).first<StudentRow>();
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
    const stalled = last ? (gap as number) >= threshold : true;

    const lesson = await lessonShareStatus(env, s, now);

    const openAlerts = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM alerts WHERE student_id = ? AND resolved = 0`
    ).bind(s.id).first<{ n: number }>();
    const open = openAlerts?.n ?? 0;

    let state: "順調" | "要観察" | "要対応" = "順調";
    if (stalled || open > 0) state = "要対応";
    else if ((gap !== null && gap === threshold - 1) || lesson.lesson_share_ok === false) state = "要観察";

    items.push({
      id: s.id,
      name: s.name,
      business: s.business,
      status: s.status,
      teacher_name: s.teacher_name,
      state,
      threshold,
      last_report_at: last?.sent_at ?? null,
      report_gap_days: gap,
      open_alerts: open,
      last_lesson_link_at: lesson.last_lesson_link_at,
      lesson_share_ok: lesson.lesson_share_ok,
      unmapped: !s.student_group_id,
    });
  }
  return { generated_at: now.toISOString(), students: items };
}

async function buildStudentDetail(env: Env, s: StudentRow) {
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

  return {
    student: {
      id: s.id,
      name: s.name,
      business: s.business,
      status: s.status,
      teacher_name: s.teacher_name,
      threshold: reportGapThreshold(s.status),
      unmapped: !s.student_group_id,
    },
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
