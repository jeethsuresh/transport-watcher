import type Database from 'better-sqlite3';
import { RAIL_GTFS_BUNDLE_PREFIX } from './db.js';

export type HistoryPathPoint = {
  stopId: string;
  lat: number;
  lon: number;
  observedAt: number;
  stopName: string | null;
};

export type HistoryPathResult = {
  routeId: string;
  tripId: string | null;
  source: 'arrival_events' | 'vehicle_samples' | 'gtfs_stop_times' | 'none';
  /** How the polyline was built (full schedule vs sparse RT samples). */
  pathShape: 'gtfs_full' | 'observed';
  /** First observation time for this trip (from RT), when known. */
  tripStartedAt: number | null;
  /** Last observation time for this trip (from RT), when known. */
  tripEndedAt: number | null;
  points: HistoryPathPoint[];
};

/** Match `RT_EVENT_RETENTION_DAYS` default in rtObservations — bounds trip search. */
const ROUTE_HISTORY_LOOKBACK_DAYS = (() => {
  const n = parseInt(process.env.HISTORY_PATH_LOOKBACK_DAYS || '40', 10);
  return Number.isFinite(n) && n > 0 ? n : 40;
})();
const ROUTE_HISTORY_LOOKBACK_SEC = ROUTE_HISTORY_LOOKBACK_DAYS * 86400;

function collapseOrderedStops(rows: { t: number; stopId: string; lat: number; lon: number; stopName: string | null }[]) {
  const out: HistoryPathPoint[] = [];
  let prev: string | null = null;
  for (const r of rows) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    if (r.stopId === prev) continue;
    prev = r.stopId;
    out.push({
      stopId: r.stopId,
      lat: r.lat,
      lon: r.lon,
      observedAt: r.t,
      stopName: r.stopName,
    });
  }
  return out;
}

type PickMode = 'complete' | 'any';

function pickLatestTripFromArrivals(
  db: Database.Database,
  routeId: string,
  lookbackLo: number,
  mode: PickMode
): string | null {
  const distinctClause = mode === 'complete' ? 'HAVING COUNT(DISTINCT stop_id) >= 2' : 'HAVING COUNT(*) >= 2';
  const row = db
    .prepare(
      `SELECT trip_id AS tripId
       FROM rt_arrival_events
       WHERE route_id = ?
         AND trip_id IS NOT NULL
         AND TRIM(trip_id) != ''
         AND observed_at >= ?
       GROUP BY trip_id
       ${distinctClause}
       ORDER BY MAX(observed_at) DESC
       LIMIT 1`
    )
    .get(routeId, lookbackLo) as { tripId: string } | undefined;
  return row?.tripId ?? null;
}

/** Map GTFS-RT `trip_id` to the row stored in `gtfs_trips` (rail bundle may use `rt:` prefix). */
function resolveStaticTripId(db: Database.Database, routeId: string, feedTripId: string): string | null {
  const row = db
    .prepare(
      `SELECT trip_id AS tripId FROM gtfs_trips WHERE route_id = ? AND (trip_id = ? OR trip_id = ?)`
    )
    .get(routeId, feedTripId, `${RAIL_GTFS_BUNDLE_PREFIX}${feedTripId}`) as { tripId: string } | undefined;
  return row?.tripId ?? null;
}

