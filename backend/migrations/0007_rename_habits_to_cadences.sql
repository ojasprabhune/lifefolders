-- Renames the habits domain to "cadence" everywhere it lives in the database.
-- 0006 is left untouched (already applied on some databases); migrations are
-- append-only, so the rename is its own step.
ALTER TABLE habits RENAME TO cadences;
ALTER INDEX habits_active_idx RENAME TO cadences_active_idx;

-- Swap 'habit_completion' for 'cadence_completion' in the logs type set. Any
-- completions logged under the old name are migrated first, while no CHECK
-- constraint is in force, so the re-added constraint never sees a stale value.
ALTER TABLE logs DROP CONSTRAINT logs_parsed_type_check;

UPDATE logs
SET parsed_type = 'cadence_completion',
    data = jsonb_build_object('cadence_id', data->'habit_id', 'cadence_name', data->'habit_name')
WHERE parsed_type = 'habit_completion';

ALTER TABLE logs ADD CONSTRAINT logs_parsed_type_check
    CHECK (parsed_type IN ('nutrition', 'person', 'album', 'song', 'workout',
                           'learning', 'place', 'trip', 'sleep', 'task',
                           'cadence_completion'));
