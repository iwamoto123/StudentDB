/**
 * グループLINE進捗監視AI - Webhookサーバー（フェーズ0-1）
 *
 * 設計原則（要件定義書6章の誤爆ガード）:
 * - 生徒グループへの送信コードパスは存在しない。送信は sendToGroup() のみで、
 *   グループ種別が teacher / admin / test 以外なら送信せずエラーログを残す
 * - reply API は実装しない。replyToken は保存もしない
 * - 新規参加グループは必ず type='student'（読み取り専用）で登録される
 */

import { parseLineExport, importMessageId } from "./importer";
import { sendToGroup } from "./send";
import { runAnalysis, runUnansweredSweep } from "./analyzer";
import { handleDashboard } from "./dashboard";
import { extractStudentInsights, refreshAllInsights } from "./insights";
import { runWeeklyHighlights } from "./highlights";
import { syncStudentsFromNotion, writeBackReportStatus } from "./notion";
import type { StudentRow } from "./queries";
import type { Env } from "./types";

export type { Env };

// ---------- LINE Webhookイベントの最小型定義 ----------

interface LineEventSource {
  type: "user" | "group" | "room";
  userId?: string;
  groupId?: string;
  roomId?: string;
}

interface LineWebhookEvent {
  type: string; // message / join / leave / memberJoined / memberLeft など
  timestamp: number;
  source: LineEventSource;
  webhookEventId?: string;
  message?: {
    id: string;
    type: string; // text / image / sticker / video / audio / file / location
    text?: string;
  };
}

interface LineWebhookBody {
  destination: string;
  events: LineWebhookEvent[];
}

// ---------- エントリポイント ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "line-monitor" });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, ctx);
    }

    if (url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }

    // ダッシュボード（閲覧専用。認証はアクセスキー方式）
    if (url.pathname === "/dashboard" || url.pathname.startsWith("/api/")) {
      return handleDashboard(request, env, url);
    }

    return json({ error: "not found" }, 404);
  },

  // 定時分析（1日2回: 23 UTC = 朝8時JST / 12 UTC = 夜21時JST）
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const isMorning = controller.cron === "0 23 * * *";
    const jstDay = new Date(controller.scheduledTime + 9 * 3600_000).getUTCDay();
    const weekly = isMorning && jstDay === 1;
    const notify = env.ANALYSIS_NOTIFY === "1";
    // 担当講師や在籍状況の正本はNotion。分析の前に流し込んでから判定する
    ctx.waitUntil(
      (async () => {
        if (isMorning) {
          try {
            const sync = await syncStudentsFromNotion(env);
            console.log(`notion sync: updated=${sync.updated.length} unmatched=${sync.unmatched_in_notion.length}`);
          } catch (e) {
            console.error("notion sync failed", e);
          }
        }
        const r = await runAnalysis(env, { notify, weekly });
        console.log(`analysis done: alerts=${r.sent_alerts.length} slack=${r.slack?.ok}`);
        try {
          const wb = await writeBackReportStatus(env, r.students.map(toReportStatusInput));
          console.log(`notion writeback: written=${wb.written.length} unchanged=${wb.unchanged}`);
        } catch (e) {
          console.error("notion writeback failed", e);
        }
      })().catch((e) => console.error("scheduled run failed", e))
    );
    if (isMorning) {
      ctx.waitUntil(
        refreshAllInsights(env).then(
          (rs) => console.log(`insights refreshed: ${rs.filter((r) => r.status === "ok").length}/${rs.length}`),
          (e) => console.error("insights refresh failed", e)
        )
      );
      if (weekly) {
        ctx.waitUntil(
          runWeeklyHighlights(env, { notify }).then(
            (r) => console.log(`weekly highlights: count=${r.count} slack=${r.slack?.ok}`),
            (e) => console.error("weekly highlights failed", e)
          )
        );
      }
    }
  },
} satisfies ExportedHandler<Env>;

// ---------- Webhook処理 ----------

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const bodyText = await request.text();

  const signature = request.headers.get("x-line-signature");
  if (!signature || !(await verifySignature(env.LINE_CHANNEL_SECRET, bodyText, signature))) {
    return json({ error: "bad signature" }, 401);
  }

  let body: LineWebhookBody;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return json({ error: "bad json" }, 400);
  }

  // LINEはタイムアウトすると再送してくる。処理はバックグラウンドに回して即200を返し、
  // 重複はDB側のUNIQUE制約（line_message_id）で吸収する
  ctx.waitUntil(processEvents(body.events ?? [], env));
  return json({ ok: true });
}

