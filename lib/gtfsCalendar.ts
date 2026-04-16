import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseCsvLine, rowToObject } from './gtfsCsv.js';

function yyyymmddToWeekday(yyyymmdd: string) {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCDay();
}

const DOW_TO_CAL_COL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

function openFirstLineStream(filePath: string) {
  return readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
}

export function* iterateDatesInclusive(startYYYYMMDD: string, endYYYYMMDD: string): Generator<string> {
  const parse = (s: string) => {
    const y = parseInt(s.slice(0, 4), 10);
    const m = parseInt(s.slice(4, 6), 10) - 1;
    const d = parseInt(s.slice(6, 8), 10);
    return Date.UTC(y, m, d);
  };
  let t = parse(startYYYYMMDD);
  const end = parse(endYYYYMMDD);
  while (t <= end) {
    const dt = new Date(t);
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const da = String(dt.getUTCDate()).padStart(2, '0');
    yield `${y}${mo}${da}`;
    t += 86400000;
  }
}

export async function activeServiceIdsInRange(gtfsDir: string, startYYYYMMDD: string, endYYYYMMDD: string) {
  const calPath = path.join(gtfsDir, 'calendar.txt');
  const calDatesPath = path.join(gtfsDir, 'calendar_dates.txt');

  const calendars = new Map<string, { start: string; end: string; dow: Record<string, string> }>();
  if (fs.existsSync(calPath)) {
    let header: string[] | null = null;
    for await (const line of openFirstLineStream(calPath)) {
      if (!header) {
        header = parseCsvLine(line);
        continue;
      }
      const row = rowToObject(header, parseCsvLine(line));
      const sid = String(row.service_id || '').trim();
      if (!sid) continue;
      calendars.set(sid, {
        start: String(row.start_date || '').trim(),
        end: String(row.end_date || '').trim(),
        dow: row,
      });
    }
  }

  const exceptionsByDate = new Map<string, Map<string, number>>();
  if (fs.existsSync(calDatesPath)) {
    let header: string[] | null = null;
    for await (const line of openFirstLineStream(calDatesPath)) {
      if (!header) {
        header = parseCsvLine(line);
        continue;
      }
      const row = rowToObject(header, parseCsvLine(line));
      const sid = String(row.service_id || '').trim();
      const dat = String(row.date || '').trim();
      const typ = parseInt(row.exception_type, 10);
      if (!sid || dat.length !== 8 || Number.isNaN(typ)) continue;
      let m = exceptionsByDate.get(dat);
      if (!m) {
        m = new Map();
        exceptionsByDate.set(dat, m);
      }
      m.set(sid, typ);
    }
  }

  const active = new Set<string>();

  if (!calendars.size && exceptionsByDate.size) {
    for (const d of iterateDatesInclusive(startYYYYMMDD, endYYYYMMDD)) {
      const ex = exceptionsByDate.get(d);
      if (!ex) continue;
      for (const [sid, typ] of ex) {
        if (typ === 1) active.add(sid);
      }
    }
    return active;
  }

  for (const d of iterateDatesInclusive(startYYYYMMDD, endYYYYMMDD)) {
    const dow = yyyymmddToWeekday(d);
    const dayCol = DOW_TO_CAL_COL[dow];
    const ex = exceptionsByDate.get(d);

    const runsToday = new Set<string>();
    for (const [serviceId, cal] of calendars) {
      if (d < cal.start || d > cal.end) continue;
      if (String(cal.dow[dayCol] || '') !== '1') continue;
      runsToday.add(serviceId);
    }

    if (ex) {
      for (const [sid, typ] of ex) {
        if (typ === 2) runsToday.delete(sid);
        if (typ === 1) runsToday.add(sid);
      }
    }

    for (const sid of runsToday) active.add(sid);
  }

  return active;
}

export function defaultTorontoDateRangeYYYYMMDD(timeZone = 'America/Toronto', daysBack = 6) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = (ms: number) => {
    const s = fmt.format(new Date(ms));
    const [y, mo, d] = s.split('-');
    return `${y}${mo}${d}`;
  };
  const now = Date.now();
  const end = parts(now);
  const start = parts(now - daysBack * 86400000);
  return { start, end };
}
