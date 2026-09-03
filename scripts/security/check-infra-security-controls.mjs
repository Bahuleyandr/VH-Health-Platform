import fs from 'node:fs';
import path from 'node:path';
import { PATCHED_DEPENDENCY_FLOORS, dependencyViolations } from './dependency-floors.mjs';

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

const checks = [];

function check(name, predicate) {
  checks.push({ name, predicate });
}

const backendApp = read('apps/backend/src/app.js');
const backendAllowlist = read('apps/backend/src/middleware/ipAllowlistMiddleware.js');
const backendDockerfile = read('apps/backend/Dockerfile');
const backendPackage = JSON.parse(read('apps/backend/package.json'));
const backendCi = read('scripts/ci/backend.mjs');
const backendLock = JSON.parse(read('apps/backend/package-lock.json'));
const adminMiddleware = read('apps/admin/src/middleware.ts');
const adminDockerfile = read('apps/admin/Dockerfile');
const adminPackage = JSON.parse(read('apps/admin/package.json'));
const adminLock = JSON.parse(read('apps/admin/package-lock.json'));
const staffWebDockerfile = read('apps/staff/Dockerfile.web');
const mcpIndex = read('infra/mcp/vh-mcp-postgres/index.js');
const mcpK8s = read('infra/mcp/vh-mcp-postgres/k8s.yaml');
const forgejoReleaseImages = read('.forgejo/workflows/release-images.yml');
const forgejoDalekDeploy = read('.forgejo/workflows/deploy-dalekdefender.yml');
const forgejoContainerSupplyChain = read('.forgejo/workflows/container-supply-chain.yml');
const forgejoSecuritySweep = read('.forgejo/workflows/security-sweep.yml');
const forgejoBuildkitHelper = read('scripts/ci/forgejo-buildkit-builder.mjs');
const forgejoCosignPublicKey = read('infra/forgejo/signing/cosign.pub');
const githubReleaseImages = read('.github/workflows/release-images.yml');
const githubDalekDeploy = read('.github/workflows/deploy-dalekdefender.yml');
const backendIngress = read('infra/kubernetes/apps/backend/ingress.yaml');

const sha256Digest = '@sha256:[a-f0-9]{64}';
// OPEN-22 (2026-09-03): the install used to copy a patch script into every
// `npm ci` stage and rewrite node_modules from postinstall. That is retired;
// each install stage may copy ONLY the manifests before `npm ci`, and nothing
// under scripts/ may be named like an install-time compatibility patch.
const MANIFEST_COPY = /^COPY package\.json package-lock\.json\*? \.\/$/;
function installStagesCopyOnlyManifestsBeforeNpmCi(dockerfile, expectedStageCount) {
  const installStages = dockerfile
    .split(/^FROM /m)
    .filter((stage) => stage.includes('RUN npm ci'));
  return (
    installStages.length === expectedStageCount &&
    installStages.every((stage) => {
      const beforeInstall = stage.slice(0, stage.indexOf('RUN npm ci'));
      const copies = beforeInstall
        .split(/\r?\n/)
        .filter((line) => /^COPY\b/.test(line));
      return copies.length === 1 && MANIFEST_COPY.test(copies[0]);
    })
  );
}

const GUARDED_DEPENDENCIES = Object.keys(PATCHED_DEPENDENCY_FLOORS);
function lockfileMeetsPatchedFloors(lockfile) {
  return GUARDED_DEPENDENCIES.every(
    (dependency) => dependencyViolations(lockfile, dependency).length === 0,
  );
}

check('backend HTTPS redirect does not reflect req.headers.host', () =>
  !/https:\/\/\$\{req\.headers\.host\}/.test(backendApp) &&
  backendApp.includes('getCanonicalHttpsOrigin') &&
  backendApp.includes('toSafeRedirectPath'));

check('backend admin IP allowlist fails closed in production', () =>
  backendAllowlist.includes('ADMIN_IP_ALLOWLIST_REQUIRED') &&
  backendAllowlist.includes('isProductionRuntime'));

check('SMS callback path bearer is excluded from ingress access logs', () =>
  /name:\s*vhhealth-backend-sms-webhooks[\s\S]*?nginx\.ingress\.kubernetes\.io\/enable-access-log:\s*"false"[\s\S]*?path:\s*\/webhooks\/sms\s*\n\s*pathType:\s*Prefix/.test(backendIngress) &&
  (backendIngress.match(/path:\s*\/webhooks\/sms\s*$/gm) || []).length === 2);

check('admin middleware uses trusted production redirect origin', () =>
  adminMiddleware.includes('trustedRedirectBase') &&
  adminMiddleware.includes('ADMIN_CANONICAL_ORIGIN'));

