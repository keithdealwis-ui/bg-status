// Daily uptime report for the 07:00 email.
//   GET /api/report               rendered HTML
//   GET /api/report?format=json   template data
//   GET /api/report?format=email  { subject, preheader, html } for the sender
//   &end=<ISO>                    override the window end (testing)
// A missing or stale snapshot still renders: the report then says "unknown".
import { head } from '@vercel/blob';
import { buildReport } from '../lib/report.mjs';
import { render } from '../lib/render.mjs';

async function loadRaw() {
  try {
    const meta = await head('report-raw.json');
    const r = await fetch(`${meta.downloadUrl}&_=${Date.now()}`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const now = new Date();
  const end = req.query.end ? new Date(req.query.end) : undefined;
  if (end && isNaN(end)) return res.status(400).json({ error: 'bad end' });

  const data = buildReport(await loadRaw(), now, end);
  res.setHeader('Cache-Control', 'no-store');

  if (req.query.format === 'json') return res.status(200).json(data);
  const html = render(data);
  if (req.query.format === 'email') {
    return res.status(200).json({ subject: data.subject, preheader: data.preheader, html });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}
