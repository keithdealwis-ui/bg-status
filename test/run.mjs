// Local checks: node test/run.mjs <outdir>
// Renders the template's own samples, the real snapshot, a Monday window,
// a synthetic incident day and both "monitoring unavailable" paths.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { buildReport, duration, reportEnd } from '../lib/report.mjs';
import { render } from '../lib/render.mjs';

const out = process.argv[2] || '.';
const raw = JSON.parse(fs.readFileSync('test/raw-2026-10-29.json', 'utf8'));
const snap = new Date(raw.generated);
const now = new Date(snap.getTime() + 60e3);
const write = (name, data) => {
  fs.writeFileSync(`${out}/${name}.json`, JSON.stringify(data, null, 1));
  fs.writeFileSync(`${out}/${name}.html`, render(data));
};

// Formatting rules from the template README.
assert.equal(duration(42), '42s');
assert.equal(duration(362), '6m 02s');
assert.equal(duration(3 * 3600 + 25 * 60), '3h 25m');
// 07:00 UK in GMT and in BST.
assert.equal(reportEnd(new Date('2026-10-29T08:18:00Z')).toISOString(), '2026-10-29T07:00:00.000Z');
assert.equal(reportEnd(new Date('2026-10-22T06:30:00Z')).toISOString(), '2026-10-22T06:00:00.000Z');
assert.equal(reportEnd(new Date('2026-10-22T05:59:00Z')).toISOString(), '2026-10-21T06:00:00.000Z');

for (const s of ['sample-data', 'sample-data-down', 'sample-data-monitor-failure']) {
  const d = JSON.parse(fs.readFileSync(`test/${s}.json`, 'utf8'));
  d.logo_url = 'https://bg-status.vercel.app/email/logo-white.png';
  fs.writeFileSync(`${out}/${s}.html`, render(d));
}

// Today, real data.
const today = buildReport(raw, now);
assert.equal(today.groups.flatMap(g => g.pages).length, 3, 'Spotify and self-test excluded');
assert.ok(!JSON.stringify(today).includes('Spotify'));
write('real-today', today);

// Monday window (72h).
const mon = buildReport(raw, now, new Date('2026-10-26T07:00:00Z'));
assert.match(mon.window_label, /72 hours/);
write('real-monday', mon);

// Synthetic incidents on monitor 1: a retried blip and an outage still open.
const inc = structuredClone(raw);
inc.transitions.push(
  [1, '2026-10-29 02:14:08.000', 2, 'timeout of 48000ms exceeded'],
  [1, '2026-10-29 02:15:08.000', 1, '200 - OK, keyword is found'],
  [3, '2026-10-29 05:40:11.000', 2, 'connect ECONNREFUSED'],
  [3, '2026-10-29 05:42:11.000', 0, 'connect ECONNREFUSED'],
);
inc.transitions.sort((a, b) => a[1] < b[1] ? -1 : 1);
inc.monitors.find(m => m.id === 3).last_status = 0;
const h = inc.hourly.find(r => r[0] === 1 && r[1] === Date.parse('2026-10-29T02:00:00Z') / 1000);
h[2] -= 2; h[3] += 2;
const d = buildReport(inc, now);
assert.equal(d.incident_list.length, 2);
assert.ok(d.incident_list[0].ongoing, 'ongoing first');
assert.ok(d.down_now.length === 1 && d.stats[1].alert);
assert.notEqual(d.stats[0].value, '100.00%', 'strict uptime counts retried failures');
write('synthetic-incidents', d);

// Monitoring unavailable: no snapshot, and a stale one.
const none = buildReport(null, now);
assert.ok(none.pages_nodata && none.data_warning && !none.freshness.monitor_ok);
write('nodata-missing', none);
const stale = buildReport(raw, new Date(snap.getTime() + 40 * 60e3));
assert.ok(stale.pages_nodata && /40 minutes/.test(stale.data_warning));
write('nodata-stale', stale);

console.log('all checks passed');
