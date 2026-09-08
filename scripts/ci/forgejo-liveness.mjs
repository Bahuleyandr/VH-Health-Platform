#!/usr/bin/env node
/**
 * Forgejo disaster-recovery mirror liveness detector.
 *
 * The Forgejo mirror at forgejo.hippocampus-monitor.ts.net is the owner-ruled
 * disaster-recovery copy of this repository. Twice now it has rotted silently:
 *
 *   1. origin/main drifted 534 commits behind github/main because the
 *      post-merge "sync Forgejo main" step lapsed and nothing measured it.
 *   2. Every `runs-on: ubuntu-latest` job on the mirror began failing in ~2s
 *      on 2026-08-17 (the runner's container image vanished from the runner
 *      host) and nothing noticed for three weeks.
 *
 * Both failures share one property: the mirror is not on anybody's critical
 * path, so a broken mirror produces silence rather than a red check. This
 * detector converts that silence into a loud failure.
 *
 * It deliberately runs OUTSIDE Forgejo (GitHub Actions), because a detector
 * hosted on the thing it watches cannot report that the thing is dead - it
 * would simply not run, which is the exact failure mode being guarded.
 *
 * evaluateLiveness() is pure: it takes an already-collected snapshot and
 * returns verdicts. That separation is what lets the unit tests drive it with
 * fixtures and PROVE each assertion can fail (see forgejo-liveness.test.mjs).
 * A detector that has only ever been observed returning "ok" has not been
 * shown to be capable of returning anything else.
 */

export const DEFAULT_FORGEJO_API =
  'https://forgejo.hippocampus-monitor.ts.net/api/v1';
export const DEFAULT_FORGEJO_OWNER = 'bahuleyan';
export const DEFAULT_FORGEJO_REPO = 'VH-Health-Platform';

/**
 * The Forgejo workflow that runs on a schedule. .forgejo/workflows/ci.yml
 * only fires on push/pull_request, so it cannot answer "is the mirror still
 * executing work on its own?" - full-stack-sweep.yml runs cron 30 1 * * 1-5
 * (Asia/Kolkata) and is the mirror's own heartbeat.
 */
export const SCHEDULED_WORKFLOW = 'full-stack-sweep.yml';

/** Matrix stages required to have completed successfully on that schedule. */
export const REQUIRED_SCHEDULED_JOBS = ['backend', 'admin'];

/**
 * full-stack-sweep runs Monday-Friday only, so the newest scheduled run can
 * legitimately be ~72h old when this detector fires on a Monday morning.
 * 96h keeps a full weekend of slack without letting a genuinely dead mirror
 * hide for a second missed weekday.
 */
export const DEFAULT_MAX_RUN_AGE_HOURS = 96;

const HOUR_MS = 60 * 60 * 1000;

function hoursBetween(laterMs, earlierMs) {
  return (laterMs - earlierMs) / HOUR_MS;
}

/**
 * Pure verdict function.
 *
 * @param {object} snapshot
 * @param {string} snapshot.githubMainSha    tip of main on GitHub
 * @param {string} snapshot.forgejoMainSha   tip of main on the Forgejo mirror
 * @param {object|null} [snapshot.compare]   GitHub compare API result, or null
 * @param {Array} snapshot.tasks             Forgejo Actions tasks
 * @param {string|number|Date} snapshot.now  evaluation instant
 * @param {number} [snapshot.maxRunAgeHours]
 * @param {string[]} [snapshot.requiredJobs]
 * @param {string} [snapshot.scheduledWorkflow]
 * @returns {{ok: boolean, checks: Array<{id: string, ok: boolean, title: string, detail: string}>}}
 */