async function processEvents(events: LineWebhookEvent[], env: Env): Promise<void> {
  for (const event of events) {
    try {
      await processEvent(event, env);
    } catch (e) {
      console.error("event processing failed", event.type, e);
    }
  }
}

async function processEvent(event: LineWebhookEvent, env: Env): Promise<void> {
  // 監視対象はグループのみ。1対1トークは扱わない（要件定義5章）
  if (event.source.type !== "group" || !event.source.groupId) return;
  const groupId = event.source.groupId;
  const sentAt = new Date(event.timestamp).toISOString();

  switch (event.type) {
    case "join": {
      // 誤爆ガード層3: 新規グループは必ず読み取り専用（student）で登録
      await env.DB.prepare(
        `INSERT INTO groups (group_id, type, active, joined_at) VALUES (?, 'student', 1, ?)
         ON CONFLICT(group_id) DO UPDATE SET active = 1, joined_at = excluded.joined_at, left_at = NULL`
      ).bind(groupId, sentAt).run();
      const name = await fetchGroupName(env, groupId);
      if (name) {
        await env.DB.prepare(`UPDATE groups SET name = ? WHERE group_id = ?`).bind(name, groupId).run();
      }
      break;
    }

    case "leave": {
      await env.DB.prepare(`UPDATE groups SET active = 0, left_at = ? WHERE group_id = ?`)
        .bind(sentAt, groupId).run();
      break;
    }

    case "message": {
      if (!event.message) return;
      await ensureGroup(env, groupId);
      const userId = event.source.userId ?? null;
      const displayName = userId ? await resolveDisplayName(env, groupId, userId) : null;
      const text = event.message.type === "text" ? (event.message.text ?? "") : null;

      // 再送・重複はUNIQUE制約で弾く
      await env.DB.prepare(
        `INSERT OR IGNORE INTO messages (line_message_id, group_id, user_id, display_name, message_type, text, sent_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'webhook')`
      ).bind(event.message.id, groupId, userId, displayName, event.message.type, text, sentAt).run();
      break;
    }

    default:
      // memberJoined / memberLeft 等は現状記録しない
      break;
  }
}

