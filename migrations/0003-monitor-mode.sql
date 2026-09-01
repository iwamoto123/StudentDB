-- 月1面談など、日報・進捗を監視しない生徒向け（2026-09-01）
ALTER TABLE students ADD COLUMN monitor_mode TEXT NOT NULL DEFAULT 'daily';
