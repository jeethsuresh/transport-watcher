# TTC Watcher

Web app for browsing Toronto Transit Commission (TTC) routes with live vehicle positions (GTFS-RT), optional MyTTC schedule hints, SQLite history, and Socket.IO updates.

## Run

Stack: **Next.js** (App Router, React) for the UI, **TypeScript** everywhere, and a **custom Node server** (`server.ts`) that serves the Next app, REST API, Socket.IO, and the GTFS poller.

```bash
npm install
npm run build      # production: compile Next.js (required before npm start)
npm start          # production: tsx server.ts (Next + API + Socket.IO)
npm run dev        # development: tsx watch server.ts
```

Default URL: [http://localhost:3010](http://localhost:3010) (override with `PORT`).

## Data sources

| Source | Role | Documentation |
|--------|------|----------------|
| **TTC GTFS-RT** | Trip updates, service alerts, vehicle positions (protobuf) | [bustime.ttc.ca/gtfsrt/](https://bustime.ttc.ca/gtfsrt/) |
| **MyTTC** | Optional JSON for selected stations (next departures); use sparingly | [myttc.ca/developers](https://myttc.ca/developers) |
| **Static routes** | Route list and mode (bus / streetcar / train–LRT) from bundled `data/routes.json` (derived from City of Toronto GTFS) | — |

MyTTC may return rate-limit or overload messages if hit too often. This app uses a **polite** `User-Agent`, **one station per N polls**, and a configurable station rotation. Default GTFS-RT polling is **30s**; avoid going much faster unless you need it and accept upstream risk.

## Server polling (TTC APIs)

All GTFS-RT feeds are fetched **in parallel** on the same timer:

- `GET …/gtfsrt/trips` — trip updates (delays when present, active trip counts)
- `GET …/gtfsrt/alerts` — service alerts per route
- `GET …/gtfsrt/vehicles` — vehicle latitude/longitude, trip/route ids

**MyTTC** is not fetched every cycle. On poll number **1, N+1, 2N+1, …** (see `MYTTC_EVERY_N_POLLS`), the server requests **one** station URI from the rotation list (`MYTTC_STATIONS`), parses routes whose names start with a number, matches them to GTFS `short_name`, and stores snapshots in SQLite.

After a **successful** poll, line status and (selectively) history rows are written to the database. Subscribers in Socket.IO room `live` receive a **`snapshot`** event (see below).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3010` | HTTP + Socket.IO listen port |
| `SQLITE_PATH` | `data/ttc-watcher.db` | SQLite database file |
| `POLL_INTERVAL_MS` | `30000` | Milliseconds between full GTFS-RT poll cycles (trips + alerts + vehicles, plus MyTTC when due) |
| `GTFS_RT_TRIPS_URL` | `https://bustime.ttc.ca/gtfsrt/trips` | Trip updates protobuf URL |
| `GTFS_RT_ALERTS_URL` | `https://bustime.ttc.ca/gtfsrt/alerts` | Alerts protobuf URL |
| `GTFS_RT_VEHICLES_URL` | `https://bustime.ttc.ca/gtfsrt/vehicles` | Vehicle positions protobuf URL |
| `MYTTC_STATIONS` | `spadina_station,finch_station,union_station` | Comma-separated MyTTC station path segments **without** `.json` (e.g. `spadina_station`) |
| `MYTTC_EVERY_N_POLLS` | `3` | Fetch MyTTC once every this many **successful** GTFS-RT polls |
| `MYTTC_USER_AGENT` | Mozilla-compatible string | `User-Agent` sent to MyTTC |
| `HISTORY_ALL_ROUTES` | unset (`0`) | Set to `1` to insert a `status_history` row for **every** route on every poll. If unset, history rows are written mainly when a route has active trips, alerts, or notable delay signals (smaller DB growth) |

Example:

```bash
POLL_INTERVAL_MS=90000 MYTTC_EVERY_N_POLLS=5 SQLITE_PATH=/var/lib/ttc/watcher.db npm start
```

## HTTP API

- `GET /api/health` — liveness
- `GET /api/lines` — optional query `q`, `mode` (`bus` \| `streetcar` \| `train_lrt`)
- `GET /api/vehicles` — latest vehicle snapshot from the last successful poll
- `GET /api/history/:routeId` — query `limit` (default 200, max 2000)

Pinned routes are stored only in the browser (`localStorage`, key `ttc-watcher:pinned-route-ids-v1`), per browser profile—not on the server.

## Socket.IO

Connect to the same origin and path `/socket.io`. Transports: **WebSocket**, falling back to **HTTP long-polling** if needed.

**Client → server**

- `snapshot:request` — send one full `snapshot` to this socket
- `subscribe` — `{ serverPush?: boolean, intervalMs?: number }`  
  - `serverPush` defaults to `true`: join room `live` and receive `snapshot` whenever the server finishes a GTFS-RT poll  
  - `intervalMs` (2000–120000): also emit `snapshot` on that cadence to this socket
- `unsubscribe` — leave `live` and clear the per-socket interval

**Server → client**

- `snapshot` — `{ lines, count, vehicleUpdatedAt, vehicleFeedTimestamp, vehicleCount, vehicles }` (full line list; the web UI filters search/mode in the browser)

## Client refresh behavior

The bundled UI loads once over HTTP, then prefers Socket.IO (`subscribe` with server push + a backup interval). If the socket is disconnected, it falls back to periodic HTTP requests. Exact intervals are defined in `public/app.js`, not via env vars.

## License

ISC (see `package.json`). Third-party data is subject to [TTC](https://www.ttc.ca/) / [City of Toronto Open Data](https://open.toronto.ca/) and [MyTTC](https://myttc.ca/) terms; use feeds respectfully.