/** Full stop sequence from static GTFS for this trip (the whole scheduled run). */
function pathFromGtfsStopTimes(db: Database.Database, routeId: string, tripId: string): HistoryPathPoint[] {
  const staticTripId = resolveStaticTripId(db, routeId, tripId);
  if (!staticTripId) return [];

  const raw = db
    .prepare(
      `SELECT st.stop_id AS stopId,
              st.stop_sequence AS seq,
              s.stop_lat AS lat,
              s.stop_lon AS lon,
              s.stop_name AS stopName
       FROM gtfs_stop_times st
       JOIN gtfs_stops s ON s.stop_id = st.stop_id
       JOIN gtfs_trips t ON t.trip_id = st.trip_id
       WHERE st.trip_id = ? AND t.route_id = ?
       ORDER BY st.stop_sequence ASC`
    )
    .all(staticTripId, routeId) as {
    stopId: string;
    seq: number;
    lat: number;
    lon: number;
    stopName: string;
  }[];

  const timeByStop = db
    .prepare(
      `SELECT stop_id AS stopId, MIN(observed_at) AS t
       FROM rt_arrival_events
       WHERE route_id = ? AND trip_id = ?
       GROUP BY stop_id`
    )
    .all(routeId, tripId) as { stopId: string; t: number }[];

  const tMap = new Map(timeByStop.map((r) => [r.stopId, r.t]));
  const tripBounds = db
    .prepare(
      `SELECT MIN(observed_at) AS t0, MAX(observed_at) AS t1
       FROM rt_arrival_events
       WHERE route_id = ? AND trip_id = ?`
    )
    .get(routeId, tripId) as { t0: number | null; t1: number | null } | undefined;
  const fallbackT = tripBounds?.t0 ?? 0;

  const out: HistoryPathPoint[] = [];
  for (const r of raw) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const t = tMap.get(r.stopId) ?? fallbackT;
    out.push({
      stopId: r.stopId,
      lat: r.lat,
      lon: r.lon,
      observedAt: t,
      stopName: r.stopName ?? null,
    });
  }
  return out;
}

/** Observed stop sequence only (no GTFS trim); uses full observation window. */
function pathFromArrivals(db: Database.Database, routeId: string, tripId: string): HistoryPathPoint[] {
  const bounds = db
    .prepare(
      `SELECT MIN(observed_at) AS t0, MAX(observed_at) AS t1
       FROM rt_arrival_events
       WHERE route_id = ? AND trip_id = ?`
    )
    .get(routeId, tripId) as { t0: number | null; t1: number | null } | undefined;
  if (!bounds || bounds.t0 == null || bounds.t1 == null) return [];

  const t0 = bounds.t0;
  const t1 = bounds.t1;

  const raw = db
    .prepare(
      `SELECT e.observed_at AS t,
              e.stop_id AS stopId,
              s.stop_lat AS lat,
              s.stop_lon AS lon,
              s.stop_name AS stopName
       FROM rt_arrival_events e
       JOIN gtfs_stops s ON s.stop_id = e.stop_id
       WHERE e.route_id = ?
         AND e.trip_id = ?
         AND e.observed_at >= ?
         AND e.observed_at <= ?
       ORDER BY e.observed_at ASC`
    )
    .all(routeId, tripId, t0, t1) as {
    t: number;
    stopId: string;
    lat: number;
    lon: number;
    stopName: string;
  }[];

  return collapseOrderedStops(
    raw.map((r) => ({
      t: r.t,
      stopId: r.stopId,
      lat: r.lat,
      lon: r.lon,
      stopName: r.stopName ?? null,
    }))
  );
}

function pickLatestTripFromVehicleSamples(
  vdb: Database.Database,
  routeId: string,
  lookbackLo: number,
  mode: PickMode
): string | null {
  const distinctClause = mode === 'complete' ? 'HAVING COUNT(DISTINCT stop_id) >= 2' : 'HAVING COUNT(*) >= 2';
  const row = vdb
    .prepare(
      `SELECT trip_id AS tripId
       FROM vehicle_location_samples
       WHERE route_id = ?
         AND trip_id IS NOT NULL
         AND TRIM(trip_id) != ''
         AND stop_id IS NOT NULL
         AND TRIM(stop_id) != ''
         AND fetched_at >= ?
       GROUP BY trip_id
       ${distinctClause}
       ORDER BY MAX(fetched_at) DESC
       LIMIT 1`
    )
    .get(routeId, lookbackLo) as { tripId: string } | undefined;
  return row?.tripId ?? null;
}

