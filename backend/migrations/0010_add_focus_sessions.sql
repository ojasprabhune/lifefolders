ALTER TABLE logs DROP CONSTRAINT logs_parsed_type_check;
ALTER TABLE logs ADD CONSTRAINT logs_parsed_type_check
    CHECK (parsed_type IN ('nutrition', 'person', 'album', 'song', 'workout',
                           'learning', 'place', 'trip', 'sleep', 'task',
                           'cadence_completion', 'weight', 'focus_session'));

-- A focus session is always attached to a task (existing or created on the
-- spot at session start). Relational because sessions are queried by task for
-- the task's history view; a logs row is still written when a session ends so
-- it lands in the daily timeline like every other domain.
CREATE TABLE focus_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    planned_minutes int NOT NULL,
    actual_minutes  int,
    started_at      timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    completed       boolean NOT NULL DEFAULT false
);

CREATE INDEX focus_sessions_task_idx ON focus_sessions (task_id, started_at DESC);
