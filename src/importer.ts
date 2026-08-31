/**
 * LINE「トーク履歴を送信」で書き出したテキストファイルのパーサー（F1-6 過去ログインポート）
 *
 * 書式（iOS / Android 共通の現行フォーマット）:
 *   [LINE] ◯◯のトーク履歴
 *   保存日時：2026/08/31 14:00
 *
 *   2026/08/29(土)
 *   21:47\t中山蒼衣\t勉強時間：5時間
 *   複数行メッセージの続きの行
 *   21:50\t岩本武士\t[スタンプ]
 *   09:12\t岩本武士がグループに参加しました        ← 名前列がない行はシステムメッセージ
 *
 * 時刻は端末ローカル（JST前提）なのでUTCに変換して保存する。
 */

export interface ParsedMessage {
  sentAtIso: string;
  displayName: string | null;
  messageType: string;
  text: string | null;
}

const DATE_LINE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\([月火水木金土日]\))?\s*$/;
// 名前欄は空のことがある（システムメッセージ）。本文は引用符付きで内部に改行を含むことがある
const MESSAGE_LINE = /^(\d{1,2}):(\d{2})\t([^\t\n]*)\t([\s\S]*)$/;
const SYSTEM_LINE = /^(\d{1,2}):(\d{2})\t([^\t\n]+)$/;

const MEDIA_TYPES: Record<string, string> = {
  "[スタンプ]": "sticker",
  "[写真]": "image",
  "[画像]": "image",
  "[動画]": "video",
  "[ファイル]": "file",
  "[ボイスメッセージ]": "audio",
  "[アルバム]": "image",
  "[位置情報]": "location",
  "[連絡先]": "file",
  "[ノート]": "system",
};

export function parseLineExport(raw: string): ParsedMessage[] {
  const content = raw.replace(/^\uFEFF/, "");

  // 現行のエクスポートはレコード区切りがCRLFで、引用符付きメッセージの内部改行はLF。
  // CRLFがあるファイルはCRLFで分割すると複数行メッセージが自動的に1レコードにまとまる。
  const hasCrlf = content.includes("\r\n");
  const records = hasCrlf ? content.split("\r\n") : content.split("\n");

  const messages: ParsedMessage[] = [];
  let currentDate: { y: number; m: number; d: number } | null = null;
  let current: ParsedMessage | null = null;
  let inQuote = false; // LF区切りファイルで引用符付きメッセージが複数レコードに跨るときの状態

  const flush = () => {
    if (current) {
      if (current.text !== null) current.text = current.text.replace(/\s+$/, "");
      messages.push(current);
      current = null;
    }
    inQuote = false;
  };

  for (const record of records) {
    // 引用符が閉じていない継続行（LF区切りファイルのみ発生）
    if (inQuote && current) {
      current.text = (current.text ?? "") + "\n" + record;
      if (quoteClosed(current.text)) {
        current.text = unquote(current.text);
        inQuote = false;
      }
      continue;
    }

    const dateMatch = record.match(DATE_LINE);
    if (dateMatch) {
      flush();
      currentDate = { y: Number(dateMatch[1]), m: Number(dateMatch[2]), d: Number(dateMatch[3]) };
      continue;
    }

    // 日付行が出てくるまではヘッダー（[LINE] ... / 保存日時：...）なので無視
    if (!currentDate) continue;

    const msgMatch = record.match(MESSAGE_LINE);
    if (msgMatch) {
      flush();
      const name = msgMatch[3] === "" ? null : msgMatch[3];
      let text = msgMatch[4];

      if (text.startsWith('"')) {
        if (quoteClosed(text)) {
          text = unquote(text);
        } else {
          // 引用符が閉じていない = 複数行メッセージが後続レコードに続く（LF区切りのみ）
          current = {
            sentAtIso: toUtcIso(currentDate, Number(msgMatch[1]), Number(msgMatch[2])),
            displayName: name,
            messageType: name === null ? "system" : "text",
            text,
          };
          inQuote = true;
          continue;
        }
      }

      const mediaType = name === null ? undefined : MEDIA_TYPES[text.trim()];
      current = {
        sentAtIso: toUtcIso(currentDate, Number(msgMatch[1]), Number(msgMatch[2])),
        displayName: name,
        messageType: name === null ? "system" : mediaType ?? "text",
        text: mediaType ? null : text,
      };
      continue;
    }

    const sysMatch = record.match(SYSTEM_LINE);
    if (sysMatch) {
      flush();
      current = {
        sentAtIso: toUtcIso(currentDate, Number(sysMatch[1]), Number(sysMatch[2])),
        displayName: null,
        messageType: "system",
        text: sysMatch[3],
      };
      continue;
    }

    // 時刻で始まらないレコードは直前のメッセージの続き（旧形式の複数行メッセージ）。
    // text が null（[写真]等のメディア）のメッセージに続きは存在しないので、区切りの空行を誤って結合しない
    if (current && current.text !== null) {
      current.text = current.text + "\n" + record;
    }
  }
  flush();
  return messages;
}

/** 引用符で始まるテキストが閉じているか（末尾の連続する引用符が奇数個なら閉じている） */
function quoteClosed(text: string): boolean {
  if (text.length < 2 || !text.endsWith('"')) return false;
  let trailing = 0;
  for (let i = text.length - 1; i >= 1 && text[i] === '"'; i--) trailing++;
  return trailing % 2 === 1;
}

/** 外側の引用符を外し、エスケープ（""）を戻す */
function unquote(text: string): string {
  return text.slice(1, -1).replace(/""/g, '"');
}

/** JSTの日付・時刻をUTCのISO文字列にする */
function toUtcIso(date: { y: number; m: number; d: number }, hour: number, minute: number): string {
  const utcMs = Date.UTC(date.y, date.m - 1, date.d, hour - 9, minute, 0);
  return new Date(utcMs).toISOString();
}

/**
 * 再インポートしても重複しないための決定的なID。
 * 同一分・同一発言者・同一本文が複数ある場合はファイル内の出現順（seq）で区別する。
 */
export async function importMessageId(
  groupId: string,
  msg: ParsedMessage,
  seq: number
): Promise<string> {
  const key = [groupId, msg.sentAtIso, msg.displayName ?? "", msg.messageType, msg.text ?? "", String(seq)].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `import:${hex}`;
}
