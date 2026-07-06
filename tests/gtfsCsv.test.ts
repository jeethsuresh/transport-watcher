import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getCsvFieldZeroBased, parseCsvLine, rowToObject } from '../lib/gtfsCsv.js';

describe('gtfsCsv', () => {
  it('parseCsvLine handles quoted commas and escaped quotes', () => {
    assert.deepEqual(parseCsvLine('a,"b,c","d""e",f'), ['a', 'b,c', 'd"e', 'f']);
  });

  it('getCsvFieldZeroBased reads a field without parsing the whole row', () => {
    assert.equal(getCsvFieldZeroBased('a,"b,c",d', 0), 'a');
    assert.equal(getCsvFieldZeroBased('a,"b,c",d', 1), 'b,c');
    assert.equal(getCsvFieldZeroBased('a,"b,c",d', 2), 'd');
    assert.equal(getCsvFieldZeroBased('only', 1), '');
  });

  it('rowToObject maps header cells to keys', () => {
    const header = ['route_id', 'short_name'];
    assert.deepEqual(rowToObject(header, ['501', 'Queen']), {
      route_id: '501',
      short_name: 'Queen',
    });
    assert.deepEqual(rowToObject(header, ['501']), {
      route_id: '501',
      short_name: '',
    });
  });
});
