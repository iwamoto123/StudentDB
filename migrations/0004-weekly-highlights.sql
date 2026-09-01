-- 週次のグループLINEよい対応リスト（2026-09-01）
CREATE TABLE IF NOT EXISTS weekly_highlights (
  week_start TEXT PRIMARY KEY,
  week_end TEXT NOT NULL,
  items_json TEXT NOT NULL,
  share_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
