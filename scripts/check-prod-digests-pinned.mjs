#!/usr/bin/env node
// scripts/check-prod-digests-pinned.mjs
//
// CI guard (audit finding H11 / B0.6): FAILS if any prod image digest in
// infra/kubernetes/apps/kustomization.yaml is still the all-zeros fail-closed
// placeholder (sha256:0000...0000) when running on `main`.
//
// Why fail-closed-but-only-on-main: an all-zeros digest is an INTENTIONAL
// placeholder — pods cannot pull it, so an unpinned tree can never silently
// deploy a mutable tag. It is the expected state on feature branches and PRs
// (the digests are written later by the release pipeline). It must NEVER be the
// state of `main`, because ArgoCD's `apps` Application syncs main and would
// leave the cluster unable to roll pods. Real digests are written by
// scripts/update-prod-digests.mjs from .forgejo/workflows/release-images.yml
// (and release-pin-digests.yml as the manual repair path) — this guard only
// asserts that main is in a pinned state, it does not resolve digests.
//
// Exit codes:
//   0  all digests pinned, OR placeholders found but not on main (informational)
//   1  on main with one or more placeholder/missing digests (CI failure)
//   2  could not parse the kustomization (treated as a hard failure)
//
// Usage:
//   node scripts/check-prod-digests-pinned.mjs            # auto-detect main via CI env
//   node scripts/check-prod-digests-pinned.mjs --require-pinned   # force strict
//   node scripts/check-prod-digests-pinned.mjs --warn-only        # never fail

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KUSTOMIZATION = path.resolve(
  __dirname,
  '../infra/kubernetes/apps/kustomization.yaml',
);

const PLACEHOLDER_DIGEST = `sha256:${'0'.repeat(64)}`;

function parseArgs(argv) {
  return {
    requirePinned: argv.includes('--require-pinned'),
    warnOnly: argv.includes('--warn-only'),
  };
}

// True when this CI run targets the protected `main` branch. Covers Forgejo and
// GitHub Actions env shapes: a push to main, or a pull_request whose BASE is
// main (merging a placeholder tree into main must be blocked at PR time too).
function isMainContext() {
  const ref = process.env.GITHUB_REF || '';
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const baseRef = process.env.GITHUB_BASE_REF || '';
  if (eventName === 'push' && ref === 'refs/heads/main') return true;
  if (eventName === 'pull_request' && baseRef === 'main') return true;
  // Fallback for `workflow_dispatch` / local runs invoked directly on main.
  if (!eventName && ref === 'refs/heads/main') return true;
  return false;
}

// Parse the `images:` block. Each entry is `- name: <image>` followed (within a
// couple of lines) by `digest: <value>`. Mirrors the line-oriented parsing in
// scripts/update-prod-digests.mjs so the two stay consistent.
function parseImageDigests(yamlText) {
  const lines = yamlText.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = lines[i].match(/^\s*-\s*name:\s*(\S+)\s*$/);
    if (!nameMatch) continue;
    const image = nameMatch[1];
    let digest = null;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      // Stop if we hit the next list entry before finding a digest.
      if (/^\s*-\s*name:\s*/.test(lines[j])) break;
      const digestMatch = lines[j].match(/^\s*digest:\s*(\S+)\s*$/);
      if (digestMatch) {
        digest = digestMatch[1];
        break;
      }
    }
    entries.push({ image, digest });
  }
  return entries;
}

function main() {
  const { requirePinned, warnOnly } = parseArgs(process.argv.slice(2));

  let yamlText;
  try {
    yamlText = fs.readFileSync(KUSTOMIZATION, 'utf8');
  } catch (err) {
    console.error(`[check-prod-digests] cannot read ${KUSTOMIZATION}: ${err.message}`);
    process.exit(2);
  }

  const entries = parseImageDigests(yamlText);
  if (entries.length === 0) {
    console.error(
      `[check-prod-digests] no images: entries found in ${path.relative(process.cwd(), KUSTOMIZATION)} — ` +
        'expected at least the backend/admin/staff-web image pins.',
    );
    process.exit(2);
  }

  const unpinned = entries.filter(
    (e) => !e.digest || e.digest === PLACEHOLDER_DIGEST || !/^sha256:[0-9a-f]{64}$/.test(e.digest),
  );

  for (const e of entries) {
    const pinned = !unpinned.includes(e);
    console.log(`  ${pinned ? 'OK  ' : 'UNPINNED'} ${e.image} -> ${e.digest || '(missing)'}`);
  }

  if (unpinned.length === 0) {
    console.log(`[check-prod-digests] all ${entries.length} prod image(s) pinned to a real @sha256 digest.`);
    process.exit(0);
  }

  const strict = requirePinned || isMainContext();
  const summary =
    `${unpinned.length} of ${entries.length} prod image(s) are NOT pinned to a real digest ` +
    `(all-zeros placeholder or missing): ${unpinned.map((e) => e.image).join(', ')}`;

  if (warnOnly || !strict) {
    console.warn(
      `[check-prod-digests] ${summary}\n` +
        '  This is expected off-main (release pipeline writes digests later); not failing CI here.',
    );
    process.exit(0);
  }

  console.error(
    `[check-prod-digests] FAIL: ${summary}\n` +
      '  main must deploy immutable digests. Run the release pipeline (release-images.yml) or the\n' +
      '  manual repair path (requires cosign verification):\n' +
      '    COSIGN_PUBLIC_KEY=<public key> node scripts/update-prod-digests.mjs --tag backend-vX.Y.Z [--tag admin-vX.Y.Z] [--tag staff-web-vX.Y.Z]\n' +
      '  and commit the bump before merging to main.',
  );
  process.exit(1);
}

main();
