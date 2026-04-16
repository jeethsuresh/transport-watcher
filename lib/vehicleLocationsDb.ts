import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { ParsedVehicle } from './gtfsRt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'vehicle-locations.db');

const RETENTION_DAYS = parseInt(process.env.VEHICLE_LOCATIONS_RETENTION_DAYS || '14', 10);

/**
 * Separate SQLite file for vehicle position history (not mixed with main `SQLITE_PATH` DB).
 */
export function openVehicleLocationsDb(
  dbPath: string = process.env.VEHICLE_LOCATIONS_SQLITE_PATH || DEFAULT_PATH
): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS vehicle_location_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fetched_at INTEGER NOT NULL,
      feed_timestamp INTEGER,
      entity_id TEXT NOT NULL,
      trip_id TEXT,
      route_id TEXT NOT NULL,
      vehicle_label TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      bearing REAL,
      speed REAL,
      current_stop_sequence INTEGER,
      current_stop_status INTEGER,
      stop_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vehicle_loc_fetched ON vehicle_location_samples (fetched_at);
    CREATE INDEX IF NOT EXISTS idx_vehicle_loc_route_time ON vehicle_location_samples (route_id, fetched_at);
  `);
  return db;
}

export function insertVehicleLocationSamples(
  vdb: Database.Database,
  fetchedAt: number,
  feedTimestamp: number | null,
  vehicles: ParsedVehicle[]
): void {
  if (!vehicles.length) return;
  const ins = vdb.prepare(
    `INSERT INTO vehicle_location_samples (
       fetched_at, feed_timestamp, entity_id, trip_id, route_id, vehicle_label,
       lat, lon, bearing, speed, current_stop_sequence, current_stop_status, stop_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = vdb.transaction((rows: ParsedVehicle[]) => {
    for (const v of rows) {
      ins.run(
        fetchedAt,
        feedTimestamp,
        v.entityId,
        v.tripId,
        v.routeId,
        v.vehicleLabel,
        v.lat,
        v.lon,
        v.bearing,
        v.speed,
        v.currentStopSequence,
        v.currentStopStatus,
        v.stopId
      );
    }
  });
  tx(vehicles);
}

export function pruneVehicleLocationSamples(vdb: Database.Database, nowSec = Math.floor(Date.now() / 1000)): void {
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS <= 0) return;
  const cut = nowSec - RETENTION_DAYS * 86400;
  vdb.prepare(`DELETE FROM vehicle_location_samples WHERE fetched_at < ?`).run(cut);
}

export { DEFAULT_PATH as VEHICLE_LOCATIONS_DEFAULT_PATH };
