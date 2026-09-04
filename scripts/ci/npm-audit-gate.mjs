#!/usr/bin/env node
// Run an npm advisory check and tell the two failure modes apart.
//
// `npm audit` and `audit-ci` exit 1 both when they FIND something and when they
// cannot REACH https://registry.npmjs.org/-/npm/v1/security/advisories/bulk. The
// step that wraps them cannot tell those apart, so an upstream hiccup arrives as
// a red security check. That is wrong in both directions: it blocks every merge
// while the endpoint is unwell, and it teaches everyone to re-run a failing
// security gate without reading it. The next real advisory arrives looking
// exactly like the noise.
//
// 2026-09-04 is what that cost. The bulk advisory endpoint answered 503, then
// timed out, across at least two unrelated PRs over three and a half hours —
// including a one-line docs change. npm's own status page reported the audit
// service at 100% uptime throughout, so "wait for the incident to clear" was not
// a plan either.
//
// THIS DOES NOT WEAKEN THE GATE. Findings still fail, at exactly the same
// threshold, and an unreachable service is only ever forgiven when the
// dependency set is byte-identical to the base branch's — which is to say, when
// the very same lockfile already passed this gate to get onto the base in the
// first place. A PR that touches a manifest and cannot be audited still fails,
// because that is the case where the answer could genuinely have changed.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Markers that mean "the advisory service did not answer", not "your tree has a
// vulnerability". Deliberately narrow: anything unrecognised is treated as a
// real finding, so a new failure mode fails CLOSED rather than being waved
// through as infrastructure.
const SERVICE_FAILURE_PATTERNS = [
  /audit endpoint returned an error/i,
  /503 Service Unavailable/i,
  /5\d\d\s+(?:Service Unavailable|Internal Server Error|Bad Gateway|Gateway Time-?out)/i,
  /network timeout at:\s*https?:\/\/\S*registry\.npmjs\.org/i,
  /request to https?:\/\/\S*registry\.npmjs\.org\S* failed/i,
  /\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ERR_SOCKET_TIMEOUT)\b/,
  // audit-ci's shape when the registry hands it something it cannot parse: it
  // prints an empty error code and exits 1 without ever reporting an advisory.
  /^code undefined:\s*$/m,
];

