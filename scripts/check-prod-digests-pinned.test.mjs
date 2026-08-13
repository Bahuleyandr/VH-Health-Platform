import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  HELD_APP_OCCURRENCES,
  HELD_APP_REFERENCES,
  ZERO_DIGEST,
  assertHeldOccurrenceInventory,
  classifyImageOccurrence,
  extractRenderedImages,
  extractSynthesizedImages,
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
  assert.deepEqual(parseImageReference(`redis:7.4.10-alpine@${digestA}`), {
    ref: `redis:7.4.10-alpine@${digestA}`,
    registry: 'docker.io',
    repositoryPath: 'library/redis',
    repository: 'docker.io/library/redis',
    tag: '7.4.10-alpine',
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
  assert.equal(HELD_APP_OCCURRENCES.length, 6);
  const heldOccurrence = { ...HELD_APP_OCCURRENCES[1], line: 10 };
  const held = classifyImageOccurrence(heldOccurrence);
  assert.equal(held.held, true);

  assert.throws(
    () => classifyImageOccurrence({
      ...heldOccurrence,
      target: 'infra/kubernetes/overlays/prod',
    }),
    /unauthorized all-zero image occurrence/,
  );
  assert.throws(
    () => classifyImageOccurrence({
      ...heldOccurrence,
      ref: `ghcr.io/attacker/backend@${ZERO_DIGEST}`,
    }),
    /unauthorized all-zero image occurrence/,
  );
  assert.throws(
    () => classifyImageOccurrence(heldOccurrence, { requirePinned: true }),
    /remains at the deliberately held all-zero digest/,
  );
  assert.throws(
    () => classifyImageOccurrence({
      ...heldOccurrence,
      ref: `ghcr.io/bahuleyandr/vh-health-platform-backend:unexpected@${ZERO_DIGEST}`,
    }),
    /unauthorized all-zero image occurrence/,
  );
});

test('retains an empty runtime image field so validation fails closed', () => {
  const [occurrence] = extractRenderedImages('operatorImage:', 'prod');
  assert.deepEqual({
    field: occurrence.field,
    ref: occurrence.ref,
    target: occurrence.target,
    line: occurrence.line,
  }, {
    field: 'operatorImage',
    ref: '',
    target: 'prod',
    line: 1,
  });
  assert.throws(() => classifyImageOccurrence(occurrence), /image repository is empty/);
});

test('inventories scheduled restore manifests synthesized at runtime and rejects unresolved image variables', () => {
  const yaml = readFileSync(
    new URL('../infra/kubernetes/base/cnpg/scheduled-restore-proof.yaml', import.meta.url),
    'utf8',
  );
  const script = readFileSync(
    new URL('../infra/kubernetes/base/cnpg/scheduled-restore-proof.sh', import.meta.url),
    'utf8',
  );
  const images = extractSynthesizedImages(`${yaml}\n${script}`, 'scheduled-restore-proof');
  assert.deepEqual(
    images.map(({ resourceKind, field, container, ref }) => ({
      resourceKind,
      field,
      container,
      ref,
    })),
    [
      {
        resourceKind: 'Job',
        field: 'image',
        container: 'verify',
        ref: 'docker.io/amazon/aws-cli:2.34.53@sha256:cf53765c0de54ad3a8ea21818f1c4c845a8cf7ca87831c078a00fef244031493',
      },
      {
        resourceKind: 'Cluster',
        field: 'imageName',
        container: '',
        ref: 'ghcr.io/cloudnative-pg/postgresql:18.4-standard-bookworm@sha256:0ec6b32ab5b644aa51da58443c5ac2c1724d97de0d2a88961920d437b71b9ad8',
      },
      {
        resourceKind: 'Job',
        field: 'image',
        container: 'verify',
        ref: 'ghcr.io/cloudnative-pg/postgresql:18.4-standard-bookworm@sha256:0ec6b32ab5b644aa51da58443c5ac2c1724d97de0d2a88961920d437b71b9ad8',
      },
    ],
  );
  assert.throws(
    () => extractSynthesizedImages(
      `${script}\n{"kind":"Pod","spec":{"image":"\${FUTURE_IMAGE}"}}`,
      'future-script',
    ),
    /must resolve to exactly one rendered literal/,
  );
});

