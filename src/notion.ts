/**
 * Notionとの同期。
 *
 * 生徒マスタの正本はNotion。このWorkerのD1は「LINEグループと生徒の対応表」と
 * 「メッセージの置き場」に徹する。担当講師・在籍状況・志望校はNotionから流し込むだけで、
 * ダッシュボードや管理APIからは編集しない（編集してもNotionに上書きされる）。
 *
 * 逆向きに、分析でわかった日報の状況はNotionへ書き戻す。
 * こうすると社員向けのPLダッシュボードはNotionだけを読めばよく、
 * LINEの実装をあちら側に持ち込まずに日報の停滞まで表示できる。
 */

import type { Env } from "./types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

/** R8 面談・体験生徒 */
const DS_TAIKEN = "e4ce1fb3-9c34-44e7-ae0b-79f917ba2acb";
/** R8 生徒（塾生） */
const DS_JUKUSEI = "72ee6524-b6fa-4426-a2f2-1e909d0dd7b0";
/** 講師マスタ（オンライン／ローカルメディ／英検） */
const DS_TEACHERS = [
  "2d649d91-8c94-4264-a516-5c031af05fdd",
  "a6b57e73-5f9b-445c-9904-3fe37ddfed22",
  "292ed607-f7f8-48e3-9dca-34b90ab8eb30",
];

const TEACHER_PROPS = ["担当講師（オンライン）", "担当講師（ローカルメディ）", "担当講師（英検）", "担当講師"];

type Json = Record<string, unknown>;

export interface NotionStudent {
  pageId: string;
  name: string;
  business: "shiratani" | "localmedi";
  status: "trial" | "enrolled" | "inactive";
  teacherName: string | null;
  targetUniversity: string | null;
  trialStartDate: string | null;
  lineGroupId: string | null;
}

export interface SyncReport {
  ran_at: string;
  notion_students: number;
  updated: { name: string; changes: string[] }[];
  unmatched_in_notion: string[];
  d1_without_notion: string[];
  skipped_reason?: string;
}

export interface WritebackReport {
  ran_at: string;
  written: { name: string; text: string }[];
  unchanged: number;
  no_page: string[];
  failed: { name: string; detail: string }[];
  skipped_reason?: string;
}

/* ---------------- Notion REST ---------------- */

async function notionFetch(env: Env, path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json()) as Json;
  if (!res.ok) throw new Error(`notion ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function queryAll(env: Env, dataSourceId: string): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | undefined;
  do {
    const body = await notionFetch(env, `/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    out.push(...((body.results as Json[]) ?? []));
    cursor = body.has_more ? (body.next_cursor as string) : undefined;
  } while (cursor);
  return out;
}

/* ---------------- プロパティの読み取り ---------------- */

function plain(prop: unknown): string {
  const p = prop as { type?: string; title?: { plain_text: string }[]; rich_text?: { plain_text: string }[] };
  if (p?.type === "title") return (p.title ?? []).map((t) => t.plain_text).join("");
  if (p?.type === "rich_text") return (p.rich_text ?? []).map((t) => t.plain_text).join("");
  return "";
}

function selectName(prop: unknown): string | null {
  const p = prop as { type?: string; select?: { name: string } | null };
  return p?.type === "select" ? (p.select?.name ?? null) : null;
}

function multiNames(prop: unknown): string[] {
  const p = prop as { type?: string; multi_select?: { name: string }[] };
  return p?.type === "multi_select" ? (p.multi_select ?? []).map((o) => o.name) : [];
}

function dateStart(prop: unknown): string | null {
  const p = prop as { type?: string; date?: { start: string } | null };
  return p?.type === "date" ? (p.date?.start?.slice(0, 10) ?? null) : null;
}

function relIds(prop: unknown): string[] {
  const p = prop as { type?: string; relation?: { id: string }[] };
  return p?.type === "relation" ? (p.relation ?? []).map((r) => r.id) : [];
}

export function dashless(id: string | null | undefined): string {
  return (id ?? "").replaceAll("-", "").toLowerCase();
}

function normalizeName(name: string): string {
  return name.replace(/[\s　]/g, "");
}

/** 短期プログラムの指導中を表すステータス。2026-09に「体験中」から分離した */
const PROGRAM_STATUSES = ["9月のプログラム実施中", "残り100日プログラム実施中"];

/**
 * 在籍の段階。結果に入力があれば結果がステータスより正しい
 * （CLAUDE.md「ステータスと結果の読み方」）。
 */
function toStatus(statusName: string | null, resultName: string | null): NotionStudent["status"] {
  if (resultName) return resultName === "体験後入塾" ? "enrolled" : "inactive";
  if (statusName === "塾生") return "enrolled";
  // 短期プログラム（9月・共テ残り100日）の指導中も体験中と同じ扱い。
  // 日報の停滞しきい値（2日）と担当生徒の抽出をここで決めている。
  if (statusName === "体験中" || PROGRAM_STATUSES.includes(statusName ?? "")) return "trial";
  return "inactive";
}

