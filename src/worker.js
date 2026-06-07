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
    const callMatch   = row.match(/qrz\.com\/db\/([A-Z0-9]+)/i);
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

// ── XLX via network API (xlxapi.rlx.lu) ──────────────────────────────────────
// The API returns XML: <name>, <dashboardurl>, <lastcontact> (Unix timestamp)
// We filter to reflectors active in the last 30 min, then probe their dashboards.

function parseXLXAPIList(xml) {
  const list   = [];
  const blockRe = /<reflector>([\s\S]*?)<\/reflector>/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block       = m[1];
    const name        = block.match(/<name>([^<]+)<\/name>/)?.[1]?.trim();
    const dashUrl     = block.match(/<dashboardurl>([^<]+)<\/dashboardurl>/)?.[1]?.trim();
    const lastContact = parseInt(block.match(/<lastcontact>(\d+)<\/lastcontact>/)?.[1] || '0', 10);
    if (name && dashUrl && lastContact > 0) list.push({ name, dashUrl, lastContact });
  }
  return list;
}

async function fetchXLXFromAPI() {
  const res = await fetch('http://xlxapi.rlx.lu/api.php?do=GetReflectorList', {
    headers: { 'User-Agent': 'DSTARDashboard/1.0 Amateur-Radio-Monitor' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`XLX API HTTP ${res.status}`);

  const now    = Math.floor(Date.now() / 1000);
  const recent = parseXLXAPIList(await res.text())
    .filter(r => now - r.lastContact < 1800)   // active in last 30 min
    .sort((a, b) => b.lastContact - a.lastContact)
    .slice(0, 25);                              // probe at most 25

  if (recent.length === 0) {
    return { entries: [], meta: { xlx: { status: 'ok', active: 0, responded: 0 } } };
  }

  const probeResults = await Promise.allSettled(
    recent.map(r => fetchOneXLX(r.name, r.dashUrl))
  );

  const allEntries = [];
  let responded = 0;
  for (const r of probeResults) {
    if (r.status === 'fulfilled' && r.value.entries.length > 0) {
      allEntries.push(...r.value.entries);
      responded++;
    }
  }

  return {
    entries: allEntries,
    meta: { xlx: { status: 'ok', active: recent.length, responded } },
  };
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

  // Run all collectors in parallel
  const [refResult, xlxApiResult, xlxEnvResult] = await Promise.allSettled([
    fetchREF(),
    fetchXLXFromAPI(),   // global XLX via xlxapi.rlx.lu
    fetchXLX(env),       // user-configured via XLX_REFLECTORS (XLX/DCS/XRF)
  ]);

  const allEntries = [];
  const sources    = {};

  if (refResult.status === 'fulfilled') {
    allEntries.push(...refResult.value);
    sources.ref = { status: 'ok', entries: refResult.value.length };
  } else {
    sources.ref = { status: 'error', message: refResult.reason?.message };
  }

  if (xlxApiResult.status === 'fulfilled') {
    allEntries.push(...xlxApiResult.value.entries);
    Object.assign(sources, xlxApiResult.value.meta);
  } else {
    sources.xlx = { status: 'error', message: xlxApiResult.reason?.message };
  }

  if (xlxEnvResult.status === 'fulfilled') {
    allEntries.push(...xlxEnvResult.value.entries);
    Object.assign(sources, xlxEnvResult.value.meta);
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

// ── /api/debug — probe candidate sources from CF edge ────────────────────────
// Hit /api/debug to discover which HTTP sources are reachable and what they look like.
// Returns status + first 500 chars of body for each candidate URL.

const DEBUG_SOURCES = [
  { key: 'dstarusers_ref',      url: 'https://www.dstarusers.org/lastheard.php' },
  { key: 'xlxapi_list',         url: 'http://xlxapi.rlx.lu/api.php?do=GetReflectorList' },
  // xreflector.net DCS investigation — chasing the inner frame content
  { key: 'xreflector_www',      url: 'http://www.xreflector.net/' },
  { key: 'xreflector_dcs',      url: 'http://www.xreflector.net/dcs.php' },
  { key: 'xreflector_status',   url: 'http://www.xreflector.net/status.php' },
  { key: 'xreflector_lh',       url: 'http://www.xreflector.net/lastheard.php' },
  { key: 'xreflector_users',    url: 'http://www.xreflector.net/pgs/users.php' },
  { key: 'xreflector_main',     url: 'http://www.xreflector.net/main.php' },
  // Try first XLX from API list to confirm dashboard scraping works
  { key: 'xlx000_dashboard',    url: 'http://xlx000.dmr.net.br/pgs/users.php' },
  { key: 'xlx000_root',         url: 'http://xlx000.dmr.net.br/' },
];

async function handleDebug() {
  const results = await Promise.allSettled(
    DEBUG_SOURCES.map(async ({ key, url }) => {
      const start = Date.now();
      const res = await fetch(url, {
        headers: { 'User-Agent': 'DSTARDashboard/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      const text = await res.text();
      return {
        key, url,
        status:      res.status,
        ok:          res.ok,
        ms:          Date.now() - start,
        contentType: res.headers.get('content-type') || '',
        bodyPreview: text.slice(0, 500).replace(/\s+/g, ' '),
      };
    })
  );

  const report = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { key: DEBUG_SOURCES[i].key, url: DEBUG_SOURCES[i].url, error: r.reason?.message };
  });

  return new Response(JSON.stringify(report, null, 2), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
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
    if (pathname === '/api/debug')      return handleDebug();

    return env.ASSETS.fetch(request);
  },
};
