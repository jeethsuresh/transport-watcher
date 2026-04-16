import type Database from 'better-sqlite3';
import * as gtfsRt from './gtfsRt.js';
import * as myttc from './myttc.js';
import * as rtObs from './rtObservations.js';
import * as vehicleLoc from './vehicleLocationsDb.js';
import type { ParsedVehicle, TripUpdatesSnapshot } from './gtfsRt.js';

function stats(delays: number[], tripDelayMax: Map<string, number> | null | undefined) {
  if (!delays.length) return { max: null as number | null, avg: null as number | null, delayedTripCount: 0 };
  let max = delays[0];
  let sum = 0;
  for (const d of delays) {
    if (d > max) max = d;
    sum += d;
  }
  let delayedTripCount = 0;
  if (tripDelayMax && tripDelayMax.size) {
    for (const v of tripDelayMax.values()) {
      if (v >= 60) delayedTripCount += 1;
    }
  }
  return { max, avg: sum / delays.length, delayedTripCount };
}

function matchRouteIdFromMyttcName(db: Database.Database, name: string) {
  const m = String(name).match(/^(\d+)/);
  if (!m) return null;
  const short = m[1];
  const row = db.prepare('SELECT route_id FROM routes WHERE short_name = ?').get(short) as
    | { route_id: string }
    | undefined;
  return row ? row.route_id : null;
}

