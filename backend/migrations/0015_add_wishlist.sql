CREATE TABLE wishlist_items (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            text NOT NULL CHECK (kind IN ('album','song','place','trip','learning','other')),
    title           text NOT NULL,
    detail          text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    resolved_at     timestamptz,
    resolved_log_id uuid REFERENCES logs(id),
    archived_at     timestamptz
);

CREATE INDEX wishlist_open_idx ON wishlist_items (kind) WHERE resolved_at IS NULL AND archived_at IS NULL;

ALTER TABLE logs DROP CONSTRAINT logs_parsed_type_check;
ALTER TABLE logs ADD CONSTRAINT logs_parsed_type_check
    CHECK (parsed_type IN ('nutrition', 'person', 'album', 'song', 'workout',
                           'learning', 'place', 'trip', 'sleep', 'task',
                           'cadence_completion', 'weight', 'focus_session',
                           'wishlist'));
