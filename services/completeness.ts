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

/** The missing answers on one sheet, in assignment order. */
export interface MissingPageGroup {
  pageK: number;
  /** `part_id` — what the printed sheet calls each answer. */
  names: string[];
}

/**
 * Grouped by the sheet they are on, pages in assignment order.
 *
 * **Every name is rendered under the page it is on.** A student acts on paper:
 * `1(b)` alone sends them looking through sixteen sheets, `1(b)` under a
 * "Page 3" heading sends them to a sheet. Grouping is also what keeps six
 * answers on one sheet from reading as six separate errands.
 */
export const groupMissingByPage = (missing: readonly MissingAnswer[]): MissingPageGroup[] => {
  const order: number[] = [];
  const byPage = new Map<number, string[]>();
  for (const m of missing) {
    if (!byPage.has(m.pageK)) { byPage.set(m.pageK, []); order.push(m.pageK); }
    byPage.get(m.pageK)!.push(m.partId || m.regionId);
  }
  return order.map(pageK => ({ pageK, names: byPage.get(pageK)! }));
};

/**
 * What the gate puts in front of the student, or null when there is nothing
 * to say.
 *
 * **Structured rather than a single string, and that is the point.** This was
 * a `window.confirm` message until 2026-09-09. A suppressed `confirm` returns
 * `false` immediately without showing anything, the handler read `false` as
 * "cancel", and a student whose browser had begun ignoring dialogs could tap
 * Download and get nothing at all — for the life of the page, on the one path
 * where the failure is a zero rather than an annoyance. See the standing rule
 * in `CLAUDE.md`: **a guard on a constructive action must fail open.**
 *
 * So the choice is rendered in the page, where nothing can suppress it and
 * nothing can answer it on the student's behalf. Three things that bought:
 *
 *   - **No default-activated control.** In a `confirm`, OK is the default and
 *     Enter downloads an incomplete submission. The gate focuses its heading
 *     and nothing is one keystroke away.
 *   - **No cap on the list.** The dialog named six answers and said "and 8
 *     more" because a dialog nobody can read to the end is a dialog nobody
 *     reads. A panel scrolls, so all seventeen can simply be there.
 *   - **The prose stops naming browser buttons.** "choose OK" became "you can
 *     download anyway", which is true wherever it renders.
 *
 * **Null on a complete submission is a requirement, not an optimisation.** The
 * common path gets no gate, no congratulation and no extra tap.
 */
export interface CompletenessNotice {
  /** The counts, as one sentence. */
  headline: string;
  /** False when nothing was captured at all — then `groups` is empty by design. */
  itemised: boolean;
  groups: MissingPageGroup[];
  /** The sentence that says downloading anyway is a legitimate choice. */
  choice: string;
}

export const completenessNotice = (c: Completeness): CompletenessNotice | null => {
  if (c.missing.length === 0) return null;

  const answers = (n: number): string => `${n} ${n === 1 ? 'answer' : 'answers'}`;

  // **An empty submission is its own sentence** (Andre, 2026-09-09, having read
  // the seventeen-missing case on screen).
  //
  // Itemising every part is noise when the answer is "all of them": the list
  // makes a student read seventeen names to learn a fact one line already
  // carries. And "if you left those blank on purpose" describes someone who
  // made choices part by part — it does not fit someone who has done nothing,
  // and offering it to them reads as an accusation of a decision they did not
  // take.
  //
  // The list earns its place as soon as the submission is partly there, which
  // is where the names and pages are what the student acts on.
  if (c.present === 0) {
    return {
      headline:
        `This assignment has ${answers(c.expected)}. ` +
        (c.expected === 1
          ? 'Your submission does not have it.'
          : 'Your submission has none of them.'),
      itemised: false,
      groups: [],
      choice: 'If that is deliberate, you can download it anyway.',
    };
  }

  return {
    headline: `This assignment has ${answers(c.expected)}. Your submission has ${c.present}.`,
    itemised: true,
    groups: groupMissingByPage(c.missing),
    choice: 'If you left those blank on purpose, you can download anyway.',
  };
};
