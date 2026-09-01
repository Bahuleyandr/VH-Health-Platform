#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  objectReferencesOf,
  parseRenderedManifests,
  syncPhasesOf,
} from './lib/rendered-manifest-refs.mjs';

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), '..');

const targets = [
  'infra/kubernetes/apps',
  // Held bedside-device ingress tree — composed by no overlay yet, but its
  // manifests must stay valid so activation does not start from rot.
  'infra/kubernetes/base/device-gateway',
  'infra/kubernetes/optional/tenant-network-boundary',
  'infra/kubernetes/overlays/staging/apps',
  'infra/kubernetes/overlays/dev',
  'infra/kubernetes/overlays/staging',
  'infra/kubernetes/overlays/prod',
];

// kubeconform's default schema catalog does not contain these repository-owned
// or operator-provided CRDs. Keep this as a full-GVK allowlist: a new or
// misspelled custom resource must fail validation instead of being hidden by
// -ignore-missing-schemas. ObjectStore's essential C1.1 fields are checked
// below because the Barman Cloud Plugin CRD is installed operator-side.
const knownExternalGvks = [
  'apiextensions.k8s.io/v1/CustomResourceDefinition',
  'argoproj.io/v1alpha1/Application',
  'argoproj.io/v1alpha1/AppProject',
  'barmancloud.cnpg.io/v1/ObjectStore',
  'bitnami.com/v1alpha1/SealedSecret',
  'cert-manager.io/v1/Certificate',
  'cert-manager.io/v1/ClusterIssuer',
  'kyverno.io/v1/ClusterPolicy',
  'minio.min.io/v2/Tenant',
  'monitoring.coreos.com/v1/PrometheusRule',
  'monitoring.coreos.com/v1/ServiceMonitor',
  'postgresql.cnpg.io/v1/Cluster',
  'postgresql.cnpg.io/v1/Pooler',
  'postgresql.cnpg.io/v1/ScheduledBackup',
];

function candidateNames(name) {
  return process.platform === 'win32' ? [name, `${name}.exe`] : [name];
}

function findBinary(name, envName) {
  const explicit = process.env[envName];
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const localToolDir = process.platform === 'win32' ? 'D:\\Dev\\Tools\\kubetools' : '';
  const pathDirs = [
    ...String(process.env.PATH || '').split(delimiter),
    ...(localToolDir ? [localToolDir] : []),
  ];

  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const candidate of candidateNames(name)) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  throw new Error(
    `${name} was not found. Install it on PATH or set ${envName} to the binary path.`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    const stdout = result.stdout ? `\n${result.stdout.trim()}` : '';
    throw new Error(`${command} ${args.join(' ')} failed.${stderr}${stdout}`);
  }

  return result;
}

function requireInRendered(target, rendered, checks) {
  const missing = checks.filter(({ pattern }) => !pattern.test(rendered));
  if (missing.length > 0) {
    const labels = missing.map(({ label }) => `- ${label}`).join('\n');
    throw new Error(`${target} is missing required production manifest checks:\n${labels}`);
  }
}

function rejectInRendered(target, rendered, checks) {
  const present = checks.filter(({ pattern }) => pattern.test(rendered));
  if (present.length > 0) {
    const labels = present.map(({ label }) => `- ${label}`).join('\n');
    throw new Error(`${target} contains forbidden manifest constructs:\n${labels}`);
  }
}

function renderedDocuments(rendered) {
  return rendered
    .split(/^---\s*$/m)
    .map((document) => document.trim())
    .filter(Boolean);
}

export function assertNoIngressClassParameters(rendered, target = 'render') {
  const ingressClasses = renderedDocuments(rendered).filter(
    (document) =>
      /^apiVersion:\s+networking\.k8s\.io\/v1\s*$/m.test(document) &&
      /^kind:\s+IngressClass\s*$/m.test(document),
  );
  const withParameters = ingressClasses.filter((document) =>
    /^\s{2}parameters:\s*(?:.*)$/m.test(document),
  );
  if (withParameters.length > 0) {
    throw new Error(
      `${target} contains IngressClass spec.parameters, but this repository defines no ` +
        'IngressClassParameters resource/controller contract.',
    );
  }
}

