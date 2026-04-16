/**
 * Minimal GTFS CSV line parser (RFC-style quoted fields).
 */
/** Extract one field (0-based index) without building a full row — same quoting rules as parseCsvLine. */
export function getCsvFieldZeroBased(line: string, fieldIndex: number): string {
  if (fieldIndex < 0) return '';
  let cur = '';
  let inQ = false;
  let idx = 0;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      if (idx === fieldIndex) return cur;
      idx += 1;
      cur = '';
    } else {
      cur += c;
    }
  }
  return idx === fieldIndex ? cur : '';
}

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export function rowToObject(header: string[], cells: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < header.length; i += 1) {
    o[header[i]] = cells[i] != null ? cells[i] : '';
  }
  return o;
}
