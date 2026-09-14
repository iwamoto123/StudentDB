-- LINE監視システム D1スキーマ
-- 適用: npx wrangler d1 execute line-monitor --remote --file=schema.sql

-- 監視対象グループ
CREATE TABLE IF NOT EXISTS groups (
  group_id TEXT PRIMARY KEY,
  name TEXT,
  type TEXT NOT NULL DEFAULT 'student' CHECK (type IN ('student', 'teacher', 'admin', 'test')),
  business TEXT CHECK (business IN ('shiratani', 'localmedi')),
  active INTEGER NOT NULL DEFAULT 1,
  joined_at TEXT,
  left_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- メッセージ（webhook受信 + 過去ログインポート）
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_message_id TEXT,
  group_id TEXT NOT NULL,
  user_id TEXT,
  display_name TEXT,
  message_type TEXT NOT NULL,
  text TEXT,
  sent_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook', 'import')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_line_id ON messages(line_message_id) WHERE line_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages(group_id, sent_at);

-- グループメンバー
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);

-- 生徒マスタ（Notionと連携）
CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  business TEXT NOT NULL CHECK (business IN ('shiratani', 'localmedi')),
  status TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'enrolled', 'inactive')),
  student_group_id TEXT REFERENCES groups(group_id),
  teacher_group_id TEXT REFERENCES groups(group_id),
  teacher_name TEXT,
  trial_start_date TEXT,
  notion_page_id TEXT,
  target_university TEXT, -- 志望大学学部学科（Notionから同期）
  monitor_mode TEXT NOT NULL DEFAULT 'daily' CHECK (monitor_mode IN ('daily', 'monthly', 'no_progress', 'skip')), -- monthlyは月1面談 / no_progressは進捗管理なし / skipはLINE未参加
  notion_synced_at TEXT,           -- Notionから流し込んだ時刻
  last_report_status_text TEXT,    -- 前回Notionへ書き戻した「日報の状況」。差分がなければ投げない
  last_report_date TEXT,           -- 前回Notionへ書き戻した「日報最終提出日」
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_students_group ON students(student_group_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_notion ON students(notion_page_id) WHERE notion_page_id IS NOT NULL;

-- 送信ログ（誤爆防止の監査用）
CREATE TABLE IF NOT EXISTS send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_group_id TEXT NOT NULL,
  target_group_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- アラート（分析結果）
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER REFERENCES students(id),
  kind TEXT NOT NULL,
  detail TEXT,
  notified_group_id TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI抽出の学習インサイト（勉強計画・教材進捗・模試結果）。生徒1人につき1行を上書き更新
CREATE TABLE IF NOT EXISTS student_insights (
  student_id INTEGER PRIMARY KEY REFERENCES students(id),
  plan_json TEXT,       -- 教材進捗 [{subject,name,total,done,unit,deadline,note}]
  exams_json TEXT,      -- 模試結果 [{name,date,scores:[{subject,score,max}],note}]
  summary TEXT,         -- 勉強計画の1〜2行要約
  message_count INTEGER, -- 抽出時点の対象メッセージ数（差分再抽出の判定用）
  extracted_at TEXT
);

-- 週次のグループLINEよい対応（チューター共有用。点数・順位は持たない）
CREATE TABLE IF NOT EXISTS weekly_highlights (
  week_start TEXT PRIMARY KEY,
  week_end TEXT NOT NULL,
  items_json TEXT NOT NULL,
  share_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dashboard_users (
  token TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher')),
  teacher_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
