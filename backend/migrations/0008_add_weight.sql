ALTER TABLE logs DROP CONSTRAINT logs_parsed_type_check;
ALTER TABLE logs ADD CONSTRAINT logs_parsed_type_check
    CHECK (parsed_type IN ('nutrition', 'person', 'album', 'song', 'workout',
                           'learning', 'place', 'trip', 'sleep', 'task',
                           'cadence_completion', 'weight'));
