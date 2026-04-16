// @ts-nocheck
import L from 'leaflet';
import { io as ioClient, type Socket } from 'socket.io-client';

type LineRow = {
  routeId: string;
  shortName: string;
  longName?: string;
  mode: string;
  pinned: boolean;
  pinPosition?: number | null;
  status?: {
    updatedAt?: number | null;
    activeTrips?: number | null;
    maxDelaySec?: number | null;
    alertCount?: number | null;
    alertHeaders?: string[] | null;
    feedTimestamp?: number | null;
  };
  myttc?: { nextDepartureUnix?: number | null } | null;
};

type VehicleRow = {
  routeId: string;
  lat: number;
  lon: number;
  vehicleLabel?: string | null;
  tripId?: string | null;
  entityId?: string;
};

let appRoot: HTMLElement | null = null;
let searchEl: HTMLInputElement | null = null;
let pinnedListEl: HTMLElement | null = null;
let routesListTrainEl: HTMLElement | null = null;
let routesListStreetcarEl: HTMLElement | null = null;
let routesListBusEl: HTMLElement | null = null;
let pinnedEmptyEl: HTMLElement | null = null;
let emptyTrainEl: HTMLElement | null = null;
let emptyStreetcarEl: HTMLElement | null = null;
let emptyBusEl: HTMLElement | null = null;
let routeAccordionEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let mapLegendEl: HTMLElement | null = null;
let panelRoutes: HTMLElement | null = null;
let panelStops: HTMLElement | null = null;
let stopSearchEl: HTMLInputElement | null = null;
let stopsListEl: HTMLElement | null = null;
let stopSearchHintEl: HTMLElement | null = null;
let inspectPanel: HTMLElement | null = null;
let inspectTitle: HTMLElement | null = null;
let inspectBody: HTMLElement | null = null;
let inspectClose: HTMLElement | null = null;
let sidebarToggle: HTMLElement | null = null;
let sidebarClose: HTMLElement | null = null;
let sidebarBackdrop: HTMLElement | null = null;
let sidebarEl: HTMLElement | null = null;

let sidebarOpen = false;
let swipeTouchStartX = 0;
let swipeTouchStartY = 0;
let lines: LineRow[] = [];
let vehicles: VehicleRow[] = [];
let vehicleMeta: { updatedAt: number | null; feedTimestamp: number | null } = { updatedAt: null, feedTimestamp: null };
let selectedRouteId: string | null = null;
let selectedStopId: string | null = null;
let inspectKind: 'cluster' | 'stop' | 'route' | null = null;
let stopMarkerGen = 0;
let inspectPollTimer: ReturnType<typeof setInterval> | null = null;
/** Invalidates in-flight cluster inspect loads when the panel switches or closes. */
let inspectAsyncGen = 0;
let sidebarMode = 'routes';
let lastFitKey = '';
let lastHistoryPinsKey = '';
let historyPathGen = 0;

const ROUTE_SECTIONS = [
  { id: 'pinned', title: '📌', ariaLabel: 'Pinned routes' },
  { id: 'train', title: '🚇', ariaLabel: 'Train and LRT routes' },
  { id: 'streetcar', title: '🚋', ariaLabel: 'Streetcar routes' },
  { id: 'bus', title: '🚌', ariaLabel: 'Bus routes' },
];

let expandedRouteSection = 'pinned';

let map: L.Map | undefined;
let tileLayer: L.TileLayer | undefined;
let historyPathLayer: L.LayerGroup | undefined;
let vehicleLayer: L.LayerGroup | undefined;
let stopLayer: L.LayerGroup | undefined;
let socket: Socket | null = null;
let socketConnected = false;

function modeLabel(m) {
  switch (m) {
    case 'train_lrt':
      return 'Train / LRT';
    case 'streetcar':
      return 'Streetcar';
    case 'bus':
      return 'Bus';
    default:
      return m;
  }
}

function formatTime(ts) {
  if (ts == null) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  });
}

function formatEtaMins(m) {
  if (m == null) return '—';
  if (m === 0) return 'Due';
  return `${m} min`;
}

function delayLabel(sec) {
  if (sec == null) return null;
  if (Math.abs(sec) < 60) return 'On time (feed)';
  const m = Math.round(sec / 60);
  return `${m >= 0 ? '+' : ''}${m} min (max trip delay)`;
}