// A clean audit prints its report and exits 0; these confirm the tool actually
// produced a verdict, so a service failure cannot be mistaken for a pass.
export function classifyAuditOutcome({ exitCode, output }) {
  const text = String(output ?? '');
  if (SERVICE_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
    // A service failure that ALSO reported findings is a findings failure: we
    // got a real answer, and the answer was bad news.
    if (exitCode !== 0 && /\bvulnerabilit(?:y|ies)\b/i.test(text)
        && !/0 vulnerabilities/i.test(text)) {
      return 'findings';
    }
    return 'service-unavailable';
  }
  return exitCode === 0 ? 'clean' : 'findings';
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Did THIS BRANCH touch the dependency set?
 *
 * Compares manifest blob ids at HEAD against the MERGE BASE, not against the
 * base branch's tip. The tip is the wrong referent: when someone else lands a
 * dependency bump on main, every open PR's manifests start differing from it
 * through no doing of their own, and the gate would report them all as
 * dependency changes. The merge base answers the question actually being asked
 * — "did this branch change the audited input since it diverged".
 *
 * Blob ids rather than a tree diff because it is the exact question ("is the
 * audited input identical?") and needs no rename or whitespace heuristics.
 * Returns null when the comparison cannot be made; the caller treats that as
 * "assume it changed".
 */
export function manifestsUnchanged({ repoRoot, baseRef, manifests }) {
  if (!baseRef) return null;
  const baseTip = git(['rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot);
  if (!baseTip) return null;
  const baseSha = git(['merge-base', 'HEAD', baseTip], repoRoot);
  if (!baseSha) return null;

  for (const manifest of manifests) {
    const head = git(['rev-parse', `HEAD:${manifest}`], repoRoot);
    const base = git(['rev-parse', `${baseSha}:${manifest}`], repoRoot);
    // A manifest that exists on one side only is a change by definition. A
    // manifest missing from BOTH is not this gate's business.
    if (head === null && base === null) continue;
    if (head !== base) return false;
  }
  return true;
}

export function resolveBaseRef(repoRoot) {
  // AUDIT_GATE_BASE_REF first, because this repo's canonical CI triggers on
  // PUSH to every non-main branch (ci.yml `on: push: branches: ['**','!main']`),
  // not on pull_request — so GITHUB_BASE_REF is empty here and a PR-only lookup
  // would never resolve a base at all. The workflows pass
  // `github.base_ref || github.event.repository.default_branch`, which covers
  // both trigger shapes.
  const base = process.env.AUDIT_GATE_BASE_REF || process.env.GITHUB_BASE_REF;
  if (!base) return null;
  // Remote-tracking refs ONLY. actions/checkout fetches the PR base as
  // origin/<base> with fetch-depth: 0, which both audit jobs use. A local
  // branch of the same name is deliberately NOT accepted as a fallback: on a
  // developer checkout it can be arbitrarily stale, and comparing against a
  // stale base is how "unchanged" starts meaning something else. No remote ref
  // means no comparison, which the caller turns into a failure.
  const candidate = `origin/${base}`;
  return git(['rev-parse', '--verify', `${candidate}^{commit}`], repoRoot) ? candidate : null;
}

function annotate(level, message) {
  // GitHub renders these in the job summary and against the step.
  console.log(`::${level}::${message}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  if (separator === -1 || separator === argv.length - 1) {
    console.error(
      'usage: npm-audit-gate.mjs [--label <name>] [--attempts <n>] -- <command> [args...]',
    );
    process.exit(2);
  }

  const flags = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  const label = flagValue(flags, '--label') ?? command.join(' ');
  const attempts = Number(flagValue(flags, '--attempts') ?? 3);

  const cwd = process.cwd();
  const repoRoot = git(['rev-parse', '--show-toplevel'], cwd) ?? cwd;
  const manifests = ['package.json', 'package-lock.json']
    .map((name) => resolve(cwd, name))
    .filter((path) => existsSync(path))
    .map((path) => relative(repoRoot, path).split('\\').join('/'));

  let outcome = 'service-unavailable';
  let lastOutput = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(command[0], command.slice(1), {
      cwd,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        // Bound each attempt. npm's default fetch timeout lets a single hung
        // request burn five minutes, which makes retrying pointless inside a
        // job timeout.
        npm_config_fetch_timeout: process.env.npm_config_fetch_timeout ?? '60000',
      },
    });
    lastOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');

    outcome = classifyAuditOutcome({ exitCode: result.status ?? 1, output: lastOutput });
    if (outcome !== 'service-unavailable') break;

    if (attempt < attempts) {
      const backoffSeconds = 10 * attempt;
      console.log(
        `\n[audit-gate] ${label}: advisory service did not answer `
        + `(attempt ${attempt}/${attempts}). Retrying in ${backoffSeconds}s.`,
      );
      await new Promise((done) => { setTimeout(done, backoffSeconds * 1000); });
    }
  }

  if (outcome === 'clean') {
    console.log(`\n[audit-gate] ${label}: no advisories at or above the threshold.`);
    process.exit(0);
  }

  if (outcome === 'findings') {
    annotate('error', `${label}: dependency advisories found at or above the configured threshold.`);
    process.exit(1);
  }

  // Service unavailable after every attempt. The gate's answer is a pure
  // function of the manifests, so if they are identical to the base the answer
  // is too — and the base only got there by passing this same gate.
  const baseRef = resolveBaseRef(repoRoot);
  // Say what was resolved. The first CI run of this gate failed on "base could
  // not be resolved" and the log could not say WHY — exactly the diagnosis-free
  // failure this whole change exists to stop shipping.
  console.log(
    `[audit-gate] ${label}: base ref = ${baseRef ?? 'UNRESOLVED'} `
    + `(AUDIT_GATE_BASE_REF=${process.env.AUDIT_GATE_BASE_REF ?? '<unset>'}, `
    + `GITHUB_BASE_REF=${process.env.GITHUB_BASE_REF ?? '<unset>'}); `
    + `manifests = ${manifests.join(', ') || '<none found>'}`,
  );
  const unchanged = manifestsUnchanged({ repoRoot, baseRef, manifests });

  if (unchanged === true) {
    annotate(
      'warning',
      `${label}: the npm advisory service was unreachable after ${attempts} attempts. `
      + `This build did NOT verify advisories. Allowed because ${manifests.join(' and ')} `
      + `are byte-identical to the base branch, so the dependency set was already `
      + `audited when it landed there. A manifest change would have failed here.`,
    );
    console.log(`\n[audit-gate] ${label}: SKIPPED — advisory service unreachable, dependencies unchanged.`);
    process.exit(0);
  }

  const reason = unchanged === false
    ? 'this change touches a dependency manifest'
    : 'the base branch could not be resolved, so a manifest change cannot be ruled out';
  annotate(
    'error',
    `${label}: the npm advisory service was unreachable after ${attempts} attempts, and `
    + `${reason}. Refusing to pass an unverified dependency set. This is an `
    + `INFRASTRUCTURE failure, not a vulnerability finding — re-run once the `
    + `registry is answering.`,
  );
  process.exit(1);
}

function flagValue(flags, name) {
  const index = flags.indexOf(name);
  return index === -1 ? null : flags[index + 1];
}

// Importable for the unit test without running the gate. pathToFileURL rather
// than string-building the URL: the two do not agree on Windows drive letters.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
