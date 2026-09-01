-- 志望校カラムとAIインサイトテーブルの追加（2026-09-01）
ALTER TABLE students ADD COLUMN target_university TEXT;

CREATE TABLE IF NOT EXISTS student_insights (
  student_id INTEGER PRIMARY KEY REFERENCES students(id),
  plan_json TEXT,
  exams_json TEXT,
  summary TEXT,
  message_count INTEGER,
  extracted_at TEXT
);