export function createPoller(
  db: Database.Database,
  options: {
    intervalMs?: number;
    onPollComplete?: () => void;
    /** When set, each successful vehicles fetch appends one row per vehicle here. */
    vehicleLocationsDb?: Database.Database | null;
  } = {}
) {
  const intervalMs = options.intervalMs || parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
  const myttcEveryN = Math.max(1, parseInt(process.env.MYTTC_EVERY_N_POLLS || '3', 10));
  const historyAllRoutes = process.env.HISTORY_ALL_ROUTES === '1';
  const onPollComplete = typeof options.onPollComplete === 'function' ? options.onPollComplete : null;
  const vehicleLocationsDb = options.vehicleLocationsDb ?? null;
  let tick = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let vehicleSnapshot: { updatedAt: number; feedTimestamp: number | null; vehicles: ParsedVehicle[] } = {
    updatedAt: 0,
    feedTimestamp: null,
    vehicles: [],
  };
  let tripUpdatesSnapshot: TripUpdatesSnapshot = {
    feedTimestamp: null,
    trips: Object.create(null),
    byRoute: Object.create(null),
  };
  let vehicleArrivalPrev = new Map<string, { status: number | null; stopId: string | null; tripId: string | null }>();
  let vehicleArrivalPrimed = false;

  async function runOnce() {
    if (running) return;
    running = true;
    const fetchedAt = Math.floor(Date.now() / 1000);
    try {
      const [tripsFeed, alertsFeed, vehiclesFeed] = await Promise.all([
        gtfsRt.fetchFeed(gtfsRt.TRIPS_URL),
        gtfsRt.fetchFeed(gtfsRt.ALERTS_URL),
        gtfsRt.fetchFeed(gtfsRt.VEHICLES_URL),
      ]);
      const tripAgg = gtfsRt.aggregateTripUpdates(tripsFeed);
      const alertAgg = gtfsRt.aggregateAlerts(alertsFeed);
      const tripToRoute = gtfsRt.tripIdToRouteFromTripFeed(tripsFeed);
      tripUpdatesSnapshot = gtfsRt.parseTripUpdatesIndex(tripsFeed);
      const vehicleParse = gtfsRt.parseVehiclePositions(vehiclesFeed, tripToRoute);
      vehicleSnapshot = {
        updatedAt: fetchedAt,
        feedTimestamp: vehicleParse.feedTimestamp,
        vehicles: vehicleParse.vehicles,
      };

      if (vehicleLocationsDb) {
        try {
          vehicleLoc.insertVehicleLocationSamples(
            vehicleLocationsDb,
            fetchedAt,
            vehicleParse.feedTimestamp,
            vehicleParse.vehicles
          );
          vehicleLoc.pruneVehicleLocationSamples(vehicleLocationsDb);
        } catch (e) {
          console.error('[vehicle-locations-db]', e instanceof Error ? e.message : e);
        }
      }

      db.transaction(() => {
        if (vehicleArrivalPrimed) {
          vehicleArrivalPrev = rtObs.recordVehicleArrivalTransitions(
            db,
            vehicleParse.vehicles,
            fetchedAt,
            tripUpdatesSnapshot.feedTimestamp,
            vehicleParse.feedTimestamp,
            vehicleArrivalPrev,
            false
          );
        } else {
          vehicleArrivalPrev = rtObs.snapshotVehicleStopState(vehicleParse.vehicles);
          vehicleArrivalPrimed = true;
        }
        const snapJson =
          process.env.RT_STORE_TRIP_SNAPSHOT_JSON === '1'
            ? rtObs.buildTripUpdatesSnapshotJson(rtObs.condensedTripUpdatesForSnapshot(tripUpdatesSnapshot))
            : null;
        rtObs.insertPollSnapshot(
          db,
          fetchedAt,
          tripUpdatesSnapshot.feedTimestamp,
          vehicleParse.feedTimestamp,
          tripsFeed.entity.length,
          vehicleParse.vehicles.length,
          snapJson
        );
      })();
      rtObs.pruneOldRows(db);

      const insertAlert = db.prepare(
        `INSERT INTO service_alerts
         (fetched_at, alert_entity_id, route_id, header, description, cause, effect)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insertHist = db.prepare(
        `INSERT INTO status_history
         (fetched_at, route_id, active_trips, max_delay_sec, avg_delay_sec,
          delayed_trip_count, alert_count, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const upsertStatus = db.prepare(
        `INSERT INTO line_status (
 route_id, updated_at, active_trips, max_delay_sec, avg_delay_sec,
           delayed_trip_count, alert_count, alert_headers, feed_timestamp
         ) VALUES (
           @route_id, @updated_at, @active_trips, @max_delay_sec, @avg_delay_sec,
           @delayed_trip_count, @alert_count, @alert_headers, @feed_timestamp
         )
         ON CONFLICT(route_id) DO UPDATE SET
           updated_at = excluded.updated_at,
           active_trips = excluded.active_trips,
           max_delay_sec = excluded.max_delay_sec,
           avg_delay_sec = excluded.avg_delay_sec,
           delayed_trip_count = excluded.delayed_trip_count,
           alert_count = excluded.alert_count,
           alert_headers = excluded.alert_headers,
           feed_timestamp = excluded.feed_timestamp`
      );

      db.transaction(() => {
        for (const ent of alertAgg.entities) {
          for (const rid of ent.routeIds) {
            insertAlert.run(
              fetchedAt,
              String(ent.id),
              rid,
              ent.header || '',
              ent.description || '',
              ent.cause || '',
              ent.effect || ''
            );
          }
        }

        const allRouteIds = new Set(
          (db.prepare('SELECT route_id FROM routes').all() as { route_id: string }[]).map((r) => r.route_id)
        );
        for (const routeId of allRouteIds) {
          const trec = tripAgg.byRoute.get(routeId);
          const delays = trec ? trec.delays : [];
          const st = stats(delays, trec ? trec.tripDelayMax : null);
          const activeTrips = trec ? trec.tripIds.size : 0;
          const arec = alertAgg.byRoute.get(routeId);
          const headers = arec ? arec.headers.slice(0, 3) : [];
          const alertCount = arec ? arec.headers.length : 0;

          upsertStatus.run({
            route_id: routeId,
            updated_at: fetchedAt,
            active_trips: activeTrips,
            max_delay_sec: st.max != null ? Math.round(st.max) : null,
            avg_delay_sec: st.avg != null ? Math.round(st.avg * 10) / 10 : null,
            delayed_trip_count: st.delayedTripCount,
            alert_count: alertCount,
            alert_headers: headers.length ? JSON.stringify(headers) : null,
            feed_timestamp: tripAgg.feedTimestamp,
          });

          const noisy =
            activeTrips > 0 ||
            alertCount > 0 ||
            (st.max != null && Math.abs(st.max) >= 60) ||
            st.delayedTripCount > 0;
          if (historyAllRoutes || noisy) {
            insertHist.run(
              fetchedAt,
              routeId,
              activeTrips,
              st.max != null ? Math.round(st.max) : null,
              st.avg != null ? Math.round(st.avg * 10) / 10 : null,
              st.delayedTripCount,
              alertCount,
              'gtfsrt'
            );
          }
        }
      })();

      tick += 1;
      if (tick % myttcEveryN === 0 && myttc.DEFAULT_STATIONS.length) {
        const station = myttc.pickStationRotation(tick);
        if (station) {
          try {
            const snap = await myttc.fetchStationJson(station);
            const ins = db.prepare(
              `INSERT OR IGNORE INTO myttc_snapshot
               (fetched_at, station_uri, route_id, route_name, next_departure_unix, next_headsign)
               VALUES (?, ?, ?, ?, ?, ?)`
            );
            db.transaction(() => {
              for (const r of snap.routes) {
                const routeId = matchRouteIdFromMyttcName(db, r.name);
                if (!routeId) continue;
                ins.run(fetchedAt, snap.stationUri, routeId, r.name, r.nextUnix, r.headsign);
              }
            })();
          } catch (e) {
            console.warn('[myttc]', e instanceof Error ? e.message : e);
          }
        }
      }
      if (onPollComplete) {
        try {
          onPollComplete();
        } catch (err) {
          console.error('[poller] onPollComplete', err);
        }
      }
    } catch (e) {
      console.error('[poller]', e);
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    void runOnce();
    timer = setInterval(() => void runOnce(), intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function getVehicleSnapshot() {
    return vehicleSnapshot;
  }

  function getTripUpdatesSnapshot() {
    return tripUpdatesSnapshot;
  }

  return { start, stop, runOnce, getVehicleSnapshot, getTripUpdatesSnapshot };
}