export function evaluateLiveness({
  githubMainSha,
  forgejoMainSha,
  compare = null,
  tasks = [],
  now,
  maxRunAgeHours = DEFAULT_MAX_RUN_AGE_HOURS,
  requiredJobs = REQUIRED_SCHEDULED_JOBS,
  scheduledWorkflow = SCHEDULED_WORKFLOW,
} = {}) {
  const checks = [];
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`evaluateLiveness: unusable "now" value: ${String(now)}`);
  }

  // ---- Check 1: mirror fast-forward drift must be zero -------------------
  if (!githubMainSha || !forgejoMainSha) {
    checks.push({
      id: 'mirror-drift',
      ok: false,
      title: 'Forgejo main matches GitHub main',
      detail:
        'Could not read one of the two main SHAs ' +
        `(github=${githubMainSha || '<unreadable>'}, forgejo=${forgejoMainSha || '<unreadable>'}). ` +
        'An unreadable mirror is treated as a failing mirror.',
    });
  } else if (githubMainSha === forgejoMainSha) {
    checks.push({
      id: 'mirror-drift',
      ok: true,
      title: 'Forgejo main matches GitHub main',
      detail: `both at ${githubMainSha}`,
    });
  } else {
    // compare distinguishes "behind by N" (the sync step lapsed) from
    // "diverged" (someone pushed to the mirror directly) - different fixes.
    let shape = 'relationship unknown (compare unavailable)';
    if (compare && typeof compare === 'object') {
      const status = compare.status ?? 'unknown';
      const behind = compare.behind_by ?? '?';
      const ahead = compare.ahead_by ?? '?';
      shape = `github/main is "${status}" relative to origin/main (ahead_by=${ahead}, behind_by=${behind})`;
    }
    checks.push({
      id: 'mirror-drift',
      ok: false,
      title: 'Forgejo main matches GitHub main',
      detail:
        `DRIFT: github/main=${githubMainSha} origin/main=${forgejoMainSha}; ${shape}. ` +
        'Fast-forward the mirror: git push origin github/main:main',
    });
  }

  // ---- Check 2: the mirror's own scheduled runs still complete ----------
  for (const jobName of requiredJobs) {
    const id = `scheduled-run:${jobName}`;
    const title = `Forgejo scheduled "${jobName}" run completed`;
    const candidates = tasks.filter(
      (t) =>
        t &&
        t.workflow_id === scheduledWorkflow &&
        t.event === 'schedule' &&
        t.name === jobName,
    );
    if (candidates.length === 0) {
      checks.push({
        id,
        ok: false,
        title,
        detail:
          `No scheduled "${jobName}" task found for ${scheduledWorkflow} in the sampled task history. ` +
          'Either the schedule stopped firing or the workflow was renamed.',
      });
      continue;
    }
    const newest = candidates.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
    const stamp = newest.updated_at || newest.created_at || newest.run_started_at;
    const ageH = hoursBetween(nowMs, new Date(stamp).getTime());
    const url = newest.url ? ` ${newest.url}` : '';

    if (!Number.isFinite(ageH)) {
      checks.push({
        id,
        ok: false,
        title,
        detail: `Newest scheduled "${jobName}" task ${newest.id} has an unreadable timestamp (${String(stamp)}).${url}`,
      });
    } else if (newest.status !== 'success') {
      checks.push({
        id,
        ok: false,
        title,
        detail:
          `Newest scheduled "${jobName}" task ${newest.id} finished "${newest.status}" ` +
          `(${ageH.toFixed(1)}h ago).${url}`,
      });
    } else if (ageH > maxRunAgeHours) {
      checks.push({
        id,
        ok: false,
        title,
        detail:
          `Newest scheduled "${jobName}" task ${newest.id} succeeded but is STALE: ` +
          `${ageH.toFixed(1)}h old, budget ${maxRunAgeHours}h. The schedule has stopped firing.${url}`,
      });
    } else {
      checks.push({
        id,
        ok: true,
        title,
        detail: `task ${newest.id} succeeded ${ageH.toFixed(1)}h ago${url}`,
      });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function renderReport(result) {
  const lines = [];
  for (const c of result.checks) {
    lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.title}\n        ${c.detail}`);
  }
  lines.push('');
  lines.push(
    result.ok
      ? 'Forgejo mirror liveness: OK'
      : 'Forgejo mirror liveness: FAILING - see the failed checks above.',
  );
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Collection (network) - kept out of evaluateLiveness so the tests stay pure.
// --------------------------------------------------------------------------

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function collectSnapshot(env = process.env) {
  const forgejoApi = (env.FORGEJO_API || DEFAULT_FORGEJO_API).replace(/\/+$/, '');
  const owner = env.FORGEJO_OWNER || DEFAULT_FORGEJO_OWNER;
  const repo = env.FORGEJO_REPO || DEFAULT_FORGEJO_REPO;
  const ghRepo = env.GITHUB_REPOSITORY || 'Bahuleyandr/VH-Health-Platform';
  const ghApi = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

  const ghHeaders = env.GITHUB_TOKEN
    ? { authorization: `Bearer ${env.GITHUB_TOKEN}` }
    : {};
  // The Forgejo repo is public; a token is optional and only used if provided.
  const fjHeaders = env.FORGEJO_TOKEN
    ? { authorization: `token ${env.FORGEJO_TOKEN}` }
    : {};

  const githubBranch = await getJson(`${ghApi}/repos/${ghRepo}/branches/main`, ghHeaders);
  const githubMainSha = githubBranch?.commit?.sha;

  const forgejoBranch = await getJson(
    `${forgejoApi}/repos/${owner}/${repo}/branches/main`,
    fjHeaders,
  );
  const forgejoMainSha = forgejoBranch?.commit?.id;

  let compare = null;
  if (githubMainSha && forgejoMainSha && githubMainSha !== forgejoMainSha) {
    try {
      compare = await getJson(
        `${ghApi}/repos/${ghRepo}/compare/${forgejoMainSha}...${githubMainSha}`,
        ghHeaders,
      );
    } catch {
      // A mirror SHA GitHub has never seen (diverged history) 404s here.
      // Drift is already established; the shape is a nicety, not the verdict.
      compare = null;
    }
  }

  const requiredJobs = env.REQUIRED_JOBS
    ? env.REQUIRED_JOBS.split(',').map((s) => s.trim()).filter(Boolean)
    : REQUIRED_SCHEDULED_JOBS;
  const pages = Number(env.FORGEJO_TASK_PAGES || 6);
  const tasks = [];
  for (let page = 1; page <= pages; page += 1) {
    const batch = await getJson(
      `${forgejoApi}/repos/${owner}/${repo}/actions/tasks?limit=50&page=${page}`,
      fjHeaders,
    );
    const rows = batch?.workflow_runs ?? [];
    tasks.push(...rows);
    if (rows.length === 0) break;
    const found = requiredJobs.every((j) =>
      tasks.some(
        (t) => t.workflow_id === SCHEDULED_WORKFLOW && t.event === 'schedule' && t.name === j,
      ),
    );
    if (found) break;
  }

  return {
    githubMainSha,
    forgejoMainSha,
    compare,
    tasks,
    requiredJobs,
    now: new Date().toISOString(),
  };
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
    : collectSnapshot();

  load
    .then(async (snapshot) => {
      const result = evaluateLiveness({
        ...snapshot,
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
      // An unreachable mirror is a FAILURE, never a skip: "cannot tell" is the
      // silence this detector exists to eliminate.
      process.stderr.write(`Forgejo mirror liveness: collection failed - ${err.message}\n`);
      process.exitCode = 1;
    });
}