test('current renders contain exactly six held workload occurrences and three synthesized images', () => {
  const occurrences = renderProductionImages();
  const held = occurrences
    .filter(({ ref }) => ref.endsWith(ZERO_DIGEST))
    .map((occurrence) => classifyImageOccurrence(occurrence));
  assert.doesNotThrow(() => assertHeldOccurrenceInventory(held));
  assert.equal(occurrences.filter(({ source }) => source === 'synthesized').length, 3);
});

test('verifies the rendered digest exists and records platforms', async () => {
  const image = parseImageReference(`redis:7.4.10-alpine@${digestA}`);
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
  assert.equal(new URL(calls[1].url).searchParams.get('scope'), 'repository:kubereboot/kured:pull');
  assert.equal(calls[2].authorization, 'Bearer public-token');
});

test('binds credentials to the HTTPS registry token authority and replaces hostile scope', async () => {
  const calls = [];
  const image = parseImageReference(`ghcr.io/example/private:1@${digestA}`);
  await verifyRegistryPin(image, {
    retries: 0,
    env: {
      GHCR_USERNAME: 'gh-user',
      GHCR_TOKEN: 'gh-token',
      CONTAINER_REGISTRY_USERNAME: 'generic-user',
      CONTAINER_REGISTRY_PASSWORD: 'generic-secret',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: options.headers?.Authorization || '' });
      if (String(url).includes('/token?')) {
        return new Response(JSON.stringify({ token: 'bound-token' }), { status: 200 });
      }
      if (!options.headers?.Authorization) {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://ghcr.io/token?leak=true",service="evil.example",scope="repository:attacker/admin:push,pull"',
          },
        });
      }
      return manifestResponse();
    },
  });
  const tokenCall = calls[1];
  const tokenUrl = new URL(tokenCall.url);
  assert.equal(tokenUrl.origin, 'https://ghcr.io');
  assert.equal(tokenUrl.searchParams.get('leak'), null);
  assert.equal(tokenUrl.searchParams.get('service'), 'ghcr.io');
  assert.equal(tokenUrl.searchParams.get('scope'), 'repository:example/private:pull');
  assert.equal(
    tokenCall.authorization,
    `Basic ${Buffer.from('gh-user:gh-token').toString('base64')}`,
  );
  assert.ok(!tokenCall.authorization.includes(Buffer.from('generic-secret').toString('base64')));
});

test('rejects hostile or plaintext token realms before any credential egress', async () => {
  const image = parseImageReference(`ghcr.io/example/private:1@${digestA}`);
  for (const realm of ['https://evil.example/token', 'http://ghcr.io/token']) {
    const calls = [];
    await assert.rejects(
      verifyRegistryPin(image, {
        retries: 0,
        env: { GHCR_USERNAME: 'gh-user', GHCR_TOKEN: 'gh-token' },
        fetchImpl: async (url, options = {}) => {
          calls.push({ url: String(url), authorization: options.headers?.Authorization || '' });
          return new Response('', {
            status: 401,
            headers: {
              'www-authenticate': `Bearer realm="${realm}",scope="repository:attacker/admin:push"`,
            },
          });
        },
      }),
      /bearer-token realm must use HTTPS authority/,
    );
    assert.deepEqual(calls.map(({ authorization }) => authorization), ['']);
  }
});