// The migration Job's failure evidence must survive long enough to be read.
//
// Checked on the RENDERED output, not the source file, so an overlay patch can
// never quietly put either half back: both `infra/kubernetes/apps` and
// `infra/kubernetes/overlays/staging/apps` render this Job today, and a target
// that stops rendering it is simply skipped.
//
// Reproduced on the dalekdefender rig 2026-09-01 with production's exact policy
// (restartPolicy OnFailure, backoffLimit 2): the job controller deleted the pod
// about a second after BackoffLimitExceeded, so the failure was left as a Job
// object reading `Failed 0/1` carrying no migration output at all — no file
// name, no Postgres error — and `kubectl logs job/<name>` returned "timed out
// waiting for the condition". restartPolicy Never retains every attempt's pod
// (3 readable pods for backoffLimit 2, verified), and a 24h TTL keeps them past
// an unattended overnight sync. `hook-delete-policy: BeforeHookCreation` bounds
// the retention to one Job regardless, so neither setting can accumulate.
const MIGRATION_JOB_MIN_TTL_SECONDS = 86400;

// Floor, not the current value — raising these is fine, lowering needs review.
//
// activeDeadlineSeconds is the one terminal path that still DESTROYS evidence:
// on DeadlineExceeded the job controller deletes the pod that is still running,
// under either restartPolicy (verified on the rig). Two hard constraints set
// the floor, and neither is about taste:
//   * The wait-owner-bypassrls initContainer has its own 5-minute hard cap
//     (DEADLINE_MS in migration-job.yaml), and it runs once per attempt. Below
//     300s the Job can be killed while the gate is still legitimately polling,
//     so the gate could never even print the "bypassrls not reconciled by CNPG"
//     message it exists to produce.
//   * Whatever is left over has to cover the migration itself, and the run that
//     matters most is a FRESH cluster applying 000_baseline plus every file
//     after it — minutes, not the <60s of a caught-up re-sync.
// 900 is the smallest round value leaving a full 10 minutes for the apply after
// a worst-case gate, so a lower value is not legitimate rather than merely
// unusual. Lowering it is also a SAFETY change, not only an evidence one: the
// deadline can kill ci-setup-db.mjs mid-file, and self-managed BEGIN/COMMIT
// migrations do not all survive that. It should cost a deliberate edit here.
const MIGRATION_JOB_MIN_ACTIVE_DEADLINE_SECONDS = 900;

// backoffLimit 0 still retains its single pod, so it does not destroy evidence
// outright — it destroys the ability to COMPARE attempts, which is how an
// operator separates a deterministic bad migration (every attempt dies the same
// way) from one transient DB blip. One retry is the minimum that gives two pods
// to compare; 2 is today's value and anything higher is a deliberate choice for
// a flaky network, so the floor is 1 rather than a pin at 2.
const MIGRATION_JOB_MIN_BACKOFF_LIMIT = 1;

// The targets that MUST render this Job. Without them the check below would
// treat "no Job matched" as "nothing to check" and print [ok] in green — a
// guard that guards nothing. Mutation-tested: renaming the Job to
// vhhealth-backend-migrate-v2 while restoring restartPolicy: OnFailure passed
// silently before this set existed. (Nothing else catches that pairing on its
// own merits: check-prod-digests-pinned happens to fail the rename via its
// image inventory, which a renamer would update in the same commit, and the
// 'backend migration Job' render check below matches `-migrate-v2` as a prefix.)
const TARGETS_RENDERING_MIGRATION_JOB = new Set([
  'infra/kubernetes/apps',
  'infra/kubernetes/overlays/staging/apps',
]);

// ...and a misspelled member of that set would fall straight through to the
// `return` below, silently restoring the hole it exists to close. Pin the
// strings to real validated targets, at import time.
for (const migrationJobTarget of TARGETS_RENDERING_MIGRATION_JOB) {
  if (!targets.includes(migrationJobTarget)) {
    throw new Error(
      `TARGETS_RENDERING_MIGRATION_JOB names "${migrationJobTarget}", which is not a validated ` +
        'target; the migration Job failure-evidence contract would silently skip it.',
    );
  }
}

