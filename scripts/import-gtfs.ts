import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { openDb, seedRoutesIfEmpty } from '../lib/db.js';
import { getCsvFieldZeroBased, parseCsvLine, rowToObject } from '../lib/gtfsCsv.js';
import { activeServiceIdsInRange, defaultTorontoDateRangeYYYYMMDD } from '../lib/gtfsCalendar.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routesJsonPath = path.join(__dirname, '..', 'data', 'routes.json');

const DEFAULT_RAIL_GTFS_URL =
  'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/7795b45e-e65a-4465-81fc-c36b9dfff169/resource/cfb6b2b8-6191-41e3-bda1-b175c51148cb/download/TTC%20Routes%20and%20Schedules%20Data.zip';

const DEFAULT_SURFACE_GTFS_URL =
  'https://ckan0.cf.opendata.inter.prod-toronto.ca/dataset/bd4809dd-e289-4de8-bbde-c5c00dafbf4f/resource/28514055-d011-4ed7-8bb0-97961dfe2b66/download/SurfaceGTFS.zip';

const BATCH = 8000;

const CALENDAR_LOOKBACK_DAYS = Math.max(1, parseInt(process.env.GTFS_IMPORT_CALENDAR_DAYS || '7', 10) || 7);

function stopTimesBatchSize() {
  const fromEnv = process.env.GTFS_STOP_TIMES_BATCH;
  if (fromEnv != null && fromEnv !== '') {
    const n = parseInt(fromEnv, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return BATCH;
}

const RAIL_TRIP_ID_PREFIX = 'rail:';

async function ensureZip(opts: { label: string; pathEnv: string; urlEnv: string; defaultUrl: string }) {
  const fromEnv = process.env[opts.pathEnv];
  if (fromEnv && fs.existsSync(fromEnv)) {
    return { zipPath: fromEnv, cleanup: false };
  }
  const dest = path.join(os.tmpdir(), `ttc-gtfs-${opts.label}-${Date.now()}.zip`);
  const url = process.env[opts.urlEnv] || opts.defaultUrl;
  process.stderr.write(`Downloading ${opts.label} GTFS…\n`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${opts.label} GTFS download failed HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return { zipPath: dest, cleanup: true };
}

function unzip(zipPath: string, dir: string) {
  execFileSync('unzip', ['-qo', zipPath, '-d', dir], { stdio: 'inherit' });
}

function openFirstLineStream(filePath: string) {
  return readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
}

function modeFromGtfsRouteType(routeType: string): 'streetcar' | 'train_lrt' | 'bus' {
  const n = parseInt(routeType, 10);
  if (n === 0) return 'streetcar';
  if (n === 1 || n === 2) return 'train_lrt';
  return 'bus';
}

async function syncRoutesFromGtfs(gtfsDir: string, db: Database.Database, routeIdPrefix = '') {
  const p = path.join(gtfsDir, 'routes.txt');
  if (!fs.existsSync(p)) {
    process.stderr.write(`Warning: missing ${p}\n`);
    return;
  }
  const ins = db.prepare(
    `INSERT OR REPLACE INTO routes (route_id, short_name, long_name, mode)
     VALUES (@route_id, @short_name, @long_name, @mode)`
  );
  let header: string[] | null = null;
  const tx = db.transaction((rows: { route_id: string; short_name: string; long_name: string; mode: string }[]) => {
    for (const r of rows) ins.run(r);
  });
  let batch: { route_id: string; short_name: string; long_name: string; mode: string }[] = [];
  let n = 0;
  const rpf = routeIdPrefix || '';
  for await (const line of openFirstLineStream(p)) {
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }
    const row = rowToObject(header, parseCsvLine(line));
    const rawRouteId = String(row.route_id || '').trim();
    if (!rawRouteId) continue;
    const routeId = rpf ? `${rpf}${rawRouteId}` : rawRouteId;
    const shortName = String(row.route_short_name || '').trim() || rawRouteId;
    const longName =
      String(row.route_long_name || '').trim() || String(row.route_short_name || '').trim() || rawRouteId;
    batch.push({
      route_id: routeId,
      short_name: shortName,
      long_name: longName,
      mode: modeFromGtfsRouteType(row.route_type),
    });
    n += 1;
    if (batch.length >= BATCH) {
      tx(batch);
      batch = [];
    }
  }
  if (batch.length) tx(batch);
  process.stderr.write(`Synced ${n} routes from ${path.basename(p)}.\n`);
}

async function collectTripIdsForImport(gtfsDir: string, activeServiceIds: Set<string>, tripIdPrefix: string) {
  const tripPath = path.join(gtfsDir, 'trips.txt');
  if (!fs.existsSync(tripPath)) throw new Error(`Missing ${tripPath}`);
  const prefix = tripIdPrefix || '';
  const filter = activeServiceIds.size > 0;
  const valid = new Set<string>();
  let header: string[] | null = null;
  for await (const line of openFirstLineStream(tripPath)) {
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }
    const row = rowToObject(header, parseCsvLine(line));
    const sid = String(row.service_id || '').trim();
    if (filter && !activeServiceIds.has(sid)) continue;
    const rawTripId = String(row.trip_id || '').trim();
    if (!rawTripId) continue;
    valid.add(`${prefix}${rawTripId}`);
  }
  return valid;
}

async function loadTrips(
  gtfsDir: string,
  validTripIds: Set<string>,
  db: Database.Database,
  tripIdPrefix: string,
  routeIdPrefix = ''
) {
  const tripPath = path.join(gtfsDir, 'trips.txt');
  if (!fs.existsSync(tripPath)) throw new Error(`Missing ${tripPath}`);

  const ins = db.prepare(
    `INSERT INTO gtfs_trips (trip_id, route_id, direction_id, trip_headsign)
     VALUES (@trip_id, @route_id, @direction_id, @trip_headsign)`
  );

  const prefix = tripIdPrefix || '';
  const rpf = routeIdPrefix || '';
  let header: string[] | null = null;
  let tripIdCol = -1;

  const tx = db.transaction(
    (rows: { trip_id: string; route_id: string; direction_id: number | null; trip_headsign: string | null }[]) => {
      for (const r of rows) ins.run(r);
    }
  );

  let batch: { trip_id: string; route_id: string; direction_id: number | null; trip_headsign: string | null }[] = [];
  let imported = 0;
  for await (const line of openFirstLineStream(tripPath)) {
    if (!header) {
      header = parseCsvLine(line);
      tripIdCol = header.indexOf('trip_id');
      if (tripIdCol < 0) throw new Error(`Missing trip_id column in ${tripPath}`);
      continue;
    }
    const rawTripId = getCsvFieldZeroBased(line, tripIdCol).trim();
    if (!rawTripId) continue;
    const tripId = `${prefix}${rawTripId}`;
    if (!validTripIds.has(tripId)) continue;
    const row = rowToObject(header, parseCsvLine(line));
    const rawRouteId = String(row.route_id || '').trim();
    if (!rawRouteId) continue;
    const canonicalRouteId = rpf ? `${rpf}${rawRouteId}` : rawRouteId;
    let directionId: number | null = null;
    if (row.direction_id !== '' && row.direction_id != null) {
      const d = parseInt(row.direction_id, 10);
      if (!Number.isNaN(d)) directionId = d;
    }
    batch.push({
      trip_id: tripId,
      route_id: canonicalRouteId,
      direction_id: directionId,
      trip_headsign: String(row.trip_headsign || '').trim() || null,
    });
    imported += 1;
    if (batch.length >= BATCH) {
      tx(batch);
      batch = [];
    }
  }
  if (batch.length) tx(batch);

  process.stderr.write(`Imported ${imported} trips.\n`);
}

async function streamStopTimes(gtfsDir: string, validTripIds: Set<string>, db: Database.Database, tripIdPrefix: string) {
  const p = path.join(gtfsDir, 'stop_times.txt');
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);

  const chunk = stopTimesBatchSize();
  const ins = db.prepare(
    `INSERT INTO gtfs_stop_times (trip_id, stop_sequence, stop_id, arrival_time, departure_time)
     VALUES (?, ?, ?, ?, ?)`
  );

  const neededStops = new Set<string>();
  let header: string[] | null = null;
  let tripIdCol = -1;
  let n = 0;
  /** Raw trip_id from feed for a trip we're skipping (stop_times are grouped by trip). */
  let skipTripRaw: string | null = null;
  let inChunkTx = false;
  let sinceCommit = 0;
  const progressEvery = 250_000;
  let nextProgress = progressEvery;

  const beginChunk = () => {
    if (!inChunkTx) {
      db.exec('BEGIN');
      inChunkTx = true;
    }
  };
  const commitChunk = () => {
    if (inChunkTx) {
      db.exec('COMMIT');
      inChunkTx = false;
      sinceCommit = 0;
    }
  };

  for await (const line of openFirstLineStream(p)) {
    if (!header) {
      header = parseCsvLine(line);
      tripIdCol = header.indexOf('trip_id');
      if (tripIdCol < 0) throw new Error(`Missing trip_id column in ${p}`);
      continue;
    }
    const rawTripId = getCsvFieldZeroBased(line, tripIdCol).trim();
    if (skipTripRaw !== null && rawTripId === skipTripRaw) continue;
    const tripId = `${tripIdPrefix || ''}${rawTripId}`;
    if (!validTripIds.has(tripId)) {
      skipTripRaw = rawTripId;
      continue;
    }
    skipTripRaw = null;
    const row = rowToObject(header, parseCsvLine(line));
    const stopId = String(row.stop_id || '').trim();
    if (!stopId) continue;
    const seq = parseInt(row.stop_sequence, 10);
    if (Number.isNaN(seq)) continue;
    neededStops.add(stopId);

    const arrival = String(row.arrival_time || '').trim() || null;
    const departure = String(row.departure_time || '').trim() || null;

    beginChunk();
    ins.run(tripId, seq, stopId, arrival, departure);
    n += 1;
    sinceCommit += 1;
    if (sinceCommit >= chunk) {
      commitChunk();
    }
    if (n >= nextProgress) {
      process.stderr.write(`stop_times… ${n} rows\n`);
      nextProgress += progressEvery;
    }
  }
  commitChunk();

  process.stderr.write(`Imported ${n} stop_times rows.\n`);
  return neededStops;
}

