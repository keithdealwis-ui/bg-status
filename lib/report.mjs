// Builds the daily uptime report data (email/bg-uptime-report.hbs.html) from the
// raw snapshot the box pushes (box/report.sql). Every value is computed and
// formatted here; the template only uses `if` and `each`.
//
// Uptime is strict: Kuma's hourly stats count PENDING (failed, being retried)
// as down, so a short outage that never alerted still costs uptime.

const TZ = 'Europe/London';
const REPORT_HOUR = 7;            // report window ends at 07:00 UK
const STALE_MINUTES = 15;         // snapshot older than this = monitoring unavailable
const SLOW_FACTOR = 3;            // slow = 3x the 7-day median hourly response...
const SLOW_FLOOR_MS = 1000;       // ...but never below 1s, so 15 ms sites don't flap
const CERT_WARN_DAYS = 21;
const STATUS_URL = 'https://bg-status.vercel.app';
const LOGO_URL = `${STATUS_URL}/email/logo-white.png`;

// Monitors published in the report. Anything in Kuma that is neither listed
// nor excluded is shown under "Other" rather than silently dropped.
const PAGES = [
  { id: 1, group: 'Make Your Claim', name: 'Home' },
  { id: 3, group: 'Benson Goldstein', name: 'Main site' },
  { id: 5, group: 'Benson Goldstein', name: 'Lead ingestion API',
    caveat: 'Status-code check only; the API has no health endpoint yet' },
];
const EXCLUDED = new Set([
  2, // MYC Spotify LP, taken down by BG (Keith, 29 Oct 2026)
  4, // internal self-test target
]);

const UP = 1, DOWN = 0, PENDING = 2;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Kuma stores heartbeat times as UTC 'YYYY-MM-DD HH:MM:SS.sss'.
const kumaTime = s => new Date(s.replace(' ', 'T') + 'Z');

function londonParts(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]));
  return p;
}
const hhmm = d => { const p = londonParts(d); return `${p.hour}:${p.minute}`; };
const dayKey = d => { const p = londonParts(d); return `${p.year}-${p.month}-${p.day}`; };
const fmt = (d, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts }).format(d);

// "02:14" on the report day, "Sun 02:14" on any other day.
function when(d, end) {
  return dayKey(d) === dayKey(end) ? hhmm(d) : `${fmt(d, { weekday: 'short' })} ${hhmm(d)}`;
}

// README rule 3: under 60 s "Ns", under an hour "Nm NNs", otherwise "Nh Nm".
export function duration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const ms = v => `${Math.round(v).toLocaleString('en-GB')} ms`;
// Floor, not round: 99.996% must not display as 100.00.
const pct = (up, total) => (Math.floor((up / total) * 10000) / 100).toFixed(2);

