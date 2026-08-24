#!/usr/bin/env bash
# Pushes current Uptime Kuma status to the public status page.
# Runs on the BG monitoring box via systemd timer (bg-status-push.timer).
# Config: /opt/bg-monitoring/push-status.env  (PUSH_URL, PUSH_SECRET; mode 600)
set -euo pipefail

source /opt/bg-monitoring/push-status.env

# Monitor 4 is an internal self-test target, never published.
JSON=$(docker exec uptime-kuma sqlite3 /app/data/kuma.db "
SELECT json_object(
  'generated', strftime('%Y-%m-%dT%H:%M:%SZ','now'),
  'monitors', json_group_array(json_object(
    'id', m.id,
    'name', TRIM(m.name),
    'status', h.status,
    'ping', h.ping,
    'uptime24h', u.pct,
    'time', h.time
  ))
)
FROM monitor m
JOIN heartbeat h ON h.id = (SELECT MAX(id) FROM heartbeat WHERE monitor_id = m.id)
LEFT JOIN (
  SELECT monitor_id,
         ROUND(SUM(status=1)*100.0 / NULLIF(SUM(status IN (0,1)),0), 2) AS pct
  FROM heartbeat
  WHERE time >= datetime('now','-1 day')
  GROUP BY monitor_id
) u ON u.monitor_id = m.id
WHERE m.active = 1 AND m.id != 4;
")

curl -sf -X POST \
  -H "Authorization: Bearer ${PUSH_SECRET}" \
  -H "Content-Type: application/json" \
  --data "${JSON}" \
  --max-time 20 \
  "${PUSH_URL}/api/push" > /dev/null
