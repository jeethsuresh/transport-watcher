import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { openDb } from '../lib/db.js';
import {
  clockMinuteInSymmetricWindow,
  computeStopHeadwayHeuristic,
  torontoDateKey,
  torontoMinutesSinceMidnight,
} from '../lib/stopHeadway.js';

describe('stopHeadway', () => {
  it('torontoMinutesSinceMidnight uses America/Toronto', () => {
    const noonToronto = Math.floor(Date.parse('2024-06-15T16:00:00.000Z') / 1000);
    assert.equal(torontoMinutesSinceMidnight(noonToronto), 12 * 60);
    assert.equal(torontoDateKey(noonToronto), '2024-06-15');
  });

  it('clockMinuteInSymmetricWindow wraps around midnight', () => {
    assert.equal(clockMinuteInSymmetricWindow(10, 5, 10), true);
    assert.equal(clockMinuteInSymmetricWindow(1435, 5, 10), true);
    assert.equal(clockMinuteInSymmetricWindow(700, 5, 10), false);
  });

  describe('computeStopHeadwayHeuristic', () => {
    const dbPath = path.join(os.tmpdir(), `ttc-watcher-headway-${process.pid}.db`);
    const db = openDb(dbPath);
    const stopId = 'stop-test-1';

    after(() => {
      db.close();
      fs.unlinkSync(dbPath);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
      }
    });

    it('estimates average headway from recent arrivals', () => {
      const base = Math.floor(Date.parse('2024-06-15T16:00:00.000Z') / 1000);
      const insert = db.prepare(
        `INSERT INTO rt_arrival_events (observed_at, stop_id, route_id, source)
         VALUES (?, ?, 'r501', 'test')`
      );
      insert.run(base - 7200, stopId);
      insert.run(base - 3600, stopId);
      insert.run(base - 1800, stopId);
      insert.run(base - 900, stopId);
      insert.run(base - 600, stopId);
      insert.run(base - 300, stopId);

      const result = computeStopHeadwayHeuristic(db, stopId, base, 7, 30);
      assert.ok(result.windowArrivalCount >= 3);
      assert.ok(result.gapSampleCount >= 1);
      assert.ok(result.avgHeadwayMinutes != null && result.avgHeadwayMinutes > 0);
      assert.equal(result.minutesSinceLastArrival, 5);
    });
  });
});
