# Using NamelessTelemetry

This guide covers how to report usage from your project, how to read the collected numbers, and how to run your own instance.

## Reporting from a project

Send a `POST` to `/census` with a small JSON body. Hosted endpoint: `https://telemetry.namelessnanashi.dev/census`

```json
{
  "id": "<64-char lowercase SHA-256 hex of a random per-install UUID>",
  "project": "MyProject"
}
```

| Field                   | Required | Notes                                                                                                   |
|-------------------------|----------|---------------------------------------------------------------------------------------------------------|
| `id`                    | yes      | SHA-256 hex (64 chars). Used only for per-day dedupe. Any other format is accepted but **not counted**. |
| `project`/`projectname` | yes      | Project name, trimmed, max 100 chars. Can also be sent via the `X-Project-Name` header (header wins).   |
| `date`, `count`         | no       | Ignored. The server always uses the current UTC day and counts each `id` once per day.                  |

Responses:

| Status | When                                                                                                          |
|--------|---------------------------------------------------------------------------------------------------------------|
| `204`  | Any valid JSON body, whether it was counted or dropped, so clients can't probe what's stored.                 |
| `400`  | Body is not valid JSON.                                                                                       |
| `429`  | Over the per-IP rate limit (60 requests/minute). Has `Retry-After: 60`. Drop the ping; don't retry in a loop. |
| `415`  | `Content-Type` does not include `application/json`.                                                           |
| `500`  | Server misconfigured (KV not bound) or an unexpected error. Clients should ignore it like any other failure.  |

Pings are dropped (still `204`) when the project name is empty or on the denylist (`Project`, `ExampleProject`, `<PROJECT_NAME>`), so pick a real name. CORS is open (`*`), so browser clients work too.

### Generating the `id`

Generate a random UUID once per install, store it locally, and send only its SHA-256 hash. Never send hardware IDs, usernames, IPs, or anything personally identifying. Hash the UUID string exactly as stored (no trailing newline) so the hash stays stable across restarts.

### Client conventions

Clients should follow these so users get consistent behavior across projects:

- **Opt-out:** skip sending when `TELEMETRY_OPTOUT` or a project-specific `<ACRONYM>_TELEMETRY_OPTOUT` is truthy (`1`, `true`, `yes`, `on`), or when `TELEMETRY` is falsy (`0`, `false`, `no`, `off`).
- **Endpoint override:** respect `TELEMETRY_ENDPOINT`.
- **Fail silently** with a short timeout (~2s), off the main thread if possible.
- **Frequency:** once at startup, and for long-running services periodically (e.g. every few hours). Extra pings on the same UTC day are free; they're deduped.
- Document the telemetry and the opt-out in your project's README.

These conventions live in the clients. The server can't see or enforce them.

## Reading the data

### Dashboard

`GET /`: chart of daily counts.

- `?project=<name>`: one project only (exact, case-sensitive match).
- `?range=7d|30d|90d|180d|365d|1y` or `?days=7..365`: timeframe (default 7 days).

Example: <https://telemetry.namelessnanashi.dev/?project=MyProject&range=30d>

### JSON API

`GET /api/stats` takes the same `project` and `range`/`days` parameters.

```json
{
  "projects": { "MyProject": { "2026-10-15": 42, "2026-10-16": 40 } },
  "totals": { "2026-10-15": 42, "2026-10-16": 40 },
  "days": ["2026-10-10", "...", "2026-10-16"]
}
```

Days with no pings are missing from `projects`/`totals`; treat missing as `0`.

The dashboard and `/api/stats` are edge-cached for 2 minutes (`Cache-Control: public, max-age=120`), so new pings can take up to 2 minutes to show. The cache key uses only `project` and the resolved number of days, so `?range=30d` and `?days=30` share an entry and extra query parameters don't bypass it.

### How accurate are the numbers?

Treat them as estimates, not exact figures:

- **No authentication.** Anyone can post to `/census`, so a project's count can be inflated by sending many different hashes. The per-IP rate limit slows this down but can't stop it, and there's no way to tell fake hashes from real installs.
- **Today's count is provisional.** KV has no atomic increment, so pings arriving at the same moment can lose or double an update. Once a day (after 01:00 UTC) the worker recounts the last few finished days from the dedupe markers and corrects them, so finished days are accurate once that pass has run.
- Opted-out, offline, and firewalled installs are never counted.

## Self-hosting

Requires a Cloudflare account and [Wrangler](<https://developers.cloudflare.com/workers/wrangler/>).

1. Create a KV namespace: `npx wrangler kv namespace create TELEMETRY`
2. In `wrangler.toml`, replace the `kv_namespaces` `id` with yours, and change or remove the `routes` (they point at `namelessnanashi.dev`). For a quick test, set `workers_dev = true`.
3. Optionally edit `PROJECT_DENYLIST` and the footer links/site text in `worker.js`.
4. Run locally: `npx wrangler dev`. Deploy: `npx wrangler deploy`.
5. Point clients at your instance with `TELEMETRY_ENDPOINT=https://<your-host>/census`.

### Limits and abuse

- **KV write quota.** Cloudflare's free plan allows 1,000 KV writes per day. Each new install per project per day costs 2 writes (dedupe marker + count), plus a few for daily maintenance, so the free plan tops out around 500 unique install-days per day across all projects. Pings past the quota fail silently and aren't counted. The free plan also allows 1,000 KV list operations per day, and each uncached dashboard or `/api/stats` view uses at least one. The 2-minute edge cache keeps repeat views free. (The Cache API only works on a custom domain or route, not on `workers.dev`.) The paid Workers plan raises these limits.
- **Rate limiting.** `POST /census` is limited to 60 requests per minute per IP by the `CENSUS_RATE_LIMITER` binding in `wrangler.toml` ([Workers Rate Limiting](<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>)). That stops floods while leaving room for many installs sharing one IP. The limit is checked before any KV access, so rejected requests cost no KV quota. Counters are per Cloudflare location and approximate. The IP is passed only to Cloudflare's in-memory limiter and is never stored. Change `limit` (and `period`, 10 or 60 seconds) to tune it, or remove the block to disable limiting. `namespace_id` must be unique per rate limiter in your account.

### Storage layout (KV)

| Key                          | Value                                    | Expiry                  |
|------------------------------|------------------------------------------|-------------------------|
| `seen:<date>:<project>:<id>` | `1`                                      | 10 days                 |
| `counts:<date>:<project>`    | daily count (also in metadata `{count}`) | ~366 days after the day |
| `maintenance:lastCleanupAt`  | UTC date                                 | 3 days                  |

Daily maintenance runs on the first request after 01:00 UTC each day (the delay lets late pings from the previous day settle in KV first). It deletes `counts:` keys older than 365 days and recounts the last 3 finished days from their `seen:` keys.
