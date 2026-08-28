-- The blurb is cached for a day and only reconsidered when the date or the
-- goal changes. The prompt and the facts it reads changed instead, so today's
-- cached sentence would otherwise outlive the deploy that fixed it.
DELETE FROM sleep_insight_cache;
