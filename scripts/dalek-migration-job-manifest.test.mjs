// Dalekdefender migration Job — manifest contract.
//
// The rig runs no ArgoCD, so the production PreSync ordering guarantee
// (infra/kubernetes/apps/backend/migration-job.yaml) is reproduced by the
// root-owned deploy helper: it renders the Job with the digest it is about to
// pin, waits for it, and only then sets the Deployment images.
//
// That helper runs as root from /usr/local/sbin, where the host's git checkout
// is neither a trusted nor a reliably current input, so it EMBEDS the manifest
// instead of reading it. Two copies of anything drift; this suite is what stops
// them. It also pins the properties that make the step safe to run on every
// deploy: tracker-driven, seedless, and unable to mask the image's Prisma
// client with a volume.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = relative => readFileSync(path.join(repoRoot, relative), 'utf8');

const OVERLAY = 'infra/kubernetes/overlays/dalekdefender';
const MANIFEST_PATH = `${OVERLAY}/migration-job.yaml`;
const HELPER_PATH = `${OVERLAY}/vhhealth-gha-deploy.sh`;
const KUSTOMIZATION_PATH = `${OVERLAY}/kustomization.yaml`;
const HEREDOC_TAG = 'MIGRATION_JOB_MANIFEST';

/** The exact bytes the helper emits from its embedded heredoc. */
function embeddedManifest(helper) {
  const opener = `  cat <<'${HEREDOC_TAG}'\n`;
  const start = helper.indexOf(opener);
  assert.notEqual(
    start, -1,
    `${HELPER_PATH} no longer embeds the migration Job manifest in a quoted heredoc`,
  );
  const bodyStart = start + opener.length;
  const terminator = `\n${HEREDOC_TAG}\n`;
  const end = helper.indexOf(terminator, bodyStart);
  assert.notEqual(end, -1, `${HELPER_PATH} heredoc is not terminated`);
  // The heredoc body is every byte up to and including the newline that
  // precedes the terminator line — exactly what `cat` writes to stdout.
  return helper.slice(bodyStart, end + 1);
}

test('the helper embeds the overlay migration Job manifest byte-for-byte', () => {
  const embedded = embeddedManifest(readRepo(HELPER_PATH));
  const onDisk = readRepo(MANIFEST_PATH);

  assert.ok(onDisk.length > 0, `${MANIFEST_PATH} is empty`);
  assert.equal(
    embedded, onDisk,
    `${HELPER_PATH}'s embedded manifest has drifted from ${MANIFEST_PATH}. `
    + 'Re-embed the file verbatim: the helper cannot read the host checkout, so this '
    + 'copy is what actually runs on the rig.',
  );
});

test('the Job is not a static kustomize resource (its image is a placeholder)', () => {
  const kustomization = readRepo(KUSTOMIZATION_PATH);
  const manifest = readRepo(MANIFEST_PATH);

  // The manifest ships an unpullable placeholder that the helper substitutes.
  // Listing it under `resources:` would make `kubectl apply -k` create a Job
  // that can never pull.
  assert.match(manifest, /^\s+image: ghcr\.io\/bahuleyandr\/vh-health-platform-backend:0\.0\.0-placeholder$/m);
  assert.doesNotMatch(
    kustomization, /^\s*-\s*migration-job\.yaml\s*$/m,
    'migration-job.yaml must not be a kustomize resource — its image is a placeholder the deploy helper substitutes',
  );
  assert.match(
    kustomization, /migration-job\.yaml/,
    'kustomization.yaml should say why migration-job.yaml is deliberately absent from resources',
  );
});

