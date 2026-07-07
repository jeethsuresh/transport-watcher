import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import next from 'next';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import type { Socket } from 'socket.io';

declare module 'socket.io' {
  interface SocketData {
    intervalId?: ReturnType<typeof setInterval> | null;
  }
}

function pathParam(param: string | string[] | undefined): string {
  if (param == null) return '';
  return Array.isArray(param) ? param[0] ?? '' : param;
}
import { openDb, seedRoutesIfEmpty } from './lib/db.js';
import { openVehicleLocationsDb } from './lib/vehicleLocationsDb.js';
import { createPoller } from './lib/poller.js';
import {
  buildLinesList,
  filterAndSortLines,
  buildVehiclesPayload,
  buildSnapshot,
} from './lib/snapshot.js';
import * as gtfsLive from './lib/gtfsLive.js';
import { buildHistoricalTripPath } from './lib/historicalTripPath.js';
import { ALERTS_URL, TRIPS_URL, VEHICLES_URL } from './lib/gtfsRt.js';

const GTFS_RT_PROXY: Record<string, string> = {
  trips: TRIPS_URL,
  vehicles: VEHICLES_URL,
  alerts: ALERTS_URL,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== 'production';
const PORT = parseInt(process.env.PORT || '3010', 10);
const routesJson = path.join(__dirname, 'data', 'routes.json');

const db = openDb();
seedRoutesIfEmpty(db, routesJson);
const vehicleLocationsDb = openVehicleLocationsDb();

let io: SocketIOServer | null = null;
const poller = createPoller(db, {
  vehicleLocationsDb,
  onPollComplete() {
    if (io) {
      const payload = buildSnapshot(db, poller);
      io.to('live').emit('snapshot', payload);
    }
  },
});

const nextApp = next({ dev, dir: __dirname });
const handle = nextApp.getRequestHandler();

async function main() {
  await nextApp.prepare();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get('/api/lines', (req: Request, res: Response) => {
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const modeFilter = (req.query.mode || '').toString().trim();
    const list = filterAndSortLines(buildLinesList(db), q, modeFilter);
    res.json({ lines: list, count: list.length });
  });

  app.get('/api/vehicles', (_req: Request, res: Response) => {
    res.json(buildVehiclesPayload(poller));
  });

  /** Same-origin proxy for browser GTFS-RT fetches (TTC does not send CORS headers). */
  app.get('/api/gtfs-rt/:feed', async (req: Request, res: Response) => {
    const feed = pathParam(req.params.feed);
    const url = GTFS_RT_PROXY[feed];
    if (!url) return res.status(404).json({ error: 'Unknown feed' });
    try {
      const upstream = await fetch(url, {
        headers: { Accept: 'application/x-protobuf, application/octet-stream, */*' },
      });
      if (!upstream.ok) {
        res.status(upstream.status).send(await upstream.text());
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/x-protobuf');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : 'GTFS-RT proxy failed' });
    }
  });

  app.get('/api/history/:routeId', (req: Request, res: Response) => {
    const routeId = pathParam(req.params.routeId);
    const exists = db.prepare('SELECT 1 FROM routes WHERE route_id = ?').get(routeId);
    if (!exists) return res.status(404).json({ error: 'Unknown route' });
    const limit = Math.min(parseInt(req.query.limit as string || '200', 10) || 200, 2000);
    const rows = db
      .prepare(
        `SELECT fetched_at, active_trips, max_delay_sec, avg_delay_sec, delayed_trip_count, alert_count, source
         FROM status_history
         WHERE route_id = ?
         ORDER BY fetched_at DESC
         LIMIT ?`
      )
      .all(routeId, limit);
    res.json({ routeId, samples: rows });
  });

  app.get('/api/stops/search', (req: Request, res: Response) => {
    if (!gtfsLive.hasGtfsData(db)) {
      return res.json({ stops: [], hint: 'Run npm run import-gtfs to load stop directory.' });
    }
    const q = (req.query.q || '').toString();
    const rawLimit = parseInt(req.query.limit as string || '25', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 25;
    const stops = gtfsLive.searchStops(db, q, limit);
    res.json({ stops, count: stops.length });
  });

  app.get('/api/stops/:stopId', (req: Request, res: Response) => {
    if (!gtfsLive.hasGtfsData(db)) {
      return res.status(503).json({ error: 'GTFS stops not imported', hint: 'npm run import-gtfs' });
    }
    const stopId = decodeURIComponent(pathParam(req.params.stopId));
    const tripSnap = poller.getTripUpdatesSnapshot();
    const vs = poller.getVehicleSnapshot();
    const detail = gtfsLive.stopDetail(db, tripSnap, stopId);
    if (!detail) return res.status(404).json({ error: 'Unknown stop' });
    const routeIds = new Set(detail.lines.map((l) => l.routeId));
    const vehicles = vs.vehicles
      .filter((v) => routeIds.has(v.routeId))
      .map((v) => {
        const pos = gtfsLive.describeVehiclePosition(db, v);
        const tripHeadsign = gtfsLive.tripHeadsignForTripId(db, v.tripId, v.routeId);
        return { ...v, ...pos, tripHeadsign };
      });
    res.json({
      ...detail,
      tripFeedTimestamp: tripSnap.feedTimestamp,
      vehicleFeedTimestamp: vs.feedTimestamp,
      vehicles,
    });
  });

  app.get('/api/routes/:routeId/stops', (req: Request, res: Response) => {
    const routeId = pathParam(req.params.routeId);
    const exists = db.prepare('SELECT 1 FROM routes WHERE route_id = ?').get(routeId);
    if (!exists) return res.status(404).json({ error: 'Unknown route' });
    if (!gtfsLive.hasGtfsData(db)) {
      return res.json({ routeId, stops: [], hint: 'npm run import-gtfs' });
    }
    const stops = gtfsLive.routeStopsForMap(db, routeId);
    res.json({ routeId, stops });
  });

  /** Stop-to-stop path from the latest trip with enough observations, for map overlay. */
  app.get('/api/routes/:routeId/history-path', (req: Request, res: Response) => {
    const routeId = pathParam(req.params.routeId);
    const exists = db.prepare('SELECT 1 FROM routes WHERE route_id = ?').get(routeId);
    if (!exists) return res.status(404).json({ error: 'Unknown route' });
    const pathPayload = buildHistoricalTripPath(db, vehicleLocationsDb, routeId);
    res.json(pathPayload);
  });

  app.get('/api/routes/:routeId/live', (req: Request, res: Response) => {
    const routeId = pathParam(req.params.routeId);
    const exists = db.prepare('SELECT 1 FROM routes WHERE route_id = ?').get(routeId);
    if (!exists) return res.status(404).json({ error: 'Unknown route' });
    const tripSnap = poller.getTripUpdatesSnapshot();
    const vs = poller.getVehicleSnapshot();
    const vehicles = vs.vehicles
      .filter((v) => v.routeId === routeId)
      .map((v) => {
        const pos = gtfsLive.describeVehiclePosition(db, v);
        const tripHeadsign = gtfsLive.hasGtfsData(db) ? gtfsLive.tripHeadsignForTripId(db, v.tripId, v.routeId) : null;
        return { ...v, ...pos, tripHeadsign };
      });
    const stopArrivals = gtfsLive.hasGtfsData(db) ? gtfsLive.stopArrivalsAlongRoute(db, tripSnap, routeId) : [];
    res.json({
      routeId,
      tripFeedTimestamp: tripSnap.feedTimestamp,
      vehicleFeedTimestamp: vs.feedTimestamp,
      vehicles,
      stopArrivals,
      gtfsImported: gtfsLive.hasGtfsData(db),
    });
  });

  app.use((req: Request, res: Response) => {
    void handle(req, res);
  });

  const httpServer = http.createServer(app);

  io = new SocketIOServer(httpServer, {
    cors: { origin: true, credentials: true },
    transports: ['websocket', 'polling'],
  });

  function emitSnapshot(socket: Socket) {
    socket.emit('snapshot', buildSnapshot(db, poller));
  }

  io.on('connection', (socket) => {
    socket.on('snapshot:request', () => {
      emitSnapshot(socket);
    });

    socket.on('subscribe', (opts: { serverPush?: boolean; intervalMs?: string | number } = {}) => {
      if (socket.data.intervalId) {
        clearInterval(socket.data.intervalId);
        socket.data.intervalId = null;
      }

      const serverPush = opts.serverPush !== false;
      if (serverPush) socket.join('live');
      else socket.leave('live');

      const raw = parseInt(String(opts.intervalMs), 10);
      const intervalMs = Number.isFinite(raw) ? Math.min(120_000, Math.max(2_000, raw)) : 0;
      if (intervalMs > 0) {
        socket.data.intervalId = setInterval(() => emitSnapshot(socket), intervalMs);
      }

      emitSnapshot(socket);
    });

    socket.on('unsubscribe', () => {
      socket.leave('live');
      if (socket.data.intervalId) {
        clearInterval(socket.data.intervalId);
        socket.data.intervalId = null;
      }
    });

    socket.on('disconnect', () => {
      if (socket.data.intervalId) {
        clearInterval(socket.data.intervalId);
        socket.data.intervalId = null;
      }
    });
  });

  httpServer.listen(PORT, () => {
    console.log(`Awesome TTC Watcher http://localhost:${PORT}`);
  });

  poller.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
