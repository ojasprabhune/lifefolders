ALTER TABLE focus_sessions ADD COLUMN afk_seconds int NOT NULL DEFAULT 0;
ALTER TABLE focus_sessions ADD COLUMN afk_at timestamptz;
