// Receives the raw daily-report snapshot (box/report.sql) from the monitoring box.
// Auth: same bearer secret as /api/push.
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const auth = req.headers['authorization'] || '';
  const secret = process.env.PUSH_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body;
  if (!body || !Array.isArray(body.monitors) || !Array.isArray(body.hourly) || !Array.isArray(body.transitions)) {
    return res.status(400).json({ error: 'expected { generated, monitors, hourly, transitions }' });
  }

  // Server-side receipt time: the report treats an old snapshot as "unknown".
  const doc = { ...body, received: new Date().toISOString() };

  await put('report-raw.json', JSON.stringify(doc), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: 'application/json',
  });

  return res.status(200).json({ ok: true });
}
