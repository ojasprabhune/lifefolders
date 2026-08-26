-- Cadences could only be "daily" or "weekly". This replaces that with a real
-- recurrence: every N days, or every N weeks on chosen weekdays. Daily is
-- simply (day, 1) and the old weekly is (week, 1) with no weekdays picked,
-- so both existing shapes survive the backfill unchanged.
--
-- anchor_date is what the interval counts from - without it "every 2 weeks"
-- has no way to say *which* two weeks.
ALTER TABLE cadences
    ADD COLUMN interval_unit text NOT NULL DEFAULT 'day'
        CHECK (interval_unit IN ('day', 'week')),
    ADD COLUMN interval_n integer NOT NULL DEFAULT 1
        CHECK (interval_n BETWEEN 1 AND 52),
    -- 0 = Sunday .. 6 = Saturday. Empty means "any day inside the period",
    -- which is what the old weekly cadence meant. Only read when unit = week.
    ADD COLUMN weekdays smallint[] NOT NULL DEFAULT '{}',
    ADD COLUMN anchor_date date;

UPDATE cadences SET
    interval_unit = CASE WHEN target_frequency = 'weekly' THEN 'week' ELSE 'day' END,
    interval_n = 1,
    weekdays = '{}',
    anchor_date = created_at::date;

ALTER TABLE cadences ALTER COLUMN anchor_date SET NOT NULL;
ALTER TABLE cadences ALTER COLUMN anchor_date SET DEFAULT CURRENT_DATE;

ALTER TABLE cadences DROP COLUMN target_frequency;
