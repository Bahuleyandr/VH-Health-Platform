#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
}

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\r\n/g, '\n');
}

function render(path) {
  if (process.env.KUSTOMIZE_BIN) {
    return run(process.env.KUSTOMIZE_BIN, ['build', path]);
  }
  try {
    return run('kustomize', ['build', path]);
  } catch {
    return run('kubectl', ['kustomize', path]);
  }
}

function walk(root) {
  const result = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}

const basePath = 'infra/kubernetes/base/cnpg';
const heldPath = 'infra/kubernetes/held/c6-2-warm-standby';
const objectStore = read(`${basePath}/barman-cloud-object-store.yaml`);
const writer = read(
  `${basePath}/cnpg-backup-producer-credentials.sealed-secret.yaml.example`,
);
const reader = read(
  `${basePath}/cnpg-dr-reader-credentials.sealed-secret.yaml.example`,
);
const remover = read(`${basePath}/c6-2-retention-removal.yaml`);
const removerScript = read(`${basePath}/c6-2-retention-removal.sh`);
const restore = read(`${basePath}/scheduled-restore-proof.yaml`);
const restoreScript = read(`${basePath}/scheduled-restore-proof.sh`);
const rehearsal = read(`${basePath}/pg18-upgrade-rehearsal.yaml`);
const alerts = read('infra/kubernetes/base/monitoring/alert-rules.yaml');
const delta = read('docs/continuity/c6-2-backup-dr-design-delta.md');
const restoreEvidence = read(
  'docs/qa-findings/c6-2-restore-evidence-template.md',
);
const promotionEvidence = read(
  'docs/qa-findings/cross-site-dr-promotion-template.md',
);
const warmRunbook = read(
  'docs/runbooks/C6_2_WARM_STANDBY_PROMOTION_FAILBACK.md',
);

assert.doesNotMatch(objectStore, /^\s*retentionPolicy:/m);
assert.match(objectStore, /database-retention-boundary: "30d"/);
assert.match(objectStore, /sessionToken:/);
assert.match(writer, /ACCESS_SESSION_TOKEN:/);
assert.match(writer, /omit DeleteObject and DeleteObjects/);
assert.match(reader, /ACCESS_SESSION_TOKEN:/);
assert.match(reader, /list\/head\/get only/);

assert.match(remover, /name: cnpg-retention-removal/);
assert.match(remover, /suspend: true/);
assert.match(remover, /EXECUTE_RETENTION_REMOVAL[\s\S]*value: "false"/);
assert.match(remover, /cnpg-retention-remover-credentials/);
assert.match(removerScript, /legal-hold-state/);
assert.match(removerScript, /replacement-backup-id/);
assert.match(removerScript, /etag_changed_since_approval/);
assert.match(removerScript, /object_inside_database_retention_boundary/);
assert.match(removerScript, /s3api delete-object/);
assert.doesNotMatch(removerScript, /delete-objects/);
assert.match(removerScript, /wildcard_key_forbidden/);

assert.match(restore, /schedule: "0 3 1 \*\/3 \*"/);
assert.match(restore, /suspend: true/);
assert.match(restore, /OWNER_INPUT_RFC3339/);
assert.match(restore, /cnpg-restore-evidence-writer-credentials/);
assert.match(restore, /cnpg-restore-evidence-reader-credentials/);
assert.match(restoreScript, /recoveryTarget/);
assert.match(restoreScript, /backup_verify=passed/);
assert.match(restoreScript, /clinical_timeline_events/);
assert.match(restoreScript, /clinical_audit_events/);
assert.match(restoreScript, /APPLICATION_READ_URL/);
assert.match(restoreScript, /restore_only_decision_authority=C-D1/);
assert.match(restoreScript, /warm_standby_measurement=NOT_RUN_PHASE_2/);
assert.match(restoreScript, /warm_standby_decision_authority=C-D9/);

assert.match(rehearsal, /Disposable synthetic rehearsal only/);
assert.match(rehearsal, /retentionPolicy: "7d"/);

for (const alert of [
  'C6BackupLockNotEffective',
  'C6RestoreProofFailed',
  'C6RetentionRemovalUnexpectedlyEnabled',
  'C6RetentionRemovalFailed',
]) {
  const block = alerts.slice(alerts.indexOf(`alert: ${alert}`));
  assert.ok(block.startsWith(`alert: ${alert}`));
  assert.match(block.slice(0, block.indexOf('        - alert:', 1) || undefined), /team: backup/);
}
assert.match(
  alerts.slice(alerts.indexOf('alert: C6WarmStandbyReplicationLagHigh')),
  /team: database/,
);
assert.doesNotMatch(alerts, /kind:\s*(?:Alertmanager|AlertmanagerConfig)/);
assert.doesNotMatch(alerts, /^\s*receivers?:/m);

for (const evidence of [restoreEvidence, promotionEvidence]) {
  assert.match(evidence, /Immutable-backup restore-only/);
  assert.match(evidence, /Warm-standby/);
  assert.match(evidence, /C-D1/);
  assert.match(evidence, /C-D9/);
}
assert.match(restoreEvidence, /NOT_RUN_PHASE_2/);
assert.match(delta, /12 hours does not mean C-D9/);

for (const source of [delta, warmRunbook, promotionEvidence]) {
  assert.match(source, /access-revision/i);
  assert.match(source, /last valid/i);
  assert.match(source, /signed expiry/i);
  assert.match(source, /reset/i);
}

const baseRender = render(basePath);
const heldRender = render(heldPath);
assert.match(baseRender, /name: cnpg-scheduled-restore-proof/);
assert.match(baseRender, /name: cnpg-retention-removal/);
assert.equal(
  (baseRender.match(/suspend: true/g) ?? []).length >= 2,
  true,
  'restore and removal CronJobs must both render suspended',
);
assert.match(heldRender, /name: vhhealth-pg-dr-held/);
assert.match(heldRender, /OWNER_INPUT/);
assert.match(heldRender, /192\.0\.2\.10\/32/);
assert.doesNotMatch(heldRender, /kind:\s*Application\s*$/m);

const productionKustomizations = walk(
  resolve(repoRoot, 'infra/kubernetes'),
)
  .filter(
    (path) =>
      /kustomization\.ya?ml$/i.test(path) &&
      !path.includes(resolve(repoRoot, heldPath)),
  )
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
assert.doesNotMatch(productionKustomizations, /c6-2-warm-standby/);

const argoFiles = walk(resolve(repoRoot, 'infra/kubernetes'))
  .filter((path) => /\.ya?ml$/i.test(path))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
assert.doesNotMatch(argoFiles, /automated:\s*\n\s*prune:/);

const heldFiles = walk(resolve(repoRoot, heldPath))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const allowedHeldAddresses = new Set([
  '192.0.2.10/32',
  '0.0.0.0/0',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '127.0.0.0/8',
]);
for (const address of heldFiles.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d+)?\b/g) ?? []) {
  assert.ok(
    allowedHeldAddresses.has(address),
    `held template contains non-sentinel address ${address}`,
  );
}
assert.doesNotMatch(
  heldFiles,
  /(?:AKIA|AIza|ghp_|github_pat_|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/,
);

console.log(
  'C6.2 contract passed: Phase 1 is suspended, Phase 2 is held, objectives are separate, and C1.3 routing is reused.',
);
