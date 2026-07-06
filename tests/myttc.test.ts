import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_STATIONS, pickStationRotation } from '../lib/myttc.js';

describe('myttc', () => {
  it('pickStationRotation cycles through configured stations', () => {
    assert.ok(DEFAULT_STATIONS.length >= 1);
    const first = pickStationRotation(0);
    assert.ok(first);
    assert.equal(pickStationRotation(DEFAULT_STATIONS.length), first);
    assert.equal(pickStationRotation(1), pickStationRotation(DEFAULT_STATIONS.length + 1));
  });
});
