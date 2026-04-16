/**
 * GTFS-RT trip updates + vehicles for ETAs; static GTFS for stop directory only (not for ETA matching).
 */

import type Database from 'better-sqlite3';
import { computeStopHeadwayHeuristic } from './stopHeadway.js';
import type { ParsedVehicle, TripUpdatesSnapshot } from './gtfsRt.js';

type TripSnap = TripUpdatesSnapshot;

const STOP_STATUS: Record<number, string> = {
  0: 'Approaching stop',
  1: 'At stop',
  2: 'In transit to next stop',
};

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function bestPredictedUnix(u: { arrTime: number | null; depTime: number | null }) {
  if (u.arrTime != null) return u.arrTime;
  if (u.depTime != null) return u.depTime;
  return null;
}

function minutesUntil(unixSec: number | null, t0 = nowSec()) {
  if (unixSec == null) return null;
  const d = unixSec - t0;
  if (d < -90) return null;
  return Math.max(0, Math.round(d / 60));
}

function nextArrivalTripForRouteAtStop(tripSnap: TripSnap, routeId: string, stopId: string) {
  const ids = tripSnap.byRoute[routeId];
  if (!ids || !ids.length) return { unix: null as number | null, tripId: null as string | null };
  const t0 = nowSec();
  let best: number | null = null;
  let bestTripId: string | null = null;
  const sid = String(stopId || '').trim();
  for (const tripId of ids) {
    const t = tripSnap.trips[tripId];
    if (!t || t.routeId !== routeId) continue;
    for (const u of t.updates) {
      const rtStop = u.stopId != null && String(u.stopId).trim() ? String(u.stopId).trim() : '';
      if (!rtStop || rtStop !== sid) continue;
      const unix = bestPredictedUnix(u);
      if (unix == null || unix < t0 - 60) continue;
      if (best == null || unix < best) {
        best = unix;
        bestTripId = tripId;
      }
    }
  }
  return { unix: best, tripId: bestTripId };
}

function nextArrivalUnixForRouteAtStop(tripSnap: TripSnap, routeId: string, stopId: string) {
  return nextArrivalTripForRouteAtStop(tripSnap, routeId, stopId).unix;
}

export function tripHeadsignForTripId(db: Database.Database, tripId: string | null) {
  if (!tripId) return null;
  const row = db.prepare('SELECT trip_headsign AS tripHeadsign FROM gtfs_trips WHERE trip_id = ?').get(tripId) as
    | { tripHeadsign: string | null }
    | undefined;
  return row && row.tripHeadsign ? String(row.tripHeadsign).trim() || null : null;
}

function stopNameById(db: Database.Database, stopId: string | null) {
  if (!stopId) return null;
  const row = db.prepare('SELECT stop_name AS stopName FROM gtfs_stops WHERE stop_id = ?').get(stopId) as
    | { stopName: string }
    | undefined;
  return row ? row.stopName : null;
}

export function describeVehiclePosition(db: Database.Database, v: ParsedVehicle) {
  const status = v.currentStopStatus;
  const stopStatusLabel = status != null ? STOP_STATUS[status] || null : null;

  if (v.stopId) {
    const nm = stopNameById(db, v.stopId);
    if (nm) {
      let positionDescription = `Near ${nm}`;
      if (status === 1) positionDescription = `At ${nm}`;
      else if (status === 2) positionDescription = `Departed ${nm} (in transit)`;
      else if (status === 0) positionDescription = `Approaching ${nm}`;
      return {
        positionDescription,
        atStopName: status === 1 ? nm : null,
        nextStopName: status === 0 ? nm : null,
        stopStatusLabel,
      };
    }
  }

  const seq = v.currentStopSequence;
  if (v.routeId && seq != null) {
    return {
      positionDescription: `Route ${v.routeId} · stop sequence ${seq}`,
      atStopName: null,
      nextStopName: null,
      stopStatusLabel,
    };
  }
  return {
    positionDescription: v.tripId ? 'In service (no stop id in feed)' : 'No trip assignment',
    atStopName: null,
    nextStopName: null,
    stopStatusLabel,
  };
}

export type RouteStopRow = { stopId: string; stopName: string; lat: number; lon: number };

/**
 * Stops to draw on the map for a route: one **canonical** trip pattern (the trip with the most
 * stop_times rows). Unioning all trips and ordering by `MIN(stop_sequence)` mixes incompatible
 * branches (each variant has its own sequence 1…n at different terminals), which looks random for
 * branched routes (e.g. 11 Bayview, 301 Queen).
 */
