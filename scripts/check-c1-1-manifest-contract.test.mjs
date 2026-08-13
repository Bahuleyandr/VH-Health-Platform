import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ALLOWED_ZERO_DIGEST_IMAGES,
  EXPECTED_ACTIVE_PG_IMAGE,
  EXPECTED_ALPINE_OPENSSL_IMAGE,
  EXPECTED_AWS_CLI_IMAGE,
  EXPECTED_CURL_IMAGE,
  EXPECTED_PG_IMAGE,
  HELD_OLLAMA_IMAGE,
  assertLiteralAndImageContract,
  extractImageRefs,
  findDeclarativeTemplateTokens,
  parseRenderedDocuments,
  requiredScriptEnvironment,
  runManifestContract,
} from './check-c1-1-manifest-contract.mjs';
import { stagesForChangedFiles } from './ci/stage-selection.mjs';
import { assertNoIngressClassParameters } from './validate-kubernetes-manifests.mjs';

const minio =
  'quay.io/minio/minio:RELEASE.2024-11-07T00-52-20Z@sha256:ac591851803a79aee64bc37f66d77c56b0a4b6e12d9e5356380f4105510f2332';

function validLiteralFixture() {
  return {
    platform: [
      // The live database runs the declared, fail-closed PostgreSQL 17 pin.
      // The PostgreSQL 18.4 target appears only as the inert provenance marker.
      `imageName: ${EXPECTED_ACTIVE_PG_IMAGE}`,
      `postgresImage: ${EXPECTED_PG_IMAGE}`,
      `image: ${minio}`,
      'script.sh: |',
      '  echo "${RUNTIME_ONLY}"',
      '',
    ].join('\n'),
    apps: [
      `image: ${EXPECTED_CURL_IMAGE}`,
      `image: ${EXPECTED_AWS_CLI_IMAGE}`,
      `image: ${EXPECTED_ALPINE_OPENSSL_IMAGE}`,
      ...[...ALLOWED_ZERO_DIGEST_IMAGES]
        .filter((ref) => ref !== EXPECTED_ACTIVE_PG_IMAGE)
        .map((ref) => `image: ${ref}`),
      '',
    ].join('\n'),
  };
}

test('splits rendered resources and reads only top-level metadata', () => {
  const docs = parseRenderedDocuments([
    'apiVersion: batch/v1',
    'kind: CronJob',
    'metadata:',
    '  name: outer',
    '  namespace: test',
    'spec:',
    '  jobTemplate:',
    '    metadata:',
    '      name: inner',
    '---',
    'apiVersion: v1',
    'kind: ServiceAccount',
    'metadata:',
    '  name: runner',
    '',
  ].join('\n'));

  assert.deepEqual(
    docs.map(({ apiVersion, kind, name, namespace }) => ({ apiVersion, kind, name, namespace })),
    [
      { apiVersion: 'batch/v1', kind: 'CronJob', name: 'outer', namespace: 'test' },
      { apiVersion: 'v1', kind: 'ServiceAccount', name: 'runner', namespace: null },
    ],
  );
});

test('allows runtime shell expansion in block scalars but rejects declarative tokens', () => {
  const runtime = [
    'data:',
    '  verify.sh: |-',
    '    : "${R2_ENDPOINT:?required}"',
    '    echo "${LOCAL_VALUE}"',
    '',
  ].join('\n');
  assert.deepEqual(findDeclarativeTemplateTokens(runtime), []);

  const declarative = [
    'spec:',
    '  configuration:',
    '    endpointURL: "https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com"',
    '',
  ].join('\n');
  assert.deepEqual(findDeclarativeTemplateTokens(declarative), [
    { line: 3, token: '${CF_ACCOUNT_ID}' },
  ]);

  const declarativeBlock = [
    'data:',
    '  application.conf: |',
    '    endpoint=https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com',
    '',
  ].join('\n');
  assert.deepEqual(findDeclarativeTemplateTokens(declarativeBlock), [
    { line: 3, token: '${CF_ACCOUNT_ID}' },
  ]);
});

test('collects required pod environment from supported shell guards', () => {
  const script = [
    ': "${DIRECT:?required}"',
    'required_vars=(',
    '  ARRAY_ONE',
    '  ARRAY_TWO',
    ')',
    'require_vars \\',
    '  MULTI_ONE \\',
    '  MULTI_TWO',
    'require_vars INLINE_ONE INLINE_TWO',
    '',
  ].join('\n');

  assert.deepEqual(
    [...requiredScriptEnvironment(script)].sort(),
    ['ARRAY_ONE', 'ARRAY_TWO', 'DIRECT', 'INLINE_ONE', 'INLINE_TWO', 'MULTI_ONE', 'MULTI_TWO'],
  );
});