function routeColor(routeId) {
  let h = 0;
  for (let i = 0; i < routeId.length; i++) h = (h * 31 + routeId.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 78% 52%)`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** GTFS-RT vehicle position speed is m/s */
function formatSpeedKmh(mps) {
  if (mps == null || Number.isNaN(mps)) return null;
  const kmh = mps * 3.6;
  return `${kmh < 10 ? kmh.toFixed(1) : Math.round(kmh)} km/h`;
}

function formatLatLon(lat, lon) {
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return `${Number(lat).toFixed(4)}°, ${Number(lon).toFixed(4)}°`;
}

function htmlRouteVehicleCard(v) {
  const label = v.vehicleLabel || v.entityId || 'Vehicle';
  const title = escapeHtml(label);
  const feedEntityNote =
    v.entityId && v.vehicleLabel && String(v.entityId) !== String(v.vehicleLabel)
      ? `<div class="inspect-vehicle__feed-id">Feed entity <span class="stop-card__id">${escapeHtml(v.entityId)}</span></div>`
      : '';
  const main = escapeHtml(v.positionDescription || '—');
  const headsign =
    v.tripHeadsign && String(v.tripHeadsign).trim()
      ? `<div class="inspect-vehicle__headsign">Towards ${escapeHtml(String(v.tripHeadsign).trim())}</div>`
      : '';
  const statusLine = v.stopStatusLabel
    ? `<div class="inspect-vehicle__status">${escapeHtml(v.stopStatusLabel)}</div>`
    : '';
  const ids = [];
  if (v.tripId) ids.push(`Trip <span class="stop-card__id">${escapeHtml(v.tripId)}</span>`);
  if (v.stopId) ids.push(`Stop <span class="stop-card__id">${escapeHtml(v.stopId)}</span>`);
  if (v.currentStopSequence != null) ids.push(`Seq. ${escapeHtml(String(v.currentStopSequence))}`);
  const idsBlock = ids.length ? `<div class="inspect-vehicle__ids">${ids.join(' · ')}</div>` : '';
  const telem = [];
  const ll = formatLatLon(v.lat, v.lon);
  if (ll) telem.push(ll);
  const sp = formatSpeedKmh(v.speed);
  if (sp) telem.push(sp);
  if (v.bearing != null && !Number.isNaN(v.bearing)) telem.push(`${Math.round(Number(v.bearing))}°`);
  const telemBlock = telem.length
    ? `<div class="inspect-vehicle__telem">${telem.join(' · ')}</div>`
    : '';
  return `<div class="inspect-vehicle">
    <strong>${title}</strong>
    ${feedEntityNote}
    <div class="inspect-vehicle__where">${main}</div>
    ${headsign}
    ${statusLine}
    ${idsBlock}
    ${telemBlock}
  </div>`;
}

const VEHICLE_PIN_SIZE = 30;
/** Group stops within this distance (meters)—typical cross-street / same-intersection spacing. */
const STOP_CLUSTER_RADIUS_M = 72;
const STOPS_MAP_PANE = 'stopsAboveVehicles';

/** Hide static GTFS routes at a stop unless the trip feed predicts arrival within this many minutes. */
const ARRIVAL_SOON_MAX_MINUTES = 60;

function lineHasImminentArrival(ln: { minutesUntil?: number | null }) {
  const m = ln.minutesUntil;
  return m != null && m <= ARRIVAL_SOON_MAX_MINUTES;
}

function distMeters(a, b) {
  const R = 6371000;
  const ph1 = (a.lat * Math.PI) / 180;
  const ph2 = (b.lat * Math.PI) / 180;
  const dph = ((b.lat - a.lat) * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const x = Math.sin(dph / 2) ** 2 + Math.cos(ph1) * Math.cos(ph2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function clusterStopsByDistance(stops, radiusM) {
  const n = stops.length;
  if (n === 0) return [];
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  }
  function union(i, j) {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (distMeters(stops[i], stops[j]) <= radiusM) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(stops[i]);
  }
  return [...groups.values()].map((g) =>
    g.slice().sort((x, y) => {
      const nx = (x.stopName || '').localeCompare(y.stopName || '', undefined, { sensitivity: 'base' });
      if (nx !== 0) return nx;
      return String(x.stopId).localeCompare(String(y.stopId));
    })
  );
}

function clusterCentroid(cluster) {
  let lat = 0;
  let lon = 0;
  for (const s of cluster) {
    lat += s.lat;
    lon += s.lon;
  }
  const n = cluster.length;
  return { lat: lat / n, lon: lon / n };
}

function clusterTooltipText(cluster) {
  if (cluster.length === 1) return cluster[0].stopName || cluster[0].stopId;
  const maxLines = 8;
  const lines = cluster.slice(0, maxLines).map((s) => s.stopName || s.stopId);
  let t = lines.join('\n');
  if (cluster.length > maxLines) t += `\n+${cluster.length - maxLines} more`;
  return t;
}

function wireClusterInspectBody() {
  if (!inspectBody) return;
  inspectBody.querySelectorAll('.cluster-arrival-row[data-stop-id]').forEach((row) => {
    row.onclick = () => {
      const id = row.getAttribute('data-stop-id');
      if (id) selectStop(id, { pan: true });
    };
  });
  inspectBody.querySelectorAll('.cluster-stop-btn[data-stop-id]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-stop-id');
      if (id) selectStop(id, { pan: true });
    };
  });
}

async function loadClusterInspectBody(cluster, loadGen) {
  try {
    const results = await Promise.all(
      cluster.map((s) =>
        fetch(`/api/stops/${encodeURIComponent(s.stopId)}`).then((r) => (r.ok ? r.json() : null))
      )
    );
    if (loadGen !== inspectAsyncGen || inspectKind !== 'cluster') return;

    const arrivalRows = [];
    for (let i = 0; i < cluster.length; i++) {
      const data = results[i];
      const stop = cluster[i];
      const stopLabel = stop.stopName || stop.stopId;
      if (!data?.lines?.length) continue;
      for (const ln of data.lines) {
        if (!lineHasImminentArrival(ln)) continue;
        const dest =
          (ln.tripHeadsign && String(ln.tripHeadsign).trim()) || ln.longName || '—';
        arrivalRows.push({
          stopId: stop.stopId,
          stopLabel,
          shortName: ln.shortName,
          dest,
          minutesUntil: ln.minutesUntil,
        });
      }
    }

    arrivalRows.sort((a, b) => {
      const ma = a.minutesUntil;
      const mb = b.minutesUntil;
      if (ma == null && mb == null) return 0;
      if (ma == null) return 1;
      if (mb == null) return -1;
      return ma - mb;
    });

    const tableBody =
      arrivalRows.length === 0
        ? '<p class="cluster-overlay__empty">No live predictions for these stops right now.</p>'
        : `<table class="cluster-overlay__table">
            <thead><tr><th>Line</th><th>Towards</th><th>ETA</th><th>Stop</th></tr></thead>
            <tbody>
            ${arrivalRows
              .map(
                (r) =>
                  `<tr class="cluster-arrival-row" data-stop-id="${escapeHtml(String(r.stopId))}">
                    <td><strong>${escapeHtml(String(r.shortName))}</strong></td>
                    <td>${escapeHtml(r.dest)}</td>
                    <td>${escapeHtml(formatEtaMins(r.minutesUntil))}</td>
                    <td class="cluster-overlay__platform">${escapeHtml(r.stopLabel)}</td>
                  </tr>`
              )
              .join('')}
            </tbody>
          </table>`;

    const stopBtns = cluster
      .map(
        (s) =>
          `<button type="button" class="cluster-stop-btn" data-stop-id="${escapeHtml(String(s.stopId))}">${escapeHtml(
            s.stopName || s.stopId
          )}</button>`
      )
      .join('');

    const html = `<div class="cluster-overlay">
      <div class="cluster-overlay__arrivals-scroll">${tableBody}</div>
      <p class="cluster-overlay__hint">Tap a row for full stop detail. All stops:</p>
      <div class="cluster-overlay__stop-btns">${stopBtns}</div>
    </div>`;

    if (loadGen !== inspectAsyncGen || inspectKind !== 'cluster') return;
    if (!inspectBody) return;
    inspectBody.innerHTML = html;
    wireClusterInspectBody();
  } catch {
    if (loadGen !== inspectAsyncGen || inspectKind !== 'cluster') return;
    if (inspectBody) inspectBody.innerHTML = '<p class="cluster-overlay__err">Could not load arrivals.</p>';
  }
}

function openClusterInspect(cluster) {
  if (!inspectPanel || !inspectBody || !inspectTitle) return;
  inspectAsyncGen++;
  const gen = inspectAsyncGen;
  inspectKind = 'cluster';
  selectedStopId = null;
  inspectPanel.hidden = false;
  inspectPanel.classList.add('inspect-panel--cluster');
  clearInspectPoll();
  inspectTitle.textContent = `${cluster.length} stops · combined arrivals`;
  inspectBody.innerHTML = '<p class="inspect-loading">Loading…</p>';
  if (map && cluster.length) {
    const { lat, lon } = clusterCentroid(cluster);
    map.panTo([lat, lon], { animate: true });
  }
  renderStopSearchResultsHighlight();
  void syncStopMarkers();
  void loadClusterInspectBody(cluster, gen);
}

function vehicleMarkerIcon(fill, shortName) {
  const label = shortName || '—';
  const len = label.length;
  const fontPx = len <= 2 ? 12 : len <= 3 ? 10 : len <= 4 ? 9 : 8;
  const inner = `<div class="vehicle-marker__disc" style="--pin-fill:${fill};font-size:${fontPx}px">${escapeHtml(label)}</div>`;
  return L.divIcon({
    className: 'vehicle-marker',
    html: inner,
    iconSize: [VEHICLE_PIN_SIZE, VEHICLE_PIN_SIZE],
    iconAnchor: [VEHICLE_PIN_SIZE / 2, VEHICLE_PIN_SIZE / 2],
    popupAnchor: [0, -VEHICLE_PIN_SIZE / 2],
  });
}

function shortNameByRouteId() {
  const m = new Map();
  for (const l of lines) m.set(l.routeId, l.shortName);
  return m;
}

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true });
  map.setView([43.7, -79.38], 11);
  tileLayer = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> ' +
        '&copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }
  );
  tileLayer.addTo(map);
  historyPathLayer = L.layerGroup().addTo(map);
  vehicleLayer = L.layerGroup().addTo(map);
  stopLayer = L.layerGroup().addTo(map);
  const stopsPane = map.createPane(STOPS_MAP_PANE);
  stopsPane.style.zIndex = 620;
  stopsPane.style.pointerEvents = 'auto';
  if (map.zoomControl) map.zoomControl.setPosition('topright');
  window.addEventListener('resize', () => {
    map?.invalidateSize();
  });
}

/** Routes whose live vehicles are drawn on the map (pinned ∪ selected). */
function visibleRouteIdsForVehicles() {
  const pinned = lines.filter((l) => l.pinned).map((l) => l.routeId);
  const set = new Set(pinned);
  if (selectedRouteId) set.add(selectedRouteId);
  return set;
}

/**
 * Routes used to place stop markers: selected line only when one is focused, otherwise all pinned.
 * Avoids showing every pinned line's stops while inspecting a single route.
 */
function visibleRouteIdsForStopMarkers() {
  if (selectedRouteId) return new Set([selectedRouteId]);
  const pinned = lines.filter((l) => l.pinned).map((l) => l.routeId);
  return new Set(pinned);
}

function clearInspectPoll() {
  if (inspectPollTimer) {
    clearInterval(inspectPollTimer);
    inspectPollTimer = null;
  }
}

function closeInspectPanel() {
  if (!inspectPanel || !inspectBody || !inspectTitle) return;
  inspectAsyncGen++;
  inspectPanel.hidden = true;
  inspectPanel.classList.remove('inspect-panel--cluster');
  inspectKind = null;
  selectedStopId = null;
  clearInspectPoll();
  inspectBody.innerHTML = '';
  inspectTitle.textContent = '';
}

async function syncStopMarkers() {
  if (!map || !stopLayer) return;
  const gen = ++stopMarkerGen;
  stopLayer.clearLayers();
  const rids = [...visibleRouteIdsForStopMarkers()];
  if (!rids.length) return;

  const byStop = new Map();
  for (const rid of rids) {
    try {
      const res = await fetch(`/api/routes/${encodeURIComponent(rid)}/stops`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const s of data.stops || []) {
        if (!byStop.has(s.stopId)) byStop.set(s.stopId, s);
      }
    } catch {
      /* ignore */
    }
    if (gen !== stopMarkerGen) return;
  }
  // A newer sync may have cleared the layer while we were awaiting fetches; do not redraw stale routes.
  if (gen !== stopMarkerGen) return;

  const rawStops = [...byStop.values()].filter((s) => s.lat != null && s.lon != null);
  const clusters = clusterStopsByDistance(rawStops, STOP_CLUSTER_RADIUS_M);

  for (const cluster of clusters) {
    const { lat, lon } = clusterCentroid(cluster);
    const isSel = cluster.some((s) => selectedStopId === s.stopId);
    const m = L.circleMarker([lat, lon], {
      pane: STOPS_MAP_PANE,
      radius: isSel ? 8 : cluster.length > 1 ? 6 : 4,
      color: isSel ? '#4da3ff' : '#5c6a7e',
      weight: isSel ? 2 : cluster.length > 1 ? 2 : 1,
      fillColor: '#1a2130',
      fillOpacity: 0.92,
    });
    m.bindTooltip(clusterTooltipText(cluster), { sticky: true });
    if (cluster.length === 1) {
      m.on('click', () => {
        selectStop(cluster[0].stopId, { pan: true });
      });
    } else {
      m.on('click', () => {
        openClusterInspect(cluster);
      });
    }
    m.addTo(stopLayer);
  }
}

function selectStop(stopId, opts: { pan?: boolean } = {}) {
  if (!inspectPanel || !inspectBody) return;
  inspectAsyncGen++;
  selectedStopId = stopId;
  inspectKind = 'stop';
  inspectPanel.classList.remove('inspect-panel--cluster');
  inspectPanel.hidden = false;
  clearInspectPoll();
  inspectPollTimer = setInterval(() => {
    if (inspectKind === 'stop' && selectedStopId) void refreshStopInspectBody(selectedStopId);
  }, 15000);
  void refreshStopInspectBody(stopId);
  if (opts.pan && map) {
    void (async () => {
      try {
        const r = await fetch(`/api/stops/${encodeURIComponent(stopId)}`);
        if (r.ok) {
          const d = await r.json();
          if (map && d.stop?.lat != null && d.stop?.lon != null) {
            map.panTo([d.stop.lat, d.stop.lon], { animate: true });
          }
        }
      } catch {
        /* ignore */
      }
    })();
  }
  renderStopSearchResultsHighlight();
  void syncStopMarkers();
}

async function refreshStopInspectBody(stopId) {
  if (inspectKind !== 'stop' || selectedStopId !== stopId) return;
  if (!inspectTitle || !inspectBody) return;
  try {
    const res = await fetch(`/api/stops/${encodeURIComponent(stopId)}`);
    if (!res.ok) {
      inspectTitle.textContent = 'Stop';
      inspectBody.innerHTML = `<p>${res.status === 404 ? 'Stop not found.' : 'Could not load stop.'}</p>`;
      return;
    }
    const data = await res.json();
    inspectTitle.textContent = data.stop?.stopName || stopId;
    const soonLines = (data.lines || []).filter(lineHasImminentArrival);
    const linesRows = soonLines
      .map((ln) => {
        const dest =
          (ln.tripHeadsign && String(ln.tripHeadsign).trim()) || ln.longName || '—';
        return `<tr><td><strong>${escapeHtml(ln.shortName)}</strong> <span class="stop-card__id">${escapeHtml(
          modeLabel(ln.mode)
        )}</span></td><td>${escapeHtml(dest)}</td><td>${formatEtaMins(ln.minutesUntil)}</td></tr>`;
      })
      .join('');
    const hw = data.headwayHeuristic;
    const headwayBlock =
      hw &&
      `<div class="inspect-section">
        <h3>Headway heuristic (logged vehicles)</h3>
        <p style="margin:0 0 0.35rem" class="stop-card__id">
          Avg gap (30-day lookback, +/-30 min clock): ${hw.avgHeadwayMinutes != null ? `${hw.avgHeadwayMinutes} min` : '—'}
          · since last arrival: ${hw.minutesSinceLastArrival != null ? `${hw.minutesSinceLastArrival} min` : '—'}
          · est. delay: ${hw.estimatedDelayMinutes != null ? `${hw.estimatedDelayMinutes} min` : '—'}
        </p>
        <p class="inspect-loading" style="margin:0">From ${hw.gapSampleCount} inter-arrival gaps (${hw.windowArrivalCount} arrivals in time band). Sparse data means wider uncertainty.</p>
      </div>`;
    inspectBody.innerHTML = `
      <p class="stop-card__id" style="margin:0 0 0.5rem">ID ${escapeHtml(data.stop.stopId)} · trip updates ${formatTime(data.tripFeedTimestamp)}</p>
      ${headwayBlock || ''}
      <div class="inspect-section">
        <h3>Arriving soon (live feed)</h3>
        <table class="inspect-table">
          <thead><tr><th>Line</th><th>Towards</th><th>Next arrival (approx.)</th></tr></thead>
          <tbody>${
            linesRows ||
            '<tr><td colspan="3">No imminent arrivals in the trip feed for this stop (within ' +
              ARRIVAL_SOON_MAX_MINUTES +
              ' min).</td></tr>'
          }</tbody>
        </table>
      </div>
      <p class="inspect-loading" style="margin-top:0.5rem">Only routes with a matching GTFS-RT prediction are listed (within ~${ARRIVAL_SOON_MAX_MINUTES} min).</p>
    `;
  } catch {
    inspectBody.innerHTML = '<p>Failed to load stop.</p>';
  }
}

async function refreshRouteInspectBody(routeId) {
  if (inspectKind !== 'route' || selectedRouteId !== routeId) return;
  if (!inspectTitle || !inspectBody) return;
  const line = lines.find((l) => l.routeId === routeId);
  inspectTitle.textContent = line ? `${line.shortName} · ${line.longName || line.shortName}` : routeId;
  try {
    const res = await fetch(`/api/routes/${encodeURIComponent(routeId)}/live`);
    if (!res.ok) {
      inspectBody.innerHTML = '<p>Could not load live route data.</p>';
      return;
    }
    const data = await res.json();
    if (!data.gtfsImported) {
      inspectBody.innerHTML =
        '<p>Stop and ETA features need a one-time static import. Run <code>npm run import-gtfs</code> on the server.</p>';
      return;
    }
    const vehList = data.vehicles || [];
    const vehBlocks = vehList.map((v) => htmlRouteVehicleCard(v)).join('');
    const vehCount = vehList.length;
    const stopRows = (data.stopArrivals || [])
      .map(
        (s) =>
          `<tr><td>${escapeHtml(s.stopName)}</td><td>${formatEtaMins(s.minutesUntil)}</td><td class="stop-card__id">${escapeHtml(
            s.stopId
          )}</td></tr>`
      )
      .join('');
    inspectBody.innerHTML = `
      <p class="inspect-loading" style="margin:0 0 0.65rem">Trip feed ${formatTime(data.tripFeedTimestamp)} · vehicles ${formatTime(
      data.vehicleFeedTimestamp
    )}</p>
      <div class="inspect-section">
        <h3>Minutes to each stop (from trip updates)</h3>
        <div style="max-height:220px;overflow:auto">
          <table class="inspect-table">
            <thead><tr><th>Stop</th><th>ETA</th><th>ID</th></tr></thead>
            <tbody>${stopRows || '<tr><td colspan="3">No imported stops for this route.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <details class="inspect-section inspect-section--collapsible">
        <summary class="inspect-section__summary">Vehicles on this line (${vehCount})</summary>
        <div class="inspect-section__collapsible-body">
          ${
            vehBlocks ||
            '<p class="inspect-loading" style="margin:0">No vehicles in the live feed for this route right now.</p>'
          }
        </div>
      </details>
    `;
  } catch {
    inspectBody.innerHTML = '<p>Failed to load route.</p>';
  }
}

function openInspectRoute(routeId) {
  if (!inspectPanel || !inspectBody) return;
  inspectAsyncGen++;
  inspectKind = 'route';
  inspectPanel.hidden = false;
  inspectPanel.classList.remove('inspect-panel--cluster');
  clearInspectPoll();
  inspectBody.innerHTML = '<p class="inspect-loading">Loading…</p>';
  void refreshRouteInspectBody(routeId);
  inspectPollTimer = setInterval(() => {
    if (inspectKind === 'route' && selectedRouteId === routeId) void refreshRouteInspectBody(routeId);
  }, 15000);
}

function renderStopSearchResultsHighlight() {
  stopsListEl?.querySelectorAll('.stop-card').forEach((el) => {
    el.classList.toggle('is-selected', el.getAttribute('data-stop-id') === selectedStopId);
  });
}

function updateStatusBar() {
  if (!statusEl) return;
  const latest = lines.reduce((acc, l) => Math.max(acc, l.status?.updatedAt || 0), 0);
  const vc = vehicles.length;
  const via = socketConnected ? ' · socket' : ' · http';
  statusEl.textContent = latest
    ? `Lines ${formatTime(latest)} · ${vc} vehicles${via}`
    : `${lines.length} lines · ${vc} vehicles${via}`;
}

function applySnapshot(data) {
  if (!data || !Array.isArray(data.lines)) return;
  lines = data.lines;
  vehicles = data.vehicles || [];
  vehicleMeta = {
    updatedAt: data.vehicleUpdatedAt,
    feedTimestamp: data.vehicleFeedTimestamp,
  };
  updateStatusBar();
  render();
  if (inspectKind === 'route' && selectedRouteId) void refreshRouteInspectBody(selectedRouteId);
  if (inspectKind === 'stop' && selectedStopId) void refreshStopInspectBody(selectedStopId);
}

async function syncHistoryPathOverlays() {
  if (!map || !historyPathLayer) return;
  const pinned = lines.filter((l) => l.pinned).map((l) => l.routeId);
  const key = pinned.slice().sort().join(',');
  if (key === lastHistoryPinsKey) return;
  lastHistoryPinsKey = key;
  const gen = ++historyPathGen;
  historyPathLayer.clearLayers();
  if (!pinned.length) return;

  const names = shortNameByRouteId();
  await Promise.all(
    pinned.map(async (routeId) => {
      try {
        const res = await fetch(`/api/routes/${encodeURIComponent(routeId)}/history-path`);
        if (!res.ok) return;
        const data = await res.json();
        if (gen !== historyPathGen) return;
        const pts = data.points || [];
        if (pts.length < 2) return;
        const latlngs = pts.map((p) => L.latLng(p.lat, p.lon));
        const poly = L.polyline(latlngs, {
          color: routeColor(routeId),
          weight: 4,
          opacity: 0.5,
          dashArray: '6 10',
          lineCap: 'round',
          lineJoin: 'round',
        });
        const rn = names.get(routeId) || routeId;
        let src = 'stop observations';
        if (data.source === 'vehicle_samples') src = 'vehicle samples';
        else if (data.source === 'gtfs_stop_times') src = 'full scheduled path (all stops)';
        const end = data.tripEndedAt != null ? formatTime(data.tripEndedAt) : '—';
        const span =
          data.tripStartedAt != null && data.tripEndedAt != null
            ? `${formatTime(data.tripStartedAt)}–${formatTime(data.tripEndedAt)}`
            : end;
        poly.bindPopup(
          `<strong>${escapeHtml(rn)}</strong><br/>Latest trip ${escapeHtml(String(data.tripId || '—'))}<br/>${escapeHtml(src)} · ${escapeHtml(span)}`
        );
        poly.addTo(historyPathLayer);
      } catch {
        /* ignore */
      }
    })
  );
}

function updateMapMarkers(shouldFit) {
  if (!map || !vehicleLayer) return;
  vehicleLayer.clearLayers();
  const allowed = visibleRouteIdsForVehicles();
  const names = shortNameByRouteId();
  const visible = vehicles.filter((v) => allowed.has(v.routeId));
  const latlngs = [];

  for (const v of visible) {
    const latlng = L.latLng(v.lat, v.lon);
    latlngs.push(latlng);
    const fill = routeColor(v.routeId);
    const rn = names.get(v.routeId) || v.routeId;
    const m = L.marker(latlng, {
      icon: vehicleMarkerIcon(fill, rn),
      keyboard: true,
      title: rn,
    });
    const parts = [`<strong>${rn}</strong>`];
    if (v.vehicleLabel) parts.push(`Vehicle ${v.vehicleLabel}`);
    if (v.tripId) parts.push(`Trip ${v.tripId}`);
    m.bindPopup(parts.join('<br/>'));
    m.addTo(vehicleLayer);
  }

  const pinned = lines.filter((l) => l.pinned).map((l) => l.routeId);
  const fitKey = `${selectedRouteId || ''}|${pinned.slice().sort().join(',')}`;
  if (shouldFit || fitKey !== lastFitKey) {
    lastFitKey = fitKey;
    if (latlngs.length) {
      const b = L.latLngBounds(latlngs);
      map.fitBounds(b, { padding: [40, 40], maxZoom: 14, animate: true });
    } else {
      map.setView([43.7, -79.38], 11, { animate: true });
    }
  }

  const pinCount = pinned.length;
  const selName = selectedRouteId ? names.get(selectedRouteId) || selectedRouteId : null;
  if (mapLegendEl) {
    if (!pinCount && !selectedRouteId) {
      mapLegendEl.hidden = false;
      mapLegendEl.innerHTML =
        '<strong>No routes on the map.</strong> Pin routes or select one in the list to plot live vehicles.';
    } else {
      mapLegendEl.hidden = false;
      const bits = [];
      if (pinCount) bits.push(`<strong>${pinCount}</strong> pinned route(s) always shown`);
      if (selName) bits.push(`selected <strong>${selName}</strong>`);
      bits.push(`<strong>${visible.length}</strong> vehicle marker(s) · feed ${formatTime(vehicleMeta.feedTimestamp)}`);
      if (selectedRouteId) bits.push('stop markers: <strong>selected</strong> route only');
      else if (pinCount) bits.push('stop markers: <strong>pinned</strong> routes');
      mapLegendEl.innerHTML = bits.join(' · ');
    }
  }
  void syncStopMarkers();
  void syncHistoryPathOverlays();
}

function sortLinesForSidebar(rows) {
  return rows.slice().sort((a, b) => {
    const order = { train_lrt: 0, streetcar: 1, bus: 2 };
    const mo = order[a.mode] - order[b.mode];
    if (mo !== 0) return mo;
    const an = parseInt(a.shortName, 10);
    const bn = parseInt(b.shortName, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && String(an) === a.shortName && String(bn) === b.shortName) {
      return an - bn;
    }
    return a.shortName.localeCompare(b.shortName, undefined, { numeric: true });
  });
}

function syncRouteModeTabs(counts) {
  for (const s of ROUTE_SECTIONS) {
    const panel = document.getElementById(`expanded-panel-${s.id}`);
    if (panel) panel.hidden = expandedRouteSection !== s.id;

    const tab = document.querySelector(`.route-mode-tab[data-route-section="${s.id}"]`);
    if (tab) {
      const active = expandedRouteSection === s.id;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      const n = counts[s.id];
      tab.setAttribute(
        'aria-label',
        n > 0 ? `${s.ariaLabel}, ${n} route${n === 1 ? '' : 's'}` : s.ariaLabel
      );
    }
  }
}

function setSidebarOpen(open: boolean) {
  sidebarOpen = open;
  appRoot?.classList.toggle('sidebar-open', open);
  if (sidebarToggle) {
    sidebarToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    sidebarToggle.title = open ? 'Close menu' : 'Open routes and stops';
  }
  if (sidebarBackdrop) {
    if (open) {
      sidebarBackdrop.hidden = false;
      sidebarBackdrop.setAttribute('aria-hidden', 'false');
    } else {
      sidebarBackdrop.hidden = true;
      sidebarBackdrop.setAttribute('aria-hidden', 'true');
    }
  }
}

function buildLineCard(line, { compact, onSelect }) {
  const st = line.status || {};
  const card = document.createElement('li');
  card.className = 'line-card' + (line.pinned ? ' is-pinned' : '');
  if (selectedRouteId === line.routeId) card.classList.add('is-selected');

  const badge = document.createElement('div');
  badge.className = 'line-card__badge';
  badge.textContent = line.shortName;

  const meta = document.createElement('div');
  meta.className = 'line-card__meta';
  if (!compact) {
    const modeEl = document.createElement('span');
    modeEl.className = 'line-card__mode';
    modeEl.textContent = modeLabel(line.mode);
    meta.appendChild(modeEl);
  }
  const name = document.createElement('p');
  name.className = 'line-card__name';
  name.textContent = line.longName || line.shortName;

  meta.appendChild(name);

  if (!compact) {
    const detail = document.createElement('p');
    detail.className = 'line-card__detail';
    const parts = [];
    if (st.activeTrips != null) parts.push(`${st.activeTrips} active trips (RT)`);
    const dl = delayLabel(st.maxDelaySec);
    if (dl) parts.push(dl);
    if (st.feedTimestamp) parts.push(`feed ${formatTime(st.feedTimestamp)}`);
    detail.textContent = parts.join(' · ') || 'Waiting for first poll…';
    meta.appendChild(detail);

    const pills = document.createElement('div');
    pills.style.display = 'flex';
    pills.style.flexWrap = 'wrap';
    pills.style.gap = '0.35rem';

    if (st.alertCount > 0) {
      const pill = document.createElement('span');
      pill.className = 'pill pill--bad';
      pill.textContent = `${st.alertCount} alert${st.alertCount === 1 ? '' : 's'}`;
      pills.appendChild(pill);
    } else if (st.updatedAt) {
      const pill = document.createElement('span');
      pill.className = 'pill pill--ok';
      pill.textContent = 'No route alerts';
      pills.appendChild(pill);
    }

    if (line.myttc && line.myttc.nextDepartureUnix) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = `MyTTC ${formatTime(line.myttc.nextDepartureUnix)}`;
      pills.appendChild(pill);
    }
    meta.appendChild(pills);

    if (st.alertHeaders && st.alertHeaders.length) {
      const ul = document.createElement('ul');
      ul.className = 'line-card__alerts';
      for (const h of st.alertHeaders.slice(0, 2)) {
        const li = document.createElement('li');
        li.textContent = h;
        ul.appendChild(li);
      }
      meta.appendChild(ul);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'line-card__actions';
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.className = 'pin-btn' + (line.pinned ? ' is-pinned' : '');
  pinBtn.textContent = line.pinned ? 'Unpin' : 'Pin';
  pinBtn.title = line.pinned ? 'Remove from map pins' : 'Always show on map';
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePin(line.routeId);
  });
  actions.appendChild(pinBtn);

  card.appendChild(badge);
  card.appendChild(meta);
  card.appendChild(actions);

  card.addEventListener('click', () => {
    const next = selectedRouteId === line.routeId ? null : line.routeId;
    selectedRouteId = next;
    selectedStopId = null;
    if (next) openInspectRoute(next);
    else closeInspectPanel();
    onSelect();
  });

  return card;
}

function render() {
  if (
    !searchEl ||
    !pinnedListEl ||
    !pinnedEmptyEl ||
    !routesListTrainEl ||
    !routesListStreetcarEl ||
    !routesListBusEl ||
    !emptyTrainEl ||
    !emptyStreetcarEl ||
    !emptyBusEl
  ) {
    return;
  }
  const q = searchEl.value.trim().toLowerCase();

  const pinned = sortLinesForSidebar(lines.filter((l) => l.pinned)).sort((a, b) => {
    if (a.pinPosition != null && b.pinPosition != null) return a.pinPosition - b.pinPosition;
    return 0;
  });

   let rest = lines.filter((l) => !l.pinned);
  if (q) {
    rest = rest.filter((l) => {
      const hay = `${l.shortName} ${l.longName} ${l.routeId}`.toLowerCase();
      return hay.includes(q);
    });
  }
  const trains = sortLinesForSidebar(rest.filter((l) => l.mode === 'train_lrt'));
  const streetcars = sortLinesForSidebar(rest.filter((l) => l.mode === 'streetcar'));
  const buses = sortLinesForSidebar(rest.filter((l) => l.mode === 'bus'));

  syncRouteModeTabs({
    pinned: pinned.length,
    train: trains.length,
    streetcar: streetcars.length,
    bus: buses.length,
  });

  pinnedEmptyEl.hidden = pinned.length > 0;

  pinnedListEl.innerHTML = '';
  if (pinned.length) {
    for (const line of pinned) {
      pinnedListEl.appendChild(
        buildLineCard(line, {
          compact: true,
          onSelect: () => {
            render();
            updateMapMarkers(true);
          },
        })
      );
    }
  }

  const fillModeList = (ul, linesChunk, emptyEl) => {
    ul.innerHTML = '';
    if (!linesChunk.length) {
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    for (const line of linesChunk) {
      ul.appendChild(
        buildLineCard(line, {
          compact: false,
          onSelect: () => {
            render();
            updateMapMarkers(true);
          },
        })
      );
    }
  };

  fillModeList(routesListTrainEl, trains, emptyTrainEl);
  fillModeList(routesListStreetcarEl, streetcars, emptyStreetcarEl);
   fillModeList(routesListBusEl, buses, emptyBusEl);

  updateMapMarkers(false);
}

async function togglePin(routeId) {
  const line = lines.find((l) => l.routeId === routeId);
  const pinnedIds = lines.filter((l) => l.pinned).map((l) => l.routeId);
  let next;
  if (line && line.pinned) next = pinnedIds.filter((id) => id !== routeId);
  else next = [...pinnedIds, routeId];
  await fetch('/api/pins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routeIds: next }),
  });
  if (socket?.connected) socket.emit('snapshot:request');
  else await refreshHttp();
  updateMapMarkers(true);
}

async function refreshHttp() {
  if (statusEl) statusEl.textContent = 'Updating…';
  const [lr, vr] = await Promise.all([fetch('/api/lines'), fetch('/api/vehicles')]);
  if (!lr.ok) {
    if (statusEl) statusEl.textContent = 'Failed to load lines';
    return;
  }
  const data = await lr.json();
  lines = data.lines || [];

  if (vr.ok) {
    const vdata = await vr.json();
    vehicles = vdata.vehicles || [];
    vehicleMeta = {
      updatedAt: vdata.updatedAt,
      feedTimestamp: vdata.feedTimestamp,
    };
  }

  updateStatusBar();
  render();
  if (inspectKind === 'route' && selectedRouteId) void refreshRouteInspectBody(selectedRouteId);
  if (inspectKind === 'stop' && selectedStopId) void refreshStopInspectBody(selectedStopId);
}

function connectSocket() {
  socket = ioClient({
    transports: ['websocket', 'polling'],
    path: '/socket.io',
  });

  socket.on('connect', () => {
    socketConnected = true;
    socket!.emit('subscribe', {
      serverPush: true,
      intervalMs: 12000,
    });
    updateStatusBar();
  });

  socket.on('disconnect', () => {
    socketConnected = false;
    updateStatusBar();
  });

  socket.on('snapshot', (payload) => {
    applySnapshot(payload);
  });

  socket.on('connect_error', () => {
    socketConnected = false;
    updateStatusBar();
  });
}

let stopSearchTimer: ReturnType<typeof setTimeout> | null = null;

async function runStopSearch() {
  if (!stopSearchEl || !stopsListEl || !stopSearchHintEl || !panelRoutes || !panelStops) return;
  const q = stopSearchEl.value.trim();
  stopsListEl.innerHTML = '';
  if (q.length < 2) {
    stopSearchHintEl.hidden = false;
    stopSearchHintEl.textContent = 'Type at least 2 characters to search stops.';
    return;
  }
  stopSearchHintEl.hidden = true;
  try {
    const res = await fetch(`/api/stops/search?q=${encodeURIComponent(q)}&limit=30`);
    const data = await res.json();
    if (data.hint && (!data.stops || !data.stops.length)) {
      stopSearchHintEl.hidden = false;
      stopSearchHintEl.textContent = data.hint;
      return;
    }
    if (!data.stops || !data.stops.length) {
      stopSearchHintEl.hidden = false;
      stopSearchHintEl.textContent = 'No stops match.';
      return;
    }
    stopSearchHintEl.hidden = true;
    for (const s of data.stops) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stop-card' + (selectedStopId === s.stopId ? ' is-selected' : '');
      btn.setAttribute('data-stop-id', s.stopId);
      btn.innerHTML = `<p class="stop-card__name">${escapeHtml(s.stopName)}</p><p class="stop-card__id">${escapeHtml(s.stopId)}</p>`;
      btn.addEventListener('click', () => {
        selectStop(s.stopId, { pan: true });
        sidebarMode = 'stops';
        document.querySelectorAll('.sidebar-tab').forEach((b) => b.classList.remove('is-active'));
        const st = document.querySelector('.sidebar-tab[data-sidebar="stops"]');
        if (st) st.classList.add('is-active');
        panelRoutes.hidden = true;
        panelStops.hidden = false;
        setSidebarOpen(true);
      });
      stopsListEl.appendChild(btn);
    }
  } catch {
    stopSearchHintEl.hidden = false;
    stopSearchHintEl.textContent = 'Stop search failed.';
  }
}

function bindDomRefs() {
  appRoot = document.getElementById('app-root');
  searchEl = document.getElementById('search') as HTMLInputElement | null;
  pinnedListEl = document.getElementById('pinned-list');
  routesListTrainEl = document.getElementById('routes-list-train');
  routesListStreetcarEl = document.getElementById('routes-list-streetcar');
  routesListBusEl = document.getElementById('routes-list-bus');
  pinnedEmptyEl = document.getElementById('pinned-empty');
  emptyTrainEl = document.getElementById('empty-train');
  emptyStreetcarEl = document.getElementById('empty-streetcar');
  emptyBusEl = document.getElementById('empty-bus');
  routeAccordionEl = document.getElementById('route-accordion');
  statusEl = document.getElementById('status');
  mapLegendEl = document.getElementById('map-legend');
  panelRoutes = document.getElementById('panel-routes');
  panelStops = document.getElementById('panel-stops');
  stopSearchEl = document.getElementById('stop-search') as HTMLInputElement | null;
  stopsListEl = document.getElementById('stops-list');
  stopSearchHintEl = document.getElementById('stop-search-hint');
  inspectPanel = document.getElementById('inspect-panel');
  inspectTitle = document.getElementById('inspect-title');
  inspectBody = document.getElementById('inspect-body');
  inspectClose = document.getElementById('inspect-close');
  sidebarToggle = document.getElementById('sidebar-toggle');
  sidebarClose = document.getElementById('sidebar-close');
  sidebarBackdrop = document.getElementById('sidebar-backdrop');
  sidebarEl = document.getElementById('app-sidebar');
}

export async function mountTtcWatcher(): Promise<void> {
  bindDomRefs();
  if (
    !appRoot ||
    !searchEl ||
    !pinnedListEl ||
    !statusEl ||
    !routeAccordionEl ||
    !inspectClose ||
    !panelRoutes ||
    !panelStops ||
    !stopSearchEl
  ) {
    console.error('TTC Watcher: required DOM nodes missing');
    return;
  }

  routeAccordionEl.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest('.route-mode-tab');
    if (!tab) return;
    const id = tab.getAttribute('data-route-section');
    if (id && ROUTE_SECTIONS.some((s) => s.id === id)) {
      expandedRouteSection = id;
      render();
    }
  });

  searchEl.addEventListener('input', () => {
    render();
  });

  sidebarToggle?.addEventListener('click', () => {
    setSidebarOpen(!sidebarOpen);
  });

  sidebarClose?.addEventListener('click', () => {
    setSidebarOpen(false);
  });

  sidebarBackdrop?.addEventListener('click', () => {
    setSidebarOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (sidebarOpen) {
      setSidebarOpen(false);
      return;
    }
    if (inspectPanel && !inspectPanel.hidden) {
      closeInspectPanel();
      render();
      updateMapMarkers(false);
    }
  });

  sidebarEl?.addEventListener(
    'touchstart',
    (e) => {
      if (!sidebarOpen) return;
      const t = e.touches[0];
      if (!t) return;
      swipeTouchStartX = t.clientX;
      swipeTouchStartY = t.clientY;
    },
    { passive: true }
  );

  sidebarEl?.addEventListener(
    'touchend',
    (e) => {
      if (!sidebarOpen) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - swipeTouchStartX;
      const dy = Math.abs(t.clientY - swipeTouchStartY);
      if (dx < -56 && dy < 48) setSidebarOpen(false);
    },
    { passive: true }
  );

  document.querySelectorAll('.sidebar-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      sidebarMode = btn.getAttribute('data-sidebar') || 'routes';
      if (panelRoutes && panelStops) {
        panelRoutes.hidden = sidebarMode !== 'routes';
        panelStops.hidden = sidebarMode !== 'stops';
      }
    });
  });

  stopSearchEl.addEventListener('input', () => {
    if (stopSearchTimer) clearTimeout(stopSearchTimer);
    stopSearchTimer = setTimeout(() => void runStopSearch(), 320);
  });

  inspectClose.addEventListener('click', () => {
    closeInspectPanel();
    render();
    updateMapMarkers(false);
  });

  initMap();
  await refreshHttp();
  connectSocket();
  setInterval(() => {
    if (!socket?.connected) {
      void refreshHttp();
    }
  }, 12000);
}
