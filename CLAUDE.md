# lifefolders

Personal logging app: one text/voice input, LLM tool-calling parser, structured timeline organized by date and category. Tracks nutrition, people, music, workouts, places, trips, sleep, learning, and tasks.

For setup and deployment details, see the [README](./README.md).

## Data model

The `logs` table (`id uuid, created_at timestamptz, raw_input text, parsed_type text CHECK, data jsonb, deleted_at timestamptz`) is the primary workhorse, storing timestamped entries across eight lightweight domains (nutrition, person, album, song, place, trip, sleep, task). Each new `parsed_type` is added via a migration that widens the CHECK constraint.

Two domains break from this JSONB-in-logs pattern:

- **learning** (`backend/migrations/0004_add_batch2.sql`): has real relational tables (`fields`, `resources`, `topics`, `resource_files`) because it needs efficient querying by field/topic/resource relationship, not just "insert and list by created_at." A `logs` row is still written per action (create/update/progress) so timeline history is preserved.
- **tasks** (`backend/migrations/0005_add_tasks.sql`): similar pattern — a real `tasks` table (title, category, due_date, status, is_exam, effort_minutes) and a related `task_checkpoints` table (spaced-review reminders for exams) for efficient due-date and status queries, plus per-action timeline entries in `logs`.

The JSONB-first convention is: unless there's a concrete querying need beyond date/type filtering (like "all tasks due in the next 7 days" or "relationship between resource and topic"), keep it in `logs.data` and add relational tables only when justified.

## Backend module map

- **main.rs** — bootstrap, route registration, CORS config, shared bearer-token auth middleware.
- **models.rs** — all entity structs (`NutritionData`, `PersonData`, `TaskData`, etc.) and dispatch enums (`Action`, `Parsed`).
- **routes.rs** — generic CRUD endpoints for `logs` (`/api/logs`); special-case handlers for entities needing side effects (`upsert_workout`, `handle_sleep`, `append_itinerary`, `transcribe`).
- **groq.rs** — LLM client (Groq API, tool-calling dispatch, system prompt, context injection).
- **learning.rs** — learning-domain-specific routes and side-effect logic (field/resource/topic CRUD, PDF ingestion, plan generation).
- **tasks.rs** — task-domain-specific routes and side-effect logic (task/checkpoint CRUD, fuzzy-match resolution, spaced-review generation).
- **commands.rs** — apply logic for the command tool group: reschedule/clear-due-date/status/recategorize/delete a task, start a focus session, plan the day, delete the last entry. Returns a notice, never a `logs` row (the exception being the task-history rows `write_history` writes). `plan_today` is the one command that reaches outside the tasks domain: it feeds the clock, `tasks::context_block`, and `focus::minutes_by_task` to `groq::plan_today` and prepends the result to `daily_notes.today_text`.
- **wishlist.rs** — things wanted but not done yet (`wishlist_items` table). Manual only, never auto-populated. `try_resolve` runs after every insert in `create_log` and crosses an item off when a matching album/song/place/trip/learning entry is finally logged.
- **search.rs** — plain-text search across every log (`GET /api/search`), `ILIKE` over `raw_input` and `data::text`. Deliberately unindexed and LLM-free; correct at this scale.
- **cadences.rs** — recurring habits. `Schedule` (every N days, or every N weeks on chosen weekdays, counted from `anchor_date`) is the core: everything downstream works in *occurrences* rather than calendar days, so a day the cadence wasn't due can't read as a miss, and a completion clears the latest occurrence at or before it. Completions themselves stay JSONB-in-logs; only the definition is relational.
- **rank.rs** — shared pairwise-comparison ranking engine used by album/place/trip domains.
- **usda.rs** — USDA FoodData Central API client for nutrition grounding.
- **wger.rs** — wger.de gym API client for workout import.

## LLM wiring

A single dispatcher in `groq.rs` sends one flat tool list with `tool_choice: "required"` to one Groq model at a time. The list is two groups concatenated by `tools(command_only)`: `log_tools()` (records of something that happened — `log_nutrition`, `log_person`, `log_task`, `log_album`, `log_song`, `log_learning`, `log_workout`, `log_place`, `log_trip`, `log_sleep`, `add_wishlist_item`, etc.) and `command_tools()` (instructions about things already tracked — `reschedule_tasks`, `set_task_status`, `delete_task`, `recategorize_task`, `start_focus`, `delete_last_entry`). One call picks either kind. Models are tried sequentially (`openai/gpt-oss-120b` → `llama-3.3-70b-versatile`), with fallback on network/API errors.

The one `SYSTEM_PROMPT` in `groq.rs` contains all domain-specific disambiguation rules (portion-size heuristics, exam vs. project classification, sleep parsing, etc.) — this is where cross-cutting logic lives, not in code branches.

