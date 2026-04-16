/**
 * Browser-side GTFS-RT: fetches protobuf via same-origin `/api/gtfs-rt/*` proxies,
 * decodes with gtfs-realtime-bindings, merges train/LRT vehicles into the server snapshot.
 */

export type ClientVehicleRow = {
  routeId: string;
  lat: number;
  lon: number;
  vehicleLabel?: string | null;
  tripId?: string | null;
  entityId?: string;
};

type FeedEntity = {
  id?: string | null;
  tripUpdate?: {
    trip?: { routeId?: string | null; tripId?: string | null } | null;
  } | null;
  vehicle?: {
    trip?: { tripId?: string | null; routeId?: string | null } | null;
    position?: {
      latitude?: number | null;
      longitude?: number | null;
      bearing?: bigint | number | null;
      speed?: bigint | number | null;
    } | null;
    vehicle?: { id?: string | null } | null;
    currentStopSequence?: bigint | number | null;
    currentStatus?: bigint | number | string | null;
    stopId?: string | null;
  } | null;
};

type FeedMessage = {
  header?: { timestamp?: bigint | number | null };
  entity?: FeedEntity[];
};

function feedHeaderTimestamp(feed: FeedMessage): number | null {
  if (!feed.header || feed.header.timestamp == null) return null;
  const t = feed.header.timestamp;
  return typeof t === 'bigint' ? Number(t) : Number(t);
}

function tripIdToRouteFromTripFeed(feed: FeedMessage): Map<string, string> {
  const map = new Map<string, string>();
  for (const ent of feed.entity || []) {
    const tu = ent.tripUpdate;
    if (!tu || !tu.trip) continue;
    const tid = tu.trip.tripId != null ? String(tu.trip.tripId) : null;
    const rid = tu.trip.routeId != null ? String(tu.trip.routeId) : null;
    if (tid && rid) map.set(tid, rid);
  }
  return map;
}

function numFromMaybeLong(v: bigint | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isNaN(n) ? null : n;
}

function parseVehiclePositions(feed: FeedMessage, tripToRoute: Map<string, string> | null): {
  feedTimestamp: number | null;
  vehicles: ClientVehicleRow[];
} {
  const out: ClientVehicleRow[] = [];
  const feedTimestamp = feedHeaderTimestamp(feed);
  for (const ent of feed.entity || []) {
    const vp = ent.vehicle;
    if (!vp || !vp.position) continue;
    const lat = vp.position.latitude;
    const lon = vp.position.longitude;
    if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) continue;
    const tripId = vp.trip && vp.trip.tripId != null ? String(vp.trip.tripId) : null;
    let routeId = vp.trip && vp.trip.routeId != null ? String(vp.trip.routeId) : null;
    if (!routeId && tripId && tripToRoute) routeId = tripToRoute.get(tripId) || null;
    if (!routeId) continue;
    const vehicleLabel = vp.vehicle && vp.vehicle.id != null ? String(vp.vehicle.id) : null;
    out.push({
      routeId,
      lat: Number(lat),
      lon: Number(lon),
      vehicleLabel,
      tripId,
      entityId: ent.id != null ? String(ent.id) : vehicleLabel || tripId || 'unknown',
    });
  }
  return { feedTimestamp, vehicles: out };
}

function canonicalTrainRouteId(routeId: string, trainIds: Set<string>): string {
  if (trainIds.has(routeId)) return routeId;
  if (routeId.startsWith('rail:')) {
    const bare = routeId.slice('rail:'.length);
    if (trainIds.has(bare)) return bare;
  }
  return routeId;
}

function isTrainRoute(routeId: string, trainIds: Set<string>): boolean {
  if (trainIds.has(routeId)) return true;
  if (routeId.startsWith('rail:')) {
    const bare = routeId.slice('rail:'.length);
    if (trainIds.has(bare)) return true;
  }
  return false;
}

/**
 * Replaces vehicles whose route is train/LRT (from `lines`) using the live GTFS-RT feed
 * fetched in the browser (via same-origin proxy). Other modes keep the server snapshot.
 */
export async function mergeTrainVehiclesFromProxiedGtfs(
  serverVehicles: ClientVehicleRow[],
  serverMeta: { updatedAt: number | null; feedTimestamp: number | null },
  trainRouteIds: Set<string>
): Promise<{ vehicles: ClientVehicleRow[]; meta: { updatedAt: number | null; feedTimestamp: number | null } }> {
  if (trainRouteIds.size === 0) {
    return { vehicles: serverVehicles, meta: serverMeta };
  }

  const headers = { Accept: 'application/x-protobuf, application/octet-stream, */*' };
  const [tripsRes, vehRes] = await Promise.all([
    fetch('/api/gtfs-rt/trips', { headers }),
    fetch('/api/gtfs-rt/vehicles', { headers }),
  ]);
  if (!tripsRes.ok || !vehRes.ok) {
    throw new Error(`GTFS-RT proxy HTTP ${tripsRes.status} / ${vehRes.status}`);
  }

  const mod = await import('gtfs-realtime-bindings');
  const root = mod.default as { transit_realtime: { FeedMessage: { decode: (b: Uint8Array) => FeedMessage } } };
  const decode = root.transit_realtime.FeedMessage.decode;

  const tripsFeed = decode(new Uint8Array(await tripsRes.arrayBuffer()));
  const vehFeed = decode(new Uint8Array(await vehRes.arrayBuffer()));

  const tripToRoute = tripIdToRouteFromTripFeed(tripsFeed);
  const { feedTimestamp, vehicles: parsed } = parseVehiclePositions(vehFeed, tripToRoute);

  const trainParsed: ClientVehicleRow[] = parsed
    .filter((v) => isTrainRoute(v.routeId, trainRouteIds))
    .map((v) => ({
      routeId: canonicalTrainRouteId(v.routeId, trainRouteIds),
      lat: v.lat,
      lon: v.lon,
      vehicleLabel: v.vehicleLabel,
      tripId: v.tripId,
      entityId: v.entityId,
    }));

  const withoutTrain = serverVehicles.filter((v) => !isTrainRoute(v.routeId, trainRouteIds));
  const merged = [...withoutTrain, ...trainParsed];
  const now = Math.floor(Date.now() / 1000);
  return {
    vehicles: merged,
    meta: {
      updatedAt: serverMeta.updatedAt != null ? Math.max(serverMeta.updatedAt, now) : now,
      feedTimestamp: feedTimestamp ?? serverMeta.feedTimestamp,
    },
  };
}
