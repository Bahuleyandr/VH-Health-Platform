import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const checks = [];

function check(name, predicate) {
  checks.push({ name, predicate });
}

const backendApp = read('apps/backend/src/app.js');
const backendAllowlist = read('apps/backend/src/middleware/ipAllowlistMiddleware.js');
const backendDockerfile = read('apps/backend/Dockerfile');
const adminMiddleware = read('apps/admin/src/middleware.ts');
const adminDockerfile = read('apps/admin/Dockerfile');
const staffWebDockerfile = read('apps/staff/Dockerfile.web');
const mcpIndex = read('infra/mcp/vh-mcp-postgres/index.js');
const mcpK8s = read('infra/mcp/vh-mcp-postgres/k8s.yaml');
const forgejoReleaseImages = read('.forgejo/workflows/release-images.yml');
const forgejoDalekDeploy = read('.forgejo/workflows/deploy-dalekdefender.yml');
const forgejoContainerSupplyChain = read('.forgejo/workflows/container-supply-chain.yml');
const githubReleaseImages = read('.github/workflows/release-images.yml');
const githubDalekDeploy = read('.github/workflows/deploy-dalekdefender.yml');

const sha256Digest = '@sha256:[a-f0-9]{64}';

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

check('release workflows keep backend base image overrides digest-pinned', () => {
  const combined = `${forgejoReleaseImages}\n${forgejoDalekDeploy}\n${forgejoContainerSupplyChain}\n${githubReleaseImages}\n${githubDalekDeploy}`;
  return !/NODE_IMAGE=(?![^\r\n]*@sha256:[a-f0-9]{64})/m.test(combined);
});

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
