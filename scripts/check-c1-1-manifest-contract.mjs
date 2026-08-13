#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNoIngressClassParameters } from './validate-kubernetes-manifests.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PLATFORM_TARGET = 'infra/kubernetes/overlays/prod';
export const APPS_TARGET = 'infra/kubernetes/apps';
export const EXPECTED_R2_ENDPOINT =
  'https://dbe488236c64499a3dfc797a750c912d.r2.cloudflarestorage.com';
export const EXPECTED_R2_ACCOUNT_ID = 'dbe488236c64499a3dfc797a750c912d';
export const EXPECTED_CNPG_VERSION = '1.30.0';
export const EXPECTED_PLUGIN_VERSION = '0.13.0';
export const EXPECTED_PLUGIN_NAME = 'barman-cloud.cloudnative-pg.io';
export const EXPECTED_PG_IMAGE =
  'ghcr.io/cloudnative-pg/postgresql:18.4-standard-bookworm@sha256:0ec6b32ab5b644aa51da58443c5ac2c1724d97de0d2a88961920d437b71b9ad8';
export const EXPECTED_CNPG_OPERATOR_IMAGE =
  'ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0@sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb';
export const EXPECTED_PLUGIN_MANAGER_IMAGE =
  'ghcr.io/cloudnative-pg/plugin-barman-cloud:v0.13.0@sha256:71589dbac582333442812b07b31f7ea4d00324a8358aac7ca507dabf9f4b6c96';
export const EXPECTED_PLUGIN_SIDECAR_IMAGE =
  'ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.13.0@sha256:990361af3319f9e23aafa0f6d7981f99bf1f69b4e6a85cf1bc7d71d6f09bb288';
export const EXPECTED_CURL_IMAGE =
  'docker.io/curlimages/curl:8.11.1@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69';
export const EXPECTED_AWS_CLI_IMAGE =
  'docker.io/amazon/aws-cli:2.34.53@sha256:cf53765c0de54ad3a8ea21818f1c4c845a8cf7ca87831c078a00fef244031493';
export const EXPECTED_ALPINE_OPENSSL_IMAGE =
  'docker.io/alpine/openssl:3.5.7@sha256:045a40a53b8e283cff95052e0c39f256b7467d48c7445260d4f180fc0e767999';

// The generation the LIVE cluster is declared to run (docs/DEPLOYMENT_GUIDE.md
// §6, docs/PRODUCTION_DB_HARDENING.md, docs/GO_LIVE_ACTIVATION_CHECKLIST.md A4).
// The exact secure PG17 minor and its digest are operator evidence this
// repository does not hold — docs/CNPG_POSTGRES_18_QUALIFICATION.md §1 requires
// the operator to capture the digest off the running cluster — so the digest is
// the documented all-zero FAIL-CLOSED placeholder. Audit 2026-08-13, P1: before
// this, the production Cluster carried EXPECTED_PG_IMAGE, so one ordinary sync
// of the platform Application would have run a declarative offline pg_upgrade
// on the live clinical database.
export const EXPECTED_ACTIVE_PG_IMAGE = `ghcr.io/cloudnative-pg/postgresql:17.10-standard-bookworm@sha256:${'0'.repeat(64)}`;

// Pending-GPU clinical-AI deep tier. Held, composed by nothing.
export const HELD_OLLAMA_IMAGE =
  'docker.io/ollama/ollama:0.5.4@sha256:18bfb1d605604fd53dcad20d0556df4c781e560ebebcd923454d627c994a0e37';

export const PG18_CUTOVER_HELD_SOURCE =
  'infra/kubernetes/held/c1-1-pg18-cutover/pg18-cutover-target.yaml';
export const DEEP_TIER_HELD_SOURCES = [
  'infra/kubernetes/held/clinical-ai-deep-tier/kustomization.yaml',
  'infra/kubernetes/held/clinical-ai-deep-tier/statefulset.yaml',
  'infra/kubernetes/held/clinical-ai-deep-tier/deep-tier-preflight-job.yaml',
];

export const ALLOWED_ZERO_DIGEST_IMAGES = new Set([
  `ghcr.io/bahuleyandr/vh-health-platform-backend@sha256:${'0'.repeat(64)}`,
  `ghcr.io/bahuleyandr/vh-health-platform-adminportal@sha256:${'0'.repeat(64)}`,
  `ghcr.io/bahuleyandr/vhhealth-staff-web@sha256:${'0'.repeat(64)}`,
  EXPECTED_ACTIVE_PG_IMAGE,
]);

const expectedRenderedPins = [
  EXPECTED_ACTIVE_PG_IMAGE,
  'quay.io/minio/minio:RELEASE.2024-11-07T00-52-20Z@sha256:ac591851803a79aee64bc37f66d77c56b0a4b6e12d9e5356380f4105510f2332',
  EXPECTED_CURL_IMAGE,
  EXPECTED_AWS_CLI_IMAGE,
  EXPECTED_ALPINE_OPENSSL_IMAGE,
];

// Images that must NEVER appear as a rendered workload image field in either
// active production root. Each names a capability that is deliberately held
// outside the active graph; a reappearance here is an unreviewed activation.
const forbiddenActiveWorkloadImages = [
  {
    ref: EXPECTED_PG_IMAGE,
    why:
      'PostgreSQL 18.4 is the HELD cutover target; the active graph must stay on its ' +
      `declared PostgreSQL 17 generation (see ${PG18_CUTOVER_HELD_SOURCE})`,
  },
  {
    ref: HELD_OLLAMA_IMAGE,
    why:
      'the pending-GPU clinical-AI deep tier is HELD at ' +
      'infra/kubernetes/held/clinical-ai-deep-tier/ and must not be composed',
  },
];

const pgImageSourceFiles = [
  PG18_CUTOVER_HELD_SOURCE,
  'infra/kubernetes/base/cnpg/operator.yaml',
  'infra/kubernetes/base/cnpg/dr-restore-drill.yaml',
  'infra/kubernetes/base/cnpg/pg18-upgrade-rehearsal.yaml',
];

const backendProducerName = 'vhhealth-backend-r2-sync';
const backendVerifierName = 'backup-verification';
const cnpgVerifierName = 'cnpg-backup-verify';

function fail(message) {
  throw new Error(`[c1.1-contract] ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function requireText(text, pattern, message) {
  requireCondition(pattern.test(text), message);
}

function rejectText(text, pattern, message) {
  requireCondition(!pattern.test(text), message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function candidateNames(name) {
  return process.platform === 'win32' ? [name, `${name}.exe`] : [name];
}

function findBinary(name, envName) {
  const explicit = process.env[envName];
  if (explicit && existsSync(explicit)) return explicit;

  const localToolDir = process.platform === 'win32' ? 'D:\\Dev\\Tools\\kubetools' : '';
  const pathDirs = [
    ...String(process.env.PATH || '').split(delimiter),
    ...(localToolDir ? [localToolDir] : []),
  ];

  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const candidate of candidateNames(name)) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }

  fail(`${name} was not found. Install it on PATH or set ${envName}.`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : '.'}`);
  }
  return result.stdout;
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, '');
}

function metadataField(raw, field) {
  const lines = raw.split(/\r?\n/);
  const metadataIndex = lines.findIndex((line) => /^metadata:\s*$/.test(line));
  if (metadataIndex === -1) return null;
  for (let i = metadataIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() && !/^\s/.test(lines[i])) break;
    const match = lines[i].match(new RegExp(`^  ${field}:\\s*(.+?)\\s*$`));
    if (match) return unquote(match[1]);
  }
  return null;
}

export function parseRenderedDocuments(rendered, target = 'render') {
  return rendered
    .split(/^---\s*$/m)
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => ({
      target,
      raw,
      apiVersion: raw.match(/^apiVersion:\s*(\S+)\s*$/m)?.[1] || null,
      kind: raw.match(/^kind:\s*(\S+)\s*$/m)?.[1] || null,
      name: metadataField(raw, 'name'),
      namespace: metadataField(raw, 'namespace'),
    }));
}

function resource(docs, kind, name) {
  const matches = docs.filter((doc) => doc.kind === kind && doc.name === name);
  requireCondition(matches.length === 1, `expected one ${kind}/${name}; found ${matches.length}`);
  return matches[0];
}

function resourcesOfKind(docs, apiVersion, kind) {
  return docs.filter((doc) => doc.apiVersion === apiVersion && doc.kind === kind);
}

