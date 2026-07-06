import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('ui markup', () => {
  it('renders the map title panel beside the menu button', () => {
    const page = fs.readFileSync(path.join(repoRoot, 'app/page.tsx'), 'utf8');
    assert.match(page, /className="map-top-bar"/);
    assert.match(page, /className="map-title-panel__title">Jeeth&apos;s TTC Watcher</);
    assert.doesNotMatch(page, /sidebar__head-row[\s\S]*className="title">Jeeth&apos;s TTC Watcher</);
  });
});