Live app state is injected into the prompt per-request via helper functions (`learning::context_block`, `tasks::context_block`) called in `routes::create_log`. This is how the model resolves free text like "finished the chem lab writeup" against an existing task without needing to know its UUID — the open tasks list is appended to the prompt, and the LLM can reference them by title. Reuse this pattern (`*_context_block`) for any future module that needs to reference live state.

Three deterministic prefixes bypass the model's tool judgment in `parse()`: `task:` forces `log_task` via `tool_choice`, `wish:` forces `add_wishlist_item` (and is the *only* way to reach it — `tools()` leaves that tool out of the list entirely otherwise, so classifying wants by tense can't put things on the list uninvited), and `/` forces a command by narrowing the offered tools to `command_tools()` alone — there's no `tool_choice` that means "any of this subset", so the log tools simply aren't sent.

Inside an entry, three markers are parsed in Rust rather than trusted to the model, all in `tasks.rs`: `#tag` (category), `@time` (due time), and `note:` (everything after it becomes the note verbatim). `strip_markers` keeps all three out of the title as a backstop.

Task notes have two write paths on purpose. A typed entry **appends** a line (`update_task`'s `note = CASE ... note || E'\n' || $6`), because repeated check-ins should build a history. Editing the field via `PATCH /api/tasks/:id` with `note` **replaces** it, applied after `update_task` rather than through it — a correction has to be able to shorten a note, not only grow it. Both the timeline row editor and the expanded sidequest card use the replace path and fire `life-log-created` so the other view catches up.

`groq.rs` also holds three single-purpose non-tool-calling model helpers, all the same shape — small model, `reasoning_effort: "low"` to dodge the hidden-reasoning budget trap, `None`/passthrough on any failure so a Groq hiccup never writes something broken: `polish()` (voice transcripts), `sleep_insight()` (the solace blurb), and `plan_today()` (the day plan). Anything the blurb asserts as a *relationship* — a streak, a run, "in a row" — must be computed in Rust and handed over in a facts block (`sleep::build_facts`); the model reliably invents these when left to derive them from raw rows.

Commands mutate existing state and return a `notice` (plus an optional `focus_session` for `start_focus`), never a `logs` row — `create_log` can legitimately come back with an empty `logs` array.

Entities that need side effects beyond "insert into `logs`" (workout session tracking, itinerary appends, learning resource ingestion, task create-or-update) go through special `Action` variants (`Workout`, `ItineraryItem`, `Learning`, `Task`) that get dispatched in `routes::create_log`; everything else becomes `Action::Entry(Parsed::...)` and goes straight into the `logs` table.

## Recipe: adding a new tracked entity end-to-end

1. **models.rs**: Define a `NewThingData` struct (the snapshot shape that goes into `logs.data` JSONB). If it requires live state or multiple SQL mutations, also define a corresponding `NewThingRequest` struct and add a `NewThing(NewThingRequest)` arm to the `Action` enum.

2. **groq.rs**: Add a `log_new_thing` function def to the tool list in `tools()`. Add a paragraph to `SYSTEM_PROMPT` explaining the domain's classification rules and expected phrasing. In the `parse()` function, add a match arm for `"log_new_thing"` that constructs either an `Action::NewThing(NewThingRequest{...})` (if it has side effects) or pushes an `Action::Entry(Parsed::NewThing(...))` (if it's plain JSONB).

3. **routes.rs** (if it needs side effects): Add a handler function (or inline code in the action-dispatch match) to call `NewThingRequest` side-effect logic, write a `logs` row via `sqlx::query("INSERT INTO logs ...")`, and return the result. Optionally, inject live state into the prompt via `NewThingRequest` → a `new_thing::context_block(&state)` function called in `create_log`.

4. **migrations** (if it needs relational structure): Create a new `00XX_add_new_thing.sql` migration. If it's simple JSONB in `logs`, just widen the `logs_parsed_type_check` constraint. If it needs real tables (like learning/tasks), define those.

5. **main.rs**: If you added new HTTP routes (e.g. `GET /api/new-things`), register them on the `api` router, protected by `require_auth`. Otherwise, the generic `/api/logs` endpoint covers CRUD.

