import fs from 'node:fs';
import path from 'node:path';

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
const backendMinimatchPatch = read('apps/backend/scripts/patch-minimatch-compat.mjs');
const adminMiddleware = read('apps/admin/src/middleware.ts');
const adminDockerfile = read('apps/admin/Dockerfile');
const adminPackage = JSON.parse(read('apps/admin/package.json'));
const adminMinimatchPatch = read('apps/admin/scripts/patch-minimatch-compat.mjs');
const staffWebDockerfile = read('apps/staff/Dockerfile.web');
const mcpIndex = read('infra/mcp/vh-mcp-postgres/index.js');
const mcpK8s = read('infra/mcp/vh-mcp-postgres/k8s.yaml');
const forgejoReleaseImages = read('.forgejo/workflows/release-images.yml');
const forgejoDalekDeploy = read('.forgejo/workflows/deploy-dalekdefender.yml');
const forgejoContainerSupplyChain = read('.forgejo/workflows/container-supply-chain.yml');
const forgejoSecuritySweep = read('.forgejo/workflows/security-sweep.yml');
const forgejoCosignPublicKey = read('infra/forgejo/signing/cosign.pub');
const githubReleaseImages = read('.github/workflows/release-images.yml');
const githubDalekDeploy = read('.github/workflows/deploy-dalekdefender.yml');

const sha256Digest = '@sha256:[a-f0-9]{64}';
const minimatchPatchCopy =
  'COPY scripts/patch-minimatch-compat.mjs ./scripts/patch-minimatch-compat.mjs';
const redoclyPatchCopy =
  'COPY scripts/patch-redocly-js-yaml-compat.mjs ./scripts/patch-redocly-js-yaml-compat.mjs';

function installStagesCopyPostinstallPatches(
  dockerfile,
  expectedStageCount,
  expectedCopies,
) {
  const installStages = dockerfile
    .split(/^FROM /m)
    .filter((stage) => stage.includes('RUN npm ci'));
  return (
    installStages.length === expectedStageCount &&
    installStages.every(
      (stage) =>
        expectedCopies.every(
          (copy) =>
            stage.indexOf(copy) >= 0 &&
            stage.indexOf(copy) < stage.indexOf('RUN npm ci'),
        ),
    )
  );
}

check('backend HTTPS redirect does not reflect req.headers.host', () =>
  !/https:\/\/\$\{req\.headers\.host\}/.test(backendApp) &&
  backendApp.includes('getCanonicalHttpsOrigin') &&
  backendApp.includes('toSafeRedirectPath'));

check('backend admin IP allowlist fails closed in production', () =>
  backendAllowlist.includes('ADMIN_IP_ALLOWLIST_REQUIRED') &&
  backendAllowlist.includes('isProductionRuntime'));

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
  new RegExp(`^ARG FLUTTER_IMAGE=ghcr\\.io/cirruslabs/flutter:3\\.44\\.0${sha256Digest}$`, 'm').test(staffWebDockerfile) &&
  new RegExp(`^ARG NGINX_IMAGE=nginx:1\\.27-alpine${sha256Digest}$`, 'm').test(staffWebDockerfile) &&
  !/^FROM (node|nginx|ghcr\.io\/cirruslabs\/flutter):/m.test(`${backendDockerfile}\n${adminDockerfile}\n${staffWebDockerfile}`));

check('container npm postinstall hooks remain inside each Docker build context', () =>
  backendPackage.scripts.postinstall ===
    'node scripts/patch-minimatch-compat.mjs' &&
  adminPackage.scripts.postinstall ===
    'node scripts/patch-minimatch-compat.mjs && node scripts/patch-redocly-js-yaml-compat.mjs' &&
  backendMinimatchPatch === adminMinimatchPatch &&
  installStagesCopyPostinstallPatches(backendDockerfile, 2, [
    minimatchPatchCopy,
  ]) &&
  installStagesCopyPostinstallPatches(adminDockerfile, 1, [
    minimatchPatchCopy,
    redoclyPatchCopy,
  ]));

check('release workflows keep backend base image overrides digest-pinned', () => {
  const combined = `${forgejoReleaseImages}\n${forgejoDalekDeploy}\n${forgejoContainerSupplyChain}\n${githubReleaseImages}\n${githubDalekDeploy}`;
  return !/NODE_IMAGE=(?![^\r\n]*@sha256:[a-f0-9]{64})/m.test(combined);
});

check('backend generation stays within the Forgejo runner memory budget', () =>
  backendDockerfile.includes(
    'RUN NODE_OPTIONS=--max-old-space-size=4096 npx prisma generate',
  ) && backendCi.includes("NODE_OPTIONS: '--max-old-space-size=4096'"));

check('staff web runtime applies Alpine security updates', () =>
  staffWebDockerfile.includes('RUN apk upgrade --no-cache'));

check('Forgejo admin image builds provide the backend named context', () =>
  forgejoContainerSupplyChain.includes(
    "build_contexts: '--build-context backend=apps/backend'",
  ) &&
  forgejoDalekDeploy.includes('--build-context backend=apps/backend') &&
  forgejoReleaseImages.includes(
    'build_context_args+=(--build-context "backend=apps/backend")',
  ));

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

check('Forgejo Dalekdefender transport fails closed as a clean skip', () =>
  forgejoDalekDeploy.includes(
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