function topLevelSection(source, key, label) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimEnd() === `${key}:`);
  requireCondition(start >= 0, `${label} lacks a top-level ${key} section`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z][A-Za-z0-9_-]*:\s*(?:#.*)?$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function requireReplacementSource(section, { name, namespace, fieldPath }, label) {
  const sourceBlock = section.split(/^    targets:\s*$/m, 1)[0];
  requireText(
    sourceBlock,
    new RegExp(`^      name:\\s*${escapeRegExp(name)}\\s*$`, 'm'),
    `${label} has the wrong source`,
  );
  if (namespace) {
    requireText(
      sourceBlock,
      new RegExp(`^      namespace:\\s*${escapeRegExp(namespace)}\\s*$`, 'm'),
      `${label} has the wrong source namespace`,
    );
  }
  requireText(
    sourceBlock,
    new RegExp(`^      fieldPath:\\s*${escapeRegExp(fieldPath)}\\s*$`, 'm'),
    `${label} has the wrong source field`,
  );
}

function requireReplacementTarget(section, { name, fieldPath }, label) {
  const target = section
    .split(/(?=^      - select:\s*$)/m)
    .find(
      (block) =>
        new RegExp(`^          name:\\s*${escapeRegExp(name)}\\s*$`, 'm').test(block) &&
        new RegExp(`^          - ${escapeRegExp(fieldPath)}\\s*$`, 'm').test(block),
    );
  requireCondition(target, `${label} does not natively replace ${name} at ${fieldPath}`);
}

function isExecutableBlockHeader(lines, index, indent) {
  const trimmed = lines[index].trim();
  if (/^[^:]+\.(?:sh|bash):\s*[|>][0-9+-]*$/.test(trimmed)) return true;
  if (/^(?:args|command|script):\s*[|>][0-9+-]*$/.test(trimmed)) return true;
  if (!/^-\s*[|>][0-9+-]*$/.test(trimmed)) return false;

  for (let i = index - 1; i >= 0; i -= 1) {
    if (!lines[i].trim()) continue;
    const parentIndent = lines[i].match(/^\s*/)[0].length;
    if (parentIndent > indent) continue;
    const trimmedParent = lines[i].trim();
    if (/^(?:-\s*)?(?:args|command):\s*$/.test(trimmedParent)) return true;
    if (parentIndent === indent && /^-\s+/.test(trimmedParent)) continue;
    if (parentIndent < indent) return false;
  }
  return false;
}

function executableBlockScalarLineNumbers(text) {
  const lines = text.split(/\r?\n/);
  const blockLines = new Set();
  let parentIndent = null;
  let executable = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.match(/^\s*/)[0].length;

    if (parentIndent !== null) {
      if (!line.trim() || indent > parentIndent) {
        if (executable) blockLines.add(i);
        continue;
      }
      parentIndent = null;
      executable = false;
    }

    if (/^(\s*)(?:(?:-\s*)|(?:[^#][^:]*:\s*))[|>][0-9+-]*\s*$/.test(line)) {
      parentIndent = indent;
      executable = isExecutableBlockHeader(lines, i, indent);
    }
  }

  return blockLines;
}

export function findDeclarativeTemplateTokens(text) {
  const blockLines = executableBlockScalarLineNumbers(text);
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (blockLines.has(i)) continue;
    for (const match of lines[i].matchAll(/\$\{[^}\r\n]+\}/g)) {
      findings.push({ line: i + 1, token: match[0] });
    }
  }
  return findings;
}

export function extractImageRefs(text) {
  const refs = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(
      /^\s*(?:-\s*)?((?:image|imageName)|(?:[A-Za-z0-9_-]+Image)):\s*(.+?)\s*$/,
    );
    if (!match) continue;
    const value = unquote(match[2]);
    if (value) refs.push({ key: match[1], ref: value, line: index + 1 });
  }
  return refs;
}

export function assertLiteralAndImageContract(platformRender, appsRender) {
  const renders = [
    [PLATFORM_TARGET, platformRender],
    [APPS_TARGET, appsRender],
  ];

  for (const [target, rendered] of renders) {
    rejectText(rendered, /\bFILL_ME(?:_[A-Z0-9_]+)?\b/i, `${target} contains FILL_ME`);
    rejectText(
      rendered,
      /PLACEHOLDER(?:_REPLACE_WITH_KUBESEAL_CIPHERTEXT|\s+CIPHERTEXT)|vhhealth\.app\/placeholder:\s*"?true"?/i,
      `${target} contains placeholder ciphertext`,
    );

    const tokens = findDeclarativeTemplateTokens(rendered);
    requireCondition(
      tokens.length === 0,
      `${target} contains declarative template token(s): ${tokens
        .slice(0, 5)
        .map(({ line, token }) => `line ${line} ${token}`)
        .join(', ')}`,
    );
  }

  const imageRefs = renders.flatMap(([target, rendered]) =>
    extractImageRefs(rendered).map((entry) => ({ ...entry, target })),
  );
  const zeroDigestRefs = new Set();

  for (const image of imageRefs) {
    requireCondition(
      /^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image.ref),
      `${image.target}:${image.line} has a tag-only or malformed image reference: ${image.ref}`,
    );
    if (/@sha256:0{64}$/.test(image.ref)) {
      requireCondition(
        ALLOWED_ZERO_DIGEST_IMAGES.has(image.ref),
        `${image.target}:${image.line} has an unauthorized all-zero digest: ${image.ref}`,
      );
      zeroDigestRefs.add(image.ref);
    }
  }

  requireCondition(
    zeroDigestRefs.size === ALLOWED_ZERO_DIGEST_IMAGES.size &&
      [...ALLOWED_ZERO_DIGEST_IMAGES].every((ref) => zeroDigestRefs.has(ref)),
    'rendered all-zero image exceptions must be exactly the three documented app ' +
      'repositories plus the fail-closed active PostgreSQL 17 database pin',
  );

  const renderedRefSet = new Set(imageRefs.map(({ ref }) => ref));
  for (const expected of expectedRenderedPins) {
    requireCondition(renderedRefSet.has(expected), `required pinned image is absent from production renders: ${expected}`);
  }

  // Held capabilities must not reappear as rendered workload images. The
  // version markers scanned above deliberately still carry the PostgreSQL 18.4
  // provenance pin, so this check is scoped to fields that actually schedule a
  // container: `image` and `imageName`.
  for (const { ref, why } of forbiddenActiveWorkloadImages) {
    const offender = imageRefs.find(
      (entry) => entry.ref === ref && (entry.key === 'image' || entry.key === 'imageName'),
    );
    requireCondition(
      !offender,
      `${offender?.target}:${offender?.line} composes a HELD image into the active ` +
        `production graph (${ref}) — ${why}`,
    );
  }

  return imageRefs;
}

