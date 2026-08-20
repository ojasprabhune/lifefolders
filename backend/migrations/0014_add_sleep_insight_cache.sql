-- Single-row cache for the daily solace (sleep) insight blurb so the Groq
-- call happens once per day instead of on every dashboard open.
CREATE TABLE sleep_insight_cache (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    for_date date NOT NULL,
    blurb text NOT NULL,
    generated_at timestamptz NOT NULL DEFAULT now()
);
