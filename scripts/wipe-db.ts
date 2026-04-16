import fs from 'node:fs';
import { DEFAULT_DB } from '../lib/db.js';

if (fs.existsSync(DEFAULT_DB)) {
  fs.unlinkSync(DEFAULT_DB);
  const wal = `${DEFAULT_DB}-wal`;
  const shm = `${DEFAULT_DB}-shm`;
  if (fs.existsSync(wal)) fs.unlinkSync(wal);
  if (fs.existsSync(shm)) fs.unlinkSync(shm);
}

process.stderr.write(`Removed ${DEFAULT_DB}\n`);
