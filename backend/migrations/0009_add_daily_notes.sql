-- Daily plan / reflection scratchpad. Direct-UI, not routed through the LLM
-- parse loop. One row per calendar date; today_text is seeded once from the
-- previous date's tomorrow_text on first touch (see daily.rs).
CREATE TABLE daily_notes (
    date          date PRIMARY KEY,
    today_text    text NOT NULL DEFAULT '',
    tomorrow_text text NOT NULL DEFAULT '',
    updated_at    timestamptz NOT NULL DEFAULT now()
);