check('admin middleware fails closed when production allowlist is empty', () =>
  adminMiddleware.includes('return !isProductionRuntime()') &&
  adminMiddleware.includes('ADMIN_IP_ALLOWLIST'));

check('admin Dockerfile does not persist SENTRY_AUTH_TOKEN as ARG/ENV', () =>
  !/^ARG SENTRY_AUTH_TOKEN$/m.test(adminDockerfile) &&
  !/^ENV SENTRY_AUTH_TOKEN=/m.test(adminDockerfile));

check('release Dockerfiles use digest-pinned base image defaults', () =>
  new RegExp(`^ARG NODE_IMAGE=node:26\.5\.0-alpine${sha256Digest}$`, 'm').test(backendDockerfile) &&
  new RegExp(`^ARG NODE_IMAGE=node:26\.5\.0-alpine${sha256Digest}$`, 'm').test(adminDockerfile) &&
  new RegExp(`^ARG BUILD_IMAGE=debian:12-slim${sha256Digest}$`, 'm').test(staffWebDockerfile) &&
  /^ARG FLUTTER_VERSION=3\.47\.0$/m.test(staffWebDockerfile) &&
  /^ARG FLUTTER_SHA256=[a-f0-9]{64}$/m.test(staffWebDockerfile) &&
  new RegExp(`^ARG NGINX_IMAGE=nginx:1\\.27-alpine${sha256Digest}$`, 'm').test(staffWebDockerfile) &&
  !/^FROM (node|nginx|debian|ghcr\.io\/cirruslabs\/flutter):/m.test(`${backendDockerfile}\n${adminDockerfile}\n${staffWebDockerfile}`));

check('no app runs an install-time dependency mutation from postinstall', () =>
  backendPackage.scripts.postinstall === undefined &&
  adminPackage.scripts.postinstall === undefined &&
  !fs.existsSync(path.join(repoRoot, 'apps/backend/scripts/patch-minimatch-compat.mjs')) &&
  !fs.existsSync(path.join(repoRoot, 'apps/admin/scripts/patch-minimatch-compat.mjs')) &&
  !fs.existsSync(path.join(repoRoot, 'apps/admin/scripts/patch-redocly-js-yaml-compat.mjs')) &&
  !fs.readdirSync(path.join(repoRoot, 'apps/backend/scripts')).some((name) => /^patch-.*-compat\.mjs$/.test(name)) &&
  !fs.readdirSync(path.join(repoRoot, 'apps/admin/scripts')).some((name) => /^patch-.*-compat\.mjs$/.test(name)));

check('Docker install stages copy only the manifests before npm ci', () =>
  installStagesCopyOnlyManifestsBeforeNpmCi(backendDockerfile, 2) &&
  installStagesCopyOnlyManifestsBeforeNpmCi(adminDockerfile, 1) &&
  !/patch-[a-z-]+\.mjs/.test(`${backendDockerfile}\n${adminDockerfile}`));

check('minimatch, brace-expansion and js-yaml resolve natively at patched releases in both apps', () =>
  backendPackage.overrides?.minimatch === undefined &&
  adminPackage.overrides?.minimatch === undefined &&
  adminPackage.overrides?.['@redocly/openapi-core'] === undefined &&
  lockfileMeetsPatchedFloors(backendLock) &&
  lockfileMeetsPatchedFloors(adminLock));

check('release workflows keep backend base image overrides digest-pinned', () => {
  const workflowBuilds = `${forgejoReleaseImages}\n${forgejoDalekDeploy}\n${forgejoContainerSupplyChain}\n${githubReleaseImages}\n${githubDalekDeploy}`;
  return !/NODE_IMAGE=(?![^\r\n]*@sha256:[a-f0-9]{64})/m.test(workflowBuilds) &&
    new RegExp(`^  'mirror\\.gcr\\.io/library/node:26\\.5\\.0-alpine${sha256Digest}';$`, 'm')
      .test(forgejoBuildkitHelper) &&
    forgejoBuildkitHelper.includes('`NODE_IMAGE=${NODE_IMAGE}`');
});

check('backend generation stays within the Forgejo runner memory budget', () =>
  backendDockerfile.includes(
    'RUN NODE_OPTIONS=--max-old-space-size=4096 npx prisma generate',
  ) && backendCi.includes("NODE_OPTIONS: '--max-old-space-size=4096'"));