async function loadStops(gtfsDir: string, neededStops: Set<string>, db: Database.Database) {
  const p = path.join(gtfsDir, 'stops.txt');
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);

  const ins = db.prepare(
    `INSERT OR REPLACE INTO gtfs_stops (stop_id, stop_code, stop_name, stop_lat, stop_lon)
     VALUES (@stop_id, @stop_code, @stop_name, @stop_lat, @stop_lon)`
  );

  let header: string[] | null = null;
  const tx = db.transaction(
    (rows: { stop_id: string; stop_code: string | null; stop_name: string; stop_lat: number; stop_lon: number }[]) => {
      for (const r of rows) ins.run(r);
    }
  );
  let batch: { stop_id: string; stop_code: string | null; stop_name: string; stop_lat: number; stop_lon: number }[] =
    [];
  let found = 0;

  for await (const line of openFirstLineStream(p)) {
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }
    const row = rowToObject(header, parseCsvLine(line));
    const stopId = String(row.stop_id || '').trim();
    if (!neededStops.has(stopId)) continue;
    const lat = parseFloat(row.stop_lat);
    const lon = parseFloat(row.stop_lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    batch.push({
      stop_id: stopId,
      stop_code: String(row.stop_code || '').trim() || null,
      stop_name: String(row.stop_name || '').trim() || stopId,
      stop_lat: lat,
      stop_lon: lon,
    });
    found += 1;
    neededStops.delete(stopId);
    if (batch.length >= BATCH) {
      tx(batch);
      batch = [];
    }
  }
  if (batch.length) tx(batch);

  if (neededStops.size) {
    process.stderr.write(`Warning: ${neededStops.size} stop_ids in stop_times missing from stops.txt (skipped).\n`);
  }
  process.stderr.write(`Imported ${found} stops.\n`);
}

