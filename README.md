# life

Personal logging app. One text input, LLM parsing into structured entries,
a clean daily timeline. Tracks nutrition and people met.

Live at https://ojasprabhune.github.io/lifefolders

This is an independent deployment (detached fork) of
[tejasprabhune/life](https://github.com/tejasprabhune/life), running on
this account's own free-tier services instead of Fly.io.

## How it works

Type anything ("2 rotis with dal", "met Alex at the coffee shop"). The
backend sends it to Groq with two tool definitions; the model picks
log_nutrition or log_person and fills the fields. Nutrition entries are
grounded against the USDA FoodData Central database and scaled to the
stated portion. Entries without a clean USDA match keep the model's
estimates and a null usda_fdc_id.

## Stack

- backend/: Rust, Axum, sqlx, PostgreSQL. Deployed on Render's free tier
  (lifefolders-api.onrender.com) via the render.yaml blueprint, backed by
  a free Neon Postgres database.
- frontend/: React, TypeScript, Vite, vanilla CSS. Built locally and
  copied as static files into the sibling `dotfolders` repo
  (ojasprabhune.github.io) under `lifefolders/` — see Deploy below.
  `.github/workflows/pages.yml` is left over from the upstream repo and
  is unused here.
- Parsing: Groq (openai/gpt-oss-120b, falls back to
  llama-3.3-70b-versatile), tool calls with required choice.
- Nutrition data: USDA FoodData Central search API.

## Development

Backend (needs a local Postgres):

    brew install postgresql@16
    initdb -D /tmp/lifepg -U life --auth=trust
    pg_ctl -D /tmp/lifepg -o "-p 5433" start
    createdb -h 127.0.0.1 -p 5433 -U life life

    cd backend
    cp .env.example .env   # fill in GROQ_API_KEY, DATABASE_URL
    cargo run --bin life-api   # runs the migrations itself on boot

Docker works too (`postgres:16-alpine` on 5433) but isn't needed for anything
here — Render builds the image in the cloud from the Dockerfile, so nothing
about deploying requires a local daemon.

Test the parse loop:

    cargo run --bin life-cli -- "a banana"
    cargo run --bin life-cli -- --list

Frontend (proxies to localhost:8080 via .env.development):

    cd frontend
    npm install
    npm run dev

## Deploy

Backend: `git push origin main`. Render watches this repo and rebuilds
`backend/` from its Dockerfile automatically (a couple minutes, free
tier, sleeps after 15 min idle). Secrets (DATABASE_URL, GROQ_API_KEY,
USDA_API_KEY, AUTH_TOKEN) are set once in the Render dashboard, not in
git.

Frontend: run `scripts/deploy-frontend.sh`. It builds `frontend/`
against the Render API URL, copies the output into
`../dotfolders/lifefolders/`, and commits + pushes that repo. Nothing
rebuilds this automatically — rerun the script after any frontend
change.

## USDA API key

The app ships with DEMO_KEY, which is rate limited per IP and often
exhausted on shared egress IPs. Grounding then falls back to model
estimates. For reliable grounding, get a free key at
https://fdc.nal.usda.gov/api-key-signup.html and set it as the
USDA_API_KEY env var in the Render dashboard.
