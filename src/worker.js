// Cloudflare Worker — D-STAR Live Reflector Dashboard
//
// Routes:
//   GET /api/reflectors  → JSON feed of most-recently-active reflectors
//   everything else      → static assets from public/
//
// Environment variables (set in Cloudflare dashboard → Settings → Variables):
//   XLX_REFLECTORS   comma-separated "ID@BaseURL" pairs
//                    Works for XLX, DCS, XRF — any reflector running xlxd dashboard software
//                    Example: XLX033@https://xlx033.regasys.net,DCS007@https://dcs007.xreflector.net

const DSTAR_USERS_URL = 'https://www.dstarusers.org/lastheard.php';
const MAX_AGE_MS      = 30 * 60 * 1000;
const TOP_N           = 10;

// ── REF parser (dstarusers.org) ──────────────────────────────────────────────
// Timestamp format on this site: "MM/DD/YY HH:MM:SS UTC"

function parseREFTimestamp(str) {
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`20${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function parseDstarUsers(html) {
  const entries = [];
  for (const row of html.split(/<\/tr\s*>/i)) {
    const callMatch   = row.match(/qrz\.com\/callsign\/([A-Z0-9]+(?:\/[A-Z0-9]+)?)/i);
    const timeMatch   = row.match(/(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+UTC)/i);
    // Standalone module letter — \b prevents matching "D" inside "Dongle"
    const nodeMatch   = row.match(/\b(REF|XLX|DCS|XRF)\s*(\d{2,4})\s+([A-Z])\b/);

    if (timeMatch && nodeMatch) {
      const ts = parseREFTimestamp(timeMatch[1]);
      if (!ts) continue;
      entries.push({
        callsign: callMatch ? callMatch[1].toUpperCase() : '—',
        ts,
        protocol: nodeMatch[1],
        number:   nodeMatch[2].padStart(3, '0'),
        module:   nodeMatch[3],
        source:   'ref',
      });
    }
  }
  return entries;
}

async function fetchREF() {
  const res = await fetch(DSTAR_USERS_URL, {
    headers: { 'User-Agent': 'DSTARDashboard/1.0 Amateur-Radio-Monitor' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseDstarUsers(await res.text());
}

// ── XLX / DCS / XRF parser (xlxd dashboard software) ────────────────────────
// Timestamp format: "DD.MM.YYYY HH:MM"  (European, no seconds)
// Callsign QRZ link: qrz.com/db/CALLSIGN  (different from dstarusers.org)
// Module cell: <td align="center" width="30">A</td>

function parseXLXTimestamp(str) {
  const m = str.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00Z`);
}

function parseXLXDashboard(html, reflectorId) {
  const protoMatch = reflectorId.match(/^(REF|XLX|DCS|XRF)/i);
  const protocol   = protoMatch ? protoMatch[1].toUpperCase() : 'XLX';
  const number     = reflectorId.replace(/^[A-Za-z]+/, '').padStart(3, '0');
  const entries    = [];

  for (const row of html.split(/<\/tr\s*>/i)) {
    const callMatch   = row.match(/qrz\.com\/db\/([A-Z0-9]+)/i);
    const timeMatch   = row.match(/\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}/);
    // Module is in the last <td> cell (width="30") — just a single letter
    const moduleMatch = row.match(/width="30"[^>]*>\s*([A-Z])\s*<\/td>/i);

    if (callMatch && timeMatch && moduleMatch) {
      const ts = parseXLXTimestamp(timeMatch[0]);
      if (!ts) continue;
      entries.push({
        callsign: callMatch[1].toUpperCase(),
        ts,
        protocol,
        number,
        module:   moduleMatch[1],
        source:   protocol.toLowerCase(),
      });
    }
  }
  return entries;
}

async function fetchOneXLX(reflectorId, baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  // Try the users sub-page first (direct AJAX endpoint), then main page
  for (const path of ['/pgs/users.php', '/']) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { 'User-Agent': 'DSTARDashboard/1.0 Amateur-Radio-Monitor' },
      });
      if (res.ok) {
        const html = await res.text();
        const entries = parseXLXDashboard(html, reflectorId);
        if (entries.length > 0) return { entries, ok: true };
      }
    } catch { /* try next path */ }
  }
  throw new Error('no reachable endpoint returned usable data');
}

async function fetchXLX(env) {
  const list = (env.XLX_REFLECTORS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (list.length === 0) return { entries: [], meta: {} };

  const jobs = list.map(async (item) => {
    const atIdx = item.indexOf('@');
    if (atIdx < 1) return { id: item, status: 'error', message: 'bad format (use ID@URL)' };
    const reflectorId = item.slice(0, atIdx).toUpperCase();
    const baseUrl     = item.slice(atIdx + 1);
    try {
      const { entries } = await fetchOneXLX(reflectorId, baseUrl);
      return { id: reflectorId, status: 'ok', entries };
    } catch (err) {
      return { id: reflectorId, status: 'error', message: err.message, entries: [] };
    }
  });

  const results  = await Promise.allSettled(jobs);
  const allEntries = [];
  const meta = {};

  for (const r of results) {
    const val = r.status === 'fulfilled' ? r.value : { status: 'error', message: r.reason };
    const key = (val.id || 'unknown').toLowerCase();
    if (val.entries) allEntries.push(...val.entries);
    meta[key] = val.status === 'ok'
      ? { status: 'ok',    entries: val.entries.length }
      : { status: 'error', message: val.message };
  }

  return { entries: allEntries, meta };
}

// ── aggregation ───────────────────────────────────────────────────────────────

function buildReflectorList(entries) {
  const now    = Date.now();
  const cutoff = now - MAX_AGE_MS;
  const byKey  = new Map();

  for (const e of entries) {
    if (e.ts.getTime() < cutoff) continue;
    const key  = `${e.protocol}${e.number}-${e.module}`;
    const prev = byKey.get(key);
    if (!prev || e.ts > prev.ts) byKey.set(key, e);
  }

  return [...byKey.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, TOP_N)
    .map((e, i) => ({
      rank:         i + 1,
      protocol:     e.protocol,
      id:           `${e.protocol}${e.number}`,
      number:       e.number,
      module:       e.module,
      lastCallsign: e.callsign,
      lastHeardAt:  e.ts.toISOString(),
      source:       e.source,
    }));
}

// ── /api/reflectors handler ───────────────────────────────────────────────────

async function handleReflectors(env) {
  const fetchStart = Date.now();

  const [refResult, xlxResult] = await Promise.allSettled([
    fetchREF(),
    fetchXLX(env),
  ]);

  const allEntries = [];
  const sources    = {};

  if (refResult.status === 'fulfilled') {
    allEntries.push(...refResult.value);
    sources.ref = { status: 'ok', entries: refResult.value.length };
  } else {
    sources.ref = { status: 'error', message: refResult.reason?.message };
  }

  if (xlxResult.status === 'fulfilled') {
    allEntries.push(...xlxResult.value.entries);
    Object.assign(sources, xlxResult.value.meta);
  } else {
    sources.xlx = { status: 'error', message: xlxResult.reason?.message };
  }

  return new Response(JSON.stringify({
    reflectors: buildReflectorList(allEntries),
    sources,
    updatedAt:  new Date().toISOString(),
    fetchMs:    Date.now() - fetchStart,
  }, null, 2), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=55, s-maxage=55',
    },
  });
}

// ── main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (pathname === '/api/reflectors') return handleReflectors(env);

    return env.ASSETS.fetch(request);
  },
};
