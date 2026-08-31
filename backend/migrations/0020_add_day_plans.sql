-- The day planner. Direct-UI like daily_notes and focus_sessions: the LLM
-- writes the first draft, but every edit after that comes from the panel.
--
-- Blocks store a LENGTH and an ORDER, never a clock time. Times are derived by
-- walking the list from starts_at, which is what makes inserting a break in
-- the middle re-time everything below it for free instead of needing every
-- following row rewritten. pinned_start is the escape hatch for something that
-- happens at a fixed hour whatever ran late before it.
CREATE TABLE day_plans (
    plan_date  date PRIMARY KEY,
    starts_at  time NOT NULL,
    -- The time the day has to be finished by, defaulted from the sleep goal.
    ends_at    time,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_blocks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_date    date NOT NULL REFERENCES day_plans(plan_date) ON DELETE CASCADE,
    position     int NOT NULL,
    kind         text NOT NULL CHECK (kind IN ('task', 'break', 'custom')),
    -- Kept when the block came from a real sidequest, so it can be started,
    -- ticked off, or pushed to tomorrow from inside the plan. Nulled rather
    -- than deleted if the sidequest goes away - the block still happened.
    task_id      uuid REFERENCES tasks(id) ON DELETE SET NULL,
    label        text NOT NULL,
    minutes      int NOT NULL CHECK (minutes > 0),
    pinned_start time
);

CREATE INDEX plan_blocks_date_idx ON plan_blocks (plan_date, position);
