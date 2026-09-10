// =====================================================
// The deploy gate: refuse to publish a commit CI has not passed
// =====================================================
// On 2026-09-08 the decoder was deployed to production while `main` had been
// red for nearly twenty hours. Three failed runs had been delivered and were
// sitting unread in the GitHub inbox: **the signal existed, and it was not on
// the path between `git push` and `npm run deploy`.** Turning notifications on
// would not have helped, because they were already on; a fourth channel would
// not help either. This sits inside the one command that does the harm.
//
// The harm was never the red CI, which was recoverable. It was publishing a
// build that nothing had verified.
//
// **No credential is needed.** The repository is public and run conclusions are
// readable unauthenticated; only the LOGS endpoint returns 403. That
// distinction cost a cycle to learn, so it is written down here rather than
// rediscovered as "this needs a token".
//
// REFUSES on: a failed run, a cancelled run, no run at all, a run still in
// progress, and any error reaching the API. **A gate that opens when it cannot
// see is not a gate**, so a rate limit or a dropped connection refuses exactly
// like a red run does.
//
// "No run at all" is the case most likely to be dismissed as pedantry, and it
// is the one that matters most: ninety seconds after a push there is nothing to
// find, and a commit that was never pushed has no run and never will. **Silence
// is not success.**
//
// It refuses on all of those the same way. It does NOT report them the same
// way — see "three ways to see nothing" below, added 2026-09-09.
import { execFileSync } from 'node:child_process';

const OVERRIDE = 'GB_ALLOW_RED_CI';
const API = 'https://api.github.com';
const TIMEOUT_MS = 15000;

// Any non-empty value counts except the two that a person plainly means as off.
const raw = process.env[OVERRIDE] ?? '';
const overridden = raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false';

const say = (line) => console.log(`[deploy gate] ${line}`);
const detail = (line) => console.log(`              ${line}`);

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** `owner/repo` from the origin remote, SSH or HTTPS. Derived, never hardcoded. */
const slug = () => {
  const url = git('remote', 'get-url', 'origin');
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error(`cannot read owner/repo from the origin remote: ${url}`);
  return `${m[1]}/${m[2]}`;
};

const describe = (run) => [
  `${run.name} #${run.run_number} — ${run.status}${run.conclusion ? `, ${run.conclusion}` : ''}`,
  run.html_url,
];

/**
 * The single exit point for every refusal reason.
 *
 * Under the override this reports and returns control to the build rather than
 * blocking — but it says so in full, naming the reason it would have refused
 * and the runs it looked at. **The override is never silent**: a deploy that
 * skips the check must be as legible afterwards as one that passed it.
 */
