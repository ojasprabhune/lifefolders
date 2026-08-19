-- paused_at is set while a session is on pause; paused_seconds accumulates
-- the total time spent paused across (possibly several) pauses, so ending a
-- session can subtract dead time from the wall-clock span and report the
-- actual minutes worked.
ALTER TABLE focus_sessions ADD COLUMN paused_at timestamptz;
ALTER TABLE focus_sessions ADD COLUMN paused_seconds int NOT NULL DEFAULT 0;
