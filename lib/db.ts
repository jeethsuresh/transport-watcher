import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'ttc-watcher.db');

function openDb(dbPath: string = process.env.SQLITE_PATH || DEFAULT_DB): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS routes (
      route_id TEXT PRIMARY KEY,
      short_name TEXT NOT NULL,
      long_name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('bus', 'streetcar', 'train_lrt'))
    );

    CREATE TABLE IF NOT EXISTS pins (
      route_id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      FOREIGN KEY (route_id) REFERENCES routes(route_id)
    );

    CREATE TABLE IF NOT EXISTS line_status (
      route_id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      active_trips INTEGER NOT NULL DEFAULT 0,
      max_delay_sec INTEGER,
      avg_delay_sec REAL,
      delayed_trip_count INTEGER NOT NULL DEFAULT 0,
      alert_count INTEGER NOT NULL DEFAULT 0,
      alert_headers TEXT,
      feed_timestamp INTEGER,
      FOREIGN KEY (route_id) REFERENCES routes(route_id)
    );

    CREATE TABLE IF NOT EXISTS status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at INTEGER NOT NULL,
      route_id TEXT NOT NULL,
      active_trips INTEGER,
      max_delay_sec INTEGER,
      avg_delay_sec REAL,
      delayed_trip_count INTEGER,
      alert_count INTEGER,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_status_history_route_time
      ON status_history (route_id, fetched_at);

    CREATE TABLE IF NOT EXISTS service_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at INTEGER NOT NULL,
      alert_entity_id TEXT,
      route_id TEXT,
      header TEXT,
      description TEXT,
      cause TEXT,
      effect TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_service_alerts_route
      ON service_alerts (route_id, fetched_at);

    CREATE TABLE IF NOT EXISTS myttc_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at INTEGER NOT NULL,
      station_uri TEXT NOT NULL,
      route_id TEXT NOT NULL,
      route_name TEXT,
      next_departure_unix INTEGER,
      next_headsign TEXT,
      UNIQUE (fetched_at, station_uri, route_id)
    );
    CREATE INDEX IF NOT EXISTS idx_myttc_route_time
      ON myttc_snapshot (route_id, fetched_at);

    CREATE TABLE IF NOT EXISTS gtfs_stops (
      stop_id TEXT PRIMARY KEY,
      stop_code TEXT,
      stop_name TEXT NOT NULL,
      stop_lat REAL NOT NULL,
      stop_lon REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gtfs_trips (
      trip_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      direction_id INTEGER,
      trip_headsign TEXT,
      FOREIGN KEY (route_id) REFERENCES routes(route_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gtfs_trips_route ON gtfs_trips (route_id);

    CREATE TABLE IF NOT EXISTS gtfs_stop_times (
      trip_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL,
      stop_id TEXT NOT NULL,
      arrival_time TEXT,
      departure_time TEXT,
      PRIMARY KEY (trip_id, stop_sequence),
      FOREIGN KEY (trip_id) REFERENCES gtfs_trips(trip_id),
      FOREIGN KEY (stop_id) REFERENCES gtfs_stops(stop_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_stop ON gtfs_stop_times (stop_id);
    CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_trip ON gtfs_stop_times (trip_id);

    CREATE TABLE IF NOT EXISTS rt_arrival_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at INTEGER NOT NULL,
      stop_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      trip_id TEXT,
      vehicle_id TEXT,
      source TEXT NOT NULL,
      trip_feed_timestamp INTEGER,
      vehicle_feed_timestamp INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rt_arrival_stop_time ON rt_arrival_events (stop_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_rt_arrival_route_stop ON rt_arrival_events (route_id, stop_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_rt_arrival_route_time ON rt_arrival_events (route_id, observed_at);

    CREATE TABLE IF NOT EXISTS rt_poll_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at INTEGER NOT NULL,
      trip_feed_timestamp INTEGER,
      vehicle_feed_timestamp INTEGER,
      trip_entity_count INTEGER NOT NULL,
      vehicle_entity_count INTEGER NOT NULL,
      trip_updates_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rt_poll_fetched ON rt_poll_snapshots (fetched_at);
  `);
  return db;
}

type RouteSeedRow = { route_id: string; short_name: string; long_name: string; mode: string };

function seedRoutesIfEmpty(db: Database.Database, routesJsonPath: string): void {
  const n = (db.prepare('SELECT COUNT(*) AS c FROM routes').get() as { c: number }).c;
  if (n > 0) return;
  const raw = fs.readFileSync(routesJsonPath, 'utf8');
  const rows = JSON.parse(raw) as RouteSeedRow[];
  const insert = db.prepare(
    `INSERT INTO routes (route_id, short_name, long_name, mode)
     VALUES (@route_id, @short_name, @long_name, @mode)`
  );
  const tx = db.transaction((list: RouteSeedRow[]) => {
    for (const r of list) {
      insert.run({
        route_id: String(r.route_id),
        short_name: String(r.short_name),
        long_name: String(r.long_name || ''),
        mode: r.mode,
      });
    }
  });
  tx(rows);
}

export { openDb, seedRoutesIfEmpty, DEFAULT_DB };