// The most recent 07:00 UK at or before `now`. Searches back by the hour so it
// is correct across the clock change without a timezone library.
export function reportEnd(now) {
  const t = new Date(Math.floor(now.getTime() / 3600e3) * 3600e3);
  for (let i = 0; i < 48; i++, t.setTime(t.getTime() - 3600e3)) {
    const p = londonParts(t);
    if (Number(p.hour) === REPORT_HOUR && p.minute === '00') return new Date(t);
  }
  throw new Error('no 07:00 found in the last 48h');
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Runs of failed beats (DOWN or PENDING) per monitor, from status transitions.
function incidentRuns(transitions) {
  const runs = [];
  let open = null;
  for (const [, time, status, msg] of transitions) {
    const t = kumaTime(time);
    if (status === UP) {
      if (open) { open.end = t; runs.push(open); open = null; }
    } else if (status === DOWN || status === PENDING) {
      if (!open) open = { start: t, end: null, msg, alerted: false };
      if (status === DOWN && !open.alerted) { open.alerted = true; open.msg = msg; }
    }
  }
  if (open) runs.push(open);
  return runs;
}

function nodataReport(base, warning, monitorAt) {
  return {
    ...base,
    preheader: 'Incomplete: monitoring data unavailable this morning.',
    subject: `BG uptime, ${base.short_date}: monitoring unavailable`,
    data_warning: warning,
    stats: ['Uptime, all pages', 'Pages up now', 'Incidents', 'Total downtime']
      .map(label => ({ label, nodata: true })),
    summary_html: 'Monitoring could not be read this morning, so there is no uptime picture today. '
      + 'Nothing below should be read as the pages being healthy.',
    pages_nodata: true,
    groups: [],
    incident_list: [],
    expiring: [],
    freshness: { monitor_ok: false, monitor_at: monitorAt, generated_at: base.freshness.generated_at },
  };
}

// raw: the pushed snapshot (with server-side `received`), or null.
// now: generation time. end: override for the window end (testing).
export function buildReport(raw, now = new Date(), end = reportEnd(now)) {
  const isMonday = fmt(end, { weekday: 'long' }) === 'Monday';
  const hours = isMonday ? 72 : 24;
  const start = new Date(end.getTime() - hours * 3600e3);
  const bucketHours = hours / 24;
  const genAt = `${fmt(now, { weekday: 'short', day: 'numeric', month: 'short' })}, ${hhmm(now)} UK`;

  const base = {
    is_sample: false,
    report_date: fmt(end, { weekday: 'long', day: 'numeric', month: 'long' }),
    short_date: fmt(end, { weekday: 'short', day: 'numeric', month: 'short' }),
    window_label: isMonday
      ? 'The 72 hours from Friday 07:00 to Monday 07:00 UK time, from Uptime Kuma'
      : 'The 24 hours to 07:00 UK time, from Uptime Kuma',
    logo_url: LOGO_URL,
    cta_url: STATUS_URL,
    cta_label: 'Open the status page',
    pages_caption: `Last ${hours} hours. Uptime is the share of checks that passed, counting retried failures as down; response is the average.`,
    strip_legend: isMonday
      ? 'Each bar is three hours, Friday 07:00 on the left. Green all checks passed, orange some failed or slow, red down, grey no data.'
      : 'Each bar is one hour, 07:00 yesterday on the left. Green all checks passed, orange some failed or slow, red down, grey no data.',
    expiring_caption: `SSL certificates inside the ${CERT_WARN_DAYS}-day warning window. Domain expiry is not monitored.`,
    freshness: { generated_at: genAt },
  };

  // README rule 1: a missing or stale snapshot means "unknown", never "healthy".
  if (!raw || !Array.isArray(raw.monitors)) {
    return nodataReport(base, 'The monitoring box has not sent any data, so the health of every page below is unknown rather than healthy. Check the status page directly.', 'Unavailable');
  }
  const received = new Date(raw.received || raw.generated);
  const ageMin = (now - received) / 60e3;
  if (!(ageMin <= STALE_MINUTES)) {
    return nodataReport(base, `The monitoring box last reported at ${when(received, end)} UK, ${Math.round(ageMin)} minutes before this report, so the health of every page below is unknown rather than healthy. Check the status page directly.`, 'Unavailable');
  }

  const startS = start.getTime() / 1000, endS = end.getTime() / 1000;
  const hourly = raw.hourly || [];
  const byMonitor = id => hourly.filter(r => r[0] === id);
  const trans = raw.transitions || [];
  const warnings = [];

  const listed = new Map(PAGES.map(p => [p.id, p]));
  const pages = [];
  for (const m of raw.monitors) {
    if (EXCLUDED.has(m.id)) continue;
    const cfg = listed.get(m.id) || { id: m.id, group: 'Other', name: m.name };
    pages.push({ cfg, m });
  }

  const allIncidents = [];
  let totUp = 0, totDown = 0, totDowntime = 0;
  const built = pages.map(({ cfg, m }) => {
    const rows = byMonitor(m.id);
    const inWin = rows.filter(r => r[1] >= startS && r[1] < endS);
    const up = inWin.reduce((a, r) => a + r[2], 0);
    const down = inWin.reduce((a, r) => a + r[3], 0);
    totUp += up; totDown += down;

    const baseline = median(rows.filter(r => r[1] < endS && r[1] >= endS - 7 * 86400 && r[2] > 0).map(r => r[4]));
    const slowMs = baseline == null ? Infinity : Math.max(SLOW_FACTOR * baseline, SLOW_FLOOR_MS);
    const pingW = inWin.reduce((a, r) => a + r[4] * r[2], 0);
    const avg = up ? pingW / up : null;

    // Hourly strip, oldest first.
    const strip = [];
    let slowHours = 0;
    for (let b = 0; b < 24; b++) {
      const bs = startS + b * bucketHours * 3600, be = bs + bucketHours * 3600;
      const rs = inWin.filter(r => r[1] >= bs && r[1] < be);
      const bu = rs.reduce((a, r) => a + r[2], 0), bd = rs.reduce((a, r) => a + r[3], 0);
      const slow = rs.filter(r => r[2] > 0 && r[4] > slowMs).length;
      slowHours += slow;
      if (!rs.length || bu + bd === 0) strip.push({ nodata: true });
      else if (bu === 0) strip.push({ down: true });
      else if (bd > 0 || slow) strip.push({ partial: true });
      else strip.push({ up: true });
    }

    // Incidents overlapping the window.
    const runs = incidentRuns(trans.filter(t => t[0] === m.id))
      .filter(r => r.start < end && (r.end == null || r.end > start));
    const snapAt = new Date(raw.generated);
    const label = cfg.group === 'Other' ? cfg.name : `${cfg.group}, ${cfg.name.toLowerCase()}`;
    let pageDowntime = 0;
    for (const r of runs) {
      const s = Math.max(r.start, start), e = Math.min(r.end ?? snapAt, end);
      const clipped = Math.max(0, (e - s) / 1000);
      pageDowntime += clipped;
      const full = ((r.end ?? snapAt) - r.start) / 1000;
      const kuma = r.msg ? ` Kuma recorded: "${r.msg.slice(0, 160)}".` : '';
      allIncidents.push({
        page: label,
        what: (r.alerted
          ? 'Failed its checks and went down.'
          : 'Failed checks, then passed on retry before an alert was due.')
          + kuma + ' No cause established.',
        window: r.end ? `${when(r.start, end)} to ${when(r.end, end)}` : `Since ${when(r.start, end)}`,
        duration: r.end ? duration(full) : `${duration(full)} so far`,
        ongoing: !r.end,
        _start: r.start,
      });
    }
    totDowntime += pageDowntime;

    // Status now, from the latest heartbeat.
    const last = m.last_time ? kumaTime(m.last_time) : null;
    const lastAge = last ? (snapAt - last) / 60e3 : Infinity;
    const lastHour = rows.filter(r => r[1] < endS).sort((a, b) => b[1] - a[1])[0];
    const state = {};
    let note;
    const ongoing = runs.find(r => !r.end);
    if (!m.active) { state.is_paused = true; note = 'Monitor paused'; }
    else if (!last || lastAge > 2 * Math.max(m.interval, 60) / 60 + 5) {
      state.is_nodata = true; note = 'No recent checks from Kuma';
      warnings.push(`${cfg.name} has no recent checks, so its status is unknown.`);
    } else if (m.last_status === DOWN) state.is_down = true;
    else if (m.last_status === PENDING) { state.is_degraded = true; note = 'Failing checks now, retrying'; }
    else if (lastHour && lastHour[2] > 0 && lastHour[4] > slowMs) state.is_degraded = true;
    else state.is_up = true;
    if (!up && !down && !state.is_paused && !state.is_nodata) {
      state.is_up = state.is_down = state.is_degraded = undefined;
      state.is_nodata = true; note = 'No checks recorded in the window';
      warnings.push(`${cfg.name} has no checks recorded in the window.`);
    }

    if (!note) {
      if (ongoing) note = `Down since ${when(ongoing.start, end)}`;
      else if (runs.length === 1) note = `${runs[0].alerted ? 'Down' : 'Failing'} ${duration((runs[0].end - runs[0].start) / 1000)} at ${when(runs[0].start, end)}, recovered`;
      else if (runs.length > 1) note = `${runs.length} incidents, ${duration(pageDowntime)} in total`;
      // Older than Kuma's ~29h of raw beats, a retried failure leaves only a count.
      else if (down) note = `${down} failed check${down === 1 ? '' : 's'}, passed on retry`;
      else if (slowHours && baseline != null) note = `Slow in ${slowHours} of ${hours} hours; usual response about ${ms(baseline)}`;
      else note = cfg.caveat;
    }

    const host = m.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return {
      group: cfg.group,
      rank: state.is_down ? 0 : state.is_nodata ? 1 : state.is_degraded ? 2 : state.is_paused ? 4 : 3,
      ongoingSince: ongoing ? ongoing.start : null,
      slowHours, baseline, avg,
      page: {
        name: cfg.name,
        url: m.url,
        display_url: host,
        ...Object.fromEntries(Object.entries(state).filter(([, v]) => v)),
        uptime_pct: up + down ? pct(up, up + down) : '–',
        response: avg == null ? '–' : ms(avg),
        incidents: String(runs.length),
        ...(note ? { note } : {}),
        ...(state.is_paused ? {} : { hours: strip }),
      },
      cert: m.cert_valid_to ? { host, validTo: new Date(m.cert_valid_to) } : null,
    };
  });

  // Groups in config order, worst page first within each.
  const groupOrder = [...new Set([...PAGES.map(p => p.group), 'Other'])];
  const groups = groupOrder
    .map(title => ({ title, pages: built.filter(b => b.group === title).sort((a, b) => a.rank - b.rank).map(b => b.page) }))
    .filter(g => g.pages.length);

  const incident_list = allIncidents
    .sort((a, b) => (b.ongoing - a.ongoing) || (b._start - a._start))
    .map(({ _start, ...i }) => i);

  const expiring = built
    .filter(b => b.cert)
    .map(b => ({ ...b.cert, days: Math.floor((b.cert.validTo - now) / 86400e3) }))
    .filter(c => c.days <= CERT_WARN_DAYS)
    .sort((a, b) => a.days - b.days)
    .map(c => ({
      item: `${c.host} SSL certificate`,
      detail: c.days < 0
        ? `Expired on ${fmt(c.validTo, { day: 'numeric', month: 'long' })}.`
        : `Expires ${fmt(c.validTo, { day: 'numeric', month: 'long' })}, in ${c.days} day${c.days === 1 ? '' : 's'}.`,
    }));

  const n = built.length;
  const downNow = built.filter(b => b.page.is_down);
  const slowNow = built.filter(b => b.page.is_degraded);
  const upNow = built.filter(b => b.page.is_up || b.page.is_degraded).length;
  const ongoingCount = incident_list.filter(i => i.ongoing).length;
  const uptimeAll = totUp + totDown ? pct(totUp, totUp + totDown) : null;
  const span = isMonday ? 'since Friday 07:00' : 'in the last 24 hours';

  const stats = [
    uptimeAll == null
      ? { label: 'Uptime, all pages', nodata: true }
      : { value: `${uptimeAll}%`, label: 'Uptime, all pages', ...(uptimeAll === '100.00' ? { good: true } : { highlight: true }), delta: '100% target' },
    { value: `${upNow}/${n}`, label: 'Pages up now', ...(downNow.length ? { alert: true } : upNow === n ? { good: true } : {}),
      ...(slowNow.length ? { delta: `${slowNow.length} slow` } : {}) },
    { value: String(incident_list.length), label: 'Incidents',
      delta: !incident_list.length ? 'None' : ongoingCount ? `${ongoingCount} ongoing` : 'All resolved' },
    { value: duration(totDowntime), label: 'Total downtime', delta: 'Across all pages' },
  ];

  // Summary: facts only, names escaped (README: summary_html is unescaped).
  const parts = [];
  if (downNow.length) {
    parts.push(downNow.map(b => `<strong>${esc(b.page.name)} (${esc(b.page.display_url)}) was down at 07:00</strong>${b.ongoingSince ? `, since ${esc(when(b.ongoingSince, end))}` : ''}.`).join(' '));
  } else if (upNow === n) {
    parts.push('Every monitored page was up at 07:00.');
  } else {
    parts.push(`${upNow} of ${n} monitored pages were up at 07:00; the rest have no data.`);
  }
  if (!incident_list.length && !totDown) parts.push(`No failed checks ${span}.`);
  else if (!incident_list.length) parts.push(`No incidents ${span}; ${totDown} check${totDown === 1 ? '' : 's'} failed and passed on retry.`);
  else {
    const resolved = incident_list.length - ongoingCount;
    parts.push(`There ${incident_list.length === 1 ? 'was' : 'were'} <strong>${incident_list.length} incident${incident_list.length === 1 ? '' : 's'}</strong> ${span}, <strong>${esc(duration(totDowntime))}</strong> of downtime in total${ongoingCount ? `, ${ongoingCount} still ongoing` : resolved ? ', all resolved' : ''}.`);
  }
  const slowest = built.filter(b => b.slowHours).sort((a, b) => b.slowHours - a.slowHours)[0];
  if (slowest) parts.push(`<strong>${esc(slowest.page.name)}</strong> was slow in ${slowest.slowHours} of the ${hours} hours, against a usual response of about ${esc(ms(slowest.baseline))}.`);
  if (expiring.length) parts.push(`${expiring.length} SSL certificate${expiring.length === 1 ? '' : 's'} ${expiring.length === 1 ? 'is' : 'are'} due for renewal within ${CERT_WARN_DAYS} days.`);

  const pre = [];
  if (downNow.length) pre.push(`Down: ${downNow.map(b => b.page.name).join(', ')}.`);
  pre.push(`${upNow} of ${n} monitored pages up.`);
  pre.push(incident_list.length ? `${incident_list.length} incident${incident_list.length === 1 ? '' : 's'}, ${duration(totDowntime)} downtime.` : 'No incidents.');
  if (slowNow.length) pre.push(`${slowNow.length} page${slowNow.length === 1 ? '' : 's'} slow.`);

  const headline = downNow.length ? `${downNow.length} page${downNow.length === 1 ? '' : 's'} down`
    : warnings.length ? 'incomplete'
    : incident_list.length ? `all up, ${incident_list.length} incident${incident_list.length === 1 ? '' : 's'}`
    : 'all pages up';

  return {
    ...base,
    subject: `BG uptime, ${base.short_date}: ${headline}`,
    preheader: pre.join(' '),
    data_warning: warnings.join(' '),
    stats,
    ...(downNow.length ? { down_now: downNow.map(b => ({ name: b.page.name, since: b.ongoingSince ? when(b.ongoingSince, end) : 'the latest check' })) } : {}),
    summary_html: parts.join(' '),
    groups,
    pages_nodata: false,
    incident_list,
    expiring,
    freshness: {
      monitor_ok: true,
      monitor_at: `${fmt(new Date(raw.generated), { weekday: 'short', day: 'numeric', month: 'short' })}, ${hhmm(new Date(raw.generated))} UK`,
      generated_at: genAt,
    },
  };
}
