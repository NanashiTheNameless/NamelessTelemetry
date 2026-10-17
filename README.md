# NamelessTelemetry [![Ask DeepWiki](<https://deepwiki.com/badge.svg>)](<https://deepwiki.com/NanashiTheNameless/NamelessTelemetry>)

NamelessTelemetry is a minimalist, privacy-first telemetry service that records anonymous, per-project daily counts and presents them on a small dark-mode dashboard. It runs entirely on Cloudflare Workers with KV storage.

## Overview

- Anonymous census: daily counts per project, using UTC days.
- Per-day deduplication by `(date, project, id)` where `id` is SHA-256 hex.
- No personal data: hashed IDs are used solely for dedupe.
- Responsive chart UI with timeframe selection (7 days to 1 year).

## Usage

See [USAGE.md](<./USAGE.md>) for how to report from a project, query the data, and self-host.

## Data lifecycle

- `seen:` entries expire after ~10 days (dedupe markers).
- `counts:` entries automatically expire a little over one year after their day. A daily background pass (after 01:00 UTC) removes data older than one year and recounts the last 3 finished days from the dedupe markers to correct any lost or doubled increments.

## Domains

- Dashboard is available at: <https://telemetry.namelessnanashi.dev/> (and <https://census.namelessnanashi.dev/>)

## License & Credits

See [LICENSE.md](<./LICENSE.md>).

[All Major Contributors](<./CONTRIBUTORS.md>)

[All Other Contributors](<https://github.com/NanashiTheNameless/NamelessTelemetry/graphs/contributors>)