// Every runtime image must apply Alpine security updates UNSCOPED.
//
// This was previously `staffWebDockerfile.includes('RUN apk upgrade --no-cache')`
// on staff-web alone, which enforced nothing: the scoped form
// `RUN apk upgrade --no-cache libcrypto3 libssl3 c-ares` STARTS WITH that exact
// substring, so a re-narrowed list passed the check. A hand-maintained package
// list can only ever patch the CVEs someone already looked up, and it leaves the
// rest of the base image (musl, zlib, busybox, libstdc++, ca-certificates-bundle)
// permanently unpatchable behind a blocking Trivy gate -- which is how
// CVE-2026-14456 and CVE-2026-26740 each wedged the deploy.
//
// Line-anchored so the only thing permitted after --no-cache is `&&` or the line
// continuation. A package list fails.
const UNSCOPED_APK_UPGRADE = /^RUN apk upgrade --no-cache(?:\s+&&)?\s*\\?$/m;

check('runtime images apply Alpine security updates unscoped', () =>
  UNSCOPED_APK_UPGRADE.test(staffWebDockerfile) &&
  UNSCOPED_APK_UPGRADE.test(backendDockerfile) &&
  UNSCOPED_APK_UPGRADE.test(adminDockerfile));

// Dockerfile.web installs the official Flutter linux tarball, which is
// published for x64 ONLY (no linux-arm64 stable tarball exists in the Flutter
// release manifest — checked 2026-08-16). A multi-arch build would run x64
// toolchain binaries under an arm64 userland and publish an arch it never
// verified, so both release workflows must keep the staff-web build
// constrained to linux/amd64 while the Dockerfile stays x64-tarball-only.
check('staff web image builds stay amd64-only while Flutter ships no linux-arm64 SDK', () =>
  staffWebDockerfile.includes('this image is linux/amd64-ONLY') &&
  /file: \.\/apps\/staff\/Dockerfile\.web[\s\S]{0,900}?platforms: linux\/amd64\n/.test(githubReleaseImages) &&
  forgejoReleaseImages.includes('build_platforms="linux/amd64"'));

check('Forgejo admin image builds provide the backend named context', () =>
  forgejoContainerSupplyChain.includes(
    "build_contexts: '--build-context backend=apps/backend'",
  ) &&
  forgejoDalekDeploy.includes(
    'node scripts/ci/forgejo-buildkit-builder.mjs build dalek',
  ) &&
  forgejoReleaseImages.includes(
    'node scripts/ci/forgejo-buildkit-builder.mjs build release',
  ) &&
  (forgejoBuildkitHelper.match(/buildContexts: \['backend=apps\/backend'\]/g) || []).length === 2);

check('Forgejo image scans use resilient official Trivy DB fallbacks', () => {
  const workflows = [
    forgejoContainerSupplyChain,
    forgejoDalekDeploy,
    forgejoReleaseImages,
    forgejoSecuritySweep,
  ];
  return workflows.every(
    (workflow) =>
      workflow.includes(
        '--db-repository public.ecr.aws/aquasecurity/trivy-db:2',
      ) &&
      workflow.includes('--db-repository docker.io/aquasec/trivy-db:2'),
  );
});

check('Forgejo Dalekdefender transport fails closed on missing prerequisites', () =>
  forgejoDalekDeploy.includes(
    'forgejo-deploy-preflight.mjs --mode dalek-deploy',
  ) &&
  !forgejoDalekDeploy.includes(
    'forgejo-deploy-preflight.mjs --mode dalek-deploy --allow-skip',
  ));

check('Forgejo signing public key is retained for admission verification', () =>
  /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----\n$/.test(
    forgejoCosignPublicKey,
  ));

check('MCP bridge rejects query-string tokens', () =>
  !mcpIndex.includes('req.query.token') &&
  mcpIndex.includes('bearerTokenFromHeader'));

check('MCP bridge refuses privileged database roles', () =>
  mcpIndex.includes('rolsuper') &&
  mcpIndex.includes('rolbypassrls') &&
  mcpIndex.includes('default_transaction_read_only'));

check('MCP Kubernetes service remains ClusterIP with no NodePort', () =>
  /type:\s*ClusterIP/.test(mcpK8s) &&
  !/type:\s*NodePort/i.test(mcpK8s) &&
  !/nodePort:/i.test(mcpK8s));

check('Forgejo release image job does not pass SENTRY_AUTH_TOKEN as build arg', () =>
  !forgejoReleaseImages.includes('SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN') &&
  !forgejoReleaseImages.includes('--build-arg "SENTRY_AUTH_TOKEN='));

check('Forgejo secret-bearing jobs do not execute downloaded install scripts', () => {
  const combined = `${forgejoReleaseImages}\n${forgejoDalekDeploy}`;
  return !/curl[\s\S]{0,160}\|\s*sh\b/.test(combined) &&
    !/curl[\s\S]{0,160}\|\s*bash\b/.test(combined);
});

const failures = checks
  .filter(({ predicate }) => !predicate())
  .map(({ name }) => name);

if (failures.length > 0) {
  console.error('Infrastructure security control checks failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Infrastructure security control checks passed (${checks.length} checks).`);