test('the migration Job is tracker-driven, seedless, and cannot mask the Prisma client', () => {
  const manifest = readRepo(MANIFEST_PATH);

  assert.match(manifest, /node scripts\/ci-setup-db\.mjs --skip-seeds/);
  assert.match(manifest, /name: CI_DB_SKIP_SEEDS\n\s+value: "1"/);
  // Seeding is what makes a migration step unsafe to run against a populated
  // environment; ci-setup-db's seed helpers must never be reached here.
  assert.doesNotMatch(manifest, /seed-|--seeds\b|seedDepartments|seed:/);

  // The rig's single DSN is already the owner/superuser connection, and it has
  // no vhhealth_runtime login role — the exact configuration the production
  // Job's comment blesses this knob for.
  assert.match(manifest, /name: RUNTIME_ROLE_GRANTS_OPTIONAL\n\s+value: "true"/);
  assert.match(manifest, /secretRef:\n\s+name: vhhealth-backend/);

  assert.match(manifest, /imagePullPolicy: IfNotPresent/);
  assert.match(manifest, /imagePullSecrets:\n\s+- name: ghcr-read/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
  assert.match(manifest, /activeDeadlineSeconds: \d+/);

  // A mount over a baked-in path REPLACES it. /app/node_modules/.prisma made
  // five workloads unbootable exactly this way.
  const mountPaths = [...manifest.matchAll(/mountPath: (\S+)/g)].map(match => match[1]);
  assert.ok(mountPaths.length > 0, 'expected the migrate container to declare volumeMounts');
  for (const mountPath of mountPaths) {
    assert.ok(
      !mountPath.startsWith('/app/node_modules'),
      `volumeMount at ${mountPath} would replace image content under /app/node_modules`,
    );
  }
});

test('a failed migration leaves a pod whose logs the helper can actually read', () => {
  const manifest = readRepo(MANIFEST_PATH);
  const helper = readRepo(HELPER_PATH);

  // Observed on the rig 2026-09-01: with restartPolicy OnFailure the job
  // controller deletes the pod the instant it exceeds the backoff limit, so
  // the helper's diagnostics ran against zero pods and the operator got a
  // failed deploy with NO migration output — no file name, no Postgres error.
  // Never keeps each failed attempt's pod, which is the whole diagnosis path.
  assert.match(manifest, /^\s+restartPolicy: Never$/m);
  assert.doesNotMatch(manifest, /restartPolicy: OnFailure/);

  // And the diagnostics must select on the controller-set job-name label,
  // which is guaranteed to match this Job's pods.
  assert.match(helper, /batch\.kubernetes\.io\/job-name=\$\{MIGRATE_JOB\}/);
  assert.match(helper, /logs "\$pod" -c migrate/);
});

test('the helper migrates before it pins images, and never rolls back over a migration', () => {
  const helper = readRepo(HELPER_PATH);

  const migrateCall = helper.indexOf('if ! run_migrations "$BACKEND_REF"');
  const applyCall = helper.indexOf('apply_refs "$BACKEND_REF" "$ADMIN_REF" "$GIT_COMMIT"');
  assert.notEqual(migrateCall, -1, 'the helper must run migrations on the deploy path');
  assert.notEqual(applyCall, -1, 'the helper must still pin the deployment images');
  assert.ok(
    migrateCall < applyCall,
    'migrations must run BEFORE the images are pinned — the API workers fail closed on '
    + 'MIGRATION_TIP_MISMATCH, so rolling first is a guaranteed CrashLoopBackOff',
  );

  // Fail closed on an unknown outcome: only a parsed "0 applied" re-enables the
  // automatic image rollback.
  assert.match(helper, /^MIGRATIONS_APPLIED="unknown"$/m);
  assert.match(helper, /if \[\[ "\$MIGRATIONS_APPLIED" != "0" \]\]; then/);

  const rollbackGuard = helper.indexOf('if [[ "$MIGRATIONS_APPLIED" != "0" ]]; then');
  const rollbackApply = helper.indexOf('apply_refs "$PREV_BACKEND_REF" "$PREV_ADMIN_REF" "$PREV_COMMIT"');
  assert.notEqual(rollbackApply, -1, 'the helper must still have a rollback path');
  assert.ok(
    rollbackGuard < rollbackApply,
    'the migration gate must sit ahead of the rollback — restoring an older image against a '
    + 'database that has moved on replaces a broken pod with one that cannot boot at all',
  );
});

test('the helper reads its applied-count from the summary ci-setup-db actually prints', () => {
  const helper = readRepo(HELPER_PATH);
  const ciSetupDb = readRepo('apps/backend/scripts/ci-setup-db.mjs');

  // The helper greps the migration Job's log for this line. Pin both sides:
  // a reworded summary would silently turn every deploy into "unknown", which
  // fails safe but permanently disables the automatic rollback.
  assert.match(helper, /Migrations: \\\(\[0-9\]\[0-9\]\*\\\) applied/);
  assert.match(ciSetupDb, /→ Migrations: \$\{appliedCount\} applied,/);
});