/* ---------------- 第1段階: Notion → D1 ---------------- */

async function fetchTeacherNames(env: Env): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const ds of DS_TEACHERS) {
    let rows: Json[];
    try {
      rows = await queryAll(env, ds);
    } catch {
      continue; // このインテグレーションに接続されていない講師DBは飛ばす
    }
    for (const page of rows) {
      const props = (page.properties ?? {}) as Json;
      const name = plain(props["講師名"]) || plain(props["名前"]) || plain(props["氏名"]);
      if (name) map.set(dashless(page.id as string), name);
    }
  }
  return map;
}

function toNotionStudent(page: Json, teachers: Map<string, string>): NotionStudent | null {
  const props = (page.properties ?? {}) as Json;
  const name = plain(props["名前"]).trim();
  if (!name) return null;

  const courses = multiNames(props["コース"]);
  const teacherNames = TEACHER_PROPS.flatMap((k) => relIds(props[k]))
    .map((id) => teachers.get(dashless(id)))
    .filter((n): n is string => Boolean(n));
  // 塾生DBに残っている旧プロパティも担当ありとして拾う
  const legacy = plain(props["担当講師 1"]) || (selectName(props["担当講師 2"]) ?? "");
  if (legacy) teacherNames.push(legacy);

  return {
    pageId: dashless(page.id as string),
    name,
    business: courses.some((c) => c.includes("ローカルメディ")) ? "localmedi" : "shiratani",
    status: toStatus(selectName(props["ステータス"]), selectName(props["結果"])),
    teacherName: teacherNames.length ? Array.from(new Set(teacherNames)).join("・") : null,
    targetUniversity: plain(props["志望大学学部学科"]).trim() || null,
    trialStartDate: dateStart(props["体験開始日"]),
    lineGroupId: plain(props["LINEグループID"]).trim() || null,
  };
}

interface D1Student {
  id: number;
  name: string;
  business: string;
  status: string;
  teacher_name: string | null;
  target_university: string | null;
  trial_start_date: string | null;
  notion_page_id: string | null;
}

/**
 * Notionの生徒DB2つを読んで、D1のstudentsへ流し込む。
 * D1側に無い生徒は作らない（LINEグループの紐付けが要るので手作業のまま）。
 */
