#!/usr/bin/env node
/**
 * Forgejo disaster-recovery mirror liveness detector.
 *
 * The Forgejo mirror at forgejo.hippocampus-monitor.ts.net is the owner-ruled
 * disaster-recovery copy of this repository. It has rotted silently three
 * different ways in a single night:
 *
 *   1. origin/main drifted 534 commits behind github/main because the
 *      post-merge "sync Forgejo main" step lapsed and nothing measured it.
 *   2. Branch sets diverged in BOTH directions - 24 branches the mirror had
 *      and GitHub did not, one branch GitHub had and the mirror did not - and
 *      it broke again six minutes after parity was restored, because GitHub's
 *      merge-time branch delete does not touch the mirror. Parity breaks per
 *      merge, not slowly.
 *   3. Every `runs-on: ubuntu-latest` job on the mirror began failing in ~2s
 *      on 2026-08-17 (the runner's container image vanished from the runner
 *      host) and nothing noticed for three weeks.
 *
 * All three share one property: the mirror is not on anybody's critical path,
 * so a broken mirror produces silence rather than a red check. This detector
 * converts that silence into a loud, specific failure.
 *
 * It deliberately runs OUTSIDE Forgejo (GitHub Actions), because a detector
 * hosted on the thing it watches cannot report that the thing is dead - it
 * would simply not run, which is the exact failure mode being guarded.
 *
 * Every alarm carries its own STATE and its own ACTION, because the fixes are
 * unrelated: an unreachable host is not a drifted main is not a stale
 * scheduler. Answering "something is wrong" would just move the diagnosis
 * cost to whoever is woken up.
 *
 * evaluateLiveness() is pure: it takes an already-collected snapshot and
 * returns verdicts. That separation is what lets the unit tests drive it with
 * fixtures and PROVE each state can fire (see forgejo-liveness.test.mjs).
 * A detector that has only ever been observed returning "ok" has not been
 * shown to be capable of returning anything else.
 */

import { readFileSync } from 'node:fs';

export const DEFAULT_FORGEJO_API =
  'https://forgejo.hippocampus-monitor.ts.net/api/v1';
export const DEFAULT_FORGEJO_OWNER = 'bahuleyan';
export const DEFAULT_FORGEJO_REPO = 'VH-Health-Platform';

/**
 * The Forgejo workflow that runs on a schedule. .forgejo/workflows/ci.yml
 * fires only on push/pull_request, so it cannot answer "is the mirror still
 * executing work on its own?" - full-stack-sweep.yml runs cron 30 1 * * 1-5
 * (Asia/Kolkata) and is the mirror's only scheduled workflow.
 */
export const SCHEDULED_WORKFLOW = 'full-stack-sweep.yml';

/**
 * The mirror's sweep runs Monday-Friday only, so the newest scheduled run can
 * legitimately be ~72h old when this fires on a Monday morning. 96h keeps a
 * full weekend of slack without letting a dead scheduler hide for a second
 * missed weekday.
 */
export const DEFAULT_MAX_RUN_AGE_HOURS = 96;

/**
 * Distinct alarm states. Each names a different fault with a different fix.
 * "MIRROR UNREACHABLE" and "STALE/UNKNOWN" exist as separate states on
 * purpose: a monitor that answers from cache during an outage, or that treats
 * "I could not tell" as "fine", is the mistake this file exists to prevent.
 */
export const STATE = {
  OK: 'OK',
  UNREACHABLE: 'MIRROR UNREACHABLE',
  STALE: 'STALE/UNKNOWN',
  DRIFT: 'DIVERGED / BEHIND',
  ONE_SIDED: 'ONE-SIDED BRANCHES',
  JOBS: 'SCHEDULED JOBS NOT COMPLETING',
  /**
   * A failure the owner has already seen, with a written reason and an expiry.
   * Reported distinctly and still listed, but does not hold the alarm red.
   * A hundred identical known reds is how a new alarm gets trained out of
   * existence before a different break arrives.
   */
  ACKNOWLEDGED: 'ACKNOWLEDGED',
};

