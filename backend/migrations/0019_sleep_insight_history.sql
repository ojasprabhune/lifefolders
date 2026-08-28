-- The coach should not open the same way two days running, and the only way
-- it can avoid that is to be shown what it already said. Keeps the last few
-- blurbs alongside the cached one.
ALTER TABLE sleep_insight_cache
    ADD COLUMN recent_blurbs jsonb NOT NULL DEFAULT '[]'::jsonb;

-- The coach's voice changed with it, so the line cached for today is from
-- the old one.
DELETE FROM sleep_insight_cache;