6. **Frontend types.ts**: Add `NewThingData` (mirror of the Rust struct, matching JSONB keys). Add `'new_thing'` to the `ParsedType` union and the `Log['data']` union (and `Category` union if it's a filterable domain). If it needs a specialized row renderer, add a TypeScript type for it too (see `Task`, `Learning`, etc.).

7. **Frontend Row.tsx**: Add a case to the `summary()` function (one-line description of what happened), `badge()` (category/label pill), `rightSide()` (optional right-side metadata), and `Editor()` dispatch (inline edit form for the log snapshot). Reuse the `useEditor` hook and `EditorFooter` component as-is; they handle save/delete mutations.

8. **Frontend App.tsx**: Add `{value: 'new_thing', label: 'New Things'}` to the `FILTERS` array so it appears as a timeline filter. If you want a dedicated dashboard page (like `Learning.tsx`, `Sleep.tsx`), add a new hash route and a nav link.

9. **Frontend optional**: Add a page like `Learning.tsx` or `Tasks.tsx` if a summary/dashboard view makes sense. Add a paragraph to `Guide.tsx` documenting example phrasing.

## Second pattern: direct-UI entities (not LLM-parsed)

Most domains are entered through the one text/voice input and the `groq.rs` parse loop (the recipe above). A few are **entered through dedicated UI instead** — the LLM is not involved — but they still write a `logs` row so they show up in the daily timeline like everything else. This is the pattern for anything with a live/structured interaction that doesn't fit "type a sentence": `daily_notes` (autosaving Today/Tomorrow scratchpad, `daily.rs` + `DailyPlan.tsx`) and `focus_sessions` (live countdown timer, `focus.rs` + `FocusTimer.tsx`).

How it differs from the recipe:

- **No tool def, no `SYSTEM_PROMPT` paragraph, no `parse()` arm, no `Action`/`Parsed` variant.** The frontend calls a purpose-built endpoint directly (`POST /api/focus-sessions`, `PATCH /api/daily-notes/:date`), not `POST /api/logs`.
- **Relational table + its own module** (`daily.rs`, `focus.rs`) registered in `main.rs`, same as `tasks.rs`/`learning.rs`.
- **A `logs` row is still written** at the meaningful moment (a focus session *ending* writes `parsed_type: 'focus_session'`; the migration still widens `logs_parsed_type_check`). Timeline rendering in `Row.tsx` (`summary`/`badge`/`rightSide`/`Editor`) is added exactly as in the recipe — the timeline doesn't care how the row got there.
- **Filtering** can piggyback on an existing chip instead of adding one: `matches()` in `App.tsx` groups `weight` under the `workout`/soma chip and `focus_session` under the `task` chip, rather than giving every sub-type its own filter.
- **Auth edge case**: a `logs`-writing action triggered outside a normal fetch (e.g. `focus_sessions` ending via `navigator.sendBeacon` on tab close, which can't set the bearer header) needs a route *outside* the `require_auth` layer that checks the token itself (header or body) — see `focus::end_session` and its registration on the unauthenticated `app` router in `main.rs`.

When adding a new domain, pick this pattern over the recipe only when the interaction is genuinely structured/live (a timer, an autosaving field, a stepper) rather than a phrase the LLM could parse.

## Frontend architecture

Hash-based router (no library): `#/` = home (daily timeline), `#/music` / `#/sleep` / `#/tasks` / etc. = dedicated dashboard pages for complex domains.

`#/search` is a panel like those but is not a domain — it stays out of `DOMAINS` for the same reason `guide` does. It renders results with the shared `Row` component, holding them in local state so an edit made from search saves in place.

The `Home` page renders a daily timeline filtered by date and category. Category filters (a `FILTERS` array of value/label pairs) drive chips in the header.

`Row.tsx` is a per-log-type renderer registry: for each `log.parsed_type`, it dispatches to a `summary()` (one-line description), `badge()` (category/label), `rightSide()` (optional metadata), and `Editor()` (inline edit form). Each type gets a mini editor component (`FoodEditor`, `PersonEditor`, `TaskLogEditor`, etc.) that uses `useEditor` to handle mutations.

Voice input is wired end-to-end: hold the mic button in the input area → `MediaRecorder` → `POST /api/transcribe` (Whisper) → `groq::polish()` (small model cleanup) → text appended to the input box → submit flows through the normal parse pipeline. New entity types get voice capture for free once a tool def exists.

## Constraints

- **Auth**: single shared bearer token (not per-user — all edits share one `AUTH_TOKEN` env var). There is no multi-user account model, no session management, no OAuth.
- **Deployment**: Render free web service (sleeps after 15 min idle, no background worker / cron process). If proactive features (daily email, scheduled reminders) are needed later, they must be triggered externally (e.g. GitHub Actions cron job) hitting an HTTP endpoint.
- **Frontend deployment**: NOT auto-deployed on push. Run `scripts/deploy-frontend.sh` locally to build and push the static output to the sibling `dotfolders` repo, which GitHub Pages then serves.

## Conventions

- **Minimal comments**: default to none. Add only when the WHY is non-obvious (hidden constraint, subtle invariant, bug workaround, behavior that surprises readers).
- **No premature abstraction**: three similar lines is better than a generic helper; don't design for hypothetical future requirements.
- **No error-handling for impossible scenarios**: trust internal code and framework guarantees; validate only at system boundaries (user input, external APIs).
- **Reuse existing patterns**: JSONB-in-logs for lightweight entities, `Action` enum dispatch for side effects, `*_context_block` for state injection, `Row.tsx` per-type cases for timeline rendering, hash routes for dashboard pages.