function requireMigrationJobEvidenceContract(target, rendered) {
  const migrationJobs = renderedDocuments(rendered).filter(
    (document) =>
      /^apiVersion:\s+batch\/v1\s*$/m.test(document) &&
      /^kind:\s+Job\s*$/m.test(document) &&
      /^\s{2}name:\s+vhhealth-backend-migrate\s*$/m.test(document),
  );
  if (migrationJobs.length === 0) {
    if (TARGETS_RENDERING_MIGRATION_JOB.has(target)) {
      throw new Error(
        `${target} no longer renders a Job named vhhealth-backend-migrate, so the failure-evidence ` +
          'contract (restartPolicy: Never + a >=24h TTL) cannot be checked. The Job was renamed, ' +
          'removed, or split across YAML documents. Update this guard deliberately rather than ' +
          'letting it pass on an empty match.',
      );
    }
    return;
  }

  for (const job of migrationJobs) {
    rejectInRendered(target, job, [
      {
        label:
          'migration Job uses restartPolicy: OnFailure — the job controller deletes the pod ' +
          'on BackoffLimitExceeded, destroying the only record of which migration failed',
        pattern: /^\s+restartPolicy:\s+OnFailure\s*$/m,
      },
    ]);
    requireInRendered(target, job, [
      {
        label: 'migration Job retains failed attempt pods (restartPolicy: Never)',
        pattern: /^\s+restartPolicy:\s+Never\s*$/m,
      },
    ]);

    const ttl = job.match(/^\s{2}ttlSecondsAfterFinished:\s+(\d+)\s*$/m);
    if (!ttl) {
      throw new Error(
        `${target} migration Job has no ttlSecondsAfterFinished; retained failure evidence ` +
          'would never be reaped.',
      );
    }
    if (Number(ttl[1]) < MIGRATION_JOB_MIN_TTL_SECONDS) {
      throw new Error(
        `${target} migration Job sets ttlSecondsAfterFinished=${ttl[1]}; at least ` +
          `${MIGRATION_JOB_MIN_TTL_SECONDS} (24h) is required so a failure from an unattended ` +
          'or overnight sync is still readable when an operator returns to it.',
      );
    }

    const deadline = job.match(/^\s{2}activeDeadlineSeconds:\s+(\d+)\s*$/m);
    if (!deadline) {
      throw new Error(
        `${target} migration Job has no activeDeadlineSeconds; a hung migration would never be ` +
          'cut off.',
      );
    }
    if (Number(deadline[1]) < MIGRATION_JOB_MIN_ACTIVE_DEADLINE_SECONDS) {
      throw new Error(
        `${target} migration Job sets activeDeadlineSeconds=${deadline[1]}; at least ` +
          `${MIGRATION_JOB_MIN_ACTIVE_DEADLINE_SECONDS} is required. On DeadlineExceeded the job ` +
          'controller DELETES the still-running pod under either restartPolicy, so a short ' +
          'deadline silently converts a retained failure into no evidence at all — and can kill ' +
          'ci-setup-db.mjs mid-file. The wait-owner-bypassrls initContainer alone may legitimately ' +
          'take 300s per attempt before any migration runs.',
      );
    }

    const backoff = job.match(/^\s{2}backoffLimit:\s+(\d+)\s*$/m);
    if (!backoff) {
      throw new Error(`${target} migration Job has no backoffLimit; retries would be unbounded.`);
    }
    if (Number(backoff[1]) < MIGRATION_JOB_MIN_BACKOFF_LIMIT) {
      throw new Error(
        `${target} migration Job sets backoffLimit=${backoff[1]}; at least ` +
          `${MIGRATION_JOB_MIN_BACKOFF_LIMIT} is required. With restartPolicy: Never each attempt ` +
          'is a separate retained pod, so 0 leaves a single attempt and no way to tell a ' +
          'deterministic migration failure from one transient DB blip.',
      );
    }
  }
}

// ── ArgoCD hook phase-ordering contract ──────────────────────────────────────
//
// THE CLASS: ArgoCD runs every PreSync hook to completion BEFORE it applies any
// Sync-phase resource. Sync waves order resources within a phase; they do not
// order across phases. So a PreSync hook that hard-requires a ConfigMap/Secret
// which this same Application only creates during Sync can never start on a
// fresh namespace — and it fails in the worst possible way:
// CreateContainerConfigError is a WAITING reason, not a pod failure, so the
// backoff counter never moves and no failed pod is ever retained; the Job runs
// to activeDeadlineSeconds and DeadlineExceeded deletes the still-running pod.
// Zero pods, zero logs, and the Sync phase that would have created the object
// is itself gated on the hook, so a retry reproduces it. Reproduced on a kind
// cluster running ArgoCD.
//
// THE RULE: a PreSync hook may reference an object this render also produces
// only if that object is itself a PreSync hook, or the reference is
// `optional: true`.
//
// DELIBERATELY NOT FLAGGED: references to objects this render does NOT produce
// (vhhealth-backend-env, ghcr-read, ...). Those are applied out of band before
// the first sync — GO_LIVE_ACTIVATION_CHECKLIST B1-B3 seals the backend Secret
// well ahead of the D2 sync — and no phase ordering inside this Application can
// affect them. Flagging them would make the guard unusable and teach people to
// silence it with `optional: true`, which for a Secret carrying DATABASE_URL
// would convert a loud failure into a mysterious one.
const HOOK_PHASE_ORDER = { PreSync: 0, Sync: 1, PostSync: 2 };

