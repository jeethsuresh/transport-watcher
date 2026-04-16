/**
 * Shared JSON builders for HTTP and Socket.IO.
 */

import type Database from 'better-sqlite3';

export function buildLinesList(db: Database.Database) {
  /** Pin state is applied in the browser (localStorage), not on the server. */
  const routes = db
    .prepare(
      `SELECT r.route_id, r.short_name, r.long_name, r.mode,
              s.updated_at, s.active_trips, s.max_delay_sec, s.avg_delay_sec,
              s.delayed_trip_count, s.alert_count, s.alert_headers, s.feed_timestamp
       FROM routes r
       LEFT JOIN line_status s ON s.route_id = r.route_id
       ORDER BY r.mode ASC, CAST(r.short_name AS INTEGER), r.short_name`
    )
    .all() as {
    route_id: string;
    short_name: string;
    long_name: string;
    mode: string;
    updated_at: number | null;
    active_trips: number | null;
    max_delay_sec: number | null;
    avg_delay_sec: number | null;
    delayed_trip_count: number | null;
    alert_count: number | null;
    alert_headers: string | null;
    feed_timestamp: number | null;
  }[];

  const myttcStmt = db.prepare(
    `SELECT station_uri, next_departure_unix, next_headsign, fetched_at
     FROM myttc_snapshot
     WHERE route_id = ?
     ORDER BY fetched_at DESC
     LIMIT 1`
  );

  const list = routes.map((row) => {
    let alertHeaders: string[] | null = null;
    if (row.alert_headers) {
      try {
        alertHeaders = JSON.parse(row.alert_headers) as string[];
      } catch {
        alertHeaders = null;
      }
    }
    let myttcRow = myttcStmt.get(row.route_id) as
      | {
          station_uri: string;
          next_departure_unix: number | null;
          next_headsign: string | null;
          fetched_at: number;
        }
      | undefined;
    return {
      routeId: row.route_id,
      shortName: row.short_name,
      longName: row.long_name,
      mode: row.mode,
      pinned: false,
      pinPosition: null,
      status: {
        updatedAt: row.updated_at,
        activeTrips: row.active_trips,
        maxDelaySec: row.max_delay_sec,
        avgDelaySec: row.avg_delay_sec,
        delayedTripCount: row.delayed_trip_count,
        alertCount: row.alert_count,
        alertHeaders,
        feedTimestamp: row.feed_timestamp,
      },
      myttc: myttcRow
        ? {
            stationUri: myttcRow.station_uri,
            nextDepartureUnix: myttcRow.next_departure_unix,
            nextHeadsign: myttcRow.next_headsign,
            fetchedAt: myttcRow.fetched_at,
          }
        : null,
    };
  });

  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned && a.pinPosition != null && b.pinPosition != null) {
      return a.pinPosition - b.pinPosition;
    }
    const order = { train_lrt: 0, streetcar: 1, bus: 2 } as const;
    const mo = order[a.mode as keyof typeof order] - order[b.mode as keyof typeof order];
    if (mo !== 0) return mo;
    const an = parseInt(a.shortName, 10);
    const bn = parseInt(b.shortName, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && String(an) === a.shortName && String(bn) === b.shortName) {
      return an - bn;
    }
    return a.shortName.localeCompare(b.shortName, undefined, { numeric: true });
  });

  return list;
}

export function filterAndSortLines(list: ReturnType<typeof buildLinesList>, q: string, modeFilter: string) {
  let out = list;
  if (modeFilter && ['bus', 'streetcar', 'train_lrt'].includes(modeFilter)) {
    out = out.filter((l) => l.mode === modeFilter);
  }
  if (q) {
    out = out.filter((l) => {
      const hay = `${l.shortName} ${l.longName} ${l.routeId}`.toLowerCase();
      return hay.includes(q);
    });
  }
  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned && a.pinPosition != null && b.pinPosition != null) {
      return a.pinPosition - b.pinPosition;
    }
    const order = { train_lrt: 0, streetcar: 1, bus: 2 } as const;
    const mo = order[a.mode as keyof typeof order] - order[b.mode as keyof typeof order];
    if (mo !== 0) return mo;
    const an = parseInt(a.shortName, 10);
    const bn = parseInt(b.shortName, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && String(an) === a.shortName && String(bn) === b.shortName) {
      return an - bn;
    }
    return a.shortName.localeCompare(b.shortName, undefined, { numeric: true });
  });
  return out;
}

export function buildVehiclesPayload(poller: {
  getVehicleSnapshot: () => {
    updatedAt: number;
    feedTimestamp: number | null;
    vehicles: unknown[];
  };
}) {
  const snap = poller.getVehicleSnapshot();
  return {
    updatedAt: snap.updatedAt,
    feedTimestamp: snap.feedTimestamp,
    count: snap.vehicles.length,
    vehicles: snap.vehicles,
  };
}

/** Full snapshot for sockets (all lines; client filters locally). */
export function buildSnapshot(db: Database.Database, poller: Parameters<typeof buildVehiclesPayload>[0]) {
  const lines = buildLinesList(db);
  const v = buildVehiclesPayload(poller);
  return {
    lines,
    count: lines.length,
    vehicleUpdatedAt: v.updatedAt,
    vehicleFeedTimestamp: v.feedTimestamp,
    vehicleCount: v.count,
    vehicles: v.vehicles,
  };
}
