const MYTTC_UA =
  process.env.MYTTC_USER_AGENT ||
  'Mozilla/5.0 (compatible; TTC-Watcher/1.0; +https://github.com/)';

export const DEFAULT_STATIONS = (process.env.MYTTC_STATIONS || 'spadina_station,finch_station,union_station')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export async function fetchStationJson(stationUri: string) {
  const url = `https://myttc.ca/${stationUri.replace(/\.json$/i, '')}.json`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': MYTTC_UA,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MyTTC ${url} HTTP ${res.status}: ${text.slice(0, 120)}`);
  let data: {
    time?: number;
    stops?: {
      routes?: {
        route_group_id?: string | number;
        name?: string;
        stop_times?: { departure_timestamp?: number; shape?: string | null }[];
      }[];
    }[];
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new Error(`MyTTC ${url}: invalid JSON (${text.slice(0, 80)}…)`);
  }
  const myttcTime = typeof data.time === 'number' ? data.time : null;
  const routes: { routeId: string; name: string; nextUnix: number | null; headsign: string | null }[] = [];
  const stops = data.stops || [];
  for (const stop of stops) {
    for (const route of stop.routes || []) {
      const routeGroupId = route.route_group_id != null ? String(route.route_group_id) : '';
      const name = route.name || '';
      const stopTimes = route.stop_times || [];
      let nextUnix: number | null = null;
      let headsign: string | null = null;
      for (const st of stopTimes) {
        const ts = st.departure_timestamp;
        if (typeof ts !== 'number') continue;
        if (nextUnix == null || ts < nextUnix) {
          nextUnix = ts;
          headsign = st.shape || null;
        }
      }
      routes.push({
        routeId: routeGroupId,
        name,
        nextUnix,
        headsign,
      });
    }
  }
  return { stationUri: stationUri.replace(/\.json$/i, ''), routes, myttcTime };
}

export function pickStationRotation(index: number) {
  if (!DEFAULT_STATIONS.length) return null;
  return DEFAULT_STATIONS[index % DEFAULT_STATIONS.length];
}