function assertVersionAndImageSources(imageRefs) {
  for (const path of pgImageSourceFiles) {
    const source = read(path);
    requireCondition(
      source.includes(EXPECTED_PG_IMAGE),
      `${path} must use the exact PostgreSQL 18.4 Bookworm image pin`,
    );
  }

  // The live cluster definition is composed into the production overlay, so it
  // must carry the declared PostgreSQL 17 generation and must not name the
  // PostgreSQL 18 target at all.
  const activeCluster = read('infra/kubernetes/base/cnpg/cluster.yaml');
  requireCondition(
    activeCluster.includes(`imageName: ${EXPECTED_ACTIVE_PG_IMAGE}`),
    'base/cnpg/cluster.yaml must pin the fail-closed active PostgreSQL 17 image ' +
      `(${EXPECTED_ACTIVE_PG_IMAGE})`,
  );
  rejectText(
    activeCluster,
    new RegExp(`^\\s*imageName:\\s*${escapeRegExp(EXPECTED_PG_IMAGE)}\\s*$`, 'm'),
    'base/cnpg/cluster.yaml pins the HELD PostgreSQL 18.4 target on the live cluster; ' +
      `the cutover belongs in ${PG18_CUTOVER_HELD_SOURCE}`,
  );

  const operator = read('infra/kubernetes/base/cnpg/operator.yaml');
  for (const required of [
    `operatorVersion: "${EXPECTED_CNPG_VERSION}"`,
    `v${EXPECTED_CNPG_VERSION}/cnpg-${EXPECTED_CNPG_VERSION}.yaml`,
    'operatorManifestSha256: "f8bede43fe4ee0d478c2355b204a36876b2ae4faac60f2a9452280b293da3b88"',
    EXPECTED_CNPG_OPERATOR_IMAGE,
    EXPECTED_PG_IMAGE,
    `barmanPluginVersion: "${EXPECTED_PLUGIN_VERSION}"`,
    `releases/download/v${EXPECTED_PLUGIN_VERSION}/manifest.yaml`,
    'barmanPluginManifestSha256: "d2e71e7b06822448f1a421f05781846cfdb9cc621e7ef32eef5e20c5133213b0"',
    EXPECTED_PLUGIN_MANAGER_IMAGE,
    EXPECTED_PLUGIN_SIDECAR_IMAGE,
    EXPECTED_PLUGIN_NAME,
  ]) {
    requireCondition(operator.includes(required), `operator marker is missing exact pin/provenance value: ${required}`);
  }

  const qualification = read('docs/CNPG_POSTGRES_18_QUALIFICATION.md');
  for (const required of [
    EXPECTED_CURL_IMAGE,
    EXPECTED_AWS_CLI_IMAGE,
    EXPECTED_ALPINE_OPENSSL_IMAGE,
    '| A | 1.31 | `1.24.1 -> 1.24.4 -> 1.25.4 -> 1.26.3 -> 1.27.4`',
    '| B | 1.31 -> 1.32 | Keep 1.27.4 installed during the Kubernetes transition',
    '| F | 1.33 -> 1.34 or newer | Keep 1.29.2 installed during the Kubernetes transition',
    '| G | 1.34 or newer | Upgrade to the final 1.30.0 pin',
    'The whole ladder must never be attempted on Kubernetes 1.34 or newer',
    '`vhhealth-pg-nightly` as an owner. This is a hard blocker',
  ]) {
    requireCondition(
      qualification.includes(required),
      `qualification document lacks required pin/ladder/retirement truth: ${required}`,
    );
  }

  const deploymentGuide = read('docs/DEPLOYMENT_GUIDE.md');
  for (const required of [
    'backups-before-owner-detach.yaml',
    'backups-after-owner-detach.yaml',
    'nightly-owned-backups.txt',
    '.kind == "ScheduledBackup" and .name == "vhhealth-pg-nightly"',
    'Abort the sync if any listed',
    'With CNPG 1.29.2 healthy, advance Kubernetes to 1.34; only then advance',
  ]) {
    requireCondition(
      deploymentGuide.includes(required),
      `deployment guide lacks required interleaved-ladder or Backup evidence blocker: ${required}`,
    );
  }

  // Two distinct roles, asserted separately so neither can drift into the other:
  //   - workload fields (`image` / `imageName`) actually schedule a database
  //     container and must be the declared, fail-closed PostgreSQL 17 pin;
  //   - the inert `postgresImage` provenance marker in the operator version
  //     ConfigMap records the qualified PostgreSQL 18.4 ladder target.
  const cnpgPostgresRefs = imageRefs.filter(({ ref }) =>
    ref.startsWith('ghcr.io/cloudnative-pg/postgresql:'),
  );
  requireCondition(cnpgPostgresRefs.length > 0, 'production render contains no CNPG PostgreSQL image');

  const workloadRefs = cnpgPostgresRefs.filter(
    ({ key }) => key === 'image' || key === 'imageName',
  );
  requireCondition(
    workloadRefs.length > 0,
    'production render schedules no CNPG PostgreSQL container',
  );
  for (const { ref, target, line } of workloadRefs) {
    requireCondition(
      ref === EXPECTED_ACTIVE_PG_IMAGE,
      `${target}:${line} runs a CNPG PostgreSQL image that is not the declared, ` +
        `fail-closed active generation: ${ref}`,
    );
  }

  const markerRefs = cnpgPostgresRefs.filter(({ key }) => key === 'postgresImage');
  requireCondition(
    markerRefs.length === 1 && markerRefs[0].ref === EXPECTED_PG_IMAGE,
    'the inert CNPG version marker must record exactly one PostgreSQL 18.4 ladder target',
  );
}

// Audit 2026-08-13 (P1): both pending capabilities must stay outside the active
// graph, be genuinely composed by nothing, and fail closed on activation.
function assertHeldActivationBoundary(appsDocs) {
  const appsBarrel = read('infra/kubernetes/apps/kustomization.yaml');
  rejectText(
    appsBarrel,
    /^\s*-\s*ollama\/?\s*$/m,
    'the app barrel composes ollama/ again; the deep tier is HELD at ' +
      'infra/kubernetes/held/clinical-ai-deep-tier/',
  );
  for (const doc of appsDocs) {
    rejectText(
      doc.raw,
      /^\s{2}name:\s*ollama(-internal)?\s*$/m,
      'the apps render contains an Ollama workload; the deep tier is HELD',
    );
  }

  const cnpgBarrel = read('infra/kubernetes/base/cnpg/kustomization.yaml');
  for (const excluded of ['dr-restore-drill.yaml', 'pg18-upgrade-rehearsal.yaml']) {
    rejectText(
      cnpgBarrel,
      new RegExp(`^\\s*-\\s*${escapeRegExp(excluded)}\\s*$`, 'm'),
      `base/cnpg/kustomization.yaml composes the operator-owned template ${excluded}`,
    );
  }

  // Each held path must exist, be self-describing, and still carry its exact pin
  // so "held" never degrades into "quietly deleted".
  const cutover = read(PG18_CUTOVER_HELD_SOURCE);
  for (const required of [EXPECTED_PG_IMAGE, 'vhhealth.app/deploy-state: "held"']) {
    requireCondition(
      cutover.includes(required),
      `${PG18_CUTOVER_HELD_SOURCE} lacks required held-cutover value: ${required}`,
    );
  }
  requireCondition(
    read('infra/kubernetes/held/c1-1-pg18-cutover/kustomization.yaml').includes(
      'vhhealth-c1-1-pg18-cutover-held',
    ),
    'the PG18 cutover kustomization lacks its -held identity',
  );

  const [deepTierBarrel, deepTierWorkload, deepTierPreflight] =
    DEEP_TIER_HELD_SOURCES.map(read);
  requireCondition(
    deepTierBarrel.includes('vhhealth-clinical-ai-deep-tier-held'),
    'the deep-tier kustomization lacks its -held identity',
  );
  requireCondition(
    deepTierWorkload.includes(HELD_OLLAMA_IMAGE),
    'the held deep tier lost its exact pinned Ollama image',
  );
  // The preflight must gate activation, not report failure after the fact.
  for (const required of [
    'argocd.argoproj.io/hook: PreSync',
    'argocd.argoproj.io/hook-delete-policy: BeforeHookCreation',
  ]) {
    requireCondition(
      deepTierPreflight.includes(required),
      `the deep-tier preflight is not a fail-closed activation hook: missing ${required}`,
    );
  }
}

