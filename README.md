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

## Vercel project env

- `PUSH_SECRET` — shared bearer secret; same value in `/opt/bg-monitoring/push-status.env` on the box.
- Blob store must be connected to the project (provides `BLOB_READ_WRITE_TOKEN`).

## Rotating the secret

Generate a new value, update the Vercel env var, redeploy, update
`push-status.env` on the box. The box copy is readable by BG's AWS admins via
SSM — the secret is deliberately low-value (it only allows posting status JSON).
