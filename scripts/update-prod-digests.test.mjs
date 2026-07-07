import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseArgs, updateDigests } from './update-prod-digests.mjs';

const placeholderDigest = `sha256:${'0'.repeat(64)}`;
const resolvedDigest = `sha256:${'a'.repeat(64)}`;
const backendImage = 'ghcr.io/bahuleyandr/vh-health-platform-backend';

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

function fakeFetch() {
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
            return name.toLowerCase() === 'docker-content-digest' ? resolvedDigest : null;
          },
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test('requires a cosign policy before resolving image digests', () => {
  assert.throws(
    () => parseArgs(['--tag', 'backend-v1.2.3'], { env: {}, cwd: process.cwd() }),
    /Cosign verification is required/,
  );
});

test('verifies resolved digest before writing kustomization pin', async () => {
  const { dir, kustomization } = makeTempKustomization();
  const evidenceFile = path.join(dir, 'evidence', 'verified-digests.json');
  let verified = false;

  await updateDigests({
    targets: [{ image: backendImage, tag: 'backend-v1.2.3' }],
    kustomization,
    evidenceFile,
    verification: {
      mode: 'key',
      cosignExe: 'cosign',
      key: 'env://COSIGN_PUBLIC_KEY',
    },
    fetchImpl: fakeFetch(),
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
  assert.equal(evidence.evidence[0].verifiedRef, `${backendImage}@${resolvedDigest}`);
  assert.equal(evidence.evidence[0].verification.mode, 'key');
});

test('leaves kustomization untouched when cosign verification fails', async () => {
  const { kustomization } = makeTempKustomization();

  await assert.rejects(
    updateDigests({
      targets: [{ image: backendImage, tag: 'backend-v1.2.3' }],
      kustomization,
      verification: {
        mode: 'keyless',
        cosignExe: 'cosign',
        certificateIdentityRegexp: '^https://github.com/Bahuleyandr/VH-Health-Platform/.github/workflows/release-images.yml@.*$',
        certificateOidcIssuer: 'https://token.actions.githubusercontent.com',
      },
      fetchImpl: fakeFetch(),
      execFile() {
        throw new Error('signature rejected');
      },
    }),
    /signature rejected/,
  );

  assert.match(fs.readFileSync(kustomization, 'utf8'), new RegExp(placeholderDigest));
  assert.doesNotMatch(fs.readFileSync(kustomization, 'utf8'), new RegExp(resolvedDigest));
});
