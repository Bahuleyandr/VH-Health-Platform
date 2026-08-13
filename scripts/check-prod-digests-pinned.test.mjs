import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HELD_APP_REFERENCES,
  ZERO_DIGEST,
  classifyImageOccurrence,
  extractRenderedImages,
  parseImageReference,
  renderProductionImages,
  validateProductionImages,
  verifyRegistryPin,
} from './check-prod-digests-pinned.mjs';

const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;

function manifestResponse({
  digest = digestA,
  mediaType = 'application/vnd.oci.image.index.v1+json',
  platforms = [
    { os: 'linux', architecture: 'amd64' },
    { os: 'linux', architecture: 'arm64', variant: 'v8' },
  ],
} = {}) {
  return new Response(JSON.stringify({
    schemaVersion: 2,
    mediaType,
    manifests: platforms.map((platform, index) => ({
      digest: `sha256:${String(index + 1).repeat(64)}`,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      platform,
    })),
  }), {
    status: 200,
    headers: {
      'content-type': mediaType,
      'docker-content-digest': digest,
    },
  });
}

test('extracts workload, CRD, and operator-config image fields from rendered YAML', () => {
  const images = extractRenderedImages([
    'containers:',
    '  - image: docker.io/example/one:1@sha256:abc',
    '    name: one',
    "  imageName: 'ghcr.io/example/postgres:18@sha256:def'",
    '  operatorImage: "ghcr.io/example/operator:1@sha256:123"',
    '  barmanPluginImage: ghcr.io/example/plugin:1@sha256:456',
    '  barmanSidecarImage: ghcr.io/example/sidecar:1@sha256:789 # reviewed pin',
    '  postgresImage: ghcr.io/example/postgres:18@sha256:def',
    '  imagePullPolicy: IfNotPresent',
    'data:',
    '  note: image: is not a workload field',
  ].join('\n'), 'prod');
  assert.deepEqual(images.map(({ field, ref, line }) => ({ field, ref, line })), [
    { field: 'image', ref: 'docker.io/example/one:1@sha256:abc', line: 2 },
    { field: 'imageName', ref: 'ghcr.io/example/postgres:18@sha256:def', line: 4 },
    { field: 'operatorImage', ref: 'ghcr.io/example/operator:1@sha256:123', line: 5 },
    { field: 'barmanPluginImage', ref: 'ghcr.io/example/plugin:1@sha256:456', line: 6 },
    { field: 'barmanSidecarImage', ref: 'ghcr.io/example/sidecar:1@sha256:789', line: 7 },
    { field: 'postgresImage', ref: 'ghcr.io/example/postgres:18@sha256:def', line: 8 },
  ]);
});

test('renders both roots and rejects an empty rendered image inventory', () => {
  const calls = [];
  const images = renderProductionImages({
    roots: ['platform', 'apps'],
    cwd: '/repo',
    kustomize: 'kustomize',
    execFile(_command, args) {
      calls.push(args);
      return `kind: Pod\nspec:\n  containers:\n    - image: example/test:1@${digestA}\n`;
    },
  });
  assert.deepEqual(calls, [['build', 'platform'], ['build', 'apps']]);
  assert.equal(images.length, 2);
  assert.throws(
    () => renderProductionImages({
      roots: ['empty'],
      execFile: () => 'kind: ConfigMap\n',
    }),
    /contained no image references/,
  );
});

test('normalizes Docker Hub shorthand and preserves explicit registries', () => {
  assert.deepEqual(parseImageReference(`redis:7.4.1-alpine@${digestA}`), {
    ref: `redis:7.4.1-alpine@${digestA}`,
    registry: 'docker.io',
    repositoryPath: 'library/redis',
    repository: 'docker.io/library/redis',
    tag: '7.4.1-alpine',
    digest: digestA,
  });
  assert.equal(
    parseImageReference(`ghcr.io/kubereboot/kured:1.16.2@${digestA}`).repository,
    'ghcr.io/kubereboot/kured',
  );
});

test('accepts only the exact documented zero app placeholders as held', () => {
  assert.deepEqual([...HELD_APP_REFERENCES].sort(), [
    `ghcr.io/bahuleyandr/vh-health-platform-adminportal@${ZERO_DIGEST}`,
    `ghcr.io/bahuleyandr/vh-health-platform-backend@${ZERO_DIGEST}`,
    `ghcr.io/bahuleyandr/vhhealth-staff-web@${ZERO_DIGEST}`,
  ]);
  const held = classifyImageOccurrence({
    target: 'infra/kubernetes/apps',
    line: 10,
    ref: `ghcr.io/bahuleyandr/vh-health-platform-backend@${ZERO_DIGEST}`,
  });
  assert.equal(held.held, true);

  assert.throws(
    () => classifyImageOccurrence({
      target: 'infra/kubernetes/overlays/prod',
      line: 10,
      ref: `ghcr.io/bahuleyandr/vh-health-platform-backend@${ZERO_DIGEST}`,
    }),
    /has no immutable tag@digest tag/,
  );
  assert.throws(
    () => classifyImageOccurrence({
      target: 'infra/kubernetes/apps',
      line: 10,
      ref: `ghcr.io/attacker/backend@${ZERO_DIGEST}`,
    }),
    /has no immutable tag@digest tag/,
  );
  assert.throws(
    () => classifyImageOccurrence({
      target: 'infra/kubernetes/apps',
      line: 10,
      ref: `ghcr.io/bahuleyandr/vh-health-platform-backend@${ZERO_DIGEST}`,
    }, { requirePinned: true }),
    /remains at the deliberately held all-zero digest/,
  );
  assert.throws(
    () => classifyImageOccurrence({
      target: 'infra/kubernetes/apps',
      line: 10,
      ref: `ghcr.io/bahuleyandr/vh-health-platform-backend:unexpected@${ZERO_DIGEST}`,
    }),
    /is not pinned to a real sha256 digest/,
  );
});