const refuse = (reason, extra = []) => {
  if (overridden) {
    say(`*** OVERRIDDEN — ${OVERRIDE} is set, deploying anyway ***`);
    detail(`Would have refused: ${reason}`);
    for (const line of extra) detail(line);
    detail('');
    detail('The build about to be published has NOT been verified by CI.');
    process.exit(0);
  }
  say('REFUSING TO DEPLOY');
  detail(reason);
  for (const line of extra) detail(line);
  detail('');
  detail('If this refusal is understood and deliberate, set the override:');
  detail(`  ${OVERRIDE}=1 npm run deploy`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// THREE WAYS TO SEE NOTHING, AND THEY ARE NOT THE SAME EVENT
// ---------------------------------------------------------------------------
// This gate refuses on all of them. It must still SAY WHICH ONE it hit.
//
//   1. a well-formed empty result — the query was valid, the API answered it,
//      and there genuinely is no run. The commit is unpushed, or too new.
//   2. a malformed request — we asked a question the API cannot answer, and it
//      answered the question we actually asked. Nothing is wrong with the world.
//   3. a transport or API failure — we could not ask at all.
//
// **Collapsing these lets a typo impersonate a fact.** On 2026-09-09, while
// reconstructing state after a crash, this endpoint was queried by hand with an
// ABBREVIATED sha (`a57735d`). `head_sha` matches only the full 40 characters,
// so it returned `total_count: 0` — a well-formed answer to a malformed
// question. Read as case 1 that is "no CI run exists", the most serious thing
// this gate reports. Run #22 existed and was green throughout.
//
// Nobody was harmed — the operator noticed and re-queried. But an absence you
// manufactured yourself is the exact evidence someone cites to argue this gate
// is too brittle and should fail open, at which point the same typo publishes
// an unverified build and reports success. So:
//
//   - the REQUEST is validated before it is sent (case 2 cannot reach case 1);
//   - the RESPONSE is validated before it is read (a body of an unexpected
//     shape is not an empty list — `?? []` used to make it one);
//   - a real empty result SAYS it is real, so the next person debugs their
//     query only when the query is what is broken.
//
// See CLAUDE.md, "guards fail by the direction of the action and the recourse
// of the refused" — this gate fails CLOSED because its operator is at a
// terminal, is told why, and holds GB_ALLOW_RED_CI.

/** A full commit sha, which is the only thing `head_sha` will match. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Enough keys to recognise what came back, never the whole object. */
const summariseKeys = (obj) => {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '(none)';
  const shown = keys.slice(0, 8).join(', ');
  return keys.length > 8 ? `${shown}, … (${keys.length} in all)` : shown;
};

// Reading HEAD and the remote can fail too — outside a work tree, or with a
// broken remote. That is a failure to LOOK like any other, and it must refuse
// **legibly**: an unhandled throw here exits non-zero, so the deploy is stopped
// correctly, but it stops with a stack trace instead of a reason. A refusal the
// operator cannot read is a refusal they cannot act on, and acting on it is the
// whole basis for this gate being allowed to fail closed.
let sha;
let short;
let repo;
try {
  sha = git('rev-parse', 'HEAD');
  short = sha.slice(0, 7);
  repo = slug();
} catch (err) {
  refuse('could not read the local repository to work out what to check.', [
    String(err?.message ?? err).split('\n')[0],
    'This is a defect in the environment, not a verdict about CI.',
  ]);
}

// --- case 2, caught before it can masquerade as case 1 ---------------------
// `git rev-parse HEAD` returns 40 characters, so this cannot fire today. It is
// here for the edit that shortens it, which is precisely what happened by hand.
if (!FULL_SHA.test(sha)) {
  refuse('the CI query would be malformed, so its answer cannot be trusted.', [
    `head_sha must be a full 40-character sha; got ${sha.length}: ${sha}`,
    'The API matches head_sha only in full. An abbreviated sha returns',
    'total_count: 0 — a well-formed answer to a malformed question, which is',
    'indistinguishable from "this commit has no run" unless it is caught here.',
    'This is a defect in the gate, not a verdict about CI.',
  ]);
}

if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  refuse('the repository slug is malformed, so the CI query cannot be trusted.', [
    `derived ${repo} from the origin remote`,
    'This is a defect in the gate, not a verdict about CI.',
  ]);
}

/**
 * Is this commit on the remote at all? Distinguishes "never pushed" from
 * "pushed, run not created yet" — different actions for the operator.
 *
 * Reported as a HINT, never as a verdict: remote-tracking refs are only as
 * fresh as the last fetch, so this can say "not found" about a commit that is
 * on the remote. It narrows the search; it does not decide anything.
 */
const onRemoteHint = () => {
  try {
    // stderr ignored on purpose: an unknown sha makes git print "no such
    // commit", and that line landing in the middle of a refusal reads like a
    // second fault. The hint is optional; its failure must be silent.
    const refs = execFileSync(
      'git',
      ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/remotes/'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return refs ? `local tracking refs place it on: ${refs.split('\n').join(', ')}` : null;
  } catch {
    return null; // old git, detached state, anything — the hint is optional
  }
};

let runs;
let totalCount;
try {
  const res = await fetch(`${API}/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`, {
    headers: { 'User-Agent': 'gradebridge-deploy-gate', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    refuse('the GitHub API refused the request — rate limit, or forbidden.', [
      `HTTP ${res.status} for ${repo}`,
      reset ? `the rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}` : '',
      'This is a failure to LOOK, not a finding about CI.',
      'Refusing rather than passing: a gate that cannot see must not open.',
    ].filter(Boolean));
  } else if (res.status === 404) {
    refuse(`the GitHub API has no such repository or endpoint: ${repo}.`, [
      'HTTP 404 — this is a malformed or misdirected query, not an absent run.',
      'Check the origin remote. This is a defect in the gate, not a verdict about CI.',
    ]);
  } else if (!res.ok) {
    refuse(`the GitHub API returned HTTP ${res.status} for ${repo}.`, [
      'This is a failure to LOOK, not a finding about CI.',
      'Refusing rather than passing: a gate that cannot see must not open.',
    ]);
  }

  // --- the response must be the shape we think it is ----------------------
  // This used to read `(await res.json()).workflow_runs ?? []`, which turned any
  // unexpected body — an error document, an HTML error page, a schema change —
  // into an empty array, and therefore into "no CI run exists". A body we cannot
  // read is case 3. It is not case 1.
  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    refuse('the GitHub API returned a body that is not JSON.', [
      String(err?.message ?? err),
      'This is a failure to READ the answer, not a finding about CI.',
    ]);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    refuse('the GitHub API returned JSON of an unexpected shape.', [
      `expected an object; got ${Array.isArray(payload) ? 'an array' : typeof payload}`,
      'This is a failure to READ the answer, not a finding about CI.',
    ]);
  }
  if (!Array.isArray(payload.workflow_runs)) {
    refuse('the CI response carried no workflow_runs array.', [
      // First few keys only: enough to recognise WHAT came back instead, without
      // burying the reason under an eighty-key dump of a repository object.
      `keys present: ${summariseKeys(payload)}`,
      payload.message ? `the API said: ${payload.message}` : '',
      'An unreadable answer is NOT an empty one. Refusing on that distinction:',
      'this is a failure to READ the answer, not a finding about CI.',
    ].filter(Boolean));
  }
  runs = payload.workflow_runs;
  totalCount = payload.total_count;
  // A page of 20 can legitimately under-report a larger total; the reverse
  // cannot happen, and a non-numeric total means we are not reading what we think.
  if (typeof totalCount !== 'number' || runs.length > totalCount) {
    refuse('the CI response is internally inconsistent.', [
      `total_count=${JSON.stringify(totalCount)} against ${runs.length} runs returned`,
      'This is a failure to READ the answer, not a finding about CI.',
    ]);
  }
} catch (err) {
  refuse('could not reach the GitHub API to check CI.', [
    String(err?.message ?? err),
    'This is a failure to LOOK, not a finding about CI.',
    'Refusing rather than passing: a gate that cannot see must not open.',
  ]);
}

// --- case 1: a real absence, and it says so --------------------------------
if (runs.length === 0) {
  const hint = onRemoteHint();
  refuse(`no CI run exists for ${short}.`, [
    `repository ${repo}`,
    `The query was well-formed and the API answered it: total_count=${totalCount}.`,
    'This is a REAL absence, not a failed lookup — do not go debugging the query.',
    hint ?? 'local tracking refs do not place this commit on any remote branch',
    hint
      ? 'Either the run has not been created yet, or the workflow did not trigger.'
      : 'It looks unpushed (tracking refs may be stale — fetch to be sure).',
    'Silence is not success — push, let the run finish, then deploy.',
  ]);
}

const unfinished = runs.filter((r) => r.status !== 'completed');
if (unfinished.length > 0) {
  refuse(`CI has not finished for ${short}.`, unfinished.flatMap(describe));
}

const bad = runs.filter((r) => r.conclusion !== 'success');
if (bad.length > 0) {
  refuse(`CI is not green for ${short}.`, bad.flatMap(describe));
}

say(`CI is green for ${short}`);
for (const r of runs) describe(r).forEach(detail);