test('follows HTTPS manifest redirects without forwarding bearer authorization cross-authority', async () => {
  const calls = [];
  const image = parseImageReference(`ghcr.io/example/redirected:1@${digestA}`);
  await verifyRegistryPin(image, {
    retries: 0,
    fetchImpl: async (url, options = {}) => {
      const call = { url: String(url), authorization: options.headers?.Authorization || '' };
      calls.push(call);
      if (String(url).includes('/token?')) {
        return new Response(JSON.stringify({ token: 'manifest-token' }), { status: 200 });
      }
      if (new URL(url).host === 'cdn.example') return manifestResponse();
      if (!call.authorization) {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token"' },
        });
      }
      return new Response('', {
        status: 307,
        headers: { location: 'https://cdn.example/manifest' },
      });
    },
  });
  assert.equal(calls[2].authorization, 'Bearer manifest-token');
  assert.equal(calls[3].url, 'https://cdn.example/manifest');
  assert.equal(calls[3].authorization, '');
});

test('never falls back to generic credentials for GHCR or Docker Hub', async () => {
  const cases = [
    {
      ref: `ghcr.io/example/private:1@${digestA}`,
      challenge: 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
    },
    {
      ref: `docker.io/example/private:1@${digestA}`,
      challenge: 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
    },
  ];
  for (const { ref, challenge } of cases) {
    const tokenAuthorizations = [];
    await verifyRegistryPin(parseImageReference(ref), {
      retries: 0,
      env: {
        CONTAINER_REGISTRY_USERNAME: 'generic-user',
        CONTAINER_REGISTRY_PASSWORD: 'generic-secret',
        DOCKER_USERNAME: 'legacy-user',
        DOCKER_PASSWORD: 'legacy-secret',
      },
      fetchImpl: async (url, options = {}) => {
        if (String(url).includes('/token?')) {
          tokenAuthorizations.push(options.headers?.Authorization || '');
          return new Response(JSON.stringify({ token: 'anonymous-token' }), { status: 200 });
        }
        if (!options.headers?.Authorization) {
          return new Response('', {
            status: 401,
            headers: { 'www-authenticate': challenge },
          });
        }
        return manifestResponse();
      },
    });
    assert.deepEqual(tokenAuthorizations, ['']);
  }
});

test('rejects a registry response for a different digest', async () => {
  const image = parseImageReference(`redis:7.4.10-alpine@${digestA}`);
  await assert.rejects(
    verifyRegistryPin(image, {
      fetchImpl: async () => manifestResponse({ digest: digestB }),
      retries: 0,
    }),
    new RegExp(`${digestA} returned manifest digest ${digestB}`),
  );
});

test('rejects a single-platform manifest for the reviewed platform repositories', async () => {
  const image = parseImageReference(`redis:7.4.10-alpine@${digestA}`);
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
      ...HELD_APP_OCCURRENCES.map((occurrence, index) => ({ ...occurrence, line: index + 3 })),
    ],
    verify: async (image) => ({ ...image, platforms: [] }),
  });
  assert.equal(result.active.length, 1);
  assert.equal(result.active[0].targets.size, 2);
  assert.deepEqual([...result.active[0].fields].sort(), ['image', 'operatorImage']);
  assert.equal(result.active[0].occurrences, 2);
  assert.equal(result.activeOccurrences.length, 2);
  assert.equal(result.held.length, 3);
  assert.equal(result.heldOccurrences.length, 6);
  assert.equal(result.verified.length, 1);
});

test('rejects a missing or duplicated held workload occurrence', async () => {
  await assert.rejects(
    validateProductionImages({
      occurrences: HELD_APP_OCCURRENCES.slice(1).map((occurrence, index) => ({
        ...occurrence,
        line: index + 1,
      })),
      verify: async (image) => image,
    }),
    /exact expected six.*missing/,
  );
  await assert.rejects(
    validateProductionImages({
      occurrences: [...HELD_APP_OCCURRENCES, HELD_APP_OCCURRENCES[0]].map(
        (occurrence, index) => ({ ...occurrence, line: index + 1 }),
      ),
      verify: async (image) => image,
    }),
    /exact expected six.*extra/,
  );
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
