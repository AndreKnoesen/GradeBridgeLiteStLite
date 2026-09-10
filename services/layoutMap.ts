/**
 * layoutMap.ts — reading `layout_{ID}.csv`, and the hash check over it.
 *
 * The map is the geometry contract: eleven columns, one row per declared
 * rectangle, coordinates as page fractions to four decimal places with the
 * 3 mm region pad already baked in. **Do not pad again at crop time.**
 *
 * Two rules from the CONSUME work order, both about not guessing:
 *
 *   - Every field is read from the row **by column name**, never inferred from
 *     position, from row order, or by parsing `region_id`. A generator free to
 *     add a column must not be able to silently re-point this app at the wrong
 *     one, and `region_id` is an opaque key — `part_id`, `is_drawing` and
 *     `max_points` are their own columns precisely so nobody has to decode it.
 *   - `layout_id` is recomputed here from the rows and compared against the
 *     `layout_id` decoded from the QR on the paper. On mismatch nothing is
 *     cropped. The failure that check prevents is silent: correct rectangles,
 *     wrong labels, no error anywhere downstream.
 */

import { HashableRegion, computeLayoutId } from './qrPayload';

export const LAYOUT_COLUMNS = [
  'assignment_id', 'layout_id', 'region_id', 'part_id', 'page_k',
  'x0', 'y0', 'x1', 'y1', 'is_drawing', 'max_points',
] as const;

export interface LayoutRow {
  assignmentId: string;
  layoutId: string;
  regionId: string;
  partId: string;
  pageK: number;
  x0: number; y0: number; x1: number; y1: number;
  isDrawing: boolean;
  maxPoints: number;
}

export interface LayoutMap {
  rows: LayoutRow[];
  assignmentId: string;
  /** `layout_id` as the CSV declares it in its own column. */
  declaredLayoutId: string;
  /** `layout_id` recomputed from the rows. This is what a QR is checked against. */
  computedLayoutId: string;
  /** Highest `page_k` present. `N` comes from the QR, never from here. */
  maxPageK: number;
  /** File name the map arrived under, for error messages. */
  sourceName: string;
}

export class LayoutMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutMapError';
  }
}

/**
 * Minimal RFC-4180 field splitter: handles quoting and doubled quotes, because
 * `part_id` is a display string and a comma in one would otherwise shift every
 * column after it by one and be read as a number without complaint.
 */
const splitCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
};

const asNumber = (raw: string, column: string, lineNo: number): number => {
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) {
    throw new LayoutMapError(`row ${lineNo}: ${column} is "${raw}", which is not a number`);
  }
  return n;
};

/**
 * Booleans in the map are written by a generator, not by a person, so the set
 * of accepted spellings is small and anything else is an error rather than a
 * silent `false` — a region wrongly read as prose instead of a drawing routes
 * the answer to the wrong grader.
 */
const asBoolean = (raw: string, column: string, lineNo: number): boolean => {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
  throw new LayoutMapError(`row ${lineNo}: ${column} is "${raw}", which is not a boolean`);
};

/** Parses one `layout_*.csv` and recomputes its `layout_id`. */
export const parseLayoutCsv = async (text: string, sourceName = 'layout.csv'): Promise<LayoutMap> => {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new LayoutMapError(`${sourceName} is empty`);

  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const index: Record<string, number> = {};
  for (const column of LAYOUT_COLUMNS) {
    const at = header.indexOf(column);
    if (at < 0) throw new LayoutMapError(`${sourceName} has no "${column}" column`);
    index[column] = at;
  }

  const rows: LayoutRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const at = (column: string): string => cells[index[column]] ?? '';
    const lineNo = i + 1;
    rows.push({
      assignmentId: at('assignment_id').trim(),
      layoutId: at('layout_id').trim().toUpperCase(),
      regionId: at('region_id').trim(),
      partId: at('part_id').trim(),
      pageK: asNumber(at('page_k'), 'page_k', lineNo),
      x0: asNumber(at('x0'), 'x0', lineNo),
      y0: asNumber(at('y0'), 'y0', lineNo),
      x1: asNumber(at('x1'), 'x1', lineNo),
      y1: asNumber(at('y1'), 'y1', lineNo),
      isDrawing: asBoolean(at('is_drawing'), 'is_drawing', lineNo),
      maxPoints: asNumber(at('max_points'), 'max_points', lineNo),
    });
  }

  if (rows.length === 0) throw new LayoutMapError(`${sourceName} declares no regions`);

  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.regionId)) {
      throw new LayoutMapError(`${sourceName} declares region_id "${r.regionId}" twice`);
    }
    seen.add(r.regionId);
    if (r.x1 <= r.x0 || r.y1 <= r.y0) {
      throw new LayoutMapError(`${sourceName}: region "${r.regionId}" is empty or inverted`);
    }
  }

  const hashable: HashableRegion[] = rows.map(r => ({
    regionId: r.regionId, partId: r.partId, pageK: r.pageK,
    x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
  }));

  return {
    rows,
    assignmentId: rows[0].assignmentId,
    declaredLayoutId: rows[0].layoutId,
    computedLayoutId: await computeLayoutId(hashable),
    maxPageK: rows.reduce((m, r) => Math.max(m, r.pageK), 0),
    sourceName,
  };
};

export const rowsForPage = (map: LayoutMap, pageK: number): LayoutRow[] =>
  map.rows.filter(r => r.pageK === pageK);

/**
 * The least a row needs to be put in assignment order. Declared so the order
 * can be applied to `StoredLayoutMap` rows too — the autosaved, plain-JSON
 * shape in `types.ts` — without either side having to restate the comparison.
 */
export interface OrderableRegion {
  regionId: string;
  pageK: number;
  x0: number;
  y0: number;
}

/**
 * Assignment order: page first, then down the page, then across.
 *
 * **One comparison, not several.** The same sort is what `CropReview` shows the
 * student, what the crop record is keyed in, and what the completeness check
 * lists missing answers in; three copies of a tie-break rule is three chances
 * for a student to be shown one order and told about another.
 */
export const inAssignmentOrder = <T extends OrderableRegion>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) =>
    a.pageK - b.pageK || a.y0 - b.y0 || a.x0 - b.x0 ||
    (a.regionId < b.regionId ? -1 : a.regionId > b.regionId ? 1 : 0));

export const rowsInAssignmentOrder = (map: LayoutMap): LayoutRow[] =>
  inAssignmentOrder(map.rows);