function assertScheduleObjectStoreAndEndpoint(platformDocs, appsDocs) {
  const scheduledBackups = resourcesOfKind(
    platformDocs,
    'postgresql.cnpg.io/v1',
    'ScheduledBackup',
  );
  requireCondition(
    scheduledBackups.length === 1,
    `production must render exactly one ScheduledBackup; found ${scheduledBackups.length}`,
  );

  const scheduled = scheduledBackups[0];
  requireCondition(scheduled.name === 'vhhealth-pg-daily', `sole ScheduledBackup must be vhhealth-pg-daily`);
  requireText(scheduled.raw, /^\s{2}schedule:\s*["']?0 30 20 \* \* \*["']?\s*$/m, 'daily backup must run at 20:30 UTC');
  requireText(scheduled.raw, /^\s{2}target:\s*prefer-standby\s*$/m, 'daily backup must prefer a standby');
  requireText(scheduled.raw, /^\s{2}method:\s*plugin\s*$/m, 'daily backup must use method: plugin');
  rejectText(scheduled.raw, /vhhealth-pg-nightly/, 'retired nightly ScheduledBackup still renders');

  const objectStores = resourcesOfKind(platformDocs, 'barmancloud.cnpg.io/v1', 'ObjectStore');
  requireCondition(objectStores.length === 1, `production must render exactly one Barman ObjectStore`);
  const objectStore = objectStores[0];
  requireCondition(
    objectStore.name === 'vhhealth-pg18-producer',
    `Barman ObjectStore must be vhhealth-pg18-producer; got ${objectStore.name || '(missing)'}`,
  );
  requireCondition(
    objectStore.raw.includes(EXPECTED_R2_ENDPOINT),
    `ObjectStore/${objectStore.name} does not render the confirmed R2 endpoint`,
  );
  requireText(
    objectStore.raw,
    /^\s{4}destinationPath:\s*["']?s3:\/\/vhhealth-db-backups\/cluster\/["']?\s*$/m,
    `ObjectStore/${objectStore.name} must keep the distinct PG18 archive destination`,
  );
  rejectText(
    objectStore.raw,
    /^\s{2}retentionPolicy:\s*/m,
    `ObjectStore/${objectStore.name} must not give the no-delete writer Barman retention authority`,
  );
  requireText(
    objectStore.raw,
    /^\s{4}vhhealth\.app\/database-retention-boundary:\s*["']?30d["']?\s*$/m,
    `ObjectStore/${objectStore.name} must preserve the external remover's 30d eligibility boundary`,
  );
  requireText(
    objectStore.raw,
    /^\s{6}sessionToken:\s*$[\s\S]*?^\s{8}name:\s*cnpg-backup-producer-credentials\s*$/m,
    `ObjectStore/${objectStore.name} must use the qualified temporary writer credential`,
  );
  requireText(
    objectStore.raw,
    /^\s{4}wal:\s*$[\s\S]*?^\s{6}compression:\s*gzip\s*$/m,
    `ObjectStore/${objectStore.name} must gzip WAL archives`,
  );
  requireText(
    objectStore.raw,
    /^\s{4}data:\s*$[\s\S]*?^\s{6}compression:\s*gzip\s*$/m,
    `ObjectStore/${objectStore.name} must gzip base backups`,
  );
  rejectText(
    objectStore.raw,
    /^\s+encryption:\s*/m,
    `ObjectStore/${objectStore.name} must not claim unsupported R2 SSE configuration`,
  );
  requireCondition(
    objectStore.raw.includes('cnpg-backup-producer-credentials'),
    `ObjectStore/${objectStore.name} must use the CNPG producer identity`,
  );
  rejectText(
    objectStore.raw,
    /cnpg-dr-reader-credentials/,
    `ObjectStore/${objectStore.name} must not use the DR reader identity`,
  );

  const cluster = resource(platformDocs, 'Cluster', 'vhhealth-pg');
  rejectText(
    cluster.raw,
    /^\s{2}backup:\s*$/m,
    'Cluster/vhhealth-pg still has an in-tree backup block instead of plugin ownership',
  );
  requireCondition(
    cluster.raw.includes(EXPECTED_PLUGIN_NAME),
    'Cluster/vhhealth-pg does not reference the Barman plugin',
  );
  requireCondition(
    cluster.raw.includes(objectStore.name),
    `Cluster/vhhealth-pg does not reference ObjectStore/${objectStore.name}`,
  );
  requireText(cluster.raw, /^\s+serverName:\s*vhhealth-pg18\s*$/m, 'Cluster/vhhealth-pg lacks the PG18 archive identity');
  requireText(
    cluster.raw,
    /^\s+(?:-\s*)?isWALArchiver:\s*true\s*$/m,
    'Cluster/vhhealth-pg plugin must own WAL archiving',
  );
  requireCondition(
    scheduled.raw.includes(EXPECTED_PLUGIN_NAME),
    'ScheduledBackup/vhhealth-pg-daily does not reference the Barman plugin',
  );

  const platformEndpointConfig = platformDocs.find(
    (doc) =>
      doc.kind === 'ConfigMap' &&
      /^vhhealth-env(?:-[a-z0-9]+)?$/.test(doc.name || '') &&
      doc.raw.includes(EXPECTED_R2_ENDPOINT),
  );
  requireCondition(platformEndpointConfig, 'production vhhealth-env ConfigMap lacks the confirmed R2 endpoint');

  const appsEndpointConfig = appsDocs.find(
    (doc) =>
      doc.kind === 'ConfigMap' &&
      /^vhhealth-backend-config(?:-[a-z0-9]+)?$/.test(doc.name || '') &&
      doc.raw.includes(EXPECTED_R2_ENDPOINT),
  );
  requireCondition(appsEndpointConfig, 'backend ConfigMap lacks the confirmed R2 endpoint');
  requireText(
    appsEndpointConfig.raw,
    new RegExp(`^  CF_ACCOUNT_ID:\\s*${EXPECTED_R2_ACCOUNT_ID}\\s*$`, 'm'),
    'backend ConfigMap lacks the confirmed non-secret R2 account ID',
  );
  requireText(
    appsEndpointConfig.raw,
    new RegExp(`^  R2_ENDPOINT:\\s*${escapeRegExp(EXPECTED_R2_ENDPOINT)}\\s*$`, 'm'),
    'backend ConfigMap R2_ENDPOINT must equal the confirmed S3 API endpoint',
  );
  requireText(
    appsEndpointConfig.raw,
    /^  CF_R2_URL:\s*""\s*$/m,
    'backend ConfigMap CF_R2_URL must remain empty until a public object-download base is proven',
  );

  for (const job of [
    resource(appsDocs, 'CronJob', backendProducerName),
    resource(appsDocs, 'CronJob', backendVerifierName),
  ]) {
    requireText(
      job.raw,
      new RegExp(
        `^\\s*- name:\\s*R2_ENDPOINT\\s*\\r?\\n\\s+value:\\s*${escapeRegExp(EXPECTED_R2_ENDPOINT)}\\s*$`,
        'm',
      ),
      `CronJob/${job.name} does not receive the exact R2 endpoint through a rendered env value`,
    );
  }

  const platformReplacements = topLevelSection(
    read('infra/kubernetes/overlays/prod/kustomization.yaml'),
    'replacements',
    'production kustomization',
  );
  requireReplacementSource(
    platformReplacements,
    {
      name: 'vhhealth-env',
      namespace: 'vhhealth-platform',
      fieldPath: 'data.R2_ENDPOINT',
    },
    'production R2 endpoint replacement',
  );
  for (const target of [
    {
      name: 'vhhealth-pg18-producer',
      fieldPath: 'spec.configuration.endpointURL',
    },
    {
      name: cnpgVerifierName,
      fieldPath:
        'spec.jobTemplate.spec.template.spec.containers.[name=verify].env.[name=R2_ENDPOINT].value',
    },
    {
      name: 'cnpg-scheduled-restore-proof',
      fieldPath:
        'spec.jobTemplate.spec.template.spec.containers.[name=prove-restore].env.[name=R2_ENDPOINT].value',
    },
  ]) {
    requireReplacementTarget(
      platformReplacements,
      target,
      'production R2 endpoint replacement',
    );
  }

  const backendReplacements = topLevelSection(
    read('infra/kubernetes/apps/backend/kustomization.yaml'),
    'replacements',
    'backend kustomization',
  );
  requireReplacementSource(
    backendReplacements,
    {
      name: 'vhhealth-backend-config',
      fieldPath: 'data.R2_ENDPOINT',
    },
    'backend R2 endpoint replacement',
  );
  for (const target of [
    {
      name: backendProducerName,
      fieldPath:
        'spec.jobTemplate.spec.template.spec.containers.[name=r2-sync].env.[name=R2_ENDPOINT].value',
    },
    {
      name: backendVerifierName,
      fieldPath:
        'spec.jobTemplate.spec.template.spec.initContainers.[name=archive-reader].env.[name=R2_ENDPOINT].value',
    },
  ]) {
    requireReplacementTarget(backendReplacements, target, 'backend R2 endpoint replacement');
  }
}

function secretNames(document) {
  const names = new Set();
  const lines = document.raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*(?:secretKeyRef|secretRef):\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j += 1) {
      if (lines[j].trim() && lines[j].match(/^\s*/)[0].length <= lines[i].match(/^\s*/)[0].length) break;
      const match = lines[j].match(/^\s*name:\s*(\S+)\s*$/);
      if (match) {
        names.add(unquote(match[1]));
        break;
      }
    }
  }
  return names;
}

function assertExactSecrets(document, { required = [], forbidden = [] }) {
  const names = secretNames(document);
  for (const name of required) {
    requireCondition(names.has(name), `${document.kind}/${document.name} must reference Secret/${name}`);
  }
  for (const name of forbidden) {
    requireCondition(!names.has(name), `${document.kind}/${document.name} must not reference Secret/${name}`);
  }
  requireCondition(
    !names.has('vhhealth-backend-env'),
    `${document.kind}/${document.name} imports the broad backend Secret`,
  );
}

function serviceAccountName(document) {
  return document.raw.match(/^\s+serviceAccountName:\s*(\S+)\s*$/m)?.[1] || null;
}

function assertExplicitServiceAccount(document, docs, { requiresRbac }) {
  const name = serviceAccountName(document);
  requireCondition(name && name !== 'default', `${document.kind}/${document.name} must use an explicit ServiceAccount`);
  resource(docs, 'ServiceAccount', name);

  if (requiresRbac) {
    resource(docs, 'Role', name);
    const bound = docs.some(
      (doc) =>
        doc.kind === 'RoleBinding' &&
        new RegExp(`subjects:[\\s\\S]*kind:\\s+ServiceAccount[\\s\\S]*name:\\s+${name}(?:\\s|$)`).test(doc.raw),
    );
    requireCondition(bound, `ServiceAccount/${name} needs an explicit namespaced RoleBinding`);
  } else {
    requireText(
      document.raw,
      /^\s+automountServiceAccountToken:\s*false\s*$/m,
      `${document.kind}/${document.name} must disable service-account token automount`,
    );
  }
}

function networkPolicyForWorkload(docs, workloadName) {
  return docs.find(
    (doc) =>
      doc.kind === 'NetworkPolicy' &&
      new RegExp(`app\\.kubernetes\\.io/name:\\s*["']?${workloadName}["']?(?:\\s|$)`).test(doc.raw),
  );
}

function assertEgressPolicy(docs, workloadName) {
  const policy = networkPolicyForWorkload(docs, workloadName);
  requireCondition(policy, `workload ${workloadName} has no selecting NetworkPolicy`);
  requireText(
    policy.raw,
    /policyTypes:\s*(?:\[[^\]]*\bEgress\b[^\]]*\]|[\s\S]*?-\s+Egress)/,
    `NetworkPolicy/${policy.name} must govern egress`,
  );
  requireText(policy.raw, /port:\s*443/, `NetworkPolicy/${policy.name} must permit required HTTPS egress`);
}

