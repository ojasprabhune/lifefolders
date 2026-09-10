# lifefolders

Personal logging app. One text/voice input, LLM parsing into structured
entries, a daily timeline organized by date and category. Tracks nutrition,
people, music, workouts, weight, places, trips, sleep, learning, tasks
("sidequests"), recurring cadences, a wishlist, focus sessions, and a
generated day plan.

Live at https://ojasprabhune.github.io/lifefolders

This is an independent deployment (detached fork) of
[tejasprabhune/life](https://github.com/tejasprabhune/life), running on this
account's own free-tier services.

## How it works

Type anything ("2 rotis with dal", "met Alex at the coffee shop", "chem lab
due friday 2 hr #school"). The backend sends it to Groq with a flat list of
tool definitions; the model picks one (`log_nutrition`, `log_task`,
`log_sleep`, …) and fills in the fields. Most entries land as JSONB in a
single `logs` table; tasks and learning have real relational tables because
they need querying beyond "list by date". Nutrition is grounded against USDA
FoodData Central. Voice goes through Whisper on Groq, then a small model
cleans up the transcript.

Architecture notes for anyone editing the code live in
[CLAUDE.md](./CLAUDE.md) — that file is long and is the actual reference.
This README is about getting it running.

---

# Setting up your own copy

Everything below is what a fresh person needs to stand up their own instance:
their own database, their own backend, their own frontend on their own GitHub
Pages. Nothing is shared with the original deployment.

The shape of it: a **Rust backend** on Render (free tier), a **Postgres
database** on Neon (free tier), and a **static frontend** — plain HTML, CSS
and JS after the build — hosted anywhere, GitHub Pages included. The frontend
talks to the backend over HTTPS with a bearer token. There's no server-side
rendering and no build step at serve time; the built frontend is genuinely
just files in a folder.

## 0. Accounts you need

Required:

| Service | What for | Cost |
|---|---|---|
| [GitHub](https://github.com) | code + Pages hosting | free |
| [Neon](https://neon.tech) | Postgres database | free tier |
| [Groq](https://console.groq.com) | LLM parsing + voice transcription | free tier |
| [Render](https://render.com) | runs the Rust backend | free tier |

Optional, each one degrades gracefully if left unset:

| Service | What for |
|---|---|
| [USDA FoodData Central](https://fdc.nal.usda.gov/api-key-signup.html) | real nutrition numbers instead of model estimates |
| [wger.de](https://wger.de) | importing gym workouts |
| Apple iCloud (CalDAV) | pushing sidequest due dates into Apple Calendar |
| [Resend](https://resend.com) | weekly recap email |
| [Adobe Fonts](https://fonts.adobe.com) | the typefaces (see step 5) |

## 1. Get the code

Fork it on GitHub (so Render can watch *your* repo and rebuild on push), then:

    git clone https://github.com/YOURNAME/lifefolders.git
    cd lifefolders

You need, locally:

- **Rust** (1.93+) — `curl https://sh.rustup.rs -sSf | sh`. Only needed if you
  want to run or test the backend locally; Render builds it in the cloud.
- **Node 20+** and npm — needed, because you build the frontend on your own
  machine and push the output.

## 2. Database (Neon)

1. Create a Neon project. Any region; pick the one near you.
2. Copy the **pooled** connection string from the dashboard. It looks like
   `postgresql://user:password@ep-something-pooler.region.aws.neon.tech/neondb?sslmode=require`.
3. Keep it somewhere for step 3. It goes into Render, never into git.

That's the whole database setup. **Do not create any tables.** The backend
runs `sqlx::migrate!()` on every boot, so the 21 migrations in
`backend/migrations/` apply themselves the first time the service starts. New
migrations added later apply the same way on the next deploy.

Neon's free tier suspends the database after a few minutes idle and wakes on
the next connection, which costs a second or two. That's on top of Render's
own sleep — see step 8.

## 3. Backend (Render)

Render reads `render.yaml` at the repo root, which declares one Docker web
service with `rootDir: backend` and a health check at `/health`.

1. Render dashboard → **New → Blueprint** → connect your fork → it picks up
   `render.yaml` and offers to create `lifefolders-api`. Rename it if you
   like; the name becomes your URL (`https://<name>.onrender.com`).
2. Every env var in the blueprint is `sync: false`, which means Render asks
   you for the value rather than reading it from git. Fill in:

   **Required**

   - `DATABASE_URL` — the Neon string from step 2.
   - `GROQ_API_KEY` — from https://console.groq.com/keys.
   - `AUTH_TOKEN` — invent one. This is the app's only password (see the note
     on auth below). Make it long and random: `openssl rand -hex 24`.

   **Optional** — leave blank to disable the feature

   - `USDA_API_KEY` — defaults to `DEMO_KEY`, which is rate limited per IP and
     usually exhausted on shared cloud egress. Free key at
     https://fdc.nal.usda.gov/api-key-signup.html. Without a working key,
     nutrition entries keep the model's estimates and a null `usda_fdc_id`.
   - `WGER_API_KEY` — a wger.de account token; enables importing logged gym
     sessions.
   - `CALDAV_APPLE_ID`, `CALDAV_APP_PASSWORD`, `CALDAV_CALENDAR_URL` — pushes
     sidequests with due dates to Apple Calendar. The password is an
     app-specific password from appleid.apple.com, not your real one. All
     three must be set or the whole integration stays off.
   - `RESEND_API_KEY`, `RECAP_TO`, `RECAP_FROM`, `RECAP_TZ_OFFSET_MIN` — the
     weekly recap email. Without a key and a recipient, `/api/recap/send`
     just replies that it's unconfigured. `RECAP_FROM` defaults to
     `onboarding@resend.dev`, which works without verifying a domain.
     `RECAP_TZ_OFFSET_MIN` defaults to 420 (US Pacific, UTC-7).

3. Deploy. The first build is slow — it compiles the whole Rust dependency
   tree from scratch, ten minutes or so. Later ones are faster.
4. Check it: `curl https://<your-service>.onrender.com/health` should answer.

### The one code change you must make

`backend/src/main.rs` has a hardcoded CORS allow-list:

```rust
let allowed_origins = [
    "https://ojasprabhune.github.io",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
```

Change the first entry to **your own** GitHub Pages origin — just the origin,
scheme and host, no path: `https://yourname.github.io`. Keep the two
localhost entries so `npm run dev` keeps working. Push, and Render rebuilds.

If you skip this, the app loads and every request fails in the browser
console with a CORS error, which looks like the backend being down.

## 4. Frontend (the static files)

`npm run build` produces `frontend/dist/`: an `index.html`, a hashed JS
bundle, a hashed CSS file, a favicon, a manifest and a service worker.
Nothing else. Any static host will serve it — GitHub Pages, Netlify, Cloudflare
Pages, an S3 bucket, a folder on a VPS.

Two things decide where it can live:

**`base` in `frontend/vite.config.ts`** must match the path the site is served
at, because it's baked into the asset URLs at build time.

| Where you're hosting it | `base` |
|---|---|
| `yourname.github.io/lifefolders/` (folder in your user-site repo) | `'/lifefolders/'` |
| `yourname.github.io/life/` (a project repo's Pages) | `'/life/'` |
| `yourname.github.io/` (root of the user site) | `'/'` |
| a custom domain at the root | `'/'` |

**`VITE_API_URL`** is the backend URL, read at build time. Pass it on the
build command; the fallback baked into `frontend/src/api.ts` points at the
original deployment, so don't rely on it.

Routing needs nothing special: the app uses a **hash router** (`#/tasks`,
`#/sleep`), so every URL is really `index.html` and there's no 404-rewrite
rule or `404.html` copy to set up. This is why it works on plain GitHub Pages
without configuration.

### Option A — a folder in your `yourname.github.io` repo

This is how the original is deployed, and it's the simplest if you already
have a user site. Your Pages repo gets a `lifefolders/` folder in it; GitHub
serves it at `yourname.github.io/lifefolders/`.

`scripts/deploy-frontend.sh` does the whole thing, but it has three
hardcoded values at the top that are specific to this machine:

```bash
LIFE_DIR="/Users/ojasprabhune/Documents/personal/lifefolders"
DOTFOLDERS_DIR="/Users/ojasprabhune/Documents/personal/dotfolders"
API_URL="https://lifefolders-api.onrender.com"
```

Point `LIFE_DIR` at your clone, `DOTFOLDERS_DIR` at your local clone of your
`yourname.github.io` repo, and `API_URL` at your Render service. Then:

    ./scripts/deploy-frontend.sh

It builds with `VITE_API_URL` set, wipes and replaces the folder in the Pages
repo, commits and pushes. GitHub Pages picks it up within a minute.

Nothing about this is automatic — **rerun the script after every frontend
change.** The backend redeploys on push; the frontend does not.

### Option B — GitHub Pages from this repo, built by Actions

If you'd rather push and forget, add a workflow that builds and publishes to
Pages. Set `base` to `'/lifefolders/'` (or whatever your repo is called), then
create `.github/workflows/pages.yml`:

```yaml
name: pages
on:
  push:
    branches: [main]
  workflow_dispatch: {}
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
        working-directory: frontend
      - run: npm run build
        working-directory: frontend
        env:
          VITE_API_URL: ${{ vars.VITE_API_URL }}
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: frontend/dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - id: deploy
        uses: actions/deploy-pages@v4
```

Then in the repo settings: **Pages → Source → GitHub Actions**, and
**Secrets and variables → Actions → Variables** → add `VITE_API_URL` with
your Render URL. (A repo *variable*, not a secret — it ends up in the bundle
either way, and it isn't sensitive.)

Your CORS origin is still `https://yourname.github.io` regardless of which
option you pick.

### Option C — anywhere else

`npm run build` with `base: '/'` and `VITE_API_URL` set, then drag
`frontend/dist` into Netlify, Cloudflare Pages, or copy it onto any web
server. Add that origin to the CORS list in `main.rs`.

Opening `dist/index.html` straight off disk (`file://`) does **not** work —
ES modules and the service worker both need an HTTP origin. `npx serve
frontend/dist` if you want to check a build locally.

## 5. Fonts (cosmetic, but you'll notice)

`frontend/index.html` loads an Adobe Fonts kit:

```html
<link rel="stylesheet" href="https://use.typekit.net/hck5xcw.css" />
```

Adobe kits are locked to registered domains, so on your domain that kit won't
serve and the three faces — `neue-haas-grotesk-display`, `mencken-std-text`,
`calling-code` — fall back to generic sans, serif and monospace. The app works
fine; it just looks plainer.

Either make your own free Adobe Fonts kit with those three families (or your
own picks), add your domain to it, and swap the kit URL — or delete the
`<link>` and change the three `font-family` declarations at the top of
`frontend/src/styles.css` to fonts you like.

## 6. First run

1. Open your Pages URL.
2. You get a single password box. Type the `AUTH_TOKEN` you set in Render.
   It's stored in `localStorage` and sent as `Authorization: Bearer <token>`
   on every request.
3. Type something — "banana", or "read chapter 3 tomorrow 40min #school" — and
   watch it get parsed into a row.
4. `#/guide` in the app documents the phrasing for every domain.

## 7. Local development

Backend, against a local Postgres:

    brew install postgresql@16
    initdb -D /tmp/lifepg -U life --auth=trust
    pg_ctl -D /tmp/lifepg -o "-p 5433" start
    createdb -h 127.0.0.1 -p 5433 -U life life

    cd backend
    cp .env.example .env      # fill in GROQ_API_KEY at minimum
    cargo run --bin life-api  # applies migrations on boot, listens on :8080

You can point `DATABASE_URL` at your Neon database instead of a local one if
you'd rather not install Postgres — it's the same string from step 2, and the
migrations are already applied.

Test the parse loop without a browser:

    cargo run --bin life-cli -- "a banana"
    cargo run --bin life-cli -- --list

Frontend:

    cd frontend
    npm install
    npm run dev

`frontend/.env.development` already points `VITE_API_URL` at
`http://localhost:8080`, and `http://localhost:5173` is already in the
backend's CORS list, so the two find each other.

## 8. Free-tier limits worth knowing before you plan around them

**Render sleeps after 15 minutes idle.** The first request after that takes
30–60 seconds while the container boots — Render doesn't refuse the
connection, it holds it open. The app has a "waking up the server…" notice
for exactly this, and caches the last screen so you're not staring at nothing.
There is also no background worker or cron on the free plan, which is why the
weekly recap is a GitHub Actions cron hitting an HTTP endpoint
(`.github/workflows/weekly-recap.yml`) rather than a scheduled job in the
backend. If you want it, set the repo secrets `RECAP_URL`
(`https://<your-service>.onrender.com/api/recap/send`) and `AUTH_TOKEN`.

**Groq's free tier meters tokens per minute, per model.** Each entry sends
roughly 6k tokens of fixed overhead (system prompt plus tool definitions)
however short your sentence is, against a budget of about 8k per minute. Two
or three entries in a row exhaust one model, which is why `groq.rs` tries
three (`openai/gpt-oss-120b` → `openai/gpt-oss-20b` →
`llama-3.3-70b-versatile`), each with its own bucket, and waits out short
`retry-after` windows rather than failing. It's usable; it isn't unlimited.
Typed sidequests are parsed in the browser first (`frontend/src/localParse.ts`)
and often never hit the model at all.

**Neon free tier** is one project, a few GB, and it suspends when idle. This
app writes a handful of rows a day; you will not run out of room.

**Auth is one shared bearer token.** There are no accounts, no sessions, no
per-user rows. Anyone with the token sees and edits everything — so it's one
token per *person*, meaning your instance is yours and the original is
untouched. Don't put a second person on the same backend expecting separate
data.

## 9. Checklist

Everything that has to change from the original before it's yours:

- [ ] `backend/src/main.rs` — CORS origin → your `https://yourname.github.io`
- [ ] `frontend/vite.config.ts` — `base` → the path you're serving from
- [ ] `scripts/deploy-frontend.sh` — `LIFE_DIR`, `DOTFOLDERS_DIR`, `API_URL`
      (Option A only)
- [ ] Render env vars — `DATABASE_URL`, `GROQ_API_KEY`, `AUTH_TOKEN` at minimum
- [ ] `frontend/index.html` — the Typekit link, if you want the fonts
- [ ] `README.md` — the "Live at" line at the top

## 10. When something doesn't work

**Everything fails, console says CORS / "blocked by CORS policy".** Your
origin isn't in the allow-list in `main.rs`. Origin only — no trailing path,
no trailing slash.

**Blank page, 404s on `assets/index-*.js`.** `base` in `vite.config.ts`
doesn't match the path you're serving at. Rebuild and republish.

**Dropped back to the password box.** A 401 clears the stored token and
returns you to the gate, so this means the token in the browser doesn't match
`AUTH_TOKEN` in Render. Retype it.

**Backend won't boot, logs show a `DATABASE_URL` or migrate error.** Either
the Neon string is wrong, or it's missing `?sslmode=require`. Render's log
tab shows the exact sqlx error.

**Backend won't boot and the log just says a missing env var.**
`DATABASE_URL`, `GROQ_API_KEY` and `AUTH_TOKEN` are read with `?` — the
process exits without them. The optional ones are all `.ok()` and can't do
this.

**Entries fail to parse, or the row retries and gives up.** Usually Groq
rate limiting. Wait a minute; check the Render logs for a 429, and the key at
console.groq.com. A failed entry keeps your typed sentence — retrying is a
tap, and nothing is lost if you close the tab mid-request.

**Nutrition numbers look invented.** They are — the USDA `DEMO_KEY` is
exhausted. Get your own key.

**The frontend didn't change after you pushed.** It doesn't deploy on push
under Option A. Run `scripts/deploy-frontend.sh`.

## Stack

- `backend/` — Rust, Axum, sqlx, PostgreSQL. One Docker image, built by Render
  from `backend/Dockerfile`. Migrations run on boot.
- `frontend/` — React 19, TypeScript, Vite, hand-written CSS, no UI library
  and no animation library. Builds to static files.
- Parsing — Groq tool calling with `tool_choice: "required"`, three models
  tried in order.
- Voice — Groq `whisper-large-v3-turbo`, then `openai/gpt-oss-20b` to tidy the
  transcript.
- Nutrition — USDA FoodData Central search API.