const ACTION = {
  [STATE.UNREACHABLE]:
    'Check the Forgejo host and the tailnet. The failing step below says whether the ' +
    'GitHub runner failed to join the tailnet or the host itself did not answer.',
  [STATE.STALE]:
    'The detector could not obtain fresh, complete data. Do NOT read this as healthy. ' +
    'Confirm the mirror is answering and its scheduler is running before trusting any other verdict.',
  [STATE.DRIFT]:
    'Run the sync protocol: ancestry-check, then `git push origin github/main:main`.',
  [STATE.ONE_SIDED]:
    'Prune or push the named branches. GitHub merge-time branch deletes do not touch ' +
    'the mirror, so `git push origin --delete <branch>` is the usual missing half.',
  [STATE.JOBS]:
    'The mirror runner cannot start jobs. See infra/forgejo/ci-image/README.md - ' +
    'rebuild vhhealth/act-java17 on the runner host.',
};

const HOUR_MS = 60 * 60 * 1000;

function hoursBetween(laterMs, earlierMs) {
  return (laterMs - earlierMs) / HOUR_MS;
}

function check(id, title, state, detail) {
  return {
    id,
    title,
    state,
    ok: state === STATE.OK,
    detail,
    action: state === STATE.OK ? '' : (ACTION[state] ?? ''),
  };
}

/**
 * Derive the monitored job population from the mirror's scheduled workflow.
 *
 * PREDICATE: every entry of `matrix.stage` on the job whose `runs-on:` is
 * `ubuntu-latest` in .forgejo/workflows/full-stack-sweep.yml.
 *
 * Derived rather than hard-coded because the whole ubuntu-latest population is
 * what fails, and a hand-written list of two names would silently stop
 * covering a stage the moment someone adds one.
 */
export function deriveScheduledStages(workflowText) {
  const lines = workflowText.split(/\r?\n/);
  const runsOnUbuntu = lines.some((l) => /^\s*runs-on:\s*ubuntu-latest\s*$/.test(l));
  if (!runsOnUbuntu) {
    throw new Error(
      'full-stack-sweep.yml no longer has a `runs-on: ubuntu-latest` job; ' +
        'the monitored population must be re-derived.',
    );
  }
  const stages = [];
  let inStageList = false;
  let stageIndent = 0;
  for (const line of lines) {
    if (/^\s*stage:\s*$/.test(line)) {
      inStageList = true;
      stageIndent = line.length - line.trimStart().length;
      continue;
    }
    if (!inStageList) continue;
    const m = /^(\s*)-\s+(\S+)\s*$/.exec(line);
    if (m && m[1].length > stageIndent) {
      stages.push(m[2]);
      continue;
    }
    if (line.trim() !== '') inStageList = false;
  }
  if (stages.length === 0) {
    throw new Error(
      'Derived an EMPTY stage population from full-stack-sweep.yml. A verdict over an ' +
        'empty set reports success, so this is a hard failure rather than a pass.',
    );
  }
  return stages;
}

/**
 * Fold owner acknowledgements into a verdict set.
 *
 * An entry is `{state, match, reason, until}`. It applies to a check only when
 * ALL of these hold:
 *   - the check is failing,
 *   - its state equals `entry.state` EXACTLY,
 *   - its id contains `entry.match`,
 *   - `now` is strictly before `entry.until`.
 *
 * Anything else stays a hard failure. That is the whole safety property: an
 * acknowledgement is a narrow, dated, written-down waiver for one known
 * defect, not a mute button. Malformed entries throw rather than being
 * skipped, because an acknowledgement list that silently does nothing is
 * indistinguishable from one that silently suppresses everything.
 *
 * MIRROR UNREACHABLE can never be acknowledged: it is produced by a
 * short-circuit that returns before this function is reached, so "I could not
 * see the mirror" is never waivable.
 */
