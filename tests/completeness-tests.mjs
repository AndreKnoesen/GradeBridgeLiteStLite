// =====================================================
// The student is told the number before the file is written
// =====================================================
// `workorders/WORKORDER_SS_COMPLETENESS_2026-09-09.md`.
//
//   node tests/completeness-tests.mjs
//
// On 2026-09-04 the app handed a student a submission with two photographs
// missing and never stated a number. The cause is still unknown after three
// attempts to reproduce it. This suite covers the guard that makes the loss
// visible whatever the cause is.
//
// **The check this suite exists for is check 1.** The count must be right with
// registration entirely absent — no page ever registered, so the QR-derived `N`
// the existing page-level guard reads is undefined and its missing-page list is
// empty. That is the case the old guard cannot handle and the reason the new
// one is derived from the layout map instead.
//
// What it does NOT cover: geometry, `layout_id`, the capture gate, encryption.
// `registration-tests.mjs`, `embedded-layout-tests.mjs`, `gate-tests.mjs` and
// `package-encryption-tests.mjs` hold those, and nothing here moves them.
// =====================================================

import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './captureSet.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const results = [];
const check = (name, fn) => {
  try { fn(); passed++; results.push(`  PASS  ${name}`); }
  catch (err) { failed++; results.push(`  FAIL  ${name}\n          ${err.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); passed++; results.push(`  PASS  ${name}`); }
  catch (err) { failed++; results.push(`  FAIL  ${name}\n          ${err.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const assertEqual = (actual, expected, msg) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n          expected: ${e}\n          actual:   ${a}`);
};

const cmp = await loadModule('services/completeness.ts', 'cm_completeness.mjs');
const lay = await loadModule('services/layoutMap.ts', 'cm_layout.mjs');
const pkg = await loadModule('services/submissionPackage.ts', 'cm_pkg.mjs');

console.log('\ncompleteness — the number, before the download\n');

// The real ENG17 HW1 map: 17 regions over 16 pages, with page 1 (instructions)
// and page 13 carrying none. A fixture whose regions ran 1..N would hide two
// real properties — that `page_k` is not a row index, and that `maxPageK` is
// not the page count.
const CSV = readFileSync(join(REPO, 'tests/fixtures/layout_ENG17HOM496F.csv'), 'utf8');
const layout = await lay.parseLayoutCsv(CSV, 'layout_ENG17HOM496F.csv');
const cropFile = (regionId) => `crops/${regionId}.jpg`;

/** Every region cropped and every crop in the archive. */
const allCrops = Object.fromEntries(layout.rows.map(r =>
  [r.regionId, { regionId: r.regionId, file: cropFile(r.regionId) }]));
const allEntries = ['sub.json', ...layout.rows.map(r => cropFile(r.regionId))];

// =====================================================
// 1. With registration entirely absent, the count is still right
// =====================================================
// THE REASON THIS ORDER EXISTS. `PageUploader`'s `declaredN` comes from the QR
// on a photographed sheet; with no page registered it is undefined and its
// `missingK` list is empty, so the page-level warning vanishes at the moment it
// is most needed. The map has been in hand since the assignment loaded.
console.log('  1. no page registered, and the number is still known');

{
  const c = cmp.submissionCompleteness(layout, {}, ['sub.json']);
  check('no registration at all: every declared region is still expected', () =>
    assertEqual([c.expected, c.present, c.missing.length], [17, 0, 17],
      'the expectation collapsed when nothing had registered'));
  check('no registration at all: the message is produced, not skipped', () =>
    assert(cmp.completenessMessage(c) !== null,
      'a submission with no answers at all produced no statement'));
  check('the count is the regions declared, not maxPageK and not a page count', () => {
    assert(layout.maxPageK === 16, `fixture maxPageK is ${layout.maxPageK}, expected 16`);
    assert(c.expected === 17, `expected ${c.expected}, not the 17 regions declared`);
  });
}

// =====================================================
// 1b. An empty submission is its own sentence
// =====================================================
// Andre, 2026-09-09, having read the seventeen-missing case on screen: at zero
// the itemised list is noise, and "if you left those blank on purpose" does not
// describe someone who has done nothing. **The list earns its place at fourteen
// of seventeen**, which is what section 4 covers.
console.log('\n  1b. nothing captured at all');

{
  const msg = cmp.completenessMessage(cmp.submissionCompleteness(layout, {}, ['sub.json']));

  check('nothing captured: no answer is itemised and no page is named', () => {
    assert(!/Missing:/.test(msg), `the empty case still itemises:\n${msg}`);
    assert(!/on page \d+/.test(msg), `the empty case still names pages:\n${msg}`);
    for (const part of ['1(a)', '3(b)', '10']) {
      assert(!msg.includes(part), `the empty case names "${part}":\n${msg}`);
    }
  });

  check('nothing captured: it still states the total and that none of it is there', () => {
    assert(/This assignment has 17 answers\./.test(msg), `no total in:\n${msg}`);
    assert(/none of them/.test(msg), `it does not say none of them are there:\n${msg}`);
  });

  check('nothing captured: the wording does not assume part-by-part choices', () => {
    assert(!/left those blank/i.test(msg),
      `the empty case still offers the partial-submission wording:\n${msg}`);
    assert(/If that is deliberate/.test(msg), `no wording that fits having done nothing:\n${msg}`);
    assert(/choose OK/i.test(msg) && /Cancel/.test(msg),
      `the empty case does not say what the buttons do:\n${msg}`);
  });

  // A one-region assignment: "none of them" is wrong for a single answer, and a
  // sentence that is grammatically wrong is a sentence a student stops trusting.
  const one = cmp.completenessMessage(cmp.submissionCompleteness(
    { rows: [layout.rows[0]] }, {}, ['sub.json']));
  check('nothing captured, one answer only: the sentence is singular', () => {
    assert(/This assignment has 1 answer\./.test(one), `not singular:\n${one}`);
    assert(/does not have it\./.test(one), `still says "none of them" for one answer:\n${one}`);
  });

  // The boundary. One answer captured is a partial submission, and a partial
  // submission is exactly where the names and pages are worth reading.
  const partial = cmp.completenessMessage(cmp.submissionCompleteness(
    layout, allCrops, ['sub.json', cropFile('p1a')]));
  check('one answer captured: the itemised list comes back', () => {
    assert(/Missing: /.test(partial), `the list did not return at present=1:\n${partial}`);
    assert(/on page \d+/.test(partial), `no pages named at present=1:\n${partial}`);
    assert(/left those blank on purpose/.test(partial),
      `the partial wording did not return at present=1:\n${partial}`);
  });
}

// =====================================================
// 2. A crop record with no bytes behind it is missing
// =====================================================
// The 2026-09-04 shape: the crop is named in the payload and absent from the
// archive, because `buildSubmissionPackage` skips a crop whose bitmap
// `readBlob` cannot return. Presence must therefore be read from what the
// archive HOLDS, never from what the crop record claims.
console.log('\n  2. presence is what the archive holds');

{
  const entries = allEntries.filter(e => e !== cropFile('p3b') && e !== cropFile('p7'));
  const c = cmp.submissionCompleteness(layout, allCrops, entries);
  check('a crop in the record but not in the archive counts as missing', () =>
    assertEqual([c.expected, c.present, c.missing.map(m => m.regionId)],
      [17, 15, ['p3b', 'p7']], 'the dropped entries were counted as present'));
  check('each missing answer carries the page it is on', () =>
    assertEqual(c.missing.map(m => [m.partId, m.pageK]), [['3(b)', 8], ['7', 12]],
      'the missing list does not name the part and its page'));
}

// =====================================================
// 3. A complete submission says nothing at all
// =====================================================
console.log('\n  3. silence on the common path');

{
  const c = cmp.submissionCompleteness(layout, allCrops, allEntries);
  check('complete: nothing is missing', () =>
    assertEqual([c.expected, c.present, c.missing], [17, 17, []],
      'a complete package reported a shortfall'));
  check('complete: completenessMessage returns null — no dialog, no extra click', () =>
    assert(cmp.completenessMessage(c) === null,
      `a complete submission produced a message: ${cmp.completenessMessage(c)}`));
}

{
  // An electronic assignment has no map. It declares no regions, expects none,
  // and must never see this dialog.
  const c = cmp.submissionCompleteness(null, {}, ['sub.json', 'x.pdf']);
  check('electronic (no layout map): nothing expected, nothing said', () => {
    assertEqual([c.expected, c.present, c.missing], [0, 0, []], 'a null map expected something');
    assert(cmp.completenessMessage(c) === null,
      'an electronic submission produced a shortfall dialog');
  });
}

// =====================================================
// 4. What the message actually says
// =====================================================
// **The page numbers are the requirement, not decoration.** A student acts on
// paper: "3(b)" alone sends them through sixteen sheets, "3(b) on page 8" sends
// them to a sheet. Removing the pages from the message must fail here.
console.log('\n  4. the message');

{
  const gone = [cropFile('p3b'), cropFile('p3c'), cropFile('p7')];
  const c = cmp.submissionCompleteness(
    layout, allCrops, allEntries.filter(e => !gone.includes(e)));
  const msg = cmp.completenessMessage(c);

  check('the message states both counts', () => {
    assert(/This assignment has 17 answers\./.test(msg), `no expected count in:\n${msg}`);
    assert(/Your submission has 14\./.test(msg), `no present count in:\n${msg}`);
  });

  check('the message names the page each missing answer is on', () => {
    for (const [part, page] of [['3(b)', 8], ['3(c)', 8], ['7', 12]]) {
      assert(msg.includes(`page ${page}`), `"page ${page}" is not in the message:\n${msg}`);
      assert(msg.includes(part), `"${part}" is not in the message:\n${msg}`);
    }
    // Named and paged, not merely both present somewhere: every clause of the
    // list must end in the page its answers are on.
    const line = /Missing: (.+)\./.exec(msg);
    assert(line, `the message has no "Missing:" line:\n${msg}`);
    for (const clause of line[1].split(/,\s*/)) {
      if (/^and \d+ more$/.test(clause)) continue;
      assert(/ on page \d+$/.test(clause),
        `"${clause}" names answers without saying which page they are on`);
    }
  });

  check('answers on the same sheet are grouped under one page', () =>
    assert(msg.includes('3(b) and 3(c) on page 8'),
      `two answers on page 8 were not grouped:\n${msg}`));

  check('continue is the plain path: OK downloads, Cancel goes back', () => {
    assert(/choose OK to download/i.test(msg), `the message does not say OK continues:\n${msg}`);
    assert(/Cancel to go back/i.test(msg), `the message does not say Cancel returns:\n${msg}`);
    assert(!/(are you sure|warning|do not|must)/i.test(msg),
      `the message pressures the student out of a legitimate choice:\n${msg}`);
  });
}

{
  // Fourteen missing: the number matters more than the list, and a dialog
  // nobody reads to the end is a dialog nobody reads.
  const kept = layout.rows.slice(0, 3).map(r => cropFile(r.regionId));
  const c = cmp.submissionCompleteness(layout, allCrops, ['sub.json', ...kept]);
  const msg = cmp.completenessMessage(c);
  check('a long list is capped and says how many more', () => {
    assert(c.missing.length === 14, `${c.missing.length} missing, expected 14`);
    const named = /Missing: (.+)\./.exec(msg)[1];
    const shown = (named.match(/on page \d+/g) ?? []).length;
    assert(shown <= cmp.MISSING_NAMES_SHOWN,
      `${shown} page clauses in the message; the cap is ${cmp.MISSING_NAMES_SHOWN}`);
    assert(/, and \d+ more$/.test(named), `the capped list does not say how many more:\n${msg}`);
  });
}

// =====================================================
// 5. Against a real built package, sealed and unsealed
// =====================================================
// Not a hand-written entry list: the archive the app would actually download,
// with one crop's bitmap unreadable exactly as it would be if a photograph had
// gone missing between capture and packaging.
console.log('\n  5. against a real package');

const jpegish = (seed, length) => {
  const out = new Uint8Array(length);
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  for (let i = 4; i < length; i++) out[i] = (seed * 37 + i * 11) & 0xff;
  return out;
};

const REGIONS = layout.rows.slice(0, 4);   // p1a, p1b, p1c, p1d
const sources = (coursePublicKey) => ({
  assignment: {
    id: 'a1', courseCode: 'ENG17', title: 'Homework 1', inputMode: 'handwritten',
    ...(coursePublicKey ? { coursePublicKey } : {}),
    problems: [{ id: 'p0', title: 'P', description: '', subsections: [] }],
  },
  submissionData: {},
  isHandwritten: true,
  layoutId: layout.computedLayoutId,
  now: '2026-09-09T09:00:00.000Z',
  pages: [],
  crops: Object.fromEntries(REGIONS.map((r, i) => [r.regionId, {
    regionId: r.regionId, partId: r.partId, pageK: r.pageK,
    isDrawing: r.isDrawing, maxPoints: r.maxPoints,
    cropSource: 'registration', review: 'signed_off', qualityFlags: [],
    file: cropFile(r.regionId), width: 800, height: 300, bytes: 600 + i,
  }])),
});

/** The bitmap for p1c is gone — the store has nothing under its key. */
const readBlobMissingP1c = async (key) =>
  key === pkg.cropBlobKey('p1c') ? null : jpegish(7, 600);

await checkAsync('a real package: the unreadable crop is named, with its page', async () => {
  const built = await pkg.buildSubmissionPackage(sources(null),
    { readBlob: readBlobMissingP1c, downsampleImage: async (d) => d });
  assert(!built.entries.includes(cropFile('p1c')),
    'the fixture did not actually drop p1c from the archive');
  const c = cmp.submissionCompleteness({ rows: REGIONS }, sources(null).crops, built.entries);
  assertEqual([c.expected, c.present, c.missing.map(m => [m.partId, m.pageK])],
    [4, 3, [['1(c)', 3]]], 'the package-derived count is wrong');
});

await checkAsync('a real package, complete: no statement is produced', async () => {
  const built = await pkg.buildSubmissionPackage(sources(null),
    { readBlob: async () => jpegish(7, 600), downsampleImage: async (d) => d });
  const c = cmp.submissionCompleteness({ rows: REGIONS }, sources(null).crops, built.entries);
  assert(cmp.completenessMessage(c) === null,
    `a complete real package produced: ${cmp.completenessMessage(c)}`);
});

await checkAsync('a sealed archive: gb2 entry names still count as present', async () => {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['encrypt', 'decrypt']);
  const PUB = `-----BEGIN PUBLIC KEY-----\n${Buffer
    .from(await webcrypto.subtle.exportKey('spki', pair.publicKey))
    .toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()}\n-----END PUBLIC KEY-----\n`;

  const built = await pkg.buildSubmissionPackage(sources(PUB),
    { readBlob: readBlobMissingP1c, downsampleImage: async (d) => d });
  assert(built.entries.some(e => e.endsWith(pkg.ENCRYPTED_ENTRY_SUFFIX)),
    'the sealed fixture produced no sealed entries');
  const c = cmp.submissionCompleteness({ rows: REGIONS }, sources(PUB).crops, built.entries);
  assertEqual([c.expected, c.present, c.missing.map(m => m.partId)], [4, 3, ['1(c)']],
    'sealing the archive broke the presence test — a .gb2 entry read as a different file');
});

// =====================================================
// 6. It is wired in, before the download
// =====================================================
// `App.tsx` cannot be imported here, so the wiring is asserted over the shipped
// source. Removing the call, or moving it after `downloadBlob`, must fail here:
// the pure functions above are worth nothing if nothing calls them, and an
// uncalled guard is exactly what let 2026-09-04 pass in silence.
console.log('\n  6. wiring');

{
  const app = readFileSync(join(REPO, 'App.tsx'), 'utf8');
  const handlerAt = app.indexOf('const handleDownloadForGradescope');
  check('App.tsx still has the submission handler', () =>
    assert(handlerAt > 0, 'handleDownloadForGradescope not found'));

  const checkAt = app.indexOf('submissionCompleteness(', handlerAt);
  const confirmAt = app.indexOf('window.confirm(', handlerAt);
  const downloadAt = app.indexOf('downloadBlob(zipBlob', handlerAt);

  check('the handler computes completeness from the map and the built entries', () => {
    assert(checkAt > handlerAt, 'submissionCompleteness is not called in the submission handler');
    assert(/submissionCompleteness\(state\.layout,\s*state\.crops,\s*built\.entries\)/.test(app),
      'completeness is not computed from state.layout, state.crops and built.entries');
  });

  check('the statement is put to the student before the file is written', () => {
    assert(confirmAt > checkAt, 'nothing is put to the student after the check');
    assert(downloadAt > confirmAt,
      'the download happens before the student is asked — too late to act on');
  });

  check('declining downloads nothing', () =>
    assert(/if \(!window\.confirm\(shortfall\)\) \{[\s\S]{0,400}?return;/.test(app),
      'cancelling does not return before the archive is generated'));

  check('a complete submission reaches the download with no dialog', () =>
    assert(/const shortfall = completenessMessage\([\s\S]{0,200}?\);\s*if \(shortfall\) \{/.test(app),
      'the dialog is not conditional on there being a shortfall'));
}

// =====================================================
// 7. The dialog describes the ZIP the student actually has
// =====================================================
// The adjacent defect in the same dialog: it told EVERY student the archive
// contains a PDF, and a handwritten submission carries none by design
// (`submissionPackage`, 2026-09-01 — `PrintView` never receives the pages or
// the crops, so the PDF would be the blank question paper). Same class of thing
// as the check above: the app stating something untrue about what the student
// is holding.
console.log('\n  7. the ZIP is described truthfully');

{
  const app = readFileSync(join(REPO, 'App.tsx'), 'utf8');
  const alertAt = app.indexOf('Submission package created.');
  const alertEnd = app.indexOf('Check you have the file before you close this page.', alertAt);
  const body = app.slice(alertAt, alertEnd);

  check('the completed-download dialog branches on the input mode', () =>
    assert(/isHandwritten[\s\S]{0,400}?This ZIP contains/.test(body),
      'the dialog still describes one archive for both submission paths'));

  check('the handwritten branch does not claim a PDF', () => {
    const arm = /\?([\s\S]*?):/.exec(body);
    assert(arm, `no conditional arm found in the dialog:\n${body}`);
    assert(!/PDF/.test(arm[1]),
      `the handwritten branch still promises a PDF:\n${arm[1]}`);
    assert(/page photographs/.test(arm[1]),
      `the handwritten branch does not say what the archive holds:\n${arm[1]}`);
  });

  check('the electronic branch still names the PDF it really carries', () =>
    assert(/:\s*`This ZIP contains your PDF and submission data\./.test(body),
      'the electronic dialog stopped naming its PDF'));
}

console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