export function routeStopsForMap(db: Database.Database, routeId: string): RouteStopRow[] {
  const pick = db
    .prepare(
      `SELECT t.trip_id AS tripId
       FROM gtfs_stop_times st
       JOIN gtfs_trips t ON t.trip_id = st.trip_id
       WHERE t.route_id = ?
       GROUP BY t.trip_id
       ORDER BY COUNT(*) DESC, t.trip_id
       LIMIT 1`
    )
    .get(routeId) as { tripId: string } | undefined;
  if (!pick?.tripId) return [];

  return db
    .prepare(
      `SELECT st.stop_id AS stopId,
              s.stop_name AS stopName,
              s.stop_lat AS lat,
              s.stop_lon AS lon
       FROM gtfs_stop_times st
       JOIN gtfs_stops s ON s.stop_id = st.stop_id
       WHERE st.trip_id = ?
       ORDER BY st.stop_sequence`
    )
    .all(pick.tripId) as RouteStopRow[];
}

/** Every distinct stop served by any trip on this route (for ETAs / tables), stable order by name. */
function routeStopsAllDistinct(db: Database.Database, routeId: string): RouteStopRow[] {
  return db
    .prepare(
      `SELECT st.stop_id AS stopId,
              s.stop_name AS stopName,
              s.stop_lat AS lat,
              s.stop_lon AS lon
       FROM gtfs_stop_times st
       JOIN gtfs_trips t ON t.trip_id = st.trip_id
       JOIN gtfs_stops s ON s.stop_id = st.stop_id
       WHERE t.route_id = ?
       GROUP BY st.stop_id
       ORDER BY s.stop_name COLLATE NOCASE`
    )
    .all(routeId) as RouteStopRow[];
}

export function stopArrivalsAlongRoute(db: Database.Database, tripSnap: TripSnap, routeId: string) {
  const stops = routeStopsAllDistinct(db, routeId);
  const t0 = nowSec();
  return stops.map((s) => {
    const unix = nextArrivalUnixForRouteAtStop(tripSnap, routeId, s.stopId);
    return {
      stopId: s.stopId,
      stopName: s.stopName,
      lat: s.lat,
      lon: s.lon,
      nextArrivalUnix: unix,
      minutesUntil: minutesUntil(unix, t0),
    };
  });
}

export function routesServingStop(db: Database.Database, stopId: string) {
  return db
    .prepare(
      `SELECT DISTINCT t.route_id AS routeId, r.short_name AS shortName, r.long_name AS longName, r.mode
       FROM gtfs_stop_times st
       JOIN gtfs_trips t ON t.trip_id = st.trip_id
       JOIN routes r ON r.route_id = t.route_id
       WHERE st.stop_id = ?
       ORDER BY CAST(r.short_name AS INTEGER), r.short_name`
    )
    .all(stopId) as { routeId: string; shortName: string; longName: string; mode: string }[];
}

export function stopDetail(db: Database.Database, tripSnap: TripSnap, stopId: string) {
  const stop = db
    .prepare(`SELECT stop_id AS stopId, stop_name AS stopName, stop_lat AS lat, stop_lon AS lon FROM gtfs_stops WHERE stop_id = ?`)
    .get(stopId) as { stopId: string; stopName: string; lat: number; lon: number } | undefined;
  if (!stop) return null;
  const lines = routesServingStop(db, stopId);
  const t0 = nowSec();
  const arrivals = lines.map((line) => {
    const { unix, tripId } = nextArrivalTripForRouteAtStop(tripSnap, line.routeId, stopId);
    const tripHeadsign = tripHeadsignForTripId(db, tripId);
    return {
      routeId: line.routeId,
      shortName: line.shortName,
      longName: line.longName,
      mode: line.mode,
      nextArrivalUnix: unix,
      minutesUntil: minutesUntil(unix, t0),
      tripHeadsign,
    };
  });
  const headwayHeuristic = computeStopHeadwayHeuristic(db, stopId, t0);
  return { stop, lines: arrivals, headwayHeuristic };
}

export function searchStops(db: Database.Database, q: string, limit = 25) {
  const term = String(q || '')
    .trim()
    .toLowerCase();
  if (term.length < 2) return [];
  const like = `%${term}%`;
  return db
    .prepare(
      `SELECT stop_id AS stopId, stop_name AS stopName, stop_lat AS lat, stop_lon AS lon
       FROM gtfs_stops
       WHERE lower(stop_name) LIKE ? OR stop_id = ? OR lower(COALESCE(stop_code, '')) LIKE ?
       ORDER BY stop_name
       LIMIT ?`
    )
    .all(like, term, like, Math.min(50, Math.max(1, limit))) as {
    stopId: string;
    stopName: string;
    lat: number;
    lon: number;
  }[];
}

export function hasGtfsData(db: Database.Database) {
  const row = db.prepare('SELECT 1 AS o FROM gtfs_stops LIMIT 1').get() as { o: number } | undefined;
  return !!row;
}

export { minutesUntil, nextArrivalUnixForRouteAtStop };
