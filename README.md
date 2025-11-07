# NamelessTelemetry

NamelessTelemetry is a minimalist, privacy-first telemetry service that records anonymous, per-project daily counts and presents them on a small dark-mode dashboard. It runs entirely on Cloudflare Workers with KV storage.

## Overview

- Anonymous census: daily counts per project, using UTC days.
- Per-day deduplication by `(date, project, id)` where `id` is SHA-256 hex.
- No personal data: hashed IDs are used solely for dedupe.
- Responsive chart UI with timeframe selection (7 days to 1 year).

## Data lifecycle

- `seen:` entries expire after ~10 days (dedupe markers).
- `counts:` entries automatically expire a little over one year after their day; a daily background sweep also removes legacy data older than one year.

## Domains

- Dashboard is available at: <https://telemetry.namelessnanashi.dev/> and <https://census.namelessnanashi.dev/>

## License & Credits

See [LICENSE.md](<./LICENSE.md>).

[All Major Contributors](<./CONTRIBUTORS.md>)

[All Other Contributors](<https://github.com/NanashiTheNameless/NamelessTelemetry/graphs/contributors>)
