SELECT json_object(
  'generated', strftime('%Y-%m-%dT%H:%M:%SZ','now'),
  'monitors', (SELECT json_group_array(json_object(
      'id', m.id, 'name', TRIM(m.name), 'url', m.url, 'type', m.type,
      'interval', m.interval, 'active', m.active,
      'last_status', h.status, 'last_time', h.time, 'last_msg', h.msg,
      'cert_valid_to', json_extract(t.info_json,'$.certInfo.validTo'),
      'cert_days', json_extract(t.info_json,'$.certInfo.daysRemaining')))
    FROM monitor m
    LEFT JOIN heartbeat h ON h.id = (SELECT MAX(id) FROM heartbeat WHERE monitor_id = m.id)
    LEFT JOIN monitor_tls_info t ON t.monitor_id = m.id),
  'hourly', (SELECT json_group_array(json_array(monitor_id, timestamp, up, down, ROUND(ping,1)))
    FROM stat_hourly WHERE timestamp >= CAST(strftime('%s','now','-8 days') AS INTEGER)),
  'transitions', (SELECT json_group_array(json_array(monitor_id, time, status, msg)) FROM (
    SELECT monitor_id, time, status, msg,
           LAG(status) OVER (PARTITION BY monitor_id ORDER BY time) AS prev
    FROM heartbeat WHERE time >= datetime('now','-5 days'))
    WHERE prev IS NULL OR prev != status)
);
