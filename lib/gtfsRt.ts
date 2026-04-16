import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const gtfs = require('gtfs-realtime-bindings') as {
  transit_realtime: { FeedMessage: { decode: (buf: Uint8Array) => FeedMessage } };
};

type FeedMessage = {
  header?: { timestamp?: bigint | number | null };
  entity: {
    id?: string | null;
    tripUpdate?: {
      trip?: {
        routeId?: string | null;
        tripId?: string | null;
      } | null;
      stopTimeUpdate?: {
        stopId?: string | null;
        stopSequence?: bigint | number | null;
        arrival?: { time?: bigint | number | null; delay?: bigint | number | null } | null;
        departure?: { time?: bigint | number | null; delay?: bigint | number | null } | null;
      }[];
    } | null;
    alert?: {
      headerText?: { translation?: { language?: string | null; text?: string | null }[] } | null;
      descriptionText?: { translation?: { language?: string | null; text?: string | null }[] } | null;
      cause?: number | string | null;
      effect?: number | string | null;
      informedEntity?: { routeId?: string | null }[];
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
  }[];
};

export const TRIPS_URL = process.env.GTFS_RT_TRIPS_URL || 'https://bustime.ttc.ca/gtfsrt/trips';
export const ALERTS_URL = process.env.GTFS_RT_ALERTS_URL || 'https://bustime.ttc.ca/gtfsrt/alerts';
export const VEHICLES_URL = process.env.GTFS_RT_VEHICLES_URL || 'https://bustime.ttc.ca/gtfsrt/vehicles';

export async function fetchFeed(url: string): Promise<FeedMessage> {
  const res = await fetch(url, {
    headers: { Accept: 'application/x-protobuf, application/octet-stream, */*' },
  });
  if (!res.ok) throw new Error(`GTFS-RT ${url} HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return gtfs.transit_realtime.FeedMessage.decode(new Uint8Array(buf));
}

type TranslatedField = { translation?: { language?: string | null; text?: string | null }[] } | null | undefined;

function translationText(t: TranslatedField) {
  if (!t || !t.translation || !t.translation.length) return '';
  const en = t.translation.find((x) => x.language && x.language.startsWith('en'));
  return (en && en.text) || t.translation[0].text || '';
}

export function aggregateTripUpdates(feed: FeedMessage) {
  const byRoute = new Map<
    string,
    { delays: number[]; tripIds: Set<string>; tripDelayMax: Map<string, number> }
  >();
  let feedTimestamp: number | null = null;
  if (feed.header && feed.header.timestamp != null) {
    const t = feed.header.timestamp;
    feedTimestamp = typeof t === 'bigint' ? Number(t) : Number(t);
  }
  for (const ent of feed.entity) {
    const tu = ent.tripUpdate;
    if (!tu || !tu.trip) continue;
    const routeId = tu.trip.routeId != null ? String(tu.trip.routeId) : null;
    if (!routeId) continue;
    const tripId = tu.trip.tripId != null ? String(tu.trip.tripId) : ent.id != null ? String(ent.id) : '';
    let rec = byRoute.get(routeId);
    if (!rec) {
      rec = { delays: [], tripIds: new Set(), tripDelayMax: new Map() };
      byRoute.set(routeId, rec);
    }
    rec.tripIds.add(tripId);
    let tripMax = rec.tripDelayMax.get(tripId);
    if (tripMax == null) tripMax = 0;
    if (!tu.stopTimeUpdate) continue;
    for (const stu of tu.stopTimeUpdate) {
      for (const ev of [stu.arrival, stu.departure]) {
        if (!ev) continue;
        if (ev.delay != null) {
          const d = typeof ev.delay === 'bigint' ? Number(ev.delay) : Number(ev.delay);
          if (!Number.isNaN(d)) {
            rec.delays.push(d);
            if (d > tripMax) tripMax = d;
          }
        }
      }
    }
    rec.tripDelayMax.set(tripId, tripMax);
  }
  return { byRoute, feedTimestamp };
}

export function aggregateAlerts(feed: FeedMessage) {
  const byRoute = new Map<string, { headers: string[]; descriptions: string[]; headerSet: Set<string> }>();
  const entities: {
    id: string;
    header: string;
    description: string;
    cause: string;
    effect: string;
    routeIds: string[];
  }[] = [];
  for (const ent of feed.entity) {
    const a = ent.alert;
    if (!a) continue;
    const header = translationText(a.headerText as TranslatedField);
    const description = translationText(a.descriptionText as TranslatedField);
    const cause = a.cause != null ? String(a.cause) : '';
    const effect = a.effect != null ? String(a.effect) : '';
    entities.push({
      id: ent.id != null ? String(ent.id) : '',
      header,
      description,
      cause,
      effect,
      routeIds: [],
    });
    const idx = entities.length - 1;
    if (!a.informedEntity) continue;
    for (const ie of a.informedEntity) {
      if (ie.routeId == null) continue;
      const rid = String(ie.routeId);
      entities[idx].routeIds.push(rid);
      let rec = byRoute.get(rid);
      if (!rec) {
        rec = { headers: [], descriptions: [], headerSet: new Set() };
        byRoute.set(rid, rec);
      }
      if (header && !rec.headerSet.has(header)) {
        rec.headerSet.add(header);
        rec.headers.push(header);
      }
      if (description) rec.descriptions.push(description);
    }
  }
  return { byRoute, entities };
}

export function tripIdToRouteFromTripFeed(feed: FeedMessage) {
  const map = new Map<string, string>();
  for (const ent of feed.entity) {
    const tu = ent.tripUpdate;
    if (!tu || !tu.trip) continue;
    const tid = tu.trip.tripId != null ? String(tu.trip.tripId) : null;
    const rid = tu.trip.routeId != null ? String(tu.trip.routeId) : null;
    if (tid && rid) map.set(tid, rid);
  }
  return map;
}

export function feedHeaderTimestamp(feed: FeedMessage) {
  if (!feed.header || feed.header.timestamp == null) return null;
  const t = feed.header.timestamp;
  return typeof t === 'bigint' ? Number(t) : Number(t);
}

function numFromMaybeLong(v: bigint | number | null | undefined) {
  if (v == null) return null;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isNaN(n) ? null : n;
}

export function parseTripUpdatesIndex(feed: FeedMessage) {
  const trips: Record<
    string,
    {
      routeId: string;
      updates: { stopId: string | null; stopSequence: number | null; arrTime: number | null; depTime: number | null }[];
    }
  > = Object.create(null);
  const byRoute: Record<string, string[]> = Object.create(null);
  const feedTimestamp = feedHeaderTimestamp(feed);

  for (const ent of feed.entity) {
    const tu = ent.tripUpdate;
    if (!tu || !tu.trip) continue;
    const routeId = tu.trip.routeId != null ? String(tu.trip.routeId) : null;
    const tripId = tu.trip.tripId != null ? String(tu.trip.tripId) : null;
    if (!routeId || !tripId) continue;

    const updates: {
      stopId: string | null;
      stopSequence: number | null;
      arrTime: number | null;
      depTime: number | null;
    }[] = [];
    for (const stu of tu.stopTimeUpdate || []) {
      const stopId = stu.stopId != null ? String(stu.stopId) : null;
      let stopSequence: number | null = null;
      if (stu.stopSequence != null) {
        const s = numFromMaybeLong(stu.stopSequence);
        stopSequence = s != null && s > 0 ? s : null;
      }
      let arrTime: number | null = null;
      let depTime: number | null = null;
      if (stu.arrival && stu.arrival.time != null) {
        arrTime = numFromMaybeLong(stu.arrival.time);
      }
      if (stu.departure && stu.departure.time != null) {
        depTime = numFromMaybeLong(stu.departure.time);
      }
      updates.push({ stopId, stopSequence, arrTime, depTime });
    }

    trips[tripId] = { routeId, updates };
    if (!byRoute[routeId]) byRoute[routeId] = [];
    byRoute[routeId].push(tripId);
  }

  for (const rid of Object.keys(byRoute)) {
    byRoute[rid] = [...new Set(byRoute[rid])];
  }

  return { feedTimestamp, trips, byRoute };
}

export type TripUpdatesSnapshot = ReturnType<typeof parseTripUpdatesIndex>;

export type ParsedVehicle = {
  entityId: string;
  tripId: string | null;
  routeId: string;
  vehicleLabel: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  speed: number | null;
  currentStopSequence: number | null;
  currentStopStatus: number | null;
  stopId: string | null;
};

export function parseVehiclePositions(feed: FeedMessage, tripToRoute: Map<string, string> | null) {
  const vehicles: ParsedVehicle[] = [];
  const feedTimestamp = feedHeaderTimestamp(feed);
  for (const ent of feed.entity) {
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
    let bearing: number | null = null;
    if (vp.position.bearing != null) {
      const b = vp.position.bearing;
      bearing = typeof b === 'bigint' ? Number(b) : Number(b);
      if (Number.isNaN(bearing)) bearing = null;
    }
    let speed: number | null = null;
    if (vp.position.speed != null) {
      const s = vp.position.speed;
      speed = typeof s === 'bigint' ? Number(s) : Number(s);
      if (Number.isNaN(speed)) speed = null;
    }

    let currentStopSequence: number | null = null;
    if (vp.currentStopSequence != null) {
      const cs = numFromMaybeLong(vp.currentStopSequence);
      if (cs != null && cs > 0) currentStopSequence = cs;
    }
    let currentStopStatus: number | null = null;
    if (vp.currentStatus != null && vp.currentStatus !== '') {
      const c = numFromMaybeLong(vp.currentStatus as bigint | number);
      if (c != null && c >= 0 && c <= 2) currentStopStatus = c;
    }

    let stopId: string | null = null;
    if (vp.stopId != null && String(vp.stopId).trim()) stopId = String(vp.stopId).trim();

    vehicles.push({
      entityId: ent.id != null ? String(ent.id) : vehicleLabel || tripId || 'unknown',
      tripId,
      routeId,
      vehicleLabel,
      lat: Number(lat),
      lon: Number(lon),
      bearing,
      speed,
      currentStopSequence,
      currentStopStatus,
      stopId,
    });
  }
  return { feedTimestamp, vehicles };
}
