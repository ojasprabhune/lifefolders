-- Migration 0025 added `label` so a focus session can mean neither a sidequest
-- nor a cadence (a custom block in the day plan starts one named by the
-- block), but the XOR constraint from 0012 still demands exactly one of
-- task_id/cadence_id, so every label session died on insert with an
-- "internal error" - and the play button's catch swallowed it, which is why
-- pressing play appeared to do nothing. "Never both set" is what remains:
-- exactly-one has to make room for neither.
ALTER TABLE focus_sessions DROP CONSTRAINT focus_sessions_target_check;
ALTER TABLE focus_sessions ADD CONSTRAINT focus_sessions_target_check
    CHECK (task_id IS NULL OR cadence_id IS NULL);