export function applyAcknowledgements(checks, acknowledgements = [], nowMs = Date.now()) {
  if (!Array.isArray(acknowledgements)) {
    throw new TypeError('acknowledgements must be an array');
  }
  const entries = acknowledgements.map((e, i) => {
    for (const field of ['state', 'match', 'reason', 'until']) {
      if (typeof e?.[field] !== 'string' || e[field].trim() === '') {
        throw new Error(
          `acknowledgement[${i}] is missing a non-empty "${field}". Every waiver needs a ` +
            'state, a match, a written reason and an expiry.',
        );
      }
    }
    const untilMs = new Date(e.until).getTime();
    if (!Number.isFinite(untilMs)) {
      throw new Error(`acknowledgement[${i}] has an unparseable "until": ${e.until}`);
    }
    if (e.state === STATE.UNREACHABLE) {
      throw new Error(
        `acknowledgement[${i}] tries to waive ${STATE.UNREACHABLE}, which is never waivable.`,
      );
    }
    return { ...e, untilMs };
  });

  return checks.map((c) => {
    if (c.ok) return c;
    const hit = entries.find(
      (e) => e.state === c.state && c.id.includes(e.match) && nowMs < e.untilMs,
    );
    if (!hit) return c;
    return {
      ...c,
      ok: true,
      acknowledged: true,
      suppressedState: c.state,
      state: STATE.ACKNOWLEDGED,
      detail: `${c.detail}
        ACKNOWLEDGED until ${hit.until}: ${hit.reason}`,
      action: `Known defect, waiver expires ${hit.until}. ${ACTION[c.state] ?? ''}`.trim(),
    };
  });
}

/**
 * Pure verdict function over an already-collected snapshot.
 */
