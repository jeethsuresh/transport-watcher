import type Database from 'better-sqlite3';

const TORONTO_TZ = 'America/Toronto';

export function torontoMinutesSinceMidnight(unixSec: number) {
  const d = new Date(unixSec * 1000);
  const h = new Intl.DateTimeFormat('en-CA', {
    timeZone: TORONTO_TZ,
    hour: '2-digit',
    hour12: false,
  }).format(d);
  const m = new Intl.DateTimeFormat('en-CA', {
    timeZone: TORONTO_TZ,
    minute: '2-digit',
  }).format(d);
  const hh = parseInt(h, 10);
  const mm = parseInt(m, 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return 0;
  return hh * 60 + mm;
}

export function torontoDateKey(unixSec: number) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TORONTO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(unixSec * 1000));
}

export function clockMinuteInSymmetricWindow(eventMin: number, nowMin: number, halfWidth: number) {
  const low = nowMin - halfWidth;
  const high = nowMin + halfWidth;
  if (low < 0) {
    return eventMin >= 1440 + low || eventMin <= high;
  }
  if (high >= 1440) {
    return eventMin >= low || eventMin <= high - 1440;
  }
  return eventMin >= low && eventMin <= high;
}

export function computeStopHeadwayHeuristic(
  db: Database.Database,
  stopId: string,
  nowSec?: number,
  lookbackDays = 7,
  halfWindowMinutes = 30
) {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const cutoff = now - lookbackDays * 86400;
  const rows = db
    .prepare(
      `SELECT observed_at AS observedAt, route_id AS routeId
       FROM rt_arrival_events
       WHERE stop_id = ? AND observed_at >= ? AND observed_at <= ?
       ORDER BY observed_at ASC`
    )
    .all(stopId, cutoff, now) as { observedAt: number; routeId: string }[];

  const nowMin = torontoMinutesSinceMidnight(now);
  const inBand = rows.filter((r) =>
    clockMinuteInSymmetricWindow(torontoMinutesSinceMidnight(r.observedAt), nowMin, halfWindowMinutes)
  );

  const byDay = new Map<string, typeof rows>();
  for (const r of inBand) {
    const dk = torontoDateKey(r.observedAt);
    let arr = byDay.get(dk);
    if (!arr) {
      arr = [];
      byDay.set(dk, arr);
    }
    arr.push(r);
  }

  const gapsSec: number[] = [];
  for (const dayRows of byDay.values()) {
    const sorted = [...dayRows].sort((a, b) => a.observedAt - b.observedAt);
    for (let i = 1; i < sorted.length; i += 1) {
      gapsSec.push(sorted[i].observedAt - sorted[i - 1].observedAt);
    }
  }

  let avgHeadwayMinutes: number | null = null;
  if (gapsSec.length) {
    const meanSec = gapsSec.reduce((a, b) => a + b, 0) / gapsSec.length;
    avgHeadwayMinutes = Math.round((meanSec / 60) * 10) / 10;
  }

  const lastRow = db
    .prepare(
      `SELECT MAX(observed_at) AS t FROM rt_arrival_events
       WHERE stop_id = ? AND observed_at >= ? AND observed_at <= ?`
    )
    .get(stopId, cutoff, now) as { t: number | null } | undefined;
  const lastArrivalUnix = lastRow && lastRow.t != null ? lastRow.t : null;
  let minutesSinceLastArrival: number | null = null;
  if (lastArrivalUnix != null) {
    minutesSinceLastArrival = Math.round(((now - lastArrivalUnix) / 60) * 10) / 10;
  }

  let estimatedDelayMinutes: number | null = null;
  if (minutesSinceLastArrival != null && avgHeadwayMinutes != null && avgHeadwayMinutes > 0) {
    estimatedDelayMinutes = Math.max(0, Math.round((minutesSinceLastArrival - avgHeadwayMinutes) * 10) / 10);
  }

  return {
    windowArrivalCount: inBand.length,
    gapSampleCount: gapsSec.length,
    avgHeadwayMinutes,
    minutesSinceLastArrival,
    estimatedDelayMinutes,
    lookbackDays,
    halfWindowMinutes,
  };
}
