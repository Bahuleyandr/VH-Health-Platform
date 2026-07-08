#!/usr/bin/env node
// Static and operator-live readiness checks for the Kyverno image-signature
// policy. The checked-in manifest must stay in Audit mode; the live Enforce
// flip is an operator ceremony gated by this script's --live mode.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policyName = 'verify-vhhealth-image-signatures';
const policyPath = resolve(repoRoot, 'infra/kubernetes/base/image-policy/kyverno-verify-images.yaml');
const imagePolicyKustomizationPath = resolve(repoRoot, 'infra/kubernetes/base/image-policy/kustomization.yaml');
const baseKustomizationPath = resolve(repoRoot, 'infra/kubernetes/base/kustomization.yaml');
const defaultNamespace = 'kyverno';
const defaultPublicKeySecret = 'vhhealth-cosign-public-key';
const defaultPublicKeyName = 'cosign.pub';

function usage() {
  console.log(`Usage: node scripts/check-kyverno-enforce-readiness.mjs [--live] [options]

Default mode validates the checked-in Kyverno policy contract only. Use --live
from an operator shell to prove the live cluster has the public-key Secret and
a clean PolicyReport cycle before flipping Audit to Enforce.

Options:
  --live                         Run kubectl-backed live checks too
  --context=<name>               Kubernetes context for live checks
  --namespace=<name>             Namespace holding the public-key Secret (default: kyverno)
  --since-hours=<n>              Freshness window for pass results (default: 24; 0 disables)
  --min-pass-results=<n>         Minimum fresh pass results required in live mode (default: 1)
  --expected-action=<Audit|Enforce>
                                 Expected live validationFailureAction (default: Audit)
`);
}

function parseArgs(argv) {
  const args = {
    context: '',
    expectedAction: 'Audit',
    live: false,
    minPassResults: 1,
    namespace: defaultNamespace,
    sinceHours: 24,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--live') {
      args.live = true;
      continue;
    }
    if (arg.startsWith('--context=')) {
      args.context = arg.slice('--context='.length).trim();
      continue;
    }
    if (arg.startsWith('--namespace=')) {
      args.namespace = arg.slice('--namespace='.length).trim();
      continue;
    }
    if (arg.startsWith('--since-hours=')) {
      args.sinceHours = Number(arg.slice('--since-hours='.length));
      continue;
    }
    if (arg.startsWith('--min-pass-results=')) {
      args.minPassResults = Number(arg.slice('--min-pass-results='.length));
      continue;
    }
    if (arg.startsWith('--expected-action=')) {
      args.expectedAction = arg.slice('--expected-action='.length).trim();
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(args.sinceHours) || args.sinceHours < 0) {
    throw new Error('--since-hours must be a number >= 0');
  }
  if (!Number.isInteger(args.minPassResults) || args.minPassResults < 0) {
    throw new Error('--min-pass-results must be an integer >= 0');
  }
  if (!['Audit', 'Enforce'].includes(args.expectedAction)) {
    throw new Error('--expected-action must be Audit or Enforce');
  }
  if (!args.namespace) {
    throw new Error('--namespace cannot be empty');
  }

  return args;
}

function readRepoFile(filePath) {
  return readFileSync(filePath, 'utf8');
}

function requirePattern(label, text, pattern) {
  if (!pattern.test(text)) {
    throw new Error(`Missing static Kyverno readiness contract: ${label}`);
  }
}

function validateStaticPolicyContract() {
  const policy = readRepoFile(policyPath);
  const imagePolicyKustomization = readRepoFile(imagePolicyKustomizationPath);
  const baseKustomization = readRepoFile(baseKustomizationPath);

  requirePattern('ClusterPolicy kind', policy, /^kind:\s*ClusterPolicy\s*$/m);
  requirePattern('ClusterPolicy name', policy, new RegExp(`name:\\s*${policyName}\\s*`));
  requirePattern('checked-in policy stays in Audit mode', policy, /^\s*validationFailureAction:\s*Audit\s*$/m);
  requirePattern('admission failurePolicy fails closed', policy, /^\s*failurePolicy:\s*Fail\s*$/m);
  requirePattern('verifyImages rule exists', policy, /^\s*verifyImages:\s*$/m);
  requirePattern('GitHub keyless attestor issuer', policy, /issuer:\s*"https:\/\/token\.actions\.githubusercontent\.com"/);
  requirePattern('release and dalekdefender GitHub workflow identities', policy, /release-images\|deploy-dalekdefender/);
  requirePattern('Forgejo cosign public-key Secret name', policy, /name:\s*vhhealth-cosign-public-key/);
  requirePattern('Forgejo cosign public-key Secret namespace', policy, /namespace:\s*kyverno/);
  requirePattern('backend image reference', policy, /ghcr\.io\/bahuleyandr\/vh-health-platform-backend\*/);
  requirePattern('admin image reference', policy, /ghcr\.io\/bahuleyandr\/vh-health-platform-adminportal\*/);
  requirePattern('staff-web image reference', policy, /ghcr\.io\/bahuleyandr\/vhhealth-staff-web\*/);
  requirePattern('mutateDigest true', policy, /^\s*mutateDigest:\s*true\s*$/m);
  requirePattern('verifyDigest true', policy, /^\s*verifyDigest:\s*true\s*$/m);
  requirePattern('verifyImages required true', policy, /^\s*required:\s*true\s*$/m);
  requirePattern('image-policy kustomization includes policy', imagePolicyKustomization, /-\s*kyverno-verify-images\.yaml/);
  requirePattern('base kustomization includes image-policy', baseKustomization, /^\s*-\s*image-policy\s*$/m);

  console.log(`[kyverno-readiness] static policy contract OK (${relative(repoRoot, policyPath)})`);
}

