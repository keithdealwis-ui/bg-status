#!/usr/bin/env bash
# Pushes the raw snapshot behind the daily uptime email (see lib/report.mjs).
# Runs on the BG monitoring box via systemd timer (bg-report-push.timer).
# Config: /opt/bg-monitoring/push-status.env  (PUSH_URL, PUSH_SECRET; mode 600)
set -euo pipefail

source /opt/bg-monitoring/push-status.env

JSON=$(docker exec -i uptime-kuma sqlite3 /app/data/kuma.db < /opt/bg-monitoring/report.sql)

curl -sf -X POST \
  -H "Authorization: Bearer ${PUSH_SECRET}" \
  -H "Content-Type: application/json" \
  --data-binary "${JSON}" \
  --max-time 30 \
  "${PUSH_URL}/api/push-report" > /dev/null
