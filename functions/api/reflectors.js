// Cloudflare Pages Function — serves /api/reflectors
// Fetches dstarusers.org (REF/DPlus network) and normalises to a common shape.
// Add more collectors (XLX, DCS, XRF) to COLLECTORS array as they come online.

const SOURCES = {
  dstarUsers: 'https://www.dstarusers.org/lastheard.php',
};

const MAX_AGE_MS = 30 * 60 * 1000; // show entries up to 30 min old
const TOP_N = 10;

// ── parsers ──────────────────────────────────────────────────────────────────

function parseTimestamp(str) {
  // "06/06/26 23:22:42 UTC" → MM/DD/YY HH:MM:SS
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`20${m[3]}-${m[1]}-${m[2]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function parseDstarUsers(html) {
  const entries = [];
  // Split at row boundaries — works regardless of class names or div/table layout
  const rows = html.split(/<\/tr\s*>/i);

  for (const row of rows) {
    // Callsign is always linked to QRZ
    const callMatch = row.match(/qrz\.com\/callsign\/([A-Z0-9]+(?:\/[A-Z0-9]+)?)/i);
    // Timestamp format confirmed: "06/06/26 23:22:42 UTC"
    const timeMatch = row.match(/(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+UTC)/i);
    // Reporting node: "REF081 C 2 Meters DVD" — module must be standalone letter
    // \b after [A-Z] prevents matching "D" from "Dongle User"
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
  const now = Date.now();
  const cutoff = now - MAX_AGE_MS;

  // Keep only the most-recent transmission per (reflector + module)
  const byKey = new Map();
  for (const e of entries) {
    if (e.ts.getTime() < cutoff) continue;
    const key = `${e.protocol}${e.number}-${e.module}`;
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

// ── handler ───────────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  const fetchStart = Date.now();
  const sourceMeta = {};
  let allEntries = [];

  // ── REF via dstarusers.org ────────────────────────────────────────────────
  try {
    const res = await fetch(SOURCES.dstarUsers, {
      headers: { 'User-Agent': 'DSTARDashboard/1.0 Amateur-Radio-Monitor' },
      cf: { cacheTtl: 55, cacheEverything: false },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const entries = parseDstarUsers(html);
    allEntries = allEntries.concat(entries);
    sourceMeta.ref = { status: 'ok', entries: entries.length };
  } catch (err) {
    sourceMeta.ref = { status: 'error', message: err.message };
  }

  // ── Future sources go here (XLX, DCS, XRF) ───────────────────────────────
  // sourceMeta.xlx = { status: 'pending' };

  const reflectors = buildReflectorList(allEntries);

  const payload = {
    reflectors,
    sources:     sourceMeta,
    updatedAt:   new Date().toISOString(),
    fetchMs:     Date.now() - fetchStart,
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=55, s-maxage=55',
    },
  });
}
