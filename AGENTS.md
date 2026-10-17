# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` imports this file, so edit this one.

## What this is

NamelessTelemetry is a single Cloudflare Worker (`worker.js`) backed by one KV namespace (binding `TELEMETRY`). It collects anonymous daily per-project counts and serves a dashboard. There is no build step, no bundler, and no dependencies. See [USAGE.md](<./USAGE.md>) for the public API and client conventions.

## Layout

- `worker.js`: everything. Routing in `fetch`, then `handleCensus` (ingest), `buildStats` (aggregation), `cached` (2-minute edge cache for the dashboard and `/api/stats`), `withinRateLimit` (per-IP limit on `/census`), `renderHtml` (dashboard with inline CSS/JS and a hand-written canvas chart), `maybeCleanupOldCounts` (daily sweep: prunes old counts, then `recountDay` repairs recent counts from `seen:` keys).
- `wrangler.toml`: Worker config, production routes, KV binding, `CENSUS_RATE_LIMITER` binding.
- `test/worker.test.mjs`: dependency-free tests (`node:test` + in-memory KV mock with a controllable clock).
- `.mega-linter.yml`, `.github/workflows/mega-linter.yml`: CI lint (MegaLinter, auto-fix on).
- `.github/workflows/test.yml`: CI test run.

## Commands

- Local dev: `npx wrangler dev`
- Deploy: `npx wrangler deploy`. Deploys to production domains, so don't run it unless asked.
- Lint: JavaScript follows `standard` style (2 spaces, no semicolons, space before function parens). Check with `npx standard worker.js test/`.
- Test: `node --test test/worker.test.mjs`. Add a test when changing ingest, stats, or maintenance behavior.

## Rules

- **Privacy first.** Never add fields that could identify a user (IPs, user agents, hostnames, raw IDs) to storage or responses. The client IP is used only as the in-memory rate-limiter key. The only stored identifier is the client-supplied SHA-256 hash, kept in short-lived `seen:` keys.
- **Keep it dependency-free.** No npm packages in the Worker, and no external scripts/CDNs in the dashboard. The chart is drawn by hand on purpose.
- **Keep the API stable.** `/census` accepts `id` plus `project` or `projectname` (or the `X-Project-Name` header), replies `204` for any valid JSON body (counted or dropped; `429` when rate limited, `500` only on misconfiguration), and ignores client `date`. `/api/stats` returns `{ projects, totals, days }`. Existing clients depend on all of this.
- **Write counts through `putCount`.** It sets the expiry and mirrors the count into key metadata, which `buildStats` reads to avoid a `get` per key.
- **Mind KV limits.** Each invocation gets a capped number of KV operations, and KV has no atomic increment. Prefer listing with metadata over per-key reads, and keep writes low.
- **KV key formats** (`seen:<date>:<project>:<id>`, `counts:<date>:<project>`) are persisted data. Changing them needs a migration story.
- Dates are always UTC `YYYY-MM-DD`.
- Escape all user-controlled strings (project names) with the `esc` helper before putting them in HTML or SVG.
- Every source file starts with the NNCL license header. Keep it, and add it to new source files.
- Update `USAGE.md` when behavior, parameters, or endpoints change.