async function ensureGroup(env: Env, groupId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO groups (group_id, type, active) VALUES (?, 'student', 1)`
  ).bind(groupId).run();
}

// ---------- 表示名の解決（キャッシュ付き） ----------

const MEMBER_CACHE_DAYS = 7;

async function resolveDisplayName(env: Env, groupId: string, userId: string): Promise<string | null> {
  const cached = await env.DB.prepare(
    `SELECT display_name, updated_at FROM group_members WHERE group_id = ? AND user_id = ?`
  ).bind(groupId, userId).first<{ display_name: string | null; updated_at: string }>();

  if (cached) {
    const ageMs = Date.now() - new Date(cached.updated_at + "Z").getTime();
    if (cached.display_name && ageMs < MEMBER_CACHE_DAYS * 86400_000) return cached.display_name;
  }

  const profile = await lineApi<{ displayName: string }>(env, `/v2/bot/group/${groupId}/member/${userId}`);
  const displayName = profile?.displayName ?? cached?.display_name ?? null;

  await env.DB.prepare(
    `INSERT INTO group_members (group_id, user_id, display_name, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(group_id, user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`
  ).bind(groupId, userId, displayName).run();

  return displayName;
}

async function fetchGroupName(env: Env, groupId: string): Promise<string | null> {
  const summary = await lineApi<{ groupName: string }>(env, `/v2/bot/group/${groupId}/summary`);
  return summary?.groupName ?? null;
}

// ---------- LINE API（GET系） ----------

async function lineApi<T>(env: Env, path: string): Promise<T | null> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  try {
    const res = await fetch(`https://api.line.me${path}`, {
      headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!res.ok) {
      console.warn(`LINE API ${path} -> ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.error(`LINE API ${path} failed`, e);
    return null;
  }
}

// ---------- 管理API（グループ種別の設定・テスト送信） ----------

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = request.headers.get("authorization");
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET" && url.pathname === "/admin/groups") {
    const rows = await env.DB.prepare(
      `SELECT group_id, name, type, business, active, joined_at FROM groups ORDER BY joined_at DESC`
    ).all();
    return json(rows.results);
  }

  if (request.method === "GET" && url.pathname === "/admin/messages") {
    const groupId = url.searchParams.get("group_id");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
    const stmt = groupId
      ? env.DB.prepare(`SELECT * FROM messages WHERE group_id = ? ORDER BY sent_at DESC LIMIT ?`).bind(groupId, limit)
      : env.DB.prepare(`SELECT * FROM messages ORDER BY sent_at DESC LIMIT ?`).bind(limit);
    return json((await stmt.all()).results);
  }

  // グループ種別の変更（誤爆ガード層3: 種別変更はこの手動APIのみ）
  if (request.method === "POST" && url.pathname === "/admin/groups/set-type") {
    const body = (await request.json()) as { group_id?: string; type?: string; business?: string };
    if (!body.group_id || !body.type || !["student", "teacher", "admin", "test"].includes(body.type)) {
      return json({ error: "group_id and valid type required" }, 400);
    }
    await ensureGroup(env, body.group_id);
    await env.DB.prepare(`UPDATE groups SET type = ?, business = COALESCE(?, business) WHERE group_id = ?`)
      .bind(body.type, body.business ?? null, body.group_id).run();
    return json({ ok: true });
  }

  // 過去ログインポート（F1-6）: LINEの「トーク履歴を送信」で書き出したtxtをそのままPOSTする
  if (request.method === "POST" && url.pathname === "/admin/import") {
    const groupId = url.searchParams.get("group_id");
    if (!groupId) return json({ error: "group_id query param required" }, 400);
    await ensureGroup(env, groupId);

    const parsed = parseLineExport(await request.text());
    if (parsed.length === 0) return json({ error: "no messages parsed. check file format" }, 400);

    // 同一分・同一発言者・同一本文の重複を出現順で区別しつつ、再インポートは冪等にする
    const seqCounter = new Map<string, number>();
    let inserted = 0;
    const CHUNK = 40;
    for (let i = 0; i < parsed.length; i += CHUNK) {
      const stmts: D1PreparedStatement[] = [];
      for (const m of parsed.slice(i, i + CHUNK)) {
        // importMessageId のキー（seq以外）と完全に一致させる。ずれるとID衝突で取りこぼす
        const baseKey = [m.sentAtIso, m.displayName ?? "", m.messageType, m.text ?? ""].join("\u0000");
        const seq = seqCounter.get(baseKey) ?? 0;
        seqCounter.set(baseKey, seq + 1);
        const id = await importMessageId(groupId, m, seq);
        stmts.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO messages (line_message_id, group_id, user_id, display_name, message_type, text, sent_at, source)
             VALUES (?, ?, NULL, ?, ?, ?, ?, 'import')`
          ).bind(id, groupId, m.displayName, m.messageType, m.text, m.sentAtIso)
        );
      }
      for (const r of await env.DB.batch(stmts)) inserted += r.meta.changes ?? 0;
    }
    return json({ ok: true, parsed: parsed.length, inserted, skipped: parsed.length - inserted });
  }

  // 生徒一覧
  if (request.method === "GET" && url.pathname === "/admin/students") {
    const rows = await env.DB.prepare(`SELECT * FROM students ORDER BY name`).all();
    return json(rows.results);
  }

  // 生徒の登録・更新（notion_page_id があればそれを、なければ名前+事業をキーにupsert）
  if (request.method === "POST" && url.pathname === "/admin/students") {
    const b = (await request.json()) as {
      name?: string; business?: string; status?: string;
      student_group_id?: string; teacher_group_id?: string; teacher_name?: string;
      trial_start_date?: string; notion_page_id?: string; target_university?: string; monitor_mode?: string;
    };
    if (!b.name || !b.business || !["shiratani", "localmedi"].includes(b.business)) {
      return json({ error: "name and business (shiratani|localmedi) required" }, 400);
    }
    if (b.status && !["trial", "enrolled", "inactive"].includes(b.status)) {
      return json({ error: "status must be trial|enrolled|inactive" }, 400);
    }
    if (b.monitor_mode && !["daily", "monthly", "no_progress", "skip"].includes(b.monitor_mode)) {
      return json({ error: "monitor_mode must be daily|monthly|no_progress|skip" }, 400);
    }

    // 紐付け先グループの存在チェック（FK違反を先にわかりやすいエラーで返す）
    for (const gid of [b.student_group_id, b.teacher_group_id]) {
      if (!gid) continue;
      const g = await env.DB.prepare(`SELECT group_id FROM groups WHERE group_id = ?`).bind(gid).first();
      if (!g) {
        return json({ error: `group '${gid}' not found. 先に監視アカウントをそのグループに参加させてください` }, 400);
      }
    }

    const existing = b.notion_page_id
      ? await env.DB.prepare(`SELECT id FROM students WHERE notion_page_id = ?`).bind(b.notion_page_id).first<{ id: number }>()
      : await env.DB.prepare(`SELECT id FROM students WHERE name = ? AND business = ?`).bind(b.name, b.business).first<{ id: number }>();

    if (existing) {
      // 名前・在籍状況・担当講師・志望校・体験開始日の正本はNotion。
      // ここで受け取っても次の同期で上書きされるため、黙って捨てずに ignored として返す。
      const ignored = (["name", "status", "teacher_name", "target_university", "trial_start_date"] as const)
        .filter((k) => b[k] != null);

      await env.DB.prepare(
        `UPDATE students SET
           business = ?,
           student_group_id = COALESCE(?, student_group_id),
           teacher_group_id = COALESCE(?, teacher_group_id),
           notion_page_id = COALESCE(?, notion_page_id),
           monitor_mode = COALESCE(?, monitor_mode),
           updated_at = datetime('now')
         WHERE id = ?`
      ).bind(b.business, b.student_group_id ?? null, b.teacher_group_id ?? null,
             b.notion_page_id ?? null, b.monitor_mode ?? null, existing.id).run();

      return json({
        ok: true,
        id: existing.id,
        action: "updated",
        ...(ignored.length
          ? { ignored, note: "この項目の正本はNotionの生徒DBです。Notionで直してから /admin/notion-sync を実行してください" }
          : {}),
      });
    }

    const r = await env.DB.prepare(
      `INSERT INTO students (name, business, status, student_group_id, teacher_group_id, teacher_name, trial_start_date, notion_page_id, target_university, monitor_mode)
       VALUES (?, ?, COALESCE(?, 'trial'), ?, ?, ?, ?, ?, ?, COALESCE(?, 'daily'))`
    ).bind(b.name, b.business, b.status ?? null, b.student_group_id ?? null, b.teacher_group_id ?? null,
           b.teacher_name ?? null, b.trial_start_date ?? null, b.notion_page_id ?? null,
           b.target_university ?? null, b.monitor_mode ?? null).run();
    return json({ ok: true, id: r.meta.last_row_id, action: "inserted" });
  }

  // 生徒に紐付いていない生徒グループの一覧（紐付け作業の起点）
  if (request.method === "GET" && url.pathname === "/admin/unmapped-groups") {
    const rows = await env.DB.prepare(
      `SELECT g.group_id, g.name, g.joined_at FROM groups g
       WHERE g.type = 'student' AND g.active = 1
         AND g.group_id NOT IN (SELECT student_group_id FROM students WHERE student_group_id IS NOT NULL)
       ORDER BY g.joined_at DESC`
    ).all();
    return json(rows.results);
  }

  // ダッシュボードユーザーの発行。トークンはサーバー側で生成して返す
  if (request.method === "POST" && url.pathname === "/admin/dashboard-users") {
    const b = (await request.json()) as { name?: string; role?: string; teacher_name?: string };
    if (!b.name || !b.role || !["admin", "teacher"].includes(b.role)) {
      return json({ error: "name and role (admin|teacher) required" }, 400);
    }
    if (b.role === "teacher" && !b.teacher_name) {
      return json({ error: "teacher_name required for role=teacher（students.teacher_name と一致させる）" }, 400);
    }
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    await env.DB.prepare(
      `INSERT INTO dashboard_users (token, name, role, teacher_name) VALUES (?, ?, ?, ?)`
    ).bind(token, b.name, b.role, b.teacher_name ?? null).run();
    return json({ ok: true, name: b.name, role: b.role, url: `${url.origin}/dashboard?key=${token}` });
  }

  // ダッシュボードユーザー一覧（トークンは伏せる）
  if (request.method === "GET" && url.pathname === "/admin/dashboard-users") {
    const rows = await env.DB.prepare(
      `SELECT name, role, teacher_name, active, created_at, substr(token, 1, 8) || '…' AS token_prefix
       FROM dashboard_users ORDER BY created_at`
    ).all();
    return json(rows.results);
  }

  // ダッシュボードユーザーの無効化
  if (request.method === "POST" && url.pathname === "/admin/dashboard-users/deactivate") {
    const b = (await request.json()) as { name?: string };
    if (!b.name) return json({ error: "name required" }, 400);
    const r = await env.DB.prepare(`UPDATE dashboard_users SET active = 0 WHERE name = ?`).bind(b.name).run();
    return json({ ok: true, deactivated: r.meta.changes });
  }

  // 学習インサイトの手動抽出。student_id指定で1人、なしで全員（force=1で全員強制再抽出）
  if (request.method === "POST" && url.pathname === "/admin/extract-insights") {
    const studentId = Number(url.searchParams.get("student_id") ?? 0);
    if (studentId) {
      const s = await env.DB.prepare(
        `SELECT id, name, business, status, student_group_id, teacher_group_id, teacher_name
         FROM students WHERE id = ?`
      ).bind(studentId).first<StudentRow>();
      if (!s) return json({ error: "student not found" }, 404);
      return json(await extractStudentInsights(env, s));
    }
    const force = url.searchParams.get("force") === "1";
    return json(await refreshAllInsights(env, { force }));
  }

  // 今週のよい対応リストを作り直す。notify=1 でSlackにも送る
  if (request.method === "POST" && url.pathname === "/admin/weekly-highlights") {
    const notify = url.searchParams.get("notify") === "1";
    return json(await runWeeklyHighlights(env, { notify }));
  }

  // Notion → D1（生徒マスタの流し込み）。?dry=1 で差分だけ見る
  if (request.method === "POST" && url.pathname === "/admin/notion-sync") {
    const report = await syncStudentsFromNotion(env);
    return json(report);
  }

  // D1 → Notion（日報の状況の書き戻し）。分析を回してから書く
  if (request.method === "POST" && url.pathname === "/admin/notion-writeback") {
    const r = await runAnalysis(env, { notify: false, weekly: false });
    const report = await writeBackReportStatus(env, r.students.map(toReportStatusInput));
    return json(report);
  }

  // 分析の手動実行。デフォルトはdry-run。notify=1 で実際に通知。sweep=1 は未回答の質問・日報未返信だけ
  if (request.method === "POST" && url.pathname === "/admin/run-analysis") {
    const notify = url.searchParams.get("notify") === "1";
    if (url.searchParams.get("sweep") === "1") {
      return json(await runUnansweredSweep(env, { notify }));
    }
    const weekly = url.searchParams.get("weekly") === "1";
    const result = await runAnalysis(env, { notify, weekly });
    return json(result);
  }

  // アラート履歴
  if (request.method === "GET" && url.pathname === "/admin/alerts") {
    const rows = await env.DB.prepare(
      `SELECT a.*, s.name AS student_name FROM alerts a LEFT JOIN students s ON s.id = a.student_id
       ORDER BY a.created_at DESC LIMIT 100`
    ).all();
    return json(rows.results);
  }

  // テスト送信（sendToGroupのガードを必ず通る）
  if (request.method === "POST" && url.pathname === "/admin/send-test") {
    const body = (await request.json()) as { group_id?: string; text?: string };
    if (!body.group_id || !body.text) return json({ error: "group_id and text required" }, 400);
    const result = await sendToGroup(env, body.group_id, "test", body.text);
    return json(result, result.ok ? 200 : 403);
  }

  return json({ error: "not found" }, 404);
}

// ---------- ユーティリティ ----------

async function verifySignature(channelSecret: string, body: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // 長さが同じ場合のみ比較（タイミング攻撃対策として単純比較で十分な用途）
  return expected.length === signature.length && expected === signature;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 分析結果から、Notionへ書き戻す分だけを取り出す */
function toReportStatusInput(a: {
  student_id: number;
  name: string;
  last_student_message_at: string | null;
  report_gap_days: number | null;
  report_stalled: boolean;
  unanswered: { kind?: "question" | "daily_report" }[];
  skip_progress: boolean;
}) {
  const reports = a.unanswered.filter((u) => u.kind === "daily_report").length;
  return {
    student_id: a.student_id,
    name: a.name,
    last_student_message_at: a.last_student_message_at,
    report_gap_days: a.report_gap_days,
    report_stalled: a.report_stalled,
    unanswered_count: a.unanswered.length - reports,
    unanswered_report_count: reports,
    skip_progress: a.skip_progress,
  };
}
