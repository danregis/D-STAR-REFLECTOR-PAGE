// Cloudflare Worker — D-STAR Live Reflector Dashboard
// Routes: GET /api/reflectors → JSON feed
//         everything else     → static assets (public/)

const DSTAR_USERS_URL = 'https://www.dstarusers.org/lastheard.php';
const MAX_AGE_MS = 30 * 60 * 1000; // entries older than 30 min are dropped
const TOP_N = 10;

// ── parsers ──────────────────────────────────────────────────────────────────

function parseTimestamp(str) {
  // Format confirmed from dstarusers.org: "06/06/26 23:22:42 UTC" (MM/DD/YY)
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`20${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function parseDstarUsers(html) {
  const entries = [];
  const rows = html.split(/<\/tr\s*>/i);

  for (const row of rows) {
    // Callsign linked to QRZ
    const callMatch = row.match(/qrz\.com\/callsign\/([A-Z0-9]+(?:\/[A-Z0-9]+)?)/i);
    // UTC timestamp
    const timeMatch = row.match(/(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+UTC)/i);
    // Reporting node e.g. "REF081 C" — \b prevents matching "D" inside "Dongle"
    const nodeMatch = row.match(/\b(REF|XLX|DCS|XRF)\s*(\d{2,4})\s+([A-Z])\b/);

    if (timeMatch && nodeMatch) {
      const ts = parseTimestamp(timeMatch[1]);
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

async function handleReflectors() {
  const fetchStart = Date.now();
  const sourceMeta = {};
  let allEntries = [];

  // REF network via dstarusers.org
  try {
    const res = await fetch(DSTAR_USERS_URL, {
      headers: { 'User-Agent': 'DSTARDashboard/1.0 Amateur-Radio-Monitor' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const entries = parseDstarUsers(html);
    allEntries = allEntries.concat(entries);
    sourceMeta.ref = { status: 'ok', entries: entries.length };
  } catch (err) {
    sourceMeta.ref = { status: 'error', message: err.message };
  }

  // Future sources: XLX, DCS, XRF — push into allEntries here

  const payload = {
    reflectors: buildReflectorList(allEntries),
    sources:    sourceMeta,
    updatedAt:  new Date().toISOString(),
    fetchMs:    Date.now() - fetchStart,
  };

  return new Response(JSON.stringify(payload, null, 2), {
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
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'GET',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (url.pathname === '/api/reflectors') {
      return handleReflectors();
    }

    // Everything else: serve from public/ via Workers Assets binding
    return env.ASSETS.fetch(request);
  },
};