test('retains an empty runtime image field so validation fails closed', () => {
  const [occurrence] = extractRenderedImages('operatorImage:', 'prod');
  assert.deepEqual(occurrence, {
    field: 'operatorImage',
    ref: '',
    target: 'prod',
    line: 1,
  });
  assert.throws(() => classifyImageOccurrence(occurrence), /image repository is empty/);
});

test('verifies the rendered digest exists and records platforms', async () => {
  const image = parseImageReference(`redis:7.4.1-alpine@${digestA}`);
  const verified = await verifyRegistryPin(image, {
    fetchImpl: async () => manifestResponse(),
    retries: 0,
  });
  assert.equal(verified.resolvedDigest, digestA);
  assert.deepEqual(verified.platforms, ['linux/amd64', 'linux/arm64/v8']);
});

test('follows a Bearer challenge without logging or requiring credentials', async () => {
  const calls = [];
  const image = parseImageReference(`ghcr.io/kubereboot/kured:1.16.2@${digestA}`);
  const verified = await verifyRegistryPin(image, {
    retries: 0,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: options.headers?.Authorization || '' });
      if (String(url).includes('/token?')) {
        return new Response(JSON.stringify({ token: 'public-token' }), { status: 200 });
      }
      if (!options.headers?.Authorization) {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:kubereboot/kured:pull"',
          },
        });
      }
      return manifestResponse();
    },
  });
  assert.equal(verified.resolvedDigest, digestA);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].authorization, '');
  assert.equal(calls[2].authorization, 'Bearer public-token');
});

test('rejects a registry response for a different digest', async () => {
  const image = parseImageReference(`redis:7.4.1-alpine@${digestA}`);
  await assert.rejects(
    verifyRegistryPin(image, {
      fetchImpl: async () => manifestResponse({ digest: digestB }),
      retries: 0,
    }),
    new RegExp(`${digestA} returned manifest digest ${digestB}`),
  );
});

test('rejects a single-platform manifest for the reviewed platform repositories', async () => {
  const image = parseImageReference(`redis:7.4.1-alpine@${digestA}`);
  await assert.rejects(
    verifyRegistryPin(image, {
      fetchImpl: async () => manifestResponse({
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        platforms: [],
      }),
      retries: 0,
    }),
    /not the required multi-architecture index/,
  );
});

test('reports actionable anonymous registry rate-limit diagnostics', async () => {
  const image = parseImageReference(`example/test:1@${digestA}`);
  await assert.rejects(
    verifyRegistryPin(image, {
      retries: 0,
      fetchImpl: async () => new Response('', {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {
          'ratelimit-limit': '100;w=21600',
          'ratelimit-remaining': '0;w=21600',
          'retry-after': '60',
        },
      }),
    }),
    /HTTP 429.*ratelimit-limit=100;w=21600.*ratelimit-remaining=0;w=21600.*retry-after=60/,
  );
});

test('deduplicates active refs while retaining deliberate held occurrences', async () => {
  const activeRef = `example/test:1@${digestA}`;
  const result = await validateProductionImages({
    occurrences: [
      {
        field: 'operatorImage',
        ref: activeRef,
        target: 'infra/kubernetes/overlays/prod',
        line: 1,
      },
      { field: 'image', ref: activeRef, target: 'infra/kubernetes/apps', line: 2 },
      {
        field: 'image',
        ref: `ghcr.io/bahuleyandr/vhhealth-staff-web@${ZERO_DIGEST}`,
        target: 'infra/kubernetes/apps',
        line: 3,
      },
    ],
    verify: async (image) => ({ ...image, platforms: [] }),
  });
  assert.equal(result.active.length, 1);
  assert.equal(result.active[0].targets.size, 2);
  assert.deepEqual([...result.active[0].fields].sort(), ['image', 'operatorImage']);
  assert.equal(result.active[0].occurrences, 2);
  assert.equal(result.activeOccurrences.length, 2);
  assert.equal(result.held.length, 1);
  assert.equal(result.verified.length, 1);
});

test('rejects a zero or malformed registry concurrency instead of skipping proof', async () => {
  const occurrences = [{
    ref: `example/test:1@${digestA}`,
    target: 'infra/kubernetes/apps',
    line: 1,
  }];
  await assert.rejects(
    validateProductionImages({ occurrences, concurrency: 0 }),
    /must be a positive integer/,
  );
  await assert.rejects(
    validateProductionImages({ occurrences, concurrency: Number.NaN }),
    /must be a positive integer/,
  );
});
