import type Database from 'better-sqlite3';

const MAX_SNAPSHOT_JSON = 120_000;
const EVENT_RETENTION_DAYS = parseInt(process.env.RT_EVENT_RETENTION_DAYS || '40', 10);
const SNAPSHOT_RETENTION_DAYS = parseInt(process.env.RT_SNAPSHOT_RETENTION_DAYS || '7', 10);

export function buildTripUpdatesSnapshotJson(
  samples: { routeId: string; tripId: string; stopId: string; arrTime: number | null; depTime: number | null }[]
) {
  const body = JSON.stringify({ count: samples.length, updates: samples });
  if (body.length <= MAX_SNAPSHOT_JSON) return body;
  const trunc = samples.slice(0, Math.max(1, Math.floor(samples.length * (MAX_SNAPSHOT_JSON / body.length))));
  return JSON.stringify({
    count: samples.length,
    truncated: true,
    updates: trunc,
  });
}

export function condensedTripUpdatesForSnapshot(tripSnap: {
  trips: Record<string, { routeId: string; updates: { stopId: string | null; arrTime: number | null; depTime: number | null }[] }>;
}) {
  const out: { routeId: string; tripId: string; stopId: string; arrTime: number | null; depTime: number | null }[] = [];
  const trips = tripSnap.trips || {};
  for (const tripId of Object.keys(trips)) {
    const t = trips[tripId];
    if (!t || !t.updates) continue;
    for (const u of t.updates) {
      if (!u.stopId) continue;
      if (u.arrTime == null && u.depTime == null) continue;
      out.push({
        routeId: t.routeId,
        tripId,
        stopId: u.stopId,
        arrTime: u.arrTime,
        depTime: u.depTime,
      });
      if (out.length >= 8000) return out;
    }
  }
  return out;
}

export function insertPollSnapshot(
  db: Database.Database,
  fetchedAt: number,
  tripFeedTs: number | null,
  vehicleFeedTs: number | null,
  tripEntityCount: number,
  vehicleEntityCount: number,
  tripUpdatesJson: string | null
) {
  db.prepare(
    `INSERT INTO rt_poll_snapshots (
       fetched_at, trip_feed_timestamp, vehicle_feed_timestamp,
       trip_entity_count, vehicle_entity_count, trip_updates_json
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(fetchedAt, tripFeedTs, vehicleFeedTs, tripEntityCount, vehicleEntityCount, tripUpdatesJson);
}

export function insertArrivalEvent(
  db: Database.Database,
  p: {
    observedAt: number;
    stopId: string;
    routeId: string;
    tripId: string | null;
    vehicleId: string | null;
    source: string;
    tripFeedTimestamp?: number | null;
    vehicleFeedTimestamp?: number | null;
  }
) {
  db.prepare(
    `INSERT INTO rt_arrival_events (
       observed_at, stop_id, route_id, trip_id, vehicle_id, source,
       trip_feed_timestamp, vehicle_feed_timestamp
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    p.observedAt,
    p.stopId,
    p.routeId,
    p.tripId || null,
    p.vehicleId || null,
    p.source,
    p.tripFeedTimestamp ?? null,
    p.vehicleFeedTimestamp ?? null
  );
}

type VehicleLike = {
  vehicleLabel: string | null;
  entityId: string;
  tripId: string | null;
  routeId: string;
  currentStopStatus: number | null;
  stopId: string | null;
};

export function vehicleTrackingKey(v: VehicleLike) {
  return String(v.vehicleLabel || v.entityId || v.tripId || '').trim() || String(v.entityId);
}

export function snapshotVehicleStopState(vehicles: VehicleLike[]) {
  const next = new Map<string, { status: number | null; stopId: string | null; tripId: string | null }>();
  for (const v of vehicles) {
    const key = vehicleTrackingKey(v);
    const stopId = v.stopId != null && String(v.stopId).trim() ? String(v.stopId).trim() : null;
    next.set(key, {
      status: v.currentStopStatus,
      stopId,
      tripId: v.tripId,
    });
  }
  return next;
}

export function recordVehicleArrivalTransitions(
  db: Database.Database,
  vehicles: VehicleLike[],
  fetchedAt: number,
  tripFeedTs: number | null,
  vehicleFeedTs: number | null,
  previousByKey: Map<string, { status: number | null; stopId: string | null; tripId: string | null }>,
  isPriming: boolean
) {
  const next = new Map<string, { status: number | null; stopId: string | null; tripId: string | null }>();
  for (const v of vehicles) {
    const key = vehicleTrackingKey(v);
    const prev = previousByKey.get(key);
    const stopId = v.stopId != null && String(v.stopId).trim() ? String(v.stopId).trim() : null;
    const atStop = v.currentStopStatus === 1 && stopId && v.routeId;

    if (!isPriming && atStop) {
      const sameBoarding =
        prev &&
        prev.status === 1 &&
        String(prev.stopId || '') === stopId &&
        String(prev.tripId || '') === String(v.tripId || '');
      if (!sameBoarding) {
        insertArrivalEvent(db, {
          observedAt: fetchedAt,
          stopId,
          routeId: v.routeId,
          tripId: v.tripId,
          vehicleId: key,
          source: 'vehicle_at_stop',
          tripFeedTimestamp: tripFeedTs,
          vehicleFeedTimestamp: vehicleFeedTs,
        });
      }
    }

    next.set(key, {
      status: v.currentStopStatus,
      stopId,
      tripId: v.tripId,
    });
  }
  return next;
}

export function pruneOldRows(db: Database.Database, nowSec = Math.floor(Date.now() / 1000)) {
  const evCut = nowSec - EVENT_RETENTION_DAYS * 86400;
  const snCut = nowSec - SNAPSHOT_RETENTION_DAYS * 86400;
  db.prepare(`DELETE FROM rt_arrival_events WHERE observed_at < ?`).run(evCut);
  db.prepare(`DELETE FROM rt_poll_snapshots WHERE fetched_at < ?`).run(snCut);
}
