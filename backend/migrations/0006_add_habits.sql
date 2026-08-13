ALTER TABLE logs DROP CONSTRAINT logs_parsed_type_check;
ALTER TABLE logs ADD CONSTRAINT logs_parsed_type_check
    CHECK (parsed_type IN ('nutrition', 'person', 'album', 'song', 'workout',
                           'learning', 'place', 'trip', 'sleep', 'task',
                           'habit_completion'));

-- Habit definitions are persistent state independent of any single log entry
-- (same reasoning as tasks/learning). Completions themselves stay lightweight:
-- one logs row per completion, data = {habit_id, habit_name}, no extra table.
CREATE TABLE habits (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text NOT NULL,
    target_frequency text NOT NULL DEFAULT 'daily'
                     CHECK (target_frequency IN ('daily', 'weekly')),
    active           boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX habits_active_idx ON habits (active) WHERE active;
