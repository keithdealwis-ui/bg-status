// Serves the latest pushed status JSON to the public page.
// Reads from Blob server-side so the browser never fights CDN caching.
import { head } from '@vercel/blob';

export default async function handler(req, res) {
  try {
    const meta = await head('status.json');
    const r = await fetch(`${meta.downloadUrl}&_=${Date.now()}`, { cache: 'no-store' });
    const doc = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(doc);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ monitors: [], received: null, error: 'no data yet' });
  }
}