export async function syncStudentsFromNotion(env: Env): Promise<SyncReport> {
  const ranAt = new Date().toISOString();
  if (!env.NOTION_TOKEN) {
    return {
      ran_at: ranAt,
      notion_students: 0,
      updated: [],
      unmatched_in_notion: [],
      d1_without_notion: [],
      skipped_reason: "NOTION_TOKEN が未設定です（wrangler secret put NOTION_TOKEN）",
    };
  }

  const teachers = await fetchTeacherNames(env);
  const pages = [...(await queryAll(env, DS_TAIKEN)), ...(await queryAll(env, DS_JUKUSEI))];

  // 同じ生徒が両DBにいるときは、段階が進んでいるほうを採用する
  const rank = { enrolled: 3, trial: 2, inactive: 1 } as const;
  const byPage = new Map<string, NotionStudent>();
  const byName = new Map<string, NotionStudent>();
  for (const page of pages) {
    const s = toNotionStudent(page, teachers);
    if (!s) continue;
    byPage.set(s.pageId, s);
    const key = normalizeName(s.name);
    const prev = byName.get(key);
    if (!prev || rank[s.status] > rank[prev.status]) byName.set(key, s);
  }

  const d1 = (
    await env.DB.prepare(
      `SELECT id, name, business, status, teacher_name, target_university, trial_start_date, notion_page_id
       FROM students`
    ).all<D1Student>()
  ).results;

  const updated: SyncReport["updated"] = [];
  const matchedPages = new Set<string>();
  const withoutNotion: string[] = [];

  for (const row of d1) {
    const src = row.notion_page_id
      ? (byPage.get(dashless(row.notion_page_id)) ?? byName.get(normalizeName(row.name)))
      : byName.get(normalizeName(row.name));
    if (!src) {
      if (!row.notion_page_id) withoutNotion.push(row.name);
      continue;
    }
    matchedPages.add(src.pageId);

    const changes: string[] = [];
    if (row.name !== src.name) changes.push(`名前 ${row.name}→${src.name}`);
    if (row.business !== src.business) changes.push(`事業 ${row.business}→${src.business}`);
    if (row.status !== src.status) changes.push(`状況 ${row.status}→${src.status}`);
    if ((row.teacher_name ?? "") !== (src.teacherName ?? ""))
      changes.push(`担当 ${row.teacher_name ?? "未設定"}→${src.teacherName ?? "未設定"}`);
    if ((row.target_university ?? "") !== (src.targetUniversity ?? "")) changes.push("志望校");
    if ((row.trial_start_date ?? "") !== (src.trialStartDate ?? "")) changes.push("体験開始日");
    if (dashless(row.notion_page_id) !== src.pageId) changes.push("Notionページ紐付け");

    if (changes.length === 0) continue;

    await env.DB.prepare(
      `UPDATE students
         SET name = ?, business = ?, status = ?, teacher_name = ?, target_university = ?,
             trial_start_date = ?, notion_page_id = ?,
             notion_synced_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(
        src.name,
        src.business,
        src.status,
        src.teacherName,
        src.targetUniversity,
        src.trialStartDate,
        src.pageId,
        row.id
      )
      .run();
    updated.push({ name: src.name, changes });
  }

  // Notionにいて、D1に対応する行が無い在籍者（LINEグループの紐付けが必要）
  const unmatched = Array.from(byPage.values())
    .filter((s) => s.status !== "inactive" && !matchedPages.has(s.pageId))
    .map((s) => s.name);

  return {
    ran_at: ranAt,
    notion_students: byPage.size,
    updated,
    unmatched_in_notion: unmatched,
    d1_without_notion: withoutNotion,
  };
}

/* ---------------- 第2段階: D1 → Notion ---------------- */

export interface ReportStatusInput {
  student_id: number;
  name: string;
  last_student_message_at: string | null;
  report_gap_days: number | null;
  report_stalled: boolean;
  unanswered_count: number;
  unanswered_report_count?: number;
  skip_progress: boolean;
}

/** Notionの「日報の状況」に入れる1行。人が読んで、そのまま手を打てる粒度にする */
export function buildReportStatusText(a: ReportStatusInput, lastDate: string | null): string {
  if (a.skip_progress) return "日報の監視対象外";
  const last = lastDate ? `最終 ${lastDate.slice(5).replace("-", "/")}` : "記録なし";
  const parts: string[] = [];
  if (a.report_stalled && a.report_gap_days !== null) parts.push(`日報が${a.report_gap_days}日止まっています`);
  else if (a.report_gap_days !== null && a.report_gap_days <= 1) parts.push("日報は続いています");
  else if (a.report_gap_days !== null) parts.push(`日報は${a.report_gap_days}日空いています`);
  else parts.push("日報の記録なし");
  if (a.unanswered_count > 0) parts.push(`未回答の質問 ${a.unanswered_count}件`);
  if ((a.unanswered_report_count ?? 0) > 0) parts.push(`日報への未返信 ${a.unanswered_report_count}件`);
  return `${parts.join("／")}（${last}）`;
}

function jstDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 分析結果の日報まわりをNotionの生徒ページへ書き戻す。
 * 前回書いた内容と同じなら投げない（Workerのサブリクエスト数とNotionのレート制限を抑える）。
 */
export async function writeBackReportStatus(env: Env, analyses: ReportStatusInput[]): Promise<WritebackReport> {
  const ranAt = new Date().toISOString();
  if (!env.NOTION_TOKEN) {
    return {
      ran_at: ranAt,
      written: [],
      unchanged: 0,
      no_page: [],
      failed: [],
      skipped_reason: "NOTION_TOKEN が未設定です（wrangler secret put NOTION_TOKEN）",
    };
  }

  const rows = (
    await env.DB.prepare(
      `SELECT id, notion_page_id, last_report_status_text, last_report_date FROM students`
    ).all<{ id: number; notion_page_id: string | null; last_report_status_text: string | null; last_report_date: string | null }>()
  ).results;
  const byId = new Map(rows.map((r) => [r.id, r]));

  const written: WritebackReport["written"] = [];
  const failed: WritebackReport["failed"] = [];
  const noPage: string[] = [];
  let unchanged = 0;

  for (const a of analyses) {
    const row = byId.get(a.student_id);
    if (!row?.notion_page_id) {
      noPage.push(a.name);
      continue;
    }
    const lastDate = jstDate(a.last_student_message_at);
    const text = buildReportStatusText(a, lastDate);
    if (row.last_report_status_text === text && (row.last_report_date ?? null) === lastDate) {
      unchanged++;
      continue;
    }

    try {
      await notionFetch(env, `/pages/${row.notion_page_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          properties: {
            日報の状況: { rich_text: [{ type: "text", text: { content: text.slice(0, 2000) } }] },
            日報最終提出日: lastDate ? { date: { start: lastDate } } : { date: null },
          },
        }),
      });
      await env.DB.prepare(
        `UPDATE students SET last_report_status_text = ?, last_report_date = ? WHERE id = ?`
      )
        .bind(text, lastDate, a.student_id)
        .run();
      written.push({ name: a.name, text });
    } catch (e) {
      failed.push({ name: a.name, detail: String(e).slice(0, 200) });
    }
  }

  return { ran_at: ranAt, written, unchanged, no_page: noPage, failed };
}