async function importOneBundle(
  db: Database.Database,
  extractDir: string,
  label: string,
  tripIdPrefix: string,
  rangeStart: string,
  rangeEnd: string
) {
  process.stderr.write(`Importing ${label} (calendar ${rangeStart}–${rangeEnd})…\n`);
  const routeIdPrefix = tripIdPrefix || '';
  await syncRoutesFromGtfs(extractDir, db, routeIdPrefix);
  let activeServiceIds = await activeServiceIdsInRange(extractDir, rangeStart, rangeEnd);
  if (!activeServiceIds.size) {
    process.stderr.write(
      `Warning: ${label}: no services in calendar window; importing all trips/stop_times from feed.\n`
    );
    activeServiceIds = new Set();
  }
  const validTripIds = await collectTripIdsForImport(extractDir, activeServiceIds, tripIdPrefix);
  process.stderr.write(`${label}: ${validTripIds.size} trips match window.\n`);
  await loadTrips(extractDir, validTripIds, db, tripIdPrefix, routeIdPrefix);
  const neededStops = await streamStopTimes(extractDir, validTripIds, db, tripIdPrefix);
  await loadStops(extractDir, neededStops, db);
}

async function main() {
  const db = openDb();
  seedRoutesIfEmpty(db, routesJsonPath);
  const { start: rangeStart, end: rangeEnd } = defaultTorontoDateRangeYYYYMMDD(
    'America/Toronto',
    Math.max(0, CALENDAR_LOOKBACK_DAYS - 1)
  );
  process.stderr.write(
    `Stop times window: ${CALENDAR_LOOKBACK_DAYS} calendar days of service ending today (${rangeStart}–${rangeEnd}), all routes.\n`
  );

  const railZip = await ensureZip({
    label: 'rail',
    pathEnv: 'GTFS_ZIP_PATH',
    urlEnv: 'GTFS_STATIC_URL',
    defaultUrl: DEFAULT_RAIL_GTFS_URL,
  });
  const surfaceZip = await ensureZip({
    label: 'surface',
    pathEnv: 'GTFS_SURFACE_ZIP_PATH',
    urlEnv: 'GTFS_SURFACE_URL',
    defaultUrl: DEFAULT_SURFACE_GTFS_URL,
  });

  const extractRail = path.join(os.tmpdir(), `ttc-gtfs-rail-${Date.now()}`);
  const extractSurface = path.join(os.tmpdir(), `ttc-gtfs-surface-${Date.now()}`);
  fs.mkdirSync(extractRail, { recursive: true });
  fs.mkdirSync(extractSurface, { recursive: true });
  try {
    db.pragma('foreign_keys = OFF');
    db.exec('DELETE FROM gtfs_stop_times; DELETE FROM gtfs_trips; DELETE FROM gtfs_stops;');

    process.stderr.write(`Extracting rail bundle…\n`);
    unzip(railZip.zipPath, extractRail);
    await importOneBundle(db, extractRail, 'rail', RAIL_TRIP_ID_PREFIX, rangeStart, rangeEnd);

    process.stderr.write(`Extracting surface bundle…\n`);
    unzip(surfaceZip.zipPath, extractSurface);
    await importOneBundle(db, extractSurface, 'surface', '', rangeStart, rangeEnd);

    db.pragma('foreign_keys = ON');
    process.stderr.write('Done.\n');
  } finally {
    fs.rmSync(extractRail, { recursive: true, force: true });
    fs.rmSync(extractSurface, { recursive: true, force: true });
    if (railZip.cleanup && fs.existsSync(railZip.zipPath)) {
      try {
        fs.unlinkSync(railZip.zipPath);
      } catch {
        /* ignore */
      }
    }
    if (surfaceZip.cleanup && fs.existsSync(surfaceZip.zipPath)) {
      try {
        fs.unlinkSync(surfaceZip.zipPath);
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