test('extracts scalar, imageName, marker, and sequence-style image references', () => {
  const refs = extractImageRefs([
    `image: ${minio}`,
    `  imageName: "${EXPECTED_PG_IMAGE}"`,
    `  postgresImage: '${EXPECTED_PG_IMAGE}'`,
    `  - image: ${HELD_OLLAMA_IMAGE}`,
    '  imagePullPolicy: IfNotPresent',
  ].join('\n'));

  assert.deepEqual(
    refs.map(({ key, ref }) => ({ key, ref })),
    [
      { key: 'image', ref: minio },
      { key: 'imageName', ref: EXPECTED_PG_IMAGE },
      { key: 'postgresImage', ref: EXPECTED_PG_IMAGE },
      { key: 'image', ref: HELD_OLLAMA_IMAGE },
    ],
  );
});

test('validator rejects dangling IngressClass parameters but accepts a parameterless class', () => {
  const valid = [
    'apiVersion: networking.k8s.io/v1',
    'kind: IngressClass',
    'metadata:',
    '  name: nginx',
    'spec:',
    '  controller: k8s.io/ingress-nginx',
    '',
  ].join('\n');
  assert.doesNotThrow(() => assertNoIngressClassParameters(valid));

  const dangling = [
    valid.trimEnd(),
    '  parameters:',
    '    apiGroup: k8s.io',
    '    kind: IngressClassParameters',
    '    name: ingress-nginx',
    '',
  ].join('\n');
  assert.throws(
    () => assertNoIngressClassParameters(dangling),
    /defines no IngressClassParameters resource\/controller contract/,
  );
});

