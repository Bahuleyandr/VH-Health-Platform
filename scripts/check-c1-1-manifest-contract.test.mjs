import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ALLOWED_ZERO_DIGEST_IMAGES,
  EXPECTED_ALPINE_OPENSSL_IMAGE,
  EXPECTED_AWS_CLI_IMAGE,
  EXPECTED_CURL_IMAGE,
  EXPECTED_PG_IMAGE,
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
const ollama =
  'docker.io/ollama/ollama:0.5.4@sha256:18bfb1d605604fd53dcad20d0556df4c781e560ebebcd923454d627c994a0e37';
const busybox =
  'docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';

function validLiteralFixture() {
  return {
    platform: [
      `imageName: ${EXPECTED_PG_IMAGE}`,
      `image: ${minio}`,
      'script.sh: |',
      '  echo "${RUNTIME_ONLY}"',
      '',
    ].join('\n'),
    apps: [
      `- image: ${ollama}`,
      `image: ${busybox}`,
      `image: ${EXPECTED_CURL_IMAGE}`,
      `image: ${EXPECTED_AWS_CLI_IMAGE}`,
      `image: ${EXPECTED_ALPINE_OPENSSL_IMAGE}`,
      ...[...ALLOWED_ZERO_DIGEST_IMAGES].map((ref) => `image: ${ref}`),
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
    `  - image: ${ollama}`,
    '  imagePullPolicy: IfNotPresent',
  ].join('\n'));

  assert.deepEqual(
    refs.map(({ key, ref }) => ({ key, ref })),
    [
      { key: 'image', ref: minio },
      { key: 'imageName', ref: EXPECTED_PG_IMAGE },
      { key: 'postgresImage', ref: EXPECTED_PG_IMAGE },
      { key: 'image', ref: ollama },
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
  assert.match(workflow, /quick_infra:[\s\S]*uses: \.\/\.github\/workflows\/_reusable-kubernetes-manifests\.yml/);
  assert.match(workflow, /full_infra:[\s\S]*uses: \.\/\.github\/workflows\/_reusable-kubernetes-manifests\.yml/);
});

test('accepts only digest-pinned images and the three documented zero-digest repositories', () => {
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