function pathFromVehicleSamples(
  vdb: Database.Database,
  db: Database.Database,
  routeId: string,
  tripId: string
): HistoryPathPoint[] {
  const bounds = vdb
    .prepare(
      `SELECT MIN(fetched_at) AS t0, MAX(fetched_at) AS t1
       FROM vehicle_location_samples
       WHERE route_id = ?
         AND trip_id = ?
         AND stop_id IS NOT NULL
         AND TRIM(stop_id) != ''`
    )
    .get(routeId, tripId) as { t0: number | null; t1: number | null } | undefined;
  if (!bounds || bounds.t0 == null || bounds.t1 == null) return [];

  const t0 = bounds.t0;
  const t1 = bounds.t1;

  const raw = vdb
    .prepare(
      `SELECT v.fetched_at AS t,
              v.stop_id AS stopId,
              v.lat AS sampleLat,
              v.lon AS sampleLon
       FROM vehicle_location_samples v
       WHERE v.route_id = ?
         AND v.trip_id = ?
         AND v.stop_id IS NOT NULL
         AND TRIM(v.stop_id) != ''
         AND v.fetched_at >= ?
         AND v.fetched_at <= ?
       ORDER BY v.fetched_at ASC`
    )
    .all(routeId, tripId, t0, t1) as { t: number; stopId: string; sampleLat: number; sampleLon: number }[];

  const nameStmt = db.prepare(`SELECT stop_name AS stopName, stop_lat AS lat, stop_lon AS lon FROM gtfs_stops WHERE stop_id = ?`);

  const enriched = raw.map((r) => {
    const g = nameStmt.get(r.stopId) as { stopName: string; lat: number; lon: number } | undefined;
    const lat = g && Number.isFinite(g.lat) ? g.lat : r.sampleLat;
    const lon = g && Number.isFinite(g.lon) ? g.lon : r.sampleLon;
    return {
      t: r.t,
      stopId: r.stopId,
      lat,
      lon,
      stopName: g?.stopName ?? null,
    };
  });

  return collapseOrderedStops(enriched);
}

function tryArrivals(
  db: Database.Database,
  routeId: string,
  lookbackLo: number
): { tripId: string; points: HistoryPathPoint[]; t0: number | null; t1: number | null; pathShape: 'gtfs_full' | 'observed'; source: 'arrival_events' | 'gtfs_stop_times' } | null {
  for (const mode of ['complete', 'any'] as PickMode[]) {
    const tripId = pickLatestTripFromArrivals(db, routeId, lookbackLo, mode);
    if (!tripId) continue;

    const gtfsPoints = pathFromGtfsStopTimes(db, routeId, tripId);
    if (gtfsPoints.length >= 2) {
      const b = db
        .prepare(
          `SELECT MIN(observed_at) AS t0, MAX(observed_at) AS t1
           FROM rt_arrival_events
           WHERE route_id = ? AND trip_id = ?`
        )
        .get(routeId, tripId) as { t0: number | null; t1: number | null };
      return {
        tripId,
        points: gtfsPoints,
        t0: b?.t0 ?? null,
        t1: b?.t1 ?? null,
        pathShape: 'gtfs_full',
        source: 'gtfs_stop_times',
      };
    }

    const points = pathFromArrivals(db, routeId, tripId);
    if (points.length < 2) continue;
    const b = db
      .prepare(
        `SELECT MIN(observed_at) AS t0, MAX(observed_at) AS t1
         FROM rt_arrival_events
         WHERE route_id = ? AND trip_id = ?`
      )
      .get(routeId, tripId) as { t0: number | null; t1: number | null };
    return { tripId, points, t0: b?.t0 ?? null, t1: b?.t1 ?? null, pathShape: 'observed', source: 'arrival_events' };
  }
  return null;
}

function pathFromGtfsWithVehicleTimes(
  db: Database.Database,
  vdb: Database.Database,
  routeId: string,
  tripId: string
): HistoryPathPoint[] {
  const base = pathFromGtfsStopTimes(db, routeId, tripId);
  if (!base.length) return [];

  const timeByStop = vdb
    .prepare(
      `SELECT stop_id AS stopId, MIN(fetched_at) AS t
       FROM vehicle_location_samples
       WHERE route_id = ? AND trip_id = ? AND stop_id IS NOT NULL AND TRIM(stop_id) != ''
       GROUP BY stop_id`
    )
    .all(routeId, tripId) as { stopId: string; t: number }[];

  const tMap = new Map(timeByStop.map((r) => [r.stopId, r.t]));
  const bounds = vdb
    .prepare(
      `SELECT MIN(fetched_at) AS t0, MAX(fetched_at) AS t1
       FROM vehicle_location_samples
       WHERE route_id = ? AND trip_id = ? AND stop_id IS NOT NULL AND TRIM(stop_id) != ''`
    )
    .get(routeId, tripId) as { t0: number | null; t1: number | null } | undefined;
  const fallbackT = bounds?.t0 ?? 0;

  return base.map((p) => ({
    ...p,
    observedAt: tMap.get(p.stopId) ?? p.observedAt ?? fallbackT,
  }));
}

