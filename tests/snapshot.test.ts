import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { openDb } from '../lib/db.js';
import {
  buildLinesList,
  buildSnapshot,
  buildVehiclesPayload,
  filterAndSortLines,
} from '../lib/snapshot.js';

function mockLine(overrides: Record<string, unknown> = {}) {
  return {
    routeId: 'r1',
    shortName: '501',
    longName: 'Queen',
    mode: 'streetcar',
    pinned: false,
    pinPosition: null,
    status: {
      updatedAt: null,
      activeTrips: null,
      maxDelaySec: null,
      avgDelaySec: null,
      delayedTripCount: null,
      alertCount: null,
      alertHeaders: null,
      feedTimestamp: null,
    },
    myttc: null,
    ...overrides,
  };
}

describe('snapshot', () => {
  it('filterAndSortLines filters by mode and search query', () => {
    const lines = [
      mockLine({ routeId: 'bus-1', shortName: '29', longName: 'Dufferin', mode: 'bus' }),
      mockLine({ routeId: 'sc-1', shortName: '501', longName: 'Queen', mode: 'streetcar' }),
      mockLine({ routeId: 'train-1', shortName: '1', longName: 'Yonge-University', mode: 'train_lrt' }),
    ];

    const busOnly = filterAndSortLines(lines, '', 'bus');
    assert.equal(busOnly.length, 1);
    assert.equal(busOnly[0]?.shortName, '29');

    const queen = filterAndSortLines(lines, 'queen', '');
    assert.equal(queen.length, 1);
    assert.equal(queen[0]?.routeId, 'sc-1');
  });

  it('filterAndSortLines sorts numeric short names within a mode', () => {
    const lines = [
      mockLine({ routeId: 'b2', shortName: '29', mode: 'bus' }),
      mockLine({ routeId: 'b1', shortName: '7', mode: 'bus' }),
      mockLine({ routeId: 'b3', shortName: '100', mode: 'bus' }),
    ];
    const sorted = filterAndSortLines(lines, '', 'bus');
    assert.deepEqual(sorted.map((l) => l.shortName), ['7', '29', '100']);
  });

  it('buildVehiclesPayload exposes vehicle snapshot fields', () => {
    const payload = buildVehiclesPayload({
      getVehicleSnapshot: () => ({
        updatedAt: 100,
        feedTimestamp: 90,
        vehicles: [{ id: 'v1' }, { id: 'v2' }],
      }),
    });
    assert.deepEqual(payload, {
      updatedAt: 100,
      feedTimestamp: 90,
      count: 2,
      vehicles: [{ id: 'v1' }, { id: 'v2' }],
    });
  });

  describe('buildLinesList', () => {
    const dbPath = path.join(os.tmpdir(), `ttc-watcher-snapshot-${process.pid}.db`);
    const db = openDb(dbPath);

    after(() => {
      db.close();
      fs.unlinkSync(dbPath);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
      }
    });

    it('reads routes and parses alert headers from sqlite', () => {
      db.prepare(
        `INSERT INTO routes (route_id, short_name, long_name, mode)
         VALUES ('r501', '501', 'Queen', 'streetcar'),
                ('r7', '7', 'Bathurst', 'bus')`
      ).run();
      db.prepare(
        `INSERT INTO line_status
           (route_id, updated_at, active_trips, delayed_trip_count, alert_count, alert_headers)
         VALUES ('r501', 1000, 3, 1, 2, ?)`
      ).run(JSON.stringify(['Diversion', 'Delay']));

      const lines = buildLinesList(db);
      assert.equal(lines.length, 2);

      const queen = lines.find((l) => l.routeId === 'r501');
      assert.ok(queen);
      assert.equal(queen.status.activeTrips, 3);
      assert.deepEqual(queen.status.alertHeaders, ['Diversion', 'Delay']);
    });

    it('buildSnapshot combines lines and vehicles', () => {
      const snapshot = buildSnapshot(db, {
        getVehicleSnapshot: () => ({
          updatedAt: 2000,
          feedTimestamp: 1990,
          vehicles: [{ vehicleId: '1234' }],
        }),
      });
      assert.equal(snapshot.count, 2);
      assert.equal(snapshot.vehicleCount, 1);
      assert.equal(snapshot.vehicleUpdatedAt, 2000);
      assert.ok(Array.isArray(snapshot.lines));
    });
  });
});
