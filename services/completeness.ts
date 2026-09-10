/**
 * completeness.ts — how many answers the assignment has, how many the archive
 * carries, and which ones are not in it.
 *
 * ## Why this exists
 *
 * On 2026-09-04 a submission was built and downloaded with two photographs
 * missing, and nothing anywhere said a number. Three attempts to reproduce the
 * loss have failed and the cause is still unknown. **This does not fix the
 * cause. It removes the silence**, which is worth more, because it holds
 * whatever the trigger turns out to be — including triggers nobody has thought
 * of yet.
 *
 * ## The load-bearing decision: count from the MAP, never from the QR
 *
 * `layout_*.csv` is parsed the moment the assignment loads, before any
 * photograph exists, and it declares every region with its `part_id` and its
 * `page_k`. So the number of answers an assignment has is known from the first
 * screen and cannot stop being known.
 *
 * The page-level guard in `PageUploader` does the opposite: it reads `N` from
 * the QR on a photographed sheet, and its own comment says the count "is only
 * knowable once at least one page is in". **That is the failure mode. If
 * registration fails, `declaredN` is undefined, the missing-page list is empty,
 * and the warning disappears at exactly the moment it was needed.** A guard
 * against a thing that may be failing must not be derived from that thing.
 *
 * `maxPageK` is deliberately not used here either: it is the highest page
 * carrying a region, which on an assignment whose last sheet is blank is not
 * the page count.
 *
 * ## Presence is what the ARCHIVE holds, not what the record claims
 *
 * A region counts as answered when the built package actually carries its crop
 * entry. Not when a `CropRef` exists for it — `buildSubmissionPackage` skips a
 * crop whose bitmap `readBlob` cannot return, so a crop record with no bytes
 * behind it is precisely the 2026-09-04 shape: named in the payload, absent
 * from the ZIP, and until now silent.
 *
 * ## Inform, never block
 *
 * Nothing here refuses anything. A student submitting incomplete work on
 * purpose is a real and legitimate case, and `buildSubmissionPackage` packages
 * a partial submission without complaint by design. What this adds is that the
 * student sees the number and chooses it.
 */

import { OrderableRegion, inAssignmentOrder } from './layoutMap';
import { ENCRYPTED_ENTRY_SUFFIX } from './submissionPackage';

/** One declared answer the archive does not carry. */
export interface MissingAnswer {
  regionId: string;
  /** What the printed sheet calls it — `1(a)`. The student acts on this, not on `region_id`. */
  partId: string;
  /** The sheet it is on. Without this the name is not actionable. */
  pageK: number;
}

export interface Completeness {
  /** Regions the layout map declares. Known from load, never from a QR. */
  expected: number;
  /** Of those, how many the archive carries a crop for. */
  present: number;
  /** The rest, in assignment order. */
  missing: MissingAnswer[];
}

/**
 * How many missing answers are named before the message stops listing them.
 *
 * A student with fourteen missing needs the number more than the list, and a
 * dialog nobody can read to the end is a dialog nobody reads.
 */
export const MISSING_NAMES_SHOWN = 6;

/** The crop fields this check needs. Structural, so `CropRef` satisfies it. */
export interface CroppedEntry {
  regionId: string;
  /** Name inside the submission ZIP, before any seal suffix. */
  file: string;
}

/** A sealed entry is `crops/p1a.jpg.gb2`; the crop record still calls it `crops/p1a.jpg`. */
const unsealed = (entry: string): string =>
  entry.endsWith(ENCRYPTED_ENTRY_SUFFIX)
    ? entry.slice(0, -ENCRYPTED_ENTRY_SUFFIX.length)
    : entry;

/**
 * Compare what the map declares against what the archive holds.
 *
 * `layout` null is an electronic assignment: it declares no regions, so nothing
 * is expected, nothing is missing, and the electronic path is untouched.
 */
export const submissionCompleteness = (
  layout: { rows: readonly (OrderableRegion & { partId: string })[] } | null,
  crops: Readonly<Record<string, CroppedEntry | undefined>>,
  entries: readonly string[],
): Completeness => {
  const rows = layout ? inAssignmentOrder(layout.rows) : [];
  const written = new Set(entries.map(unsealed));

  const missing: MissingAnswer[] = [];
  for (const row of rows) {
    const crop = crops[row.regionId];
    if (crop && written.has(unsealed(crop.file))) continue;
    missing.push({ regionId: row.regionId, partId: row.partId, pageK: row.pageK });
  }

  return { expected: rows.length, present: rows.length - missing.length, missing };
};

/** `1(a), 1(b) and 3` — an Oxford-less list, because it is read aloud in a dialog. */
const nameList = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/**
 * The missing answers as `1(b) and 1(c) on page 3, 2(a) on page 5`.
 *
 * **Every name is followed by the page it is on.** A student acts on paper:
 * `1(b)` alone sends them looking through sixteen sheets, `1(b) on page 3`
 * sends them to a sheet. Grouping by page is what keeps that from becoming
 * unreadable when six answers share one sheet.
 */
export const missingByPage = (missing: readonly MissingAnswer[]): string => {
  const pages: number[] = [];
  const byPage = new Map<number, string[]>();
  for (const m of missing) {
    if (!byPage.has(m.pageK)) { byPage.set(m.pageK, []); pages.push(m.pageK); }
    byPage.get(m.pageK)!.push(m.partId || m.regionId);
  }
  return pages.map(k => `${nameList(byPage.get(k)!)} on page ${k}`).join(', ');
};

/**
 * What to put in front of the student, or null when there is nothing to say.
 *
 * **Null on a complete submission is a requirement, not an optimisation.** The
 * common path gets no congratulation and no extra click; a dialog that always
 * appears is a dialog that is always dismissed, and this one has to be read on
 * the one occasion it differs.
 */
export const completenessMessage = (c: Completeness): string | null => {
  if (c.missing.length === 0) return null;

  const shown = c.missing.slice(0, MISSING_NAMES_SHOWN);
  const rest = c.missing.length - shown.length;
  const list = missingByPage(shown) + (rest > 0 ? `, and ${rest} more` : '');
  const answers = (n: number): string => `${n} ${n === 1 ? 'answer' : 'answers'}`;

  return (
    `This assignment has ${answers(c.expected)}. Your submission has ${c.present}.\n\n` +
    `Missing: ${list}.\n\n` +
    `If you left those blank on purpose, choose OK to download your submission.\n` +
    `Choose Cancel to go back and add them.`
  );
};