function assertNamedEgressPolicy(docs, policyName) {
  const policy = resource(docs, 'NetworkPolicy', policyName);
  requireText(
    policy.raw,
    /policyTypes:\s*(?:\[[^\]]*\bEgress\b[^\]]*\]|[\s\S]*?-\s+Egress)/,
    `NetworkPolicy/${policy.name} must govern egress`,
  );
  requireText(policy.raw, /port:\s*443/, `NetworkPolicy/${policy.name} must permit required HTTPS egress`);
  return policy;
}

export function requiredScriptEnvironment(script) {
  const required = new Set(
    [...script.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?[^}]*\}/g)].map((match) => match[1]),
  );
  const requiredArray = script.match(/\brequired_vars=\(\s*([\s\S]*?)\s*\)/);
  if (requiredArray) {
    for (const match of requiredArray[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*$/gm)) {
      required.add(match[1]);
    }
  }
  const lines = script.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const invocation = lines[index].match(/^\s*require_vars\s+(.+?)\s*$/);
    if (!invocation) continue;

    let argumentsText = invocation[1];
    while (/\\\s*$/.test(argumentsText) && index + 1 < lines.length) {
      argumentsText = `${argumentsText.replace(/\\\s*$/, ' ')}${lines[index + 1].trim()}`;
      index += 1;
    }
    for (const match of argumentsText.matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) {
      required.add(match[1]);
    }
  }
  return required;
}

function assertScriptEnvironment(document, script, scriptName) {
  requireCondition(document.raw.includes(scriptName), `${document.kind}/${document.name} does not execute ${scriptName}`);
  for (const variable of requiredScriptEnvironment(script)) {
    requireText(
      document.raw,
      new RegExp(`-\\s+name:\\s+${variable}(?:\\s|$)`),
      `${document.kind}/${document.name} does not supply required runtime env ${variable}`,
    );
  }
}

function assertBackendArchiveContracts(appsDocs) {
  const producer = resource(appsDocs, 'CronJob', backendProducerName);
  const verifier = resource(appsDocs, 'CronJob', backendVerifierName);
  const uploadScript = read('infra/kubernetes/apps/backend/upload-archive.sh');
  const verifyScript = read('infra/kubernetes/apps/backend/verify-upload-archive.sh');

  assertExactSecrets(producer, {
    required: ['minio-backup-source-reader', 'offsite-backup-producer', 'backup-crypto'],
    forbidden: ['offsite-backup-reader', 'cnpg-backup-producer-credentials', 'cnpg-dr-reader-credentials'],
  });
  assertExactSecrets(verifier, {
    required: ['offsite-backup-reader', 'backup-crypto'],
    forbidden: [
      'minio-backup-source-reader',
      'offsite-backup-producer',
      'cnpg-backup-producer-credentials',
    ],
  });

  assertExplicitServiceAccount(producer, appsDocs, { requiresRbac: false });
  assertExplicitServiceAccount(verifier, appsDocs, { requiresRbac: false });
  assertEgressPolicy(appsDocs, backendProducerName);
  assertEgressPolicy(appsDocs, backendVerifierName);
  assertScriptEnvironment(producer, uploadScript, 'upload-archive.sh');
  assertScriptEnvironment(verifier, verifyScript, 'verify-upload-archive.sh');

  const uploadPhaseStart = uploadScript.indexOf('\nupload_archive() {');
  const uploadPhaseEnd = uploadScript.indexOf('\ncase "${1:-}"', uploadPhaseStart);
  requireCondition(
    uploadPhaseStart >= 0 && uploadPhaseEnd > uploadPhaseStart,
    'upload script lacks an independently auditable R2 producer phase',
  );
  const uploadPhase = uploadScript.slice(uploadPhaseStart, uploadPhaseEnd);
  rejectText(
    uploadPhase,
    /\b(?:head-object|list-objects(?:-v2)?|s3\s+ls)\b/,
    'R2 producer phase performs writer-side read/list verification',
  );
  rejectText(
    uploadPhase,
    /\$\{source_dir\}/,
    'R2 producer phase retains access to the plaintext MinIO source tree',
  );
  requireCondition(
    (uploadScript.match(/\bminio_aws s3api list-objects-v2\b/g) || []).length === 1,
    'upload script must inventory MinIO exactly once before download',
  );
  for (const required of [
    "[length(Contents), sum(Contents[].Size)]",
    'inventory_projected_bytes=$((inventory_source_bytes * 2 + capacity_margin_bytes))',
    'source was not downloaded',
  ]) {
    requireCondition(
      uploadScript.includes(required),
      `upload script lacks the bounded pre-download MinIO capacity gate: ${required}`,
    );
  }
  for (const marker of [
    'vhhealth-minio-archive-v1',
    'sha256',
    'hmac_sha256',
    'created_at',
    'source_bucket',
    'aes-256-cbc-pbkdf2-sha256',
  ]) {
    requireCondition(uploadScript.includes(marker), `upload script is missing archive metadata marker ${marker}`);
    requireCondition(verifyScript.includes(marker), `verification script does not verify metadata marker ${marker}`);
  }
  requireText(uploadScript, /openssl[\s\S]*aes-256-cbc[\s\S]*-pbkdf2[\s\S]*sha256/i, 'upload script lacks the cleared encryption contract');
  requireText(
    uploadScript,
    /openssl\s+dgst\s+-sha256\s+-hmac\s+"\$\{BACKUP_HMAC_KEY\}"/,
    'upload script lacks the independent archive HMAC contract',
  );
  requireText(verifyScript, /openssl[\s\S]*aes-256-cbc[\s\S]*(?:-d|-decrypt)/i, 'verification script lacks decrypt verification');
  requireText(
    verifyScript,
    /archive HMAC does not authenticate[\s\S]*openssl[\s\S]*aes-256-cbc[\s\S]*(?:-d|-decrypt)/i,
    'verification script must authenticate metadata and ciphertext before decryption',
  );
  requireText(verifyScript, /(?:sha256sum|openssl\s+dgst\s+-sha256)/i, 'verification script lacks checksum verification');
  requireText(verifyScript, /tar\s+-[^\n]*t/i, 'verification script does not inspect the decrypted archive');
}