function kubectl(args, options) {
  const kubectlArgs = [];
  if (options.context) kubectlArgs.push('--context', options.context);
  kubectlArgs.push(...args);

  const result = spawnSync('kubectl', kubectlArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(
      `kubectl ${kubectlArgs.join(' ')} failed` +
        (stderr ? `\n${stderr}` : '') +
        (stdout ? `\n${stdout}` : ''),
    );
  }

  return result.stdout;
}

function kubectlJson(args, options) {
  const stdout = kubectl([...args, '-o', 'json'], options);
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`kubectl ${args.join(' ')} returned invalid JSON: ${err.message}`);
  }
}

function timestampMillis(timestamp) {
  if (!timestamp) return null;
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof timestamp === 'object' && timestamp.seconds != null) {
    const seconds = Number(timestamp.seconds);
    const nanos = Number(timestamp.nanos || 0);
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    return seconds * 1000 + Math.floor(nanos / 1_000_000);
  }
  return null;
}

function collectPolicyReportResults(...lists) {
  const rows = [];
  for (const list of lists) {
    for (const item of list.items || []) {
      for (const result of item.results || []) {
        rows.push({
          kind: item.kind || list.kind || 'PolicyReport',
          name: item.metadata?.name || '(unknown)',
          namespace: item.metadata?.namespace || '',
          policy: result.policy || '',
          result: String(result.result || '').toLowerCase(),
          rule: result.rule || '',
          timestamp: result.timestamp,
        });
      }
    }
  }
  return rows;
}

function validateLiveCluster(args) {
  const secret = kubectlJson(
    ['get', 'secret', defaultPublicKeySecret, '-n', args.namespace],
    args,
  );
  if (!secret.data?.[defaultPublicKeyName]) {
    throw new Error(
      `Secret ${args.namespace}/${defaultPublicKeySecret} is missing data key ${defaultPublicKeyName}`,
    );
  }
  console.log(`[kyverno-readiness] public-key Secret present: ${args.namespace}/${defaultPublicKeySecret}`);

  const policy = kubectlJson(['get', 'clusterpolicy', policyName], args);
  const liveAction = policy.spec?.validationFailureAction || '';
  if (liveAction !== args.expectedAction) {
    throw new Error(
      `Live ClusterPolicy ${policyName} has validationFailureAction=${liveAction || '(missing)'}, expected ${args.expectedAction}`,
    );
  }
  if (policy.spec?.failurePolicy !== 'Fail') {
    throw new Error(`Live ClusterPolicy ${policyName} must keep failurePolicy=Fail`);
  }
  console.log(`[kyverno-readiness] live ClusterPolicy present with validationFailureAction=${liveAction}`);

  const policyReports = kubectlJson(['get', 'policyreport', '-A'], args);
  const clusterPolicyReports = kubectlJson(['get', 'clusterpolicyreport'], args);
  const matching = collectPolicyReportResults(policyReports, clusterPolicyReports).filter(
    (row) => row.policy === policyName,
  );
  if (matching.length === 0) {
    throw new Error(`No PolicyReport results found for policy ${policyName}; wait for a full Audit-mode sync`);
  }

  const unexpected = matching.filter((row) => ['error', 'fail', 'warn'].includes(row.result));
  if (unexpected.length > 0) {
    const summary = unexpected
      .slice(0, 10)
      .map((row) => `${row.namespace ? `${row.namespace}/` : ''}${row.name}:${row.rule}:${row.result}`)
      .join(', ');
    throw new Error(
      `PolicyReport has ${unexpected.length} unexpected ${policyName} result(s): ${summary}`,
    );
  }

  const passResults = matching.filter((row) => row.result === 'pass');
  const cutoff = args.sinceHours > 0 ? Date.now() - args.sinceHours * 60 * 60 * 1000 : 0;
  const freshPassResults = args.sinceHours > 0
    ? passResults.filter((row) => {
        const millis = timestampMillis(row.timestamp);
        return millis != null && millis >= cutoff;
      })
    : passResults;

  if (freshPassResults.length < args.minPassResults) {
    throw new Error(
      `Need at least ${args.minPassResults} fresh pass result(s) for ${policyName}; found ${freshPassResults.length}. ` +
        `Use --since-hours=0 only if the operator separately records the clean-cycle timestamp.`,
    );
  }

  console.log(
    `[kyverno-readiness] PolicyReport clean: ${freshPassResults.length} fresh pass result(s), ` +
      `${unexpected.length} fail/warn/error result(s)`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  validateStaticPolicyContract();
  if (!args.live) {
    console.log('[kyverno-readiness] live checks skipped; run with --live before any Enforce flip.');
    return;
  }
  validateLiveCluster(args);
}

try {
  main();
} catch (err) {
  console.error(`[kyverno-readiness] FAIL: ${err.message}`);
  process.exit(1);
}