export function requireHookPhaseOrdering(target, resources) {
  // Index by kind+name. Two resources of the same kind and name cannot coexist
  // in one namespace, so this is a faithful model of what the cluster will hold.
  const rendered = new Map();
  for (const resource of resources) {
    const name = resource?.metadata?.name;
    if (typeof name === 'string' && name !== '') {
      rendered.set(`${resource.kind}/${name}`, resource);
    }
  }

  const failures = [];
  for (const resource of resources) {
    const phases = syncPhasesOf(resource);
    if (!phases.includes('PreSync')) continue;
    for (const reference of objectReferencesOf(resource)) {
      if (reference.optional) continue;
      const referenced = rendered.get(`${reference.kind}/${reference.name}`);
      if (!referenced) continue; // applied out of band — see the note above
      const referencedPhases = syncPhasesOf(referenced);
      const earliest = Math.min(
        ...referencedPhases.map((phase) => HOOK_PHASE_ORDER[phase] ?? HOOK_PHASE_ORDER.Sync),
      );
      if (earliest <= HOOK_PHASE_ORDER.PreSync) continue;
      failures.push(
        `- ${resource.kind}/${resource.metadata.name} (PreSync hook) requires ` +
          `${reference.kind}/${reference.name} at ${reference.site}, but that object is a ` +
          `${referencedPhases.join(',')}-phase resource of the same Application, so it does not ` +
          'exist yet when the hook runs.',
      );
    }
  }

  // A guard that early-returns on an empty match reports green. If this target
  // is one of the two that render the migration Job, the Job must still BE a
  // PreSync hook — otherwise the rule above has nothing to check and would pass
  // silently on a tree where the hook contract was quietly dropped.
  if (TARGETS_RENDERING_MIGRATION_JOB.has(target)) {
    const migrationJob = resources.find(
      (resource) => resource?.kind === 'Job' && resource?.metadata?.name === 'vhhealth-backend-migrate',
    );
    if (!migrationJob) {
      throw new Error(
        `${target} no longer renders a Job named vhhealth-backend-migrate, so the PreSync hook ` +
          'phase-ordering contract cannot be checked. Update this guard deliberately rather than ' +
          'letting it pass on an empty match.',
      );
    }
    if (!syncPhasesOf(migrationJob).includes('PreSync')) {
      throw new Error(
        `${target} migration Job is no longer an argocd.argoproj.io/hook: PreSync resource. The ` +
          'phase-ordering guard below only inspects PreSync hooks, so dropping the annotation ' +
          'would silence it. If the Job is deliberately becoming a Sync-phase resource, it needs ' +
          'sync-wave ordering against the ConfigMap plus Replace=true (a Job pod template is ' +
          'immutable) — change this guard deliberately.',
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${target} has PreSync hooks that consume Sync-phase resources:\n${failures.join('\n')}\n` +
        'Fix by making the referenced object a PreSync hook too (see ' +
        'infra/kubernetes/apps/backend/migration-config.yaml and ' +
        'payroll-revision-754-acceptance.yaml), or — only where the hook genuinely tolerates ' +
        'the value being absent — by marking the reference `optional: true`.',
    );
  }
}

// The role ensure-runtime-role-grants.mjs GRANTS to (read by the PreSync Job
// from vhhealth-backend-migration-config) must be the role the Deployment
// CONNECTS as (read from vhhealth-backend-config). Those are two objects
// precisely because only the first exists during PreSync, so nothing but this
// check keeps them equal — and a silent divergence would grant privileges to
// one role while the API used another.
const RUNTIME_ROLE_KEY = 'AUTH_TENANT_RLS_RUNTIME_ROLE';
const RUNTIME_CONFIG_NAME = 'vhhealth-backend-config';
const MIGRATION_CONFIG_NAME = 'vhhealth-backend-migration-config';

export function requireMigrationRuntimeRoleParity(target, resources) {
  const byName = new Map(
    resources
      .filter((resource) => resource?.kind === 'ConfigMap' && resource?.metadata?.name)
      .map((resource) => [resource.metadata.name, resource]),
  );
  const runtimeConfig = byName.get(RUNTIME_CONFIG_NAME);
  const migrationConfig = byName.get(MIGRATION_CONFIG_NAME);
  // Targets that render neither are simply not app-tier targets.
  if (!runtimeConfig && !migrationConfig) return;
  if (!runtimeConfig || !migrationConfig) {
    throw new Error(
      `${target} renders ${runtimeConfig ? RUNTIME_CONFIG_NAME : MIGRATION_CONFIG_NAME} but not ` +
        `${runtimeConfig ? MIGRATION_CONFIG_NAME : RUNTIME_CONFIG_NAME}. Both are required: the ` +
        'PreSync migration Job reads the migration ConfigMap and the Deployment reads the runtime ' +
        'one, and this guard exists to keep their runtime-role values identical.',
    );
  }
  const runtimeRole = runtimeConfig.data?.[RUNTIME_ROLE_KEY];
  const migrationRole = migrationConfig.data?.[RUNTIME_ROLE_KEY];
  if (typeof runtimeRole !== 'string' || runtimeRole.trim() === '') {
    throw new Error(
      `${target}: ${RUNTIME_CONFIG_NAME} has no ${RUNTIME_ROLE_KEY}; the backend would lose tenant ` +
        'RLS runtime-role enforcement.',
    );
  }
  if (typeof migrationRole !== 'string' || migrationRole.trim() === '') {
    throw new Error(
      `${target}: ${MIGRATION_CONFIG_NAME} has no ${RUNTIME_ROLE_KEY}; the PreSync migration Job ` +
        'would fail closed in ensure-runtime-role-grants.mjs and abort the sync.',
    );
  }
  if (runtimeRole !== migrationRole) {
    throw new Error(
      `${target}: ${RUNTIME_ROLE_KEY} is "${migrationRole}" in ${MIGRATION_CONFIG_NAME} but ` +
        `"${runtimeRole}" in ${RUNTIME_CONFIG_NAME}. The migration would grant privileges to one ` +
        'role while the API connects as another.',
    );
  }
}

function requireObjectStoreContract(target, rendered) {
  if (target !== 'infra/kubernetes/overlays/prod') return;

  const objectStores = renderedDocuments(rendered).filter(
    (document) =>
      /^apiVersion:\s+barmancloud\.cnpg\.io\/v1\s*$/m.test(document) &&
      /^kind:\s+ObjectStore\s*$/m.test(document),
  );

  if (objectStores.length !== 1) {
    throw new Error(
      `${target} must render exactly one barmancloud.cnpg.io/v1 ObjectStore; found ${objectStores.length}.`,
    );
  }

  requireInRendered(target, objectStores[0], [
    { label: 'ObjectStore metadata.name', pattern: /^metadata:\s*$[\s\S]*?^\s{2}name:\s+\S+/m },
    {
      label: 'ObjectStore spec.configuration',
      pattern: /^spec:\s*$[\s\S]*?^\s{2}configuration:\s*$/m,
    },
    { label: 'ObjectStore destinationPath', pattern: /^\s{4}destinationPath:\s+s3:\/\/\S+/m },
    { label: 'ObjectStore HTTPS endpointURL', pattern: /^\s{4}endpointURL:\s+https:\/\/\S+/m },
    { label: 'ObjectStore s3Credentials', pattern: /^\s{4}s3Credentials:\s*$/m },
  ]);
}

function requireDeviceGatewayContract(target, rendered) {
  if (target !== 'infra/kubernetes/base/device-gateway') return;

  const documents = renderedDocuments(rendered);
  const deployments = documents.filter(
    document => /^kind:\s+Deployment\s*$/m.test(document) &&
      /^\s{2}name:\s+device-gateway\s*$/m.test(document),
  );
  const configMaps = documents.filter(
    document => /^kind:\s+ConfigMap\s*$/m.test(document) &&
      /^\s{2}name:\s+device-gateway-config\s*$/m.test(document),
  );

  if (deployments.length !== 1 || configMaps.length !== 1) {
    throw new Error(
      `${target} must render exactly one device-gateway Deployment and ConfigMap.`,
    );
  }

  requireInRendered(target, deployments[0], [
    {
      label: 'required dynamic LIS token Secret before authoritative ConfigMap',
      pattern: /envFrom:\s*\n(?:\s*#.*\n)*\s*- secretRef:\s*\n\s+name:\s+device-gateway-secret\s*\n\s*- configMapRef:\s*\n\s+name:\s+device-gateway-config/,
    },
    {
      label: 'explicit device-gateway backend-token mapping',
      pattern: /name:\s+DEVICE_GATEWAY_BACKEND_TOKEN[\s\S]*?secretKeyRef:\s*\n\s+key:\s+backend-token\s*\n\s+name:\s+device-gateway-secret/,
    },
    {
      label: 'explicit device-gateway api-key mapping',
      pattern: /name:\s+DEVICE_GATEWAY_API_KEY[\s\S]*?secretKeyRef:\s*\n\s+key:\s+api-key\s*\n\s+name:\s+device-gateway-secret/,
    },
  ]);
  requireInRendered(target, configMaps[0], [
    {
      label: 'dark-by-default LIS listener profiles',
      pattern: /^\s{2}DEVICE_GATEWAY_LIS_LISTENERS:\s+['"]\[\]['"]\s*$/m,
    },
  ]);
  rejectInRendered(target, configMaps[0], [
    {
      label: 'LIS bearer token stored in the non-secret ConfigMap',
      pattern: /^\s{2}LIS_[A-Z][A-Z0-9_]*_TOKEN:/m,
    },
  ]);
}

function validateTarget(kustomize, kubeconform, target, tmpDir) {
  const rendered = run(kustomize, ['build', target]).stdout;
  const outputFile = join(tmpDir, `${target.replace(/[\\/]/g, '__')}.yaml`);
  writeFileSync(outputFile, rendered, 'utf8');

  rejectInRendered(target, rendered, [
    {
      label: 'unsupported/dangling IngressClassParameters reference',
      pattern: /^\s*kind:\s+IngressClassParameters\s*$/m,
    },
  ]);
  assertNoIngressClassParameters(rendered, target);
  requireObjectStoreContract(target, rendered);
  requireDeviceGatewayContract(target, rendered);
  requireMigrationJobEvidenceContract(target, rendered);

  const parsed = parseRenderedManifests(rendered);
  requireHookPhaseOrdering(target, parsed);
  requireMigrationRuntimeRoleParity(target, parsed);

  if (target === 'infra/kubernetes/apps') {
    requireInRendered(target, rendered, [
      { label: 'backend Deployment', pattern: /kind:\s+Deployment[\s\S]*name:\s+vhhealth-backend/ },
      { label: 'backend Service', pattern: /kind:\s+Service[\s\S]*name:\s+vhhealth-backend/ },
      { label: 'backend migration Job', pattern: /kind:\s+Job[\s\S]*name:\s+vhhealth-backend-migrate/ },
      { label: 'backend liveness probe uses /health/live', pattern: /livenessProbe:[\s\S]*path:\s+\/health\/live/ },
      {
        label: 'backend readiness probe authenticates /health/ready with monitoring token',
        pattern: /readinessProbe:[\s\S]*exec:[\s\S]*MONITORING_TOKEN[\s\S]*\/health\/ready[\s\S]*x-monitoring-token/,
      },
      { label: 'backend release worker cap is CLUSTER_WORKERS=2', pattern: /name:\s+CLUSTER_WORKERS[\s\S]*value:\s+"2"/ },
      { label: 'backend secret reference', pattern: /secretRef:[\s\S]*name:\s+vhhealth-backend-env/ },
      { label: 'admin secret reference', pattern: /secretRef:[\s\S]*name:\s+vhhealth-admin-env/ },
    ]);
  }

  const kubeconformResult = run(kubeconform, [
    '-strict',
    '-skip',
    knownExternalGvks.join(','),
    '-summary',
    outputFile,
  ]);

  const summary = kubeconformResult.stdout.trim() || kubeconformResult.stderr.trim();
  console.log(`[ok] ${target}`);
  if (summary) console.log(summary);
}

function main() {
  const kustomize = findBinary('kustomize', 'KUSTOMIZE_BIN');
  const kubeconform = findBinary('kubeconform', 'KUBECONFORM_BIN');
  const tmpDir = mkdtempSync(join(tmpdir(), 'vhhealth-k8s-'));

  try {
    for (const target of targets) {
      validateTarget(kustomize, kubeconform, target, tmpDir);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main();
}
