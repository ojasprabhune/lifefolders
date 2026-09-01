-- A plan's finish-by line comes from the sleep coach: median wake minus the
-- sleep goal. That is arithmetic, and a week of early-morning wake times made
-- it hand back "be asleep by 8pm" - which then read as three hours of overflow
-- on an ordinary evening. sensible_bedtime() in sleep.rs now floors it at 11pm,
-- but rows written before that keep the number they were given, so apply the
-- same rule to the ones still ahead of us.
--
-- The 6pm-11pm band is what wake-minus-goal produces for a 2am-7am wake and is
-- no longer reachable, so anything sitting in it came from the old formula.
--
-- CURRENT_DATE is the server's, which is UTC and so already tomorrow for most
-- of the user's evening - hence the day of slack, so today's own plan is not
-- skipped by an accident of timezone.
UPDATE day_plans
SET ends_at = TIME '23:00', updated_at = now()
WHERE plan_date >= CURRENT_DATE - 1
  AND ends_at > TIME '18:00'
  AND ends_at < TIME '23:00';