function assertCnpgProofContracts(platformDocs, platformRender) {
  const cnpgVerifier = resource(platformDocs, 'CronJob', cnpgVerifierName);
  const platformAlerts = resource(platformDocs, 'PrometheusRule', 'vhhealth-platform-alerts');
  const cnpgVerifierScript = read('infra/kubernetes/base/cnpg/verify-cnpg-backup.sh');
  assertExactSecrets(cnpgVerifier, {
    required: ['cnpg-dr-reader-credentials'],
    forbidden: ['cnpg-backup-producer-credentials', 'offsite-backup-producer'],
  });
  assertExplicitServiceAccount(cnpgVerifier, platformDocs, { requiresRbac: true });
  assertEgressPolicy(platformDocs, cnpgVerifierName);
  assertScriptEnvironment(cnpgVerifier, cnpgVerifierScript, 'verify-cnpg-backup.sh');
  requireText(
    cnpgVerifierScript,
    /head-object[\s\S]*ContentLength[\s\S]*sha256sum/,
    'CNPG verification script lacks metadata and evidence-checksum checks',
  );
  requireText(
    platformAlerts.raw,
    /alert:\s*CnpgBackupVerifyStale[\s\S]*>\s*108000\)\s*or\s*absent\(kube_cronjob_status_last_schedule_time\{namespace="vhhealth-platform",\s*cronjob="cnpg-backup-verify"\}\)/,
    'CnpgBackupVerifyStale must detect a missing daily schedule within 30 hours, including an absent metric',
  );
  for (const required of [
    'for key in "${base_key}" "${wal_key}"',
    'aws s3api get-object',
    '--range "bytes=0-65535"',
    'test -s "${sample}"',
    'sample_checksum="$(sha256sum "${sample}"',
    'evidence_checksum="$(sha256sum "${evidence}"',
  ]) {
    requireCondition(
      cnpgVerifierScript.includes(required),
      `CNPG verification script lacks bounded base/WAL retrieval evidence: ${required}`,
    );
  }
  const productionBackupPolicy = assertNamedEgressPolicy(
    platformDocs,
    'cnpg-r2-backup-egress',
  );
  requireText(
    productionBackupPolicy.raw,
    /^\s{6}cnpg\.io\/cluster:\s*vhhealth-pg\s*$/m,
    'NetworkPolicy/cnpg-r2-backup-egress must select the production CNPG pods',
  );
  for (const protocol of ['UDP', 'TCP']) {
    requireText(
      productionBackupPolicy.raw,
      new RegExp(
        `(?:^\\s*- protocol:\\s*${protocol}\\s*\\r?\\n\\s+port:\\s*53\\s*$|` +
          `^\\s*- port:\\s*53\\s*\\r?\\n\\s+protocol:\\s*${protocol}\\s*$)`,
        'm',
      ),
      `NetworkPolicy/cnpg-r2-backup-egress must permit kube-dns ${protocol}/53`,
    );
  }

  const proofSource = read('infra/kubernetes/base/cnpg/scheduled-restore-proof.yaml');
  const proofSourceDocs = parseRenderedDocuments(proofSource, 'scheduled-restore-proof.yaml');
  const proofCronJobs = proofSourceDocs.filter(
    (doc) => doc.kind === 'CronJob' && /^\s{2}suspend:\s*true\s*$/m.test(doc.raw),
  );
  requireCondition(proofCronJobs.length === 1, 'scheduled restore proof must define exactly one suspended CronJob');
  const proofName = proofCronJobs[0].name;
  const proof = resource(platformDocs, 'CronJob', proofName);
  requireCondition(proof.namespace === 'vhhealth-restore-proof', `CronJob/${proofName} must use vhhealth-restore-proof`);
  requireText(proof.raw, /^\s{2}suspend:\s*true\s*$/m, `CronJob/${proofName} must remain suspended`);
  requireText(
    proof.raw,
    /^\s{2}schedule:\s*["']?0 3 1 \*\/3 \*["']?\s*$/m,
    `CronJob/${proofName} must keep the cleared quarterly proof schedule`,
  );
  requireCondition(
    proof.raw.includes(EXPECTED_PG_IMAGE),
    `CronJob/${proofName} must inject the exact PG18 qualification image`,
  );
  assertExactSecrets(proof, {
    forbidden: ['cnpg-backup-producer-credentials', 'offsite-backup-producer'],
  });
  assertExplicitServiceAccount(proof, platformDocs, { requiresRbac: true });
  assertEgressPolicy(platformDocs, 'cnpg-restore-proof');

  const drTemplate = read('infra/kubernetes/base/cnpg/dr-restore-drill.yaml');
  const drScript = read('infra/kubernetes/base/cnpg/dr-restore-drill.sh');
  requireCondition(drTemplate.includes('cnpg-dr-reader-credentials'), 'DR restore template lacks the reader identity');
  rejectText(drTemplate, /cnpg-backup-producer-credentials/, 'DR restore template reuses the producer identity');
  requireCondition(drScript.includes('cnpg-dr-reader-credentials'), 'DR restore drill lacks the reader identity');
  rejectText(drScript, /cnpg-backup-producer-credentials/, 'DR restore drill reuses the producer identity');
  for (const required of [
    'vhhealth\\.app/disposable-restore-proof}:{.metadata.uid}',
    '\\"kind\\":\\"DeleteOptions\\",\\"preconditions\\":{\\"uid\\":\\"${cluster_uid}\\"}',
    '\\"kind\\":\\"DeleteOptions\\",\\"preconditions\\":{\\"uid\\":\\"${store_uid}\\"}',
    'kubectl wait --for=delete "cluster/${DRILL_CLUSTER}"',
    "rolname IN ('vhhealth','vhhealth_app','vhhealth_runtime','vhhealth_readonly')",
    "installed_version IS NOT NULL AND installed_version = default_version",
    'SET ROLE vhhealth_runtime',
  ]) {
    requireCondition(
      drScript.includes(required),
      `DR restore drill lacks UID-safe cleanup or runtime proof: ${required}`,
    );
  }
  requireCondition(
    drScript.indexOf('kubectl wait --for=delete "cluster/${DRILL_CLUSTER}"') <
      drScript.indexOf('/objectstores/${READER_STORE}'),
    'DR restore drill must confirm Cluster deletion before deleting its ObjectStore',
  );
  const proofScript = read('infra/kubernetes/base/cnpg/scheduled-restore-proof.sh');
  requireCondition(proofScript.includes('cnpg-dr-reader-credentials'), 'scheduled restore proof lacks the reader identity');
  rejectText(proofScript, /cnpg-backup-producer-credentials/, 'scheduled restore proof reuses the producer identity');
  const synthesizedImageFields = [...proofScript.matchAll(/"(image|imageName)":"([^"]+)"/g)]
    .map((match) => `${match[1]}=${match[2]}`);
  requireCondition(
    synthesizedImageFields.length === 3 &&
      synthesizedImageFields.filter((value) => value === `image=${EXPECTED_AWS_CLI_IMAGE}`).length === 1 &&
      synthesizedImageFields.filter((value) => value === 'imageName=${PG18_IMAGE}').length === 1 &&
      synthesizedImageFields.filter((value) => value === 'image=${PG18_IMAGE}').length === 1,
    `scheduled restore proof must synthesize exactly the reviewed three runtime image occurrences; ` +
      `found ${synthesizedImageFields.join(', ') || 'none'}`,
  );
  for (const required of [
    'extract_uid()',
    'verify_disposable_identity()',
    '"vhhealth\\.app/disposable-restore-proof"',
    'delete_with_uid()',
    '\\"preconditions\\":{\\"uid\\":\\"${uid}\\"',
    'wait_for_absence "${cluster_path}"',
    'Refusing to delete ObjectStore before the created Cluster is confirmed absent',
  ]) {
    requireCondition(
      proofScript.includes(required),
      `scheduled restore proof lacks UID/label-safe cleanup: ${required}`,
    );
  }
  requireCondition(
    proofScript.indexOf('wait_for_absence "${cluster_path}"') <
      proofScript.indexOf('delete_with_uid "${store_path}"'),
    'scheduled restore proof must confirm Cluster deletion before deleting its ObjectStore',
  );
  assertScriptEnvironment(proof, proofScript, 'scheduled-restore-proof.sh');
  assertNamedEgressPolicy(platformDocs, 'restored-cnpg-r2-egress');
  resource(platformDocs, 'NetworkPolicy', 'restore-proof-default-deny');
  resource(platformDocs, 'Namespace', 'vhhealth-restore-proof');
  const argoProject = resource(platformDocs, 'AppProject', 'vhhealth');
  requireCondition(
    argoProject.raw.includes('namespace: vhhealth-restore-proof'),
    'Argo AppProject does not permit the restricted restore-proof namespace',
  );

  const rehearsalSource = read('infra/kubernetes/base/cnpg/pg18-upgrade-rehearsal.yaml');
  const rehearsalScript = read('infra/kubernetes/base/cnpg/pg18-upgrade-rehearsal.sh');
  for (const required of [
    '${PG17_SECURE_MINOR:?Set the current secure PG17 minor re-derived at execution',
    '[[ "${PG17_SECURE_MINOR}" =~ ^17\\.[0-9]+$ ]]',
    '":${PG17_SECURE_MINOR}-"*"@sha256:"*',
    "current_setting('server_version') LIKE '${PG17_SECURE_MINOR}%'",
  ]) {
    requireCondition(
      rehearsalScript.includes(required),
      `PG18 rehearsal does not bind the PG17 source and live server to the execution-time secure minor: ${required}`,
    );
  }
  for (const required of [
    'PG17 secure minor cannot be below the clearance floor 17.10',
    'c1-1-pg17-secure-minor-v1',
    'c1-1-pg17-source-inventory-v1',
    'os_family)" == "bookworm"',
    'c1-1-cnpg-ladder-v1',
    'kubernetes_transition=1.31->1.32 operator=1.27.4 result=passed',
    'kubernetes_transition=1.32->1.33 operator=1.28.4 result=passed',
    'kubernetes_transition=1.33->1.34 operator=1.29.2 result=passed',
    'kubectl version -o json',
    '10#${server_minor} -ge 34',
    'operator_image}" == "${EXPECTED_OPERATOR_IMAGE}"',
    'plugin_image}" == "${EXPECTED_PLUGIN_IMAGE}"',
    'sidecar_image}" == "${EXPECTED_SIDECAR_IMAGE}"',
    'objectstores.barmancloud.cnpg.io',
    'APPLICATION_ROLES="\'vhhealth\',\'vhhealth_app\',\'vhhealth_readonly\',\'vhhealth_runtime\'"',
    'FROM pg_auth_members membership',
    'application_ownership_checksum()',
    "left(rolname, 3) = 'pg_'",
    'predefined_added}" == "pg_signal_autovacuum_worker"',
    'SET ROLE vhhealth_runtime',
    'update_extensions.sql',
    'bool_and(installed_version = default_version)',
    'installed_version IS NOT NULL AND installed_version = default_version',
    'destination}" != "s3://vhhealth-db-backups/"*',
    'PG18_ARCHIVE_IDENTITY="vhhealth-pg18-rehearsal-${REHEARSAL_RUN_ID}"',
    '.status.backupId',
    '.spec.bootstrap.recovery.recoveryTarget.backupID',
    'printf \'producer_secret=%s\\n\'',
    'PG18_REHEARSAL_READER_SECRET}" != "$(evidence_value producer_secret)"',
    '[[ "${producer_destination%/}" == "s3://vhhealth-synthetic-qa-only/pg18-rehearsal/${REHEARSAL_RUN_ID}" ]]',
    "sh -eu -c '. /etc/os-release; printf \"%s:%s:%s\" \"${ID}\" \"${VERSION_CODENAME}\" \"${VERSION_ID}\"'",
    '[[ "${source_os}" == "debian:bookworm:12" || "${source_os}" == "debian:bookworm:12."* ]]',
    '${PG17_RESTORE_READER_SECRET:?Set the synthetic read-only Secret used by the PG17 restore proof}',
    'PG17_RESTORE_READER_SECRET}" != "cnpg-dr-reader-credentials"',
    'PG17_RESTORE_READER_SECRET}" != "cnpg-backup-producer-credentials"',
    'PG17_RESTORE_READER_SECRET}" != "${PG18_REHEARSAL_PRODUCER_SECRET}"',
    'reader_identity)" == "${PG17_RESTORE_READER_SECRET}"',
    'reader_secret_synthetic_only)" == "true"',
    'reader_secret_access)" == "read-only"',
    'data_classification)" == "synthetic"',
    'source_destination)"',
    'reject_production_destination "${pg17_restore_destination}"',
    '[[ "${pg17_restore_destination%/}" == "s3://vhhealth-synthetic-qa-only/pg18-rehearsal/${REHEARSAL_RUN_ID}" ]]',
    "jsonpath='{.metadata.labels.vhhealth\\.app/credential-access}'",
    '[[ "${producer_destination%/}" == "${pg17_restore_destination%/}" ]]',
    'kubectl get secret "${PG18_REHEARSAL_READER_SECRET}"',
    'Synthetic reader Secret must be positively labeled synthetic-only and read-only',
  ]) {
    requireCondition(
      rehearsalScript.includes(required),
      `PG18 rehearsal lacks a live-version, role, extension, isolation, or fresh-restore hard stop: ${required}`,
    );
  }
  for (const expectedImage of [
    EXPECTED_CNPG_OPERATOR_IMAGE,
    EXPECTED_PLUGIN_MANAGER_IMAGE,
    EXPECTED_PLUGIN_SIDECAR_IMAGE,
  ]) {
    requireCondition(
      rehearsalScript.includes(expectedImage),
      `PG18 rehearsal lacks exact live-image gate ${expectedImage}`,
    );
  }
  rejectText(
    rehearsalScript,
    /^LADDER=/m,
    'PG18 rehearsal must consume structured interleaved ladder evidence, not an unqualified version list',
  );
  const orderedLadder = [
    'operator=1.24.1 kubernetes=1.31 result=passed',
    'operator=1.24.4 kubernetes=1.31 result=passed',
    'operator=1.25.4 kubernetes=1.31 result=passed',
    'operator=1.26.3 kubernetes=1.31 result=passed',
    'operator=1.27.4 kubernetes=1.31 result=passed',
    'kubernetes_transition=1.31->1.32 operator=1.27.4 result=passed',
    'operator=1.27.4 kubernetes=1.32 result=passed',
    'operator=1.28.4 kubernetes=1.32 result=passed',
    'kubernetes_transition=1.32->1.33 operator=1.28.4 result=passed',
    'operator=1.28.4 kubernetes=1.33 result=passed',
    'operator=1.29.2 kubernetes=1.33 result=passed',
    'kubernetes_transition=1.33->1.34 operator=1.29.2 result=passed',
    'operator=1.29.2 kubernetes=1.34 result=passed',
    'operator=1.30.0 kubernetes=1.34 result=passed',
  ].join('\n');
  requireCondition(
    rehearsalScript.includes(orderedLadder),
    'PG18 rehearsal does not encode the exact cleared interleaved operator/Kubernetes ladder',
  );
  requireCondition(
    rehearsalScript.includes('[[ "${actual}" == "${expected}" ]]'),
    'PG18 rehearsal does not fail closed on incomplete, duplicated, or out-of-order ladder evidence',
  );
  const patchOffset = rehearsalScript.indexOf('kubectl patch cluster');
  requireCondition(patchOffset >= 0, 'PG18 rehearsal does not patch the synthetic Cluster');
  requireCondition(
    (rehearsalScript.match(/\bkubectl patch cluster\b/g) || []).length === 1,
    'PG18 rehearsal must use exactly one atomic Cluster patch',
  );
  const preUpgradeProof = rehearsalScript.slice(0, patchOffset);
  for (const required of [
    '${PG18_REHEARSAL_PRODUCER_OBJECTSTORE:?Set the same-namespace synthetic-QA producer ObjectStore name}',
    '${PG18_REHEARSAL_PRODUCER_SECRET:?Set its synthetic-QA producer credential Secret name}',
    '${PG17_RESTORE_READER_SECRET:?Set the synthetic read-only Secret used by the PG17 restore proof}',
    'PG17_RESTORE_READER_SECRET}" != "cnpg-dr-reader-credentials"',
    'PG17_RESTORE_READER_SECRET}" != "cnpg-backup-producer-credentials"',
    'PG17_RESTORE_READER_SECRET}" != "${PG18_REHEARSAL_PRODUCER_SECRET}"',
    'reader_identity)" == "${PG17_RESTORE_READER_SECRET}"',
    'reader_secret_synthetic_only)" == "true"',
    'reader_secret_access)" == "read-only"',
    'data_classification)" == "synthetic"',
    'reject_production_destination "${pg17_restore_destination}"',
    '[[ "${pg17_restore_destination%/}" == "s3://vhhealth-synthetic-qa-only/pg18-rehearsal/${REHEARSAL_RUN_ID}" ]]',
    '[[ "${producer_destination%/}" == "${pg17_restore_destination%/}" ]]',
    "jsonpath='{.spec.plugins[0].name}'",
    "jsonpath='{.spec.plugins[0].parameters.barmanObjectName}'",
    "jsonpath='{.spec.plugins[0].parameters.serverName}'",
    "jsonpath='{.spec.plugins[0].isWALArchiver}'",
    'plugin_name}" == "barman-cloud.cloudnative-pg.io"',
    'wal_archiver}" == "true"',
    'PG18_REHEARSAL_PRODUCER_OBJECTSTORE}" != "vhhealth-pg18-producer"',
    'pg17_archive_identity}" != "${PG18_ARCHIVE_IDENTITY}"',
    'PG18_REHEARSAL_PRODUCER_SECRET}" != "cnpg-dr-reader-credentials"',
    'PG18_REHEARSAL_PRODUCER_SECRET}" != "cnpg-backup-producer-credentials"',
    "jsonpath='{.metadata.labels.vhhealth\\.app/synthetic-only}'",
    "jsonpath='{.spec.configuration.destinationPath}'",
    'reject_production_destination "${producer_destination}"',
    "jsonpath='{.spec.configuration.s3Credentials.accessKeyId.name}'",
    "jsonpath='{.spec.configuration.s3Credentials.secretAccessKey.name}'",
  ]) {
    requireCondition(
      preUpgradeProof.includes(required),
      `PG18 rehearsal lacks pre-mutation plugin/archive/producer proof: ${required}`,
    );
  }
  requireText(
    preUpgradeProof,
    /assert_live_platform_versions\s*$/,
    'PG18 rehearsal must re-read the live Kubernetes/operator/plugin pins immediately before mutation',
  );
  const patchArgument = rehearsalScript
    .slice(patchOffset)
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith('-p "'));
  requireCondition(patchArgument, 'PG18 rehearsal lacks the atomic JSON Patch payload');
  for (const operation of [
    '\\"op\\":\\"replace\\",\\"path\\":\\"/spec/plugins/0/parameters/serverName\\",\\"value\\":\\"${PG18_ARCHIVE_IDENTITY}\\"',
    '\\"op\\":\\"replace\\",\\"path\\":\\"/spec/imageName\\",\\"value\\":\\"${TARGET_IMAGE}\\"',
  ]) {
    requireCondition(
      patchArgument.includes(operation),
      `PG18 rehearsal atomic patch lacks required operation: ${operation}`,
    );
  }
  const postUpgradeProof = rehearsalScript.slice(patchOffset + 'kubectl patch cluster'.length);
  for (const required of [
    "jsonpath='{.spec.plugins[0].parameters.serverName}'",
    "jsonpath='{.spec.plugins[0].parameters.barmanObjectName}'",
    'PG18_ARCHIVE_IDENTITY',
    '== "${PG18_REHEARSAL_PRODUCER_OBJECTSTORE}"',
  ]) {
    requireCondition(
      postUpgradeProof.includes(required),
      `PG18 rehearsal lacks post-conversion archive/ObjectStore proof: ${required}`,
    );
  }
  const rehearsalDocuments = parseRenderedDocuments(
    rehearsalSource,
    'pg18-upgrade-rehearsal.yaml',
  );
  const rehearsalObjectStore = resource(
    rehearsalDocuments,
    'ObjectStore',
    'vhhealth-pg18-rehearsal-producer',
  );
  requireCondition(
    rehearsalObjectStore.namespace === 'vhhealth-restore-proof',
    'PG18 rehearsal producer ObjectStore must stay in the synthetic restore-proof namespace',
  );
  requireText(
    rehearsalObjectStore.raw,
    /^\s{4}vhhealth\.app\/synthetic-only:\s*["']?true["']?\s*$/m,
    'PG18 rehearsal producer ObjectStore lacks the synthetic-only label',
  );
  requireText(
    rehearsalObjectStore.raw,
    /^\s{4}destinationPath:\s*["']?s3:\/\/vhhealth-synthetic-qa-only\/pg18-rehearsal\/run-id-required\/["']?\s*$/m,
    'PG18 rehearsal producer ObjectStore must require a run-unique isolated synthetic-QA destination',
  );
  requireCondition(
    rehearsalObjectStore.raw.includes('cnpg-pg18-rehearsal-producer-credentials'),
    'PG18 rehearsal producer ObjectStore lacks its synthetic-only producer identity',
  );
  rejectText(
    rehearsalObjectStore.raw,
    /(?:cnpg-backup-producer-credentials|cnpg-dr-reader-credentials)/,
    'PG18 rehearsal producer ObjectStore reuses a production or DR identity',
  );
  const rehearsalCluster = resource(
    rehearsalDocuments,
    'Cluster',
    'vhhealth-pg18-upgrade-rehearsal',
  );
  for (const required of [
    EXPECTED_PLUGIN_NAME,
    'barmanObjectName: vhhealth-pg18-rehearsal-producer',
    'serverName: vhhealth-pg18-rehearsal-run-id-required',
    EXPECTED_PG_IMAGE,
  ]) {
    requireCondition(
      rehearsalCluster.raw.includes(required),
      `PG18 rehearsal target Cluster lacks ${required}`,
    );
  }
  for (const required of [
    '.status.pgDataImageInfo.image',
    '.status.pgDataImageInfo.majorVersion',
    EXPECTED_PG_IMAGE,
  ]) {
    requireCondition(rehearsalScript.includes(required), `PG18 rehearsal lacks exact-image proof ${required}`);
  }
  requireText(
    rehearsalScript,
    /majorVersion[\s\S]*["']?18["']?/,
    'PG18 rehearsal does not require major version 18',
  );
  for (const [path, source] of [
    ['dr-restore-drill.yaml', drTemplate],
    ['pg18-upgrade-rehearsal.yaml', rehearsalSource],
  ]) {
    const sourceDocuments =
      path === 'pg18-upgrade-rehearsal.yaml'
        ? rehearsalDocuments
        : parseRenderedDocuments(source, path);
    for (const excluded of sourceDocuments) {
      if (!excluded.kind || !excluded.name) continue;
      const rendered = platformDocs.some(
        (doc) => doc.kind === excluded.kind && doc.name === excluded.name,
      );
      requireCondition(!rendered, `${excluded.kind}/${excluded.name} from ${path} must stay excluded`);
    }
  }

  rejectText(
    platformRender,
    /cnpg-backup-credentials/,
    'production CNPG render still references the retired shared backup credential',
  );
}

export function runManifestContract({ kustomize } = {}) {
  const kustomizeBin = kustomize || findBinary('kustomize', 'KUSTOMIZE_BIN');
  const platformRender = run(kustomizeBin, ['build', PLATFORM_TARGET]);
  const appsRender = run(kustomizeBin, ['build', APPS_TARGET]);
  const platformDocs = parseRenderedDocuments(platformRender, PLATFORM_TARGET);
  const appsDocs = parseRenderedDocuments(appsRender, APPS_TARGET);

  assertNoIngressClassParameters(platformRender, PLATFORM_TARGET);
  assertNoIngressClassParameters(appsRender, APPS_TARGET);
  const imageRefs = assertLiteralAndImageContract(platformRender, appsRender);
  assertVersionAndImageSources(imageRefs);
  assertScheduleObjectStoreAndEndpoint(platformDocs, appsDocs);
  assertBackendArchiveContracts(appsDocs);
  assertCnpgProofContracts(platformDocs, platformRender);
  assertHeldActivationBoundary(appsDocs);

  console.log(
    `[c1.1-contract] OK: ${platformDocs.length} platform + ${appsDocs.length} app resources; ` +
      'CNPG/plugin/images/endpoints/backups/proofs are internally consistent.',
  );
  return { platformRender, appsRender, platformDocs, appsDocs, imageRefs };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  try {
    runManifestContract();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
