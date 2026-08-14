import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_KUSTOMIZATION,
  assertDigestSourcePolicy,
  decidePinnedDigest,
  isProdKustomization,
  parseArgs,
  parseExpectedDigestRef,
  updateDigests,
} from './update-prod-digests.mjs';

const placeholderDigest = `sha256:${'0'.repeat(64)}`;
const resolvedDigest = `sha256:${'a'.repeat(64)}`;
const foreignDigest = `sha256:${'b'.repeat(64)}`;
const backendImage = 'ghcr.io/bahuleyandr/vh-health-platform-backend';
const adminImage = 'ghcr.io/bahuleyandr/vh-health-platform-adminportal';

const keyVerification = {
  mode: 'key',
  cosignExe: 'cosign',
  key: 'env://COSIGN_PUBLIC_KEY',
};

function makeTempKustomization() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-update-digests-'));
  const kustomization = path.join(dir, 'kustomization.yaml');
  fs.writeFileSync(kustomization, [
    'images:',
    `  - name: ${backendImage}`,
    `    digest: ${placeholderDigest}`,
    '',
  ].join('\n'));
  return { dir, kustomization };
}

function fakeFetch(digest = resolvedDigest) {
  return async (url, options = {}) => {
    if (String(url).includes('/token?')) {
      return {
        ok: true,
        json: async () => ({ token: 'test-token' }),
      };
    }
    if (options.method === 'HEAD') {
      return {
        ok: true,
        headers: {
          get(name) {
            return name.toLowerCase() === 'docker-content-digest' ? digest : null;
          },
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function refusingFetch() {
  return async (url) => {
    throw new Error(`policy must reject before any registry call, got fetch: ${url}`);
  };
}

function refusingExecFile() {
  return () => {
    throw new Error('cosign must not run for a refused pin');
  };
}

// ── argument parsing ────────────────────────────────────────────────────────

test('requires a cosign policy before resolving image digests', () => {
  assert.throws(
    () => parseArgs(['--tag', 'backend-v1.2.3'], { env: {}, cwd: process.cwd() }),
    /Cosign verification is required/,
  );
});

test('binds --expected-digest to the preceding target', () => {
  const parsed = parseArgs(
    [
      '--tag', 'backend-v1.2.3',
      '--expected-digest', resolvedDigest,
      '--tag', 'admin-v1.2.3',
      '--expected-digest', foreignDigest,
      '--dry-run',
    ],
    { env: { COSIGN_PUBLIC_KEY: 'key' }, cwd: process.cwd() },
  );
  assert.equal(parsed.targets.length, 2);
  assert.equal(parsed.targets[0].expectedDigest, resolvedDigest);
  assert.equal(parsed.targets[1].expectedDigest, foreignDigest);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.allowTagResolution, false);
});

test('rejects --expected-digest with no preceding target, duplicates, and malformed digests', () => {
  const env = { COSIGN_PUBLIC_KEY: 'key' };
  assert.throws(
    () => parseArgs(['--expected-digest', resolvedDigest], { env }),
    /must follow the --tag\/--image target/,
  );
  assert.throws(
    () => parseArgs(
      ['--tag', 'backend-v1.2.3', '--expected-digest', resolvedDigest, '--expected-digest', resolvedDigest],
      { env },
    ),
    /already has an expected digest/,
  );
  assert.throws(
    () => parseArgs(['--tag', 'backend-v1.2.3', '--expected-digest', 'sha256:nothex'], { env }),
    /is not a sha256:<64 hex> digest/,
  );
});

test('reads --expected-digest-file image-ref content and records the image', () => {
  const parsed = parseArgs(
    ['--tag', 'backend-v1.2.3', '--expected-digest-file', 'image-ref.txt'],
    {
      env: { COSIGN_PUBLIC_KEY: 'key' },
      cwd: process.cwd(),
      readFile: () => `${backendImage}@${resolvedDigest}\n`,
    },
  );
  assert.equal(parsed.targets[0].expectedDigest, resolvedDigest);
  assert.equal(parsed.targets[0].expectedImage, backendImage);
});

test('parseExpectedDigestRef accepts bare digests and image@digest refs, rejects the rest', () => {
  assert.deepEqual(parseExpectedDigestRef(`${resolvedDigest}\n`), {
    image: null,
    digest: resolvedDigest,
  });
  assert.deepEqual(parseExpectedDigestRef(`${backendImage}@${resolvedDigest}`), {
    image: backendImage,
    digest: resolvedDigest,
  });
  assert.throws(() => parseExpectedDigestRef(''), /empty value/);
  assert.throws(
    () => parseExpectedDigestRef(`${resolvedDigest}\n${foreignDigest}`),
    /single sha256/,
  );
  assert.throws(() => parseExpectedDigestRef('backend-v1.2.3'), /is not a sha256/);
  assert.throws(
    () => parseExpectedDigestRef(`${backendImage}@sha256:short`),
    /is not a sha256/,
  );
});

// ── pure decision logic (audit finding #20 accept/reject matrix) ────────────

test('decidePinnedDigest accepts only the matching build-emitted digest', () => {
  assert.equal(
    decidePinnedDigest({
      image: backendImage,
      tag: 'backend-v1.2.3',
      expectedDigest: resolvedDigest,
      resolvedDigest,
    }),
    resolvedDigest,
  );
});

test('decidePinnedDigest refuses a foreign digest (tag rebind / rollback)', () => {
  assert.throws(
    () => decidePinnedDigest({
      image: backendImage,
      tag: 'backend-v1.2.3',
      expectedDigest: resolvedDigest,
      resolvedDigest: foreignDigest,
    }),
    /SECURITY: refusing to pin .*tag rebind \/ rollback/s,
  );
});

test('decidePinnedDigest refuses malformed expected or resolved digests', () => {
  assert.throws(
    () => decidePinnedDigest({
      image: backendImage,
      tag: 'backend-v1.2.3',
      expectedDigest: 'sha256:short',
      resolvedDigest,
    }),
    /expected digest .*is not a sha256/,
  );
  assert.throws(
    () => decidePinnedDigest({
      image: backendImage,
      tag: 'backend-v1.2.3',
      expectedDigest: resolvedDigest,
      resolvedDigest: 'not-a-digest',
    }),
    /malformed digest/,
  );
});

test('isProdKustomization matches only the ArgoCD prod tree', () => {
  assert.equal(isProdKustomization(DEFAULT_KUSTOMIZATION), true);
  assert.equal(
    isProdKustomization(path.join(os.tmpdir(), 'kustomization.yaml')),
    false,
  );
});

test('digest-source policy: prod pins require a build-emitted digest', () => {
  assert.throws(
    () => assertDigestSourcePolicy({
      targets: [{ image: backendImage, tag: 'backend-v1.2.3' }],
      kustomization: DEFAULT_KUSTOMIZATION,
    }),
    /audit finding #20/,
  );
  assert.throws(
    () => assertDigestSourcePolicy({
      targets: [
        { image: backendImage, tag: 'backend-v1.2.3', expectedDigest: resolvedDigest },
      ],
      kustomization: DEFAULT_KUSTOMIZATION,
      allowTagResolution: true,
    }),
    /--allow-tag-resolution is refused for the production kustomization/,
  );
  assert.deepEqual(
    assertDigestSourcePolicy({
      targets: [
        { image: backendImage, tag: 'backend-v1.2.3', expectedDigest: resolvedDigest },
      ],
      kustomization: DEFAULT_KUSTOMIZATION,
    }),
    { isProd: true },
  );
});

test('digest-source policy: non-prod tag resolution needs the explicit opt-in', () => {
  const target = { image: backendImage, tag: 'backend-v1.2.3' };
  const kustomization = path.join(os.tmpdir(), 'staging-kustomization.yaml');
  assert.throws(
    () => assertDigestSourcePolicy({ targets: [target], kustomization }),
    /--allow-tag-resolution for non-production/,
  );
  assert.deepEqual(
    assertDigestSourcePolicy({ targets: [target], kustomization, allowTagResolution: true }),
    { isProd: false },
  );
});

test('digest-source policy: expected ref for a different image is refused', () => {
  assert.throws(
    () => assertDigestSourcePolicy({
      targets: [{
        image: backendImage,
        tag: 'backend-v1.2.3',
        expectedDigest: resolvedDigest,
        expectedImage: adminImage,
      }],
      kustomization: DEFAULT_KUSTOMIZATION,
    }),
    /digest that belongs to a\s+different image/,
  );
});

// ── updateDigests end-to-end (fake registry + fake cosign) ──────────────────

test('prod invocation without a build-emitted digest rejects before any registry call', async () => {
  await assert.rejects(
    updateDigests({
      targets: [{ image: backendImage, tag: 'backend-v1.2.3' }],
      kustomization: DEFAULT_KUSTOMIZATION,
      verification: keyVerification,
      fetchImpl: refusingFetch(),
      execFile: refusingExecFile(),
    }),
    /audit finding #20/,
  );
});

test('pins the build-emitted digest when the tag cross-check agrees', async () => {
  const { dir, kustomization } = makeTempKustomization();
  const evidenceFile = path.join(dir, 'evidence', 'verified-digests.json');
  let verified = false;

  await updateDigests({
    targets: [{
      image: backendImage,
      tag: 'backend-v1.2.3',
      expectedDigest: resolvedDigest,
      expectedImage: backendImage,
    }],
    kustomization,
    evidenceFile,
    verification: keyVerification,
    fetchImpl: fakeFetch(resolvedDigest),
    execFile(command, args) {
      assert.equal(command, 'cosign');
      assert.deepEqual(args, ['verify', '--key', 'env://COSIGN_PUBLIC_KEY', `${backendImage}@${resolvedDigest}`]);
      assert.match(fs.readFileSync(kustomization, 'utf8'), new RegExp(placeholderDigest));
      verified = true;
      return '';
    },
  });

  assert.equal(verified, true);
  assert.match(fs.readFileSync(kustomization, 'utf8'), new RegExp(resolvedDigest));

  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.equal(evidence.evidence[0].digest, resolvedDigest);
  assert.equal(evidence.evidence[0].pinSource, 'build-emitted');
  assert.equal(evidence.evidence[0].tagResolvedDigest, resolvedDigest);
  assert.equal(evidence.evidence[0].verifiedRef, `${backendImage}@${resolvedDigest}`);
});

test('refuses to pin when the tag resolves to a foreign digest (rebind) — no cosign, no write', async () => {
  const { kustomization } = makeTempKustomization();

  await assert.rejects(
    updateDigests({
      targets: [{
        image: backendImage,
        tag: 'backend-v1.2.3',
        expectedDigest: resolvedDigest,
      }],
      kustomization,
      verification: keyVerification,
      fetchImpl: fakeFetch(foreignDigest),
      execFile: refusingExecFile(),
    }),
    /SECURITY: refusing to pin/,
  );

  const yaml = fs.readFileSync(kustomization, 'utf8');
  assert.match(yaml, new RegExp(placeholderDigest));
  assert.doesNotMatch(yaml, new RegExp(resolvedDigest));
  assert.doesNotMatch(yaml, new RegExp(foreignDigest));
});

test('legacy tag resolution still works for non-prod trees with the explicit opt-in', async () => {
  const { dir, kustomization } = makeTempKustomization();
  const evidenceFile = path.join(dir, 'evidence', 'verified-digests.json');

  await updateDigests({
    targets: [{ image: backendImage, tag: 'backend-v1.2.3' }],
    kustomization,
    evidenceFile,
    allowTagResolution: true,
    verification: keyVerification,
    fetchImpl: fakeFetch(resolvedDigest),
    execFile: () => '',
  });

  assert.match(fs.readFileSync(kustomization, 'utf8'), new RegExp(resolvedDigest));
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.equal(evidence.evidence[0].pinSource, 'tag-resolution');
});

test('leaves kustomization untouched when cosign verification fails', async () => {
  const { kustomization } = makeTempKustomization();

  await assert.rejects(
    updateDigests({
      targets: [{
        image: backendImage,
        tag: 'backend-v1.2.3',
        expectedDigest: resolvedDigest,
      }],
      kustomization,
      verification: {
        mode: 'keyless',
        cosignExe: 'cosign',
        certificateIdentityRegexp: '^https://github.com/Bahuleyandr/VH-Health-Platform/.github/workflows/release-authority-images.yml@.*$',
        certificateOidcIssuer: 'https://token.actions.githubusercontent.com',
      },
      fetchImpl: fakeFetch(resolvedDigest),
      execFile() {
        throw new Error('signature rejected');
      },
    }),
    /signature rejected/,
  );

  assert.match(fs.readFileSync(kustomization, 'utf8'), new RegExp(placeholderDigest));
  assert.doesNotMatch(fs.readFileSync(kustomization, 'utf8'), new RegExp(resolvedDigest));
});

test('--dry-run verifies the full pipeline but writes no files', async () => {
  const { dir, kustomization } = makeTempKustomization();
  const evidenceFile = path.join(dir, 'evidence', 'verified-digests.json');
  const before = fs.readFileSync(kustomization, 'utf8');
  let cosignRan = false;

  const result = await updateDigests({
    targets: [{
      image: backendImage,
      tag: 'backend-v1.2.3',
      expectedDigest: resolvedDigest,
    }],
    kustomization,
    evidenceFile,
    dryRun: true,
    verification: keyVerification,
    fetchImpl: fakeFetch(resolvedDigest),
    execFile() {
      cosignRan = true;
      return '';
    },
  });

  assert.equal(cosignRan, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.evidence[0].digest, resolvedDigest);
  assert.equal(fs.readFileSync(kustomization, 'utf8'), before);
  assert.equal(fs.existsSync(evidenceFile), false);
});
