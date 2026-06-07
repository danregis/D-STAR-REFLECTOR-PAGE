# D-STAR Live Reflector Dashboard

A live activity dashboard for D-STAR digital voice reflectors, built as a Cloudflare Worker with a static frontend. No server required — runs entirely on Cloudflare's edge network.

**Live at:** https://dstar.danregis.com

---

## What it does

- Shows the **10 most recently active reflectors** across the D-STAR network, updated every 30 seconds
- Covers **REF** (DPlus network via dstarusers.org) and **XLX** (global registry via xlxapi.rlx.lu)
- Displays protocol, reflector ID, module, last heard callsign (linked to QRZ.com), and time ago
- Highlights **scheduled nets** currently on air — when a reflector matches a net in the weekly schedule, a green label appears under the reflector ID with a link to the net's website
- Manual refresh button (bypasses cache for fresh data)
- Dark operator-friendly UI, mobile responsive

---

## Architecture

```
GitHub → Cloudflare CI → Worker (src/worker.js)
                              ├── GET /api/reflectors  — live JSON feed
                              ├── GET /api/debug       — source reachability probe
                              └── everything else      → static assets (public/)
```

**Data sources:**
| Protocol | Source | Method |
|----------|--------|--------|
| REF | dstarusers.org/lastheard.php | HTML scrape |
| XLX | xlxapi.rlx.lu XML registry → individual dashboards | XML + HTML scrape |
| DCS / XRF | xreflector.net (defunct/inaccessible) | Not available |

> Modern DCS reflectors have migrated to XLX protocol and appear in the XLX feed.

**Caching:** stale-while-revalidate via Cloudflare Cache API. Auto-refresh is served instantly from cache; manual refresh bypasses cache and fetches live (~6s).

---

## Project structure

```
src/
  worker.js        Cloudflare Worker — data collection, parsing, routing
public/
  index.html       Single-page dashboard (HTML/CSS/JS, no framework)
wrangler.toml      Worker config (name, assets binding, env vars)
package.json       Dev/deploy scripts
```

---

## Local development

```bash
npm install
npm run dev        # starts wrangler dev at http://localhost:8787
```

---

## Deploy

Pushes to `main` trigger automatic deployment via Cloudflare CI.

Manual deploy:
```bash
npm run deploy
```

---

## Configuration

Set in **Cloudflare Dashboard → Workers & Pages → reflector → Settings → Variables**:

| Variable | Description |
|----------|-------------|
| `XLX_REFLECTORS` | Optional comma-separated list of additional XLX/DCS/XRF reflectors to probe. Format: `ID@BaseURL` e.g. `XLX033@https://xlx033.example.net,DCS007@https://dcs007.example.net` |

---

## Scheduled nets

The dashboard includes a weekly schedule of ~75 D-STAR nets. When the current time (US Eastern) falls within ±30 minutes of a net's scheduled slot **and** that reflector appears in the live top-10, a green `● Net Name` label appears in the table row.

Times in the schedule are **US Eastern Time** (EDT = UTC−4 in summer, EST = UTC−5 in winter).

To add or edit nets, update the `SCHEDULE` array in `public/index.html`:

```javascript
// [day, hour, minute, 'Net Name', 'ReflectorID', 'Module', 'URL or null']
// day: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
[6, 21, 0, 'International D-STAR Net', 'REF091', 'C', 'https://...'],
```

---

## API

### `GET /api/reflectors`

Returns the top-10 most recently active reflectors.

```json
{
  "reflectors": [
    {
      "rank": 1,
      "protocol": "REF",
      "id": "REF030",
      "number": "030",
      "module": "C",
      "lastCallsign": "W1ABC",
      "lastHeardAt": "2026-06-07T01:23:00.000Z",
      "source": "ref"
    }
  ],
  "sources": {
    "ref": { "status": "ok", "entries": 89 },
    "xlx": { "status": "ok", "active": 40, "responded": 3, "newestMinsAgo": 12 }
  },
  "updatedAt": "2026-06-07T01:24:00.000Z",
  "fetchMs": 6133
}
```

Add `?nocache=1` to bypass the cache and force a fresh fetch.

### `GET /api/debug`

Probes all data sources from Cloudflare's edge and returns HTTP status, response time, and a body preview for each. Useful for diagnosing source outages.

---

## Notes

- XLX dashboard timestamps are often in server-local time (not UTC). The Worker detects this (timestamp >5 min in the future) and falls back to the registry's `lastcontact` Unix timestamp, which is always UTC.
- DCS/XRF via xreflector.net is inaccessible from Cloudflare's edge (SSL errors, 404s). Those protocols are effectively defunct as separate networks; active reflectors have migrated to XLX.
