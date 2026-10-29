# bg-status

Public status page for Benson Goldstein monitored endpoints, hosted on Vercel.

## Architecture

Uptime Kuma runs on BG's EC2 box bound to localhost only (deliberate — see the
14 Aug 2026 monitoring decision). Nothing public reaches into that box. Instead:

```
EC2 (Kuma, kuma.db) --every 60s--> POST /api/push (Bearer PUSH_SECRET)
                                        └─> Vercel Blob (status.json)
Browser --> / (index.html) --> GET /api/status --> Blob --> render
```

- **Push model** — the box pushes out; no inbound port is opened on client infra.
- **Dead-man's switch** — if pushes stop for >5 minutes the page shows a stale
  warning instead of silently showing the last green state.
- Monitor 4 (internal self-test) is excluded from the feed.

## Components

| Path | Runs | Purpose |
|---|---|---|
| `index.html` | Vercel static | Public status page |
| `api/push.js` | Vercel function | Auth'd ingest, writes Blob |
| `api/status.js` | Vercel function | Serves latest JSON, no-store |
| `box/push-status.sh` | EC2 | Reads kuma.db, POSTs JSON |
| `box/bg-status-push.{service,timer}` | EC2 systemd | Every 60s |
| `api/push-report.js` | Vercel function | Auth'd ingest of the daily-report snapshot |
| `api/report.js` | Vercel function | Daily uptime email: HTML, `?format=json` or `?format=email` |
| `lib/report.mjs` | Vercel | Builds the email data; page list and exclusions live here |
| `email/` | Vercel static | Email template (Handlebars) and hosted logo |
| `box/push-report.sh`, `box/report.sql` | EC2 | Raw snapshot from kuma.db |
| `box/bg-report-push.{service,timer}` | EC2 systemd | Every 5 min |

## Vercel project env

- `PUSH_SECRET` — shared bearer secret; same value in `/opt/bg-monitoring/push-status.env` on the box.
- Blob store must be connected to the project (provides `BLOB_READ_WRITE_TOKEN`).

## Rotating the secret

Generate a new value, update the Vercel env var, redeploy, update
`push-status.env` on the box. The box copy is readable by BG's AWS admins via
SSM — the secret is deliberately low-value (it only allows posting status JSON).

## Daily uptime email

Sent Mon–Fri at 07:00 UK from keith@bensongoldstein.com by a Claude scheduled
routine (Composio Outlook), which fetches `/api/report?format=email` and sends
the HTML unchanged. Mondays cover Friday 07:00 to Monday 07:00.

- **Strict uptime.** Kuma's hourly stats count retried failures (PENDING) as
  down, so a blip that never alerted still costs uptime. The public status
  page does not; the two can disagree.
- **Incidents** come from heartbeat status transitions. Kuma keeps raw beats for
  about 29 hours, so on Mondays an older blip that never reached DOWN shows only
  as a failed-check count, and older outages start at the DOWN beat.
- **Slow** is 3x the monitor's 7-day median hourly response, never below 1s.
- **Unknown, never healthy.** No snapshot, or one older than 15 minutes, renders
  the "monitoring unavailable" version — the email still goes out.
- Excluded: monitor 2 (Spotify LP, taken down) and 4 (self-test). Any new Kuma
  monitor not listed in `PAGES` appears under "Other".

Check locally: `node test/run.mjs <outdir>`.
