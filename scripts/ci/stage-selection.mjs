import { execFileSync } from 'node:child_process';
import process from 'node:process';

const fullRunPatterns = [
  /^\.forgejo\/workflows\//,
  /^\.github\/workflows\//,
  /^scripts\/ci\//,
  /^scripts\/local-ci\.mjs$/,
];

const backendPatterns = [/^apps\/backend\//];
const adminPatterns = [/^apps\/admin\//];
const flutterPatterns = [
  /^apps\/patient\//,
  /^apps\/staff\//,
  /^packages\//,
  /^pubspec\.ya?ml$/,
  /^pubspec\.lock$/,
  /^scripts\/dart-format-check\.mjs$/,
  // The docs-vs-pubspec plugin-version gate and the two docs it guards. The
  // docs are listed even though `isKnownSecurityOnly` already treats *.md as
  // known: that only keeps a docs edit from forcing a full sweep, it does not
  // select the flutter stage, so without these a docs-only change would skip
  // the very check that exists to police it.
  /^scripts\/check-docs-plugin-versions\.mjs$/,
  /^scripts\/check-docs-plugin-versions\.test\.mjs$/,
  /^docs\/FLUTTER_PLUGIN_MAJOR_MIGRATIONS\.md$/,
  /^docs\/SMOKE_E2E_JOURNEYS\.md$/,
];
const fhirPatterns = [
  /^apps\/backend\/src\/services\/fhir\//,
  /^scripts\/ci\/fhir\.mjs$/,
];
// The client/server path contract spans every client tree AND the generated
// spec that defines what the server serves, so either side must be able to
// select it. Deliberately NOT part of the `known` calculation below: these
// paths keep whatever full-run behaviour they already had, and this only ever
// ADDS the contracts stage. Mirrors the path filter in ci-client-contract.yml.
const contractsPatterns = [
  /^apps\/admin\/src\//,
  /^apps\/patient\/lib\//,
  /^apps\/staff\/lib\//,
  /^packages\/vhhealth_core\/lib\//,
  /^apps\/device-gateway\/src\//,
  /^apps\/backend\/src\/docs\/openapi\.json$/,
  /^apps\/backend\/src\/app\.js$/,
];
// The gateway is an independent npm package with its own lint + Jest suite
// (_reusable-device-gateway-ci.yml). Its src/ tree ALSO selects contracts via
// contractsPatterns above; this stage adds the unit gate the contracts run
// does not provide.
const gatewayPatterns = [/^apps\/device-gateway\//];
const infraPatterns = [
  /^infra\/kubernetes\//,
  /^docs\/CNPG_POSTGRES_18_QUALIFICATION\.md$/,
  /^docs\/DEPLOYMENT_GUIDE\.md$/,
  /^scripts\/validate-kubernetes-manifests\.mjs$/,
  /^scripts\/check-c1-1-manifest-contract\.mjs$/,
  /^scripts\/check-c1-1-manifest-contract\.test\.mjs$/,
  /^scripts\/c1-1-backup-scripts\.test\.mjs$/,
  /^scripts\/check-kyverno-enforce-readiness\.mjs$/,
  /^scripts\/check-prod-digests-pinned\.mjs$/,
  /^scripts\/check-prod-digests-pinned\.test\.mjs$/,
  /^scripts\/check-prod-helm-image-inventory\.mjs$/,
  /^scripts\/check-prod-helm-image-inventory\.test\.mjs$/,
  /^scripts\/update-prod-digests\.mjs$/,
  /^scripts\/update-prod-digests\.test\.mjs$/,
];
// Inputs the infra gates READ that are owned by some other stage's tree. Those
// paths are already `known` below, so the unknown-file full-sweep fallback
// never fires for them and the infra tier was skipped outright: PR #949 changed
// only apps/backend/Dockerfile, apps/admin/Dockerfile and
// apps/staff/Dockerfile.web, and came back green with BOTH `quick_infra` and
// `full_infra` SKIPPED — while scripts/backend-image-command-contract.test.mjs,
// the one gate that parses apps/backend/Dockerfile into an image model and
// validates every infra/kubernetes/apps/backend command against it, is invoked
// only from scripts/ci/infra.mjs and _reusable-kubernetes-manifests.yml.
//
// Deliberately NOT part of the `known` calculation below, exactly like
// contractsPatterns: this list only ever ADDS the infra stage, so a path that
// forces a full sweep today keeps forcing one.
const infraInputPatterns = [
  // Container build definitions. backend-image-command-contract parses
  // apps/backend/Dockerfile into the image model it checks every manifest
  // command against; the admin and staff images the same overlays deploy are
  // built from theirs, and scripts/ci/forgejo-buildkit-builder.mjs — contract
  // tested inside this stage — names all three as its build inputs.
  /^apps\/[^/]+\/Dockerfile(\.[^/]+)?$/,
  // Everything that same contract resolves *inside* the image: the `npm run`
  // script table it maps aliases through, the CMD/HEALTHCHECK target, and the
  // repo file behind every `node <script>` a backend manifest invokes.
  /^apps\/backend\/package\.json$/,
  /^apps\/backend\/src\/cluster\.js$/,
  /^apps\/backend\/scripts\//,
  // Prose the infra gates hold to the manifests: infra-truthfulness asserts the
  // MinIO capacity arithmetic against docs/HARDWARE_REQUIREMENTS.md and the
  // backend-Service anchors against apps/device-gateway/README.md, and
  // canonical-workflow asserts the `[full-ci]` merge boundary in CLAUDE.md.
  /^CLAUDE\.md$/,
  /^docs\/HARDWARE_REQUIREMENTS\.md$/,
  /^apps\/device-gateway\/README\.md$/,
  // The non-Kubernetes infra trees these jobs also run: infra/forgejo's
  // ci-image Dockerfile (supply-chain pins), infra/cloudflare (zero-trust
  // pack), infra/continuity-edge (`npm test --prefix` in the reusable
  // workflow). Unknown to every stage today, so they still force a full sweep;
  // listing them keeps infra selected if that ever stops being true.
  /^infra\//,
];
const securityOnlyPatterns = [
  /^docs\//,
  /^README\.md$/i,
  /^LICENSE$/i,
  /^AGENTS\.md$/i,
  /^\.gitignore$/,
  /^\.gitleaks\.toml$/,
  /^lefthook\.yml$/,
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function gitMaybe(args) {
  try {
    return git(args);
  } catch {
    return '';
  }
}

function diffBaseForBranchPush() {
  const base = gitMaybe(['merge-base', 'HEAD', 'origin/main']);
  if (!base) {
    throw new Error('Unable to resolve the complete branch delta against origin/main');
  }
  return base;
}

export function shouldSelectChangedStages() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const ref = process.env.GITHUB_REF || '';
  return eventName === 'push' && ref.startsWith('refs/heads/') && ref !== 'refs/heads/main';
}

export function changedFilesForBranchPush() {
  const base = diffBaseForBranchPush();
  const output = git(['diff', '--name-only', `${base}..HEAD`]);
  return output
    .split(/\r?\n/)
    .map((file) => file.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

function isKnownSecurityOnly(file) {
  return matchesAny(file, securityOnlyPatterns) || /\.md$/i.test(file);
}

export function stagesForChangedFiles(files, stageOrder) {
  if (files.length === 0) return [...stageOrder];
  if (files.some((file) => matchesAny(file, fullRunPatterns))) return [...stageOrder];

  const selected = new Set(['security']);
  let unknownRiskyFile = false;

  for (const file of files) {
    if (matchesAny(file, contractsPatterns)) selected.add('contracts');
    if (matchesAny(file, backendPatterns)) selected.add('backend');
    if (matchesAny(file, adminPatterns)) selected.add('admin');
    if (matchesAny(file, flutterPatterns)) selected.add('flutter');
    if (matchesAny(file, fhirPatterns)) selected.add('fhir');
    if (matchesAny(file, gatewayPatterns)) selected.add('gateway');
    if (matchesAny(file, infraPatterns) || matchesAny(file, infraInputPatterns)) {
      selected.add('infra');
    }

    const known =
      matchesAny(file, backendPatterns) ||
      matchesAny(file, adminPatterns) ||
      matchesAny(file, flutterPatterns) ||
      matchesAny(file, fhirPatterns) ||
      matchesAny(file, gatewayPatterns) ||
      matchesAny(file, infraPatterns) ||
      isKnownSecurityOnly(file);

    if (!known) unknownRiskyFile = true;
  }

  if (unknownRiskyFile) return [...stageOrder];
  return stageOrder.filter((stage) => selected.has(stage));
}
