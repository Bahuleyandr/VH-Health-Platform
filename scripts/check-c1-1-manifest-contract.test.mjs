import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ALLOWED_ZERO_DIGEST_IMAGES,
  ENVIRONMENT_DATABASE_CONTRACT,
  EXPECTED_ACTIVE_PG_IMAGE,
  EXPECTED_ALPINE_OPENSSL_IMAGE,
  EXPECTED_AWS_CLI_IMAGE,
  EXPECTED_CURL_IMAGE,
  EXPECTED_PG_IMAGE,
  HELD_OLLAMA_IMAGE,
  NON_PROD_ACTIVE_PG_IMAGE,
  PG17_ARCHIVE_IDENTITY,
  PG18_ARCHIVE_IDENTITY,
  archiveIdentityGeneration,
  assertCutoverPatchIsNonVacuous,
  assertDatabaseGenerationContract,
  assertDatabaseGenerationPairing,
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

// ── Audit 2026-08-13 (P1) follow-up: archive identity is fail-CLOSED ────────
// The first fix left the gate asserting the literal post-cutover
// `serverName: vhhealth-pg18` while the image was pinned to PostgreSQL 17. That
// red-lined an operator who wrote the correct live PostgreSQL 17 identity and
// green-lit the contaminating one, and it made the held cutover patch's `test`
// operation pass vacuously. The invariant is now the PAIR.

test('image generation and archive identity are one decision, not two', () => {
  assert.equal(archiveIdentityGeneration(PG17_ARCHIVE_IDENTITY), 17);
  assert.equal(archiveIdentityGeneration('vhhealth-pg-staging'), 17);
  assert.equal(archiveIdentityGeneration('vhhealth-pg-dev'), 17);
  assert.equal(archiveIdentityGeneration(PG18_ARCHIVE_IDENTITY), 18);
  assert.equal(archiveIdentityGeneration('vhhealth-pg18-rehearsal-run-7'), 18);

  // Matched pairs are accepted, in both generations.
  for (const [imageName, serverName] of [
    [EXPECTED_ACTIVE_PG_IMAGE, PG17_ARCHIVE_IDENTITY],
    [NON_PROD_ACTIVE_PG_IMAGE, 'vhhealth-pg-staging'],
    [EXPECTED_PG_IMAGE, PG18_ARCHIVE_IDENTITY],
  ]) {
    assert.doesNotThrow(() =>
      assertDatabaseGenerationPairing({ label: 'fixture', imageName, serverName }));
  }

  // THE negative case: a PostgreSQL 18 archive identity paired with the
  // PostgreSQL 17 image pin. This is what the previous gate REQUIRED.
  assert.throws(
    () =>
      assertDatabaseGenerationPairing({
        label: 'fixture',
        imageName: EXPECTED_ACTIVE_PG_IMAGE,
        serverName: PG18_ARCHIVE_IDENTITY,
      }),
    /pairs a PostgreSQL 17 image with a PostgreSQL 18 archive identity/,
  );
  // And the mirror: moving the image without the identity.
  assert.throws(
    () =>
      assertDatabaseGenerationPairing({
        label: 'fixture',
        imageName: EXPECTED_PG_IMAGE,
        serverName: PG17_ARCHIVE_IDENTITY,
      }),
    /pairs a PostgreSQL 18 image with a PostgreSQL 17 archive identity/,
  );
  assert.throws(
    () =>
      assertDatabaseGenerationPairing({
        label: 'fixture',
        imageName: 'ghcr.io/cloudnative-pg/postgresql:19.0-standard-bookworm@sha256:abc',
        serverName: PG17_ARCHIVE_IDENTITY,
      }),
    /unrecognised PostgreSQL image/,
  );
});

let renderedRoots;
function docsByRoot() {
  renderedRoots ||= runManifestContract().docsByRoot;
  return renderedRoots;
}

function withMutatedDoc(root, kind, name, replacer) {
  const original = docsByRoot();
  const clone = new Map(original);
  const docs = original.get(root);
  assert.ok(docs, `${root} was not rendered`);
  clone.set(
    root,
    docs.map((doc) =>
      doc.kind === kind && doc.name === name ? { ...doc, raw: replacer(doc.raw) } : doc,
    ),
  );
  return clone;
}

test('the contract rejects a PG18 archive identity on the PG17-pinned production cluster', () => {
  assert.doesNotThrow(() => assertDatabaseGenerationContract(docsByRoot()));

  const contaminating = withMutatedDoc(
    'infra/kubernetes/overlays/prod',
    'Cluster',
    'vhhealth-pg',
    (raw) => raw.replace(/serverName: vhhealth-pg$/m, `serverName: ${PG18_ARCHIVE_IDENTITY}`),
  );
  assert.throws(
    () => assertDatabaseGenerationContract(contaminating),
    /must render the archive identity vhhealth-pg; got vhhealth-pg18/,
  );

  // Same rejection through the generation invariant itself, with the
  // environment's expected literal removed from the picture: an operator who
  // also "fixes" the expected value in the contract still cannot get a
  // PostgreSQL 18 identity past a PostgreSQL 17 image.
  assert.throws(
    () =>
      assertDatabaseGenerationPairing({
        label: 'infra/kubernetes/overlays/prod Cluster/vhhealth-pg',
        imageName: EXPECTED_ACTIVE_PG_IMAGE,
        serverName: PG18_ARCHIVE_IDENTITY,
      }),
    /MOVE TOGETHER/,
  );
});

