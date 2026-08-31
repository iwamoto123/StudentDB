/**
 * 送信（唯一の出力経路・誤爆ガードの本体）
 *
 * - 送信は sendToGroup() のみ。グループ種別が teacher / admin / test 以外なら送信せず遮断する
 * - 全送信を send_log に記録する（ガード層5）
 */
import type { Env } from "./types";

const SENDABLE_GROUP_TYPES = ["teacher", "admin", "test"] as const;

export async function sendToGroup(
  env: Env,
  targetGroupId: string,
  kind: string,
  text: string
): Promise<{ ok: boolean; reason?: string }> {
  const group = await env.DB.prepare(`SELECT group_id, type FROM groups WHERE group_id = ?`)
    .bind(targetGroupId).first<{ group_id: string; type: string }>();

  const groupType = group?.type ?? "unknown";

  // 誤爆ガード層1: 講師系グループ以外への送信はここで遮断する
  if (!group || !(SENDABLE_GROUP_TYPES as readonly string[]).includes(group.type)) {
    await logSend(env, targetGroupId, groupType, kind, text, "blocked", "group type not sendable");
    console.error(`BLOCKED send to ${targetGroupId} (type=${groupType})`);
    return { ok: false, reason: `blocked: group type is '${groupType}'` };
  }

  if (!env.LINE_CHANNEL_ACCESS_TOKEN) {
    await logSend(env, targetGroupId, groupType, kind, text, "api_error", "no access token");
    return { ok: false, reason: "LINE_CHANNEL_ACCESS_TOKEN not set" };
  }

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: targetGroupId, messages: [{ type: "text", text }] }),
  });

  if (!res.ok) {
    const detail = `${res.status} ${await res.text()}`;
    await logSend(env, targetGroupId, groupType, kind, text, "api_error", detail);
    return { ok: false, reason: detail };
  }

  await logSend(env, targetGroupId, groupType, kind, text, "sent", null);
  return { ok: true };
}

async function logSend(
  env: Env,
  groupId: string,
  groupType: string,
  kind: string,
  text: string,
  status: string,
  detail: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO send_log (target_group_id, target_group_type, kind, text, status, detail) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(groupId, groupType, kind, text, status, detail).run();
}

/** 全体ダイジェストのSlack送信（Incoming Webhook） */
export async function sendSlack(env: Env, text: string): Promise<{ ok: boolean; reason?: string }> {
  if (!env.SLACK_WEBHOOK_URL) return { ok: false, reason: "SLACK_WEBHOOK_URL not set" };
  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return { ok: false, reason: `${res.status} ${await res.text()}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}
