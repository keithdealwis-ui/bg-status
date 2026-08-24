// Receives status JSON from the monitoring box and stores it in Vercel Blob.
// Auth: Authorization: Bearer <PUSH_SECRET> (env var, set in Vercel project).
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
  if (!body || !Array.isArray(body.monitors)) {
    return res.status(400).json({ error: 'expected { generated, monitors: [...] }' });
  }

  // Stamp server-side receipt time so staleness detection cannot be spoofed
  // by a pusher with a wrong clock.
  const doc = { ...body, received: new Date().toISOString() };

  await put('status.json', JSON.stringify(doc), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: 'application/json',
  });

  return res.status(200).json({ ok: true });
}
