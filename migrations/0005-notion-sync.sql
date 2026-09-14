-- Notionを生徒マスタの正本にするための列。
-- last_report_* は「前回Notionへ書き戻した内容」で、毎回PATCHを投げないための差分判定に使う。
ALTER TABLE students ADD COLUMN notion_synced_at TEXT;
ALTER TABLE students ADD COLUMN last_report_status_text TEXT;
ALTER TABLE students ADD COLUMN last_report_date TEXT;