test('the contract rejects a database image moving generation without its identity', () => {
  const converted = withMutatedDoc(
    'infra/kubernetes/overlays/prod',
    'Cluster',
    'vhhealth-pg',
    (raw) => raw.replace(`imageName: ${EXPECTED_ACTIVE_PG_IMAGE}`, `imageName: ${EXPECTED_PG_IMAGE}`),
  );
  assert.throws(
    () => assertDatabaseGenerationContract(converted),
    /must render imageName ghcr\.io\/cloudnative-pg\/postgresql:17\.10/,
  );
});

test('the daily verifier must read the archive its own cluster writes', () => {
  const drifted = withMutatedDoc(
    'infra/kubernetes/overlays/prod',
    'CronJob',
    'cnpg-backup-verify',
    (raw) => raw.replace(/(BARMAN_SERVER_NAME\s*\n\s*value:\s*).*/m, `$1${PG18_ARCHIVE_IDENTITY}`),
  );
  assert.throws(
    () => assertDatabaseGenerationContract(drifted),
    /verifies archive identity vhhealth-pg18 while Cluster\/vhhealth-pg writes vhhealth-pg/,
  );
});

// Blast radius the first fix did not disclose: the hold went into base/, so the
// all-zero unpullable digest landed in dev and staging too, and no gate rendered
// those overlays. Both are now covered.
test('non-production overlays keep a real, pullable database and their own archive', () => {
  const nonProduction = ENVIRONMENT_DATABASE_CONTRACT.filter(({ production }) => !production);
  assert.deepEqual(
    nonProduction.map(({ root }) => root),
    ['infra/kubernetes/overlays/staging', 'infra/kubernetes/overlays/dev'],
  );

  for (const { root, archiveIdentity, imageName } of nonProduction) {
    // The contract table itself may never carry the production-only hold.
    assert.doesNotMatch(imageName, /@sha256:0{64}$/);
    assert.equal(imageName, NON_PROD_ACTIVE_PG_IMAGE);

    const docs = docsByRoot().get(root);
    const cluster = docs.find((doc) => doc.kind === 'Cluster' && doc.name === 'vhhealth-pg');
    assert.ok(cluster, `${root} renders no Cluster/vhhealth-pg`);
    assert.ok(cluster.raw.includes(`imageName: ${NON_PROD_ACTIVE_PG_IMAGE}`));
    assert.doesNotMatch(cluster.raw, /imageName:.*@sha256:0{64}/);
    assert.match(cluster.raw, new RegExp(`serverName: ${archiveIdentity}$`, 'm'));

    // Inheriting the production hold: renders fine, brings up no database.
    const unpullable = withMutatedDoc(root, 'Cluster', 'vhhealth-pg', (raw) =>
      raw.replace(`imageName: ${NON_PROD_ACTIVE_PG_IMAGE}`, `imageName: ${EXPECTED_ACTIVE_PG_IMAGE}`));
    assert.throws(
      () => assertDatabaseGenerationContract(unpullable),
      /must render imageName ghcr\.io\/cloudnative-pg\/postgresql:17\.10-standard-bookworm@sha256:f94c0eea/,
    );

    // Adopting a production archive identity would put non-production WAL into
    // the production archive prefix — both are rejected.
    for (const productionIdentity of [PG17_ARCHIVE_IDENTITY, PG18_ARCHIVE_IDENTITY]) {
      const stolen = withMutatedDoc(root, 'Cluster', 'vhhealth-pg', (raw) =>
        raw.replace(
          new RegExp(`serverName: ${archiveIdentity}$`, 'm'),
          `serverName: ${productionIdentity}`,
        ));
      assert.throws(
        () => assertDatabaseGenerationContract(stolen),
        /must render the archive identity vhhealth-pg-(staging|dev)/,
      );
    }
  }
});

test('the held cutover patch cannot pass its own test operation vacuously', () => {
  assert.doesNotThrow(() => assertCutoverPatchIsNonVacuous());

  const cutover = readFileSync(
    new URL('../infra/kubernetes/held/c1-1-pg18-cutover/pg18-cutover-target.yaml', import.meta.url),
    'utf8',
  );
  // Source and target identities must differ, or there is no archive
  // separation and the `test` op cannot distinguish pre- from post-cutover.
  assert.ok(cutover.includes(`sourceArchiveIdentity: "${PG17_ARCHIVE_IDENTITY}"`));
  assert.ok(cutover.includes(`targetArchiveIdentity: "${PG18_ARCHIVE_IDENTITY}"`));
  assert.notEqual(PG17_ARCHIVE_IDENTITY, PG18_ARCHIVE_IDENTITY);
  // And the patch refuses outright if the operator supplies the post-cutover
  // identity as the live one.
  assert.ok(cutover.includes('if [ "${LIVE_PG17_ARCHIVE_IDENTITY}" = "vhhealth-pg18" ]; then'));
  assert.match(cutover, /REFUSING: the live archive identity is already the PostgreSQL 18 identity/);
});