test('validator explicitly allowlists ObjectStore without globally ignoring missing schemas', () => {
  const validator = readFileSync(
    new URL('./validate-kubernetes-manifests.mjs', import.meta.url),
    'utf8',
  );
  assert.match(validator, /barmancloud\.cnpg\.io\/v1\/ObjectStore/);
  assert.doesNotMatch(validator, /['"]-ignore-missing-schemas['"]/);
});

test('load-bearing C1.1 docs trigger the manifest workflow and infra stage', () => {
  const docs = [
    'docs/CNPG_POSTGRES_18_QUALIFICATION.md',
    'docs/DEPLOYMENT_GUIDE.md',
  ];
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  const stageOrder = ['security', 'backend', 'fhir', 'admin', 'flutter', 'infra'];

  for (const path of docs) {
    assert.deepEqual(stagesForChangedFiles([path], stageOrder), ['security', 'infra']);
  }
  for (const path of [
    'scripts/check-prod-digests-pinned.mjs',
    'scripts/check-prod-digests-pinned.test.mjs',
    'scripts/check-prod-helm-image-inventory.mjs',
    'scripts/check-prod-helm-image-inventory.test.mjs',
  ]) {
    assert.deepEqual(stagesForChangedFiles([path], stageOrder), ['security', 'infra']);
  }
  assert.match(workflow, /quick_infra:[\s\S]*uses: \.\/\.github\/workflows\/_reusable-kubernetes-manifests\.yml/);
  assert.match(workflow, /full_infra:[\s\S]*uses: \.\/\.github\/workflows\/_reusable-kubernetes-manifests\.yml/);
});

test('accepts only digest-pinned images and the four documented zero-digest repositories', () => {
  const { platform, apps } = validLiteralFixture();
  assert.doesNotThrow(() => assertLiteralAndImageContract(platform, apps));

  assert.throws(
    () => assertLiteralAndImageContract(platform, `${apps}\nimage: docker.io/library/busybox:1.36\n`),
    /tag-only or malformed image reference/,
  );
  assert.throws(
    () =>
      assertLiteralAndImageContract(
        platform,
        `${apps}\nimage: example.invalid/other@sha256:${'0'.repeat(64)}\n`,
      ),
    /unauthorized all-zero digest/,
  );
});

// Audit 2026-08-13 (P1). Both capabilities are held outside the active graph;
// re-composing either is an unreviewed activation, so the contract must reject
// it rather than merely document it.
test('rejects a HELD capability re-entering an active production render', () => {
  const { platform, apps } = validLiteralFixture();

  assert.throws(
    () => assertLiteralAndImageContract(`${platform}\nimageName: ${EXPECTED_PG_IMAGE}\n`, apps),
    /composes a HELD image into the active production graph[\s\S]*declared PostgreSQL 17 generation/,
  );
  assert.throws(
    () => assertLiteralAndImageContract(platform, `${apps}\nimage: ${HELD_OLLAMA_IMAGE}\n`),
    /composes a HELD image into the active production graph[\s\S]*clinical-ai-deep-tier/,
  );

  // The inert provenance marker is a different role and stays legal — otherwise
  // the guard would force the qualified ladder target to be deleted, not held.
  assert.doesNotThrow(() =>
    assertLiteralAndImageContract(`${platform}\npostgresImage: ${EXPECTED_PG_IMAGE}\n`, apps),
  );
});

test('the active database generation is declared, fail-closed, and not the PG18 target', () => {
  const cluster = readFileSync(
    new URL('../infra/kubernetes/base/cnpg/cluster.yaml', import.meta.url),
    'utf8',
  );
  assert.ok(cluster.includes(`imageName: ${EXPECTED_ACTIVE_PG_IMAGE}`));
  assert.doesNotMatch(cluster, /^\s*imageName:\s*ghcr\.io\/cloudnative-pg\/postgresql:18\./m);
  assert.match(EXPECTED_ACTIVE_PG_IMAGE, /@sha256:0{64}$/);

  // Held, not deleted: the exact PG18 pin still exists, in exactly one governed
  // production place.
  const cutover = readFileSync(
    new URL('../infra/kubernetes/held/c1-1-pg18-cutover/pg18-cutover-target.yaml', import.meta.url),
    'utf8',
  );
  assert.ok(cutover.includes(EXPECTED_PG_IMAGE));
  assert.ok(cutover.includes('vhhealth.app/deploy-state: "held"'));
});

test('the held deep tier is uncomposed and its preflight gates activation', () => {
  const barrel = readFileSync(
    new URL('../infra/kubernetes/apps/kustomization.yaml', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(barrel, /^\s*-\s*ollama\/?\s*$/m);

  const preflight = readFileSync(
    new URL(
      '../infra/kubernetes/held/clinical-ai-deep-tier/deep-tier-preflight-job.yaml',
      import.meta.url,
    ),
    'utf8',
  );
  // A PreSync hook refuses the sync; a plain sync-wave Job only reports failure
  // after the workload has already been applied.
  assert.ok(preflight.includes('argocd.argoproj.io/hook: PreSync'));
  assert.ok(preflight.includes('argocd.argoproj.io/hook-delete-policy: BeforeHookCreation'));

  const statefulSet = readFileSync(
    new URL('../infra/kubernetes/held/clinical-ai-deep-tier/statefulset.yaml', import.meta.url),
    'utf8',
  );
  assert.ok(statefulSet.includes(HELD_OLLAMA_IMAGE));
});

test('rejects FILL_ME and placeholder ciphertext in rendered manifests', () => {
  const { platform, apps } = validLiteralFixture();
  assert.throws(
    () => assertLiteralAndImageContract(`${platform}\nvalue: FILL_ME_WITH_ENDPOINT\n`, apps),
    /contains FILL_ME/,
  );
  assert.throws(
    () =>
      assertLiteralAndImageContract(
        platform,
        `${apps}\nencryptedData:\n  token: PLACEHOLDER_REPLACE_WITH_KUBESEAL_CIPHERTEXT\n`,
      ),
    /placeholder ciphertext/,
  );
});

test('PG17 restore evidence is bound to a synthetic read-only identity and run destination', () => {
  const rehearsal = readFileSync(
    new URL('../infra/kubernetes/base/cnpg/pg18-upgrade-rehearsal.sh', import.meta.url),
    'utf8',
  );
  assert.match(rehearsal, /\$\{PG17_RESTORE_READER_SECRET:\?Set the synthetic read-only Secret/);
  assert.match(
    rehearsal,
    /PG17_RESTORE_READER_SECRET}" != "cnpg-dr-reader-credentials"[\s\S]*PG17_RESTORE_READER_SECRET}" != "cnpg-backup-producer-credentials"/,
  );
  assert.match(rehearsal, /reader_identity\)" == "\$\{PG17_RESTORE_READER_SECRET\}"/);
  assert.match(rehearsal, /reader_secret_synthetic_only\)" == "true"/);
  assert.match(rehearsal, /reader_secret_access\)" == "read-only"/);
  assert.match(rehearsal, /data_classification\)" == "synthetic"/);
  assert.match(
    rehearsal,
    /pg17_restore_destination%\/}" == "s3:\/\/vhhealth-synthetic-qa-only\/pg18-rehearsal\/\$\{REHEARSAL_RUN_ID\}"/,
  );
  assert.match(rehearsal, /reject_production_destination "\$\{pg17_restore_destination\}"/);
  assert.doesNotMatch(
    rehearsal,
    /reader_identity\)" == "cnpg-dr-reader-credentials"/,
  );
});

test('PG18 fresh-restore reader Secret is positively synthetic and read-only', () => {
  const rehearsal = readFileSync(
    new URL('../infra/kubernetes/base/cnpg/pg18-upgrade-rehearsal.sh', import.meta.url),
    'utf8',
  );
  assert.match(
    rehearsal,
    /kubectl get secret "\$\{PG18_REHEARSAL_READER_SECRET\}"[\s\S]*vhhealth\\\.app\/synthetic-only[\s\S]*kubectl get secret "\$\{PG18_REHEARSAL_READER_SECRET\}"[\s\S]*vhhealth\\\.app\/credential-access[\s\S]*== "read-only"/,
  );
  assert.match(
    rehearsal,
    /Synthetic reader Secret must be positively labeled synthetic-only and read-only/,
  );
});

test('current production render satisfies the complete C1.1 manifest contract', () => {
  assert.doesNotThrow(() => runManifestContract());
});