function tryVehicleSamples(
  vdb: Database.Database,
  db: Database.Database,
  routeId: string,
  lookbackLo: number
): { tripId: string; points: HistoryPathPoint[]; t0: number | null; t1: number | null; pathShape: 'gtfs_full' | 'observed'; source: 'vehicle_samples' | 'gtfs_stop_times' } | null {
  for (const mode of ['complete', 'any'] as PickMode[]) {
    const tripId = pickLatestTripFromVehicleSamples(vdb, routeId, lookbackLo, mode);
    if (!tripId) continue;

    const gtfsPoints = pathFromGtfsWithVehicleTimes(db, vdb, routeId, tripId);
    if (gtfsPoints.length >= 2) {
      const b = vdb
        .prepare(
          `SELECT MIN(fetched_at) AS t0, MAX(fetched_at) AS t1
           FROM vehicle_location_samples
           WHERE route_id = ?
             AND trip_id = ?
             AND stop_id IS NOT NULL
             AND TRIM(stop_id) != ''`
        )
        .get(routeId, tripId) as { t0: number | null; t1: number | null };
      return {
        tripId,
        points: gtfsPoints,
        t0: b?.t0 ?? null,
        t1: b?.t1 ?? null,
        pathShape: 'gtfs_full',
        source: 'gtfs_stop_times',
      };
    }

    const points = pathFromVehicleSamples(vdb, db, routeId, tripId);
    if (points.length < 2) continue;
    const b = vdb
      .prepare(
        `SELECT MIN(fetched_at) AS t0, MAX(fetched_at) AS t1
         FROM vehicle_location_samples
         WHERE route_id = ?
           AND trip_id = ?
           AND stop_id IS NOT NULL
           AND TRIM(stop_id) != ''`
      )
      .get(routeId, tripId) as { t0: number | null; t1: number | null };
    return { tripId, points, t0: b?.t0 ?? null, t1: b?.t1 ?? null, pathShape: 'observed', source: 'vehicle_samples' };
  }
  return null;
}

/**
 * Latest "complete" trip for the route: most recent trip (by last observation time) that hit at least
 * two distinct stops, then path in observation order. Falls back to thinner data when needed.
 */
export function buildHistoricalTripPath(
  db: Database.Database,
  vehicleLocationsDb: Database.Database | null,
  routeId: string,
  nowSec = Math.floor(Date.now() / 1000)
): HistoryPathResult {
  const lookbackLo = nowSec - ROUTE_HISTORY_LOOKBACK_SEC;

  const fromArrivals = tryArrivals(db, routeId, lookbackLo);
  if (fromArrivals) {
    return {
      routeId,
      tripId: fromArrivals.tripId,
      source: fromArrivals.source,
      pathShape: fromArrivals.pathShape,
      tripStartedAt: fromArrivals.t0,
      tripEndedAt: fromArrivals.t1,
      points: fromArrivals.points,
    };
  }

  if (vehicleLocationsDb) {
    const fromV = tryVehicleSamples(vehicleLocationsDb, db, routeId, lookbackLo);
    if (fromV) {
      return {
        routeId,
        tripId: fromV.tripId,
        source: fromV.source,
        pathShape: fromV.pathShape,
        tripStartedAt: fromV.t0,
        tripEndedAt: fromV.t1,
        points: fromV.points,
      };
    }
  }

  return {
    routeId,
    tripId: null,
    source: 'none',
    pathShape: 'observed',
    tripStartedAt: null,
    tripEndedAt: null,
    points: [],
  };
}