export function evaluateLiveness({
  now,
  collection = { ok: true },
  githubMainSha,
  forgejoMainSha,
  compare = null,
  githubBranches = [],
  forgejoBranches = [],
  tasks = [],
  monitoredStages = [],
  maxRunAgeHours = DEFAULT_MAX_RUN_AGE_HOURS,
  scheduledWorkflow = SCHEDULED_WORKFLOW,
  acknowledgements = [],
} = {}) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`evaluateLiveness: unusable "now" value: ${String(now)}`);
  }

  // ---- Gate 0: could we see anything at all? ----------------------------
  // Short-circuits on purpose. An unreachable mirror must never be rendered
  // as a parity diff: for ~90 seconds tonight two reviewers read an empty
  // probe result as "the mirror has lost every branch".
  if (collection && collection.ok === false) {
    return {
      ok: false,
      checks: [
        check(
          'mirror-reachable',
          'Forgejo mirror answered',
          STATE.UNREACHABLE,
          `failing step: ${collection.failedStep ?? 'unknown'}; ` +
            `${collection.url ? `url=${collection.url}; ` : ''}` +
            `error=${collection.message ?? 'unknown'}; at ${new Date(nowMs).toISOString()}`,
        ),
      ],
    };
  }

  // SANITY ASSERTION: a real parity break never removes `main`. If a ref
  // listing is empty or is missing main, the probe failed - it is not an
  // empty set.
  for (const [side, names] of [
    ['GitHub', githubBranches],
    ['Forgejo', forgejoBranches],
  ]) {
    if (!Array.isArray(names) || names.length === 0 || !names.includes('main')) {
      return {
        ok: false,
        checks: [
          check(
            'mirror-reachable',
            'Branch listings are trustworthy',
            STATE.UNREACHABLE,
            `The ${side} branch listing came back with ${Array.isArray(names) ? names.length : 0} ` +
              'refs and no `main`. A real parity break never removes main, so this is a failed ' +
              'probe, not an empty set. Refusing to report a branch diff from it.',
          ),
        ],
      };
    }
  }

  const checks = [];

  // ---- Check 1: fast-forward drift on main must be zero ------------------
  if (!githubMainSha || !forgejoMainSha) {
    checks.push(
      check(
        'mirror-drift',
        'Forgejo main matches GitHub main',
        STATE.STALE,
        'Could not read one of the two main SHAs ' +
          `(github=${githubMainSha || '<unreadable>'}, forgejo=${forgejoMainSha || '<unreadable>'}).`,
      ),
    );
  } else if (githubMainSha === forgejoMainSha) {
    checks.push(
      check('mirror-drift', 'Forgejo main matches GitHub main', STATE.OK, `both at ${githubMainSha}`),
    );
  } else {
    let shape = 'relationship unknown (compare unavailable)';
    if (compare && typeof compare === 'object') {
      shape =
        `github/main is "${compare.status ?? 'unknown'}" relative to origin/main ` +
        `(ahead_by=${compare.ahead_by ?? '?'}, behind_by=${compare.behind_by ?? '?'})`;
    }
    checks.push(
      check(
        'mirror-drift',
        'Forgejo main matches GitHub main',
        STATE.DRIFT,
        `github/main=${githubMainSha} origin/main=${forgejoMainSha}; ${shape}`,
      ),
    );
  }

  // ---- Check 2: branch sets equal in BOTH directions ---------------------
  const gh = new Set(githubBranches);
  const fj = new Set(forgejoBranches);
  const githubOnly = [...gh].filter((b) => !fj.has(b)).sort();
  const forgejoOnly = [...fj].filter((b) => !gh.has(b)).sort();
  if (githubOnly.length === 0 && forgejoOnly.length === 0) {
    checks.push(
      check(
        'branch-parity',
        'Branch sets match in both directions',
        STATE.OK,
        `${gh.size} branches on each side, zero one-sided`,
      ),
    );
  } else {
    const parts = [];
    for (const b of githubOnly) parts.push(`github-only: ${b}`);
    for (const b of forgejoOnly) parts.push(`forgejo-only: ${b}`);
    checks.push(
      check(
        'branch-parity',
        'Branch sets match in both directions',
        STATE.ONE_SIDED,
        `${parts.length} one-sided branch(es) (GitHub ${gh.size} / Forgejo ${fj.size}) -\n        ` +
          parts.join('\n        '),
      ),
    );
  }

  // ---- Check 3: every monitored scheduled stage still completes ----------
  if (!Array.isArray(monitoredStages) || monitoredStages.length === 0) {
    checks.push(
      check(
        'scheduled-runs',
        'Monitored scheduled stages',
        STATE.STALE,
        'The monitored stage population is EMPTY, so the per-stage checks below would ' +
          'pass vacuously. Refusing to report success over an empty set.',
      ),
    );
  }
  for (const stage of monitoredStages) {
    const id = `scheduled-run:${stage}`;
    const title = `Forgejo scheduled "${stage}" run completed`;
    const candidates = tasks.filter(
      (t) =>
        t && t.workflow_id === scheduledWorkflow && t.event === 'schedule' && t.name === stage,
    );
    if (candidates.length === 0) {
      checks.push(
        check(
          id,
          title,
          STATE.STALE,
          `No scheduled "${stage}" task found for ${scheduledWorkflow} in the sampled history. ` +
            'Either the schedule stopped firing or the stage was renamed.',
        ),
      );
      continue;
    }
    const newest = candidates.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
    const stamp = newest.updated_at || newest.created_at || newest.run_started_at;
    const ageH = hoursBetween(nowMs, new Date(stamp).getTime());
    const url = newest.url ? ` ${newest.url}` : '';

    if (!Number.isFinite(ageH)) {
      checks.push(
        check(id, title, STATE.STALE, `task ${newest.id} has an unreadable timestamp (${String(stamp)}).${url}`),
      );
    } else if (ageH > maxRunAgeHours) {
      checks.push(
        check(
          id,
          title,
          STATE.STALE,
          `newest scheduled task ${newest.id} is ${ageH.toFixed(1)}h old, budget ${maxRunAgeHours}h - ` +
            `the schedule has stopped firing (last status "${newest.status}").${url}`,
        ),
      );
    } else if (newest.status !== 'success') {
      checks.push(
        check(id, title, STATE.JOBS, `task ${newest.id} finished "${newest.status}" ${ageH.toFixed(1)}h ago.${url}`),
      );
    } else {
      checks.push(check(id, title, STATE.OK, `task ${newest.id} succeeded ${ageH.toFixed(1)}h ago${url}`));
    }
  }

  const finalChecks = applyAcknowledgements(checks, acknowledgements, nowMs);
  return { ok: finalChecks.every((c) => c.ok), checks: finalChecks };
}

