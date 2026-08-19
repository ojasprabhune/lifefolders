-- A focus session can now target a cadence instead of a task (e.g. "SAT
-- practice, 1 hour" against a daily "sat" cadence), so a completed session
-- logs a cadence completion instead of requiring a task to exist.
ALTER TABLE focus_sessions ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE focus_sessions ADD COLUMN cadence_id uuid REFERENCES cadences(id) ON DELETE CASCADE;
ALTER TABLE focus_sessions ADD CONSTRAINT focus_sessions_target_check
    CHECK ((task_id IS NOT NULL) <> (cadence_id IS NOT NULL));

CREATE INDEX focus_sessions_cadence_idx ON focus_sessions (cadence_id, started_at DESC);
