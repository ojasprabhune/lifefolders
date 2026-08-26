-- The blurb is written against a specific sleep goal ("57m short of your
-- target"), so a changed goal makes the cached line wrong even on the same
-- day. Key the cache on the goal as well as the date.
ALTER TABLE sleep_insight_cache ADD COLUMN goal_min integer NOT NULL DEFAULT 480;