export function renderReport(result) {
  const lines = [];
  const seenActions = new Set();
  for (const c of result.checks) {
    lines.push(`${c.ok ? 'PASS' : 'FAIL'}  [${c.state}] ${c.title}`);
    lines.push(`        ${c.detail}`);
  }
  lines.push('');
  const ackd = result.checks.filter((c) => c.acknowledged);
  if (result.ok) {
    lines.push(
      ackd.length === 0
        ? 'Forgejo mirror liveness: OK'
        : `Forgejo mirror liveness: OK with ${ackd.length} ACKNOWLEDGED defect(s) - not healthy, waived`,
    );
    // One line per distinct waived fault, not one per check: six identical
    // lines is the noise this state exists to remove.
    const seen = new Set();
    for (const c of ackd) {
      if (seen.has(c.suppressedState)) continue;
      seen.add(c.suppressedState);
      const n = ackd.filter((x) => x.suppressedState === c.suppressedState).length;
      lines.push(`  ${c.suppressedState} (${n} check(s)) -> ${c.action}`);
    }
  } else {
    lines.push('Forgejo mirror liveness: FAILING');
    for (const c of result.checks) {
      if (c.ok || seenActions.has(c.state)) continue;
      seenActions.add(c.state);
      lines.push(`  ${c.state} -> ${c.action}`);
    }
  }
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Collection (network) - kept out of evaluateLiveness so the tests stay pure.
// --------------------------------------------------------------------------

async function getJson(url, headers = {}, timeoutMs = 30000) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function listAllBranches(baseUrl, headers, pageParam, timeoutMs) {
  const names = [];
  for (let page = 1; page <= 10; page += 1) {
    const rows = await getJson(`${baseUrl}${pageParam}&page=${page}`, headers, timeoutMs);
    if (!Array.isArray(rows) || rows.length === 0) break;
    names.push(...rows.map((b) => b.name));
    if (rows.length < 50) break;
  }
  return names;
}

export async function collectSnapshot(env = process.env, readWorkflow = null) {
  const now = new Date().toISOString();
  const forgejoApi = (env.FORGEJO_API || DEFAULT_FORGEJO_API).replace(/\/+$/, '');
  const owner = env.FORGEJO_OWNER || DEFAULT_FORGEJO_OWNER;
  const repo = env.FORGEJO_REPO || DEFAULT_FORGEJO_REPO;
  const ghRepo = env.GITHUB_REPOSITORY || 'Bahuleyandr/VH-Health-Platform';
  const ghApi = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const timeoutMs = Number(env.FORGEJO_TIMEOUT_MS || 30000);

  const ghHeaders = env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
  // The Forgejo repo is public; a token is optional and only used if provided.
  const fjHeaders = env.FORGEJO_TOKEN ? { authorization: `token ${env.FORGEJO_TOKEN}` } : {};

  const fjRepo = `${forgejoApi}/repos/${owner}/${repo}`;
  let step = 'github-api';
  let url = `${ghApi}/repos/${ghRepo}/branches`;
  try {
    const githubBranches = await listAllBranches(
      `${ghApi}/repos/${ghRepo}/branches?per_page=100`, ghHeaders, '', timeoutMs,
    );
    const githubMainSha = (
      await getJson(`${ghApi}/repos/${ghRepo}/branches/main`, ghHeaders, timeoutMs)
    )?.commit?.sha;

    step = 'forgejo-api';
    url = `${fjRepo}/branches/main`;
    const forgejoMainSha = (await getJson(url, fjHeaders, timeoutMs))?.commit?.id;

    url = `${fjRepo}/branches?limit=50`;
    const forgejoBranches = await listAllBranches(url, fjHeaders, '', timeoutMs);

    step = 'github-compare';
    let compare = null;
    if (githubMainSha && forgejoMainSha && githubMainSha !== forgejoMainSha) {
      try {
        compare = await getJson(
          `${ghApi}/repos/${ghRepo}/compare/${forgejoMainSha}...${githubMainSha}`,
          ghHeaders,
          timeoutMs,
        );
      } catch {
        // A mirror SHA GitHub has never seen (diverged history) 404s here.
        // Drift is already established; the shape is a nicety, not the verdict.
        compare = null;
      }
    }

    step = 'forgejo-api';
    const monitoredStages = readWorkflow ? deriveScheduledStages(readWorkflow()) : [];
    const tasks = [];
    for (let page = 1; page <= Number(env.FORGEJO_TASK_PAGES || 6); page += 1) {
      url = `${fjRepo}/actions/tasks?limit=50&page=${page}`;
      const batch = await getJson(url, fjHeaders, timeoutMs);
      const rows = batch?.workflow_runs ?? [];
      tasks.push(...rows);
      if (rows.length === 0) break;
      const found = monitoredStages.every((s) =>
        tasks.some(
          (t) => t.workflow_id === SCHEDULED_WORKFLOW && t.event === 'schedule' && t.name === s,
        ),
      );
      if (found) break;
    }

    return {
      now,
      collection: { ok: true },
      githubMainSha,
      forgejoMainSha,
      compare,
      githubBranches,
      forgejoBranches,
      tasks,
      monitoredStages,
    };
  } catch (err) {
    return {
      now,
      collection: {
        ok: false,
        failedStep:
          step === 'forgejo-api'
            ? 'forgejo API over the tailnet (host down, or the runner never joined the tailnet)'
            : step,
        url,
        message: err?.message ?? String(err),
      },
    };
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalised = entry.replace(/\\/g, '/');
  return import.meta.url.endsWith(normalised.split('/').slice(-2).join('/'));
}

if (invokedDirectly()) {
  const fixturePath = process.env.LIVENESS_FIXTURE;
  const load = fixturePath
    ? import('node:fs/promises').then(async ({ readFile }) =>
        JSON.parse(await readFile(fixturePath, 'utf8')),
      )
    : collectSnapshot(process.env, () =>
        readFileSync(
          process.env.SCHEDULED_WORKFLOW_PATH ?? '.forgejo/workflows/full-stack-sweep.yml',
          'utf8',
        ),
      );

  load
    .then(async (snapshot) => {
      // A FIXTURE IS A COMPLETE SNAPSHOT. When one is supplied, its own
      // `acknowledgements` (default: none) are the only waivers applied - the
      // committed production list is never read. Without this the test suite
      // would silently be exercising production config: `runs-failing`
      // initially came back green because the live waiver matched it.
      let acknowledgements = snapshot.acknowledgements ?? [];
      if (!fixturePath) {
        const ackPath =
          process.env.LIVENESS_ACK_PATH ?? 'scripts/ci/forgejo-liveness-acknowledged.json';
        try {
          acknowledgements = JSON.parse(readFileSync(ackPath, 'utf8')).entries ?? [];
        } catch (e) {
          if (e.code !== 'ENOENT') throw e; // a malformed list must fail closed
        }
      }
      const result = evaluateLiveness({
        ...snapshot,
        acknowledgements,
        maxRunAgeHours: process.env.MAX_RUN_AGE_HOURS
          ? Number(process.env.MAX_RUN_AGE_HOURS)
          : (snapshot.maxRunAgeHours ?? DEFAULT_MAX_RUN_AGE_HOURS),
      });
      const report = renderReport(result);
      process.stdout.write(`${report}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `## Forgejo mirror liveness\n\n\`\`\`\n${report}\n\`\`\`\n`,
        );
      }
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch((err) => {
      process.stderr.write(`Forgejo mirror liveness: [${STATE.UNREACHABLE}] ${err.message}\n`);
      process.exitCode = 1;
    });
}
