#!/usr/bin/env node
// Render both ArgoCD production roots, inventory the exact images Kubernetes
// would pull, and verify every active tag@digest against its live registry.
// The three platform-owned application placeholders are an explicit held state:
// they are accepted only in the apps root, only for the exact repositories
// below, and only as the all-zero fail-closed digest.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
export const repoRoot = resolve(dirname(thisFile), '..');

export const PRODUCTION_ROOTS = [
  'infra/kubernetes/overlays/prod',
  'infra/kubernetes/apps',
];

export const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export const HELD_APP_REPOSITORIES = new Set([
  'ghcr.io/bahuleyandr/vh-health-platform-backend',
  'ghcr.io/bahuleyandr/vh-health-platform-adminportal',
  'ghcr.io/bahuleyandr/vhhealth-staff-web',
]);

// These reviewed platform images must remain real multi-architecture indexes,
// not architecture-specific manifests. Application release images may be
// single-platform, so they are deliberately outside this policy.
export const MULTI_ARCH_PLATFORM_REPOSITORIES = new Set([
  'docker.io/library/redis',
  'docker.io/oliver006/redis_exporter',
  'docker.io/library/busybox',
  'docker.io/hashicorp/vault',
  'docker.io/smallstep/step-ca',
  'docker.io/bitnami/sealed-secrets-controller',
  'docker.io/cloudflare/cloudflared',
  'ghcr.io/kubereboot/kured',
]);

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const INDEX_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

function candidateNames(name) {
  return process.platform === 'win32' ? [name, `${name}.exe`] : [name];
}

export function findKustomize() {
  const explicit = process.env.KUSTOMIZE_BIN;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`KUSTOMIZE_BIN does not exist: ${explicit}`);
    }
    return explicit;
  }

  const searchDirs = String(process.env.PATH || '').split(delimiter);
  if (process.platform === 'win32') searchDirs.push('D:\\Dev\\Tools\\kubetools');
  for (const dir of searchDirs) {
    if (!dir) continue;
    for (const candidate of candidateNames('kustomize')) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) return fullPath;
    }
  }
  return 'kustomize';
}

export function extractRenderedImages(rendered, target) {
  const images = [];
  for (const [index, line] of rendered.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:-\s*)?image:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/);
    if (match) images.push({ ref: match[1], target, line: index + 1 });
  }
  return images;
}

export function renderProductionImages({
  roots = PRODUCTION_ROOTS,
  cwd = repoRoot,
  kustomize = findKustomize(),
  execFile = execFileSync,
} = {}) {
  const occurrences = [];
  for (const target of roots) {
    const rendered = execFile(kustomize, ['build', target], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const targetImages = extractRenderedImages(rendered, target);
    if (targetImages.length === 0) {
      throw new Error(`${target}: rendered successfully but contained no image references`);
    }
    occurrences.push(...targetImages);
  }
  return occurrences;
}

function canonicalRegistry(registry) {
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') return 'docker.io';
  return registry;
}

export function parseImageReference(ref) {
  const at = ref.lastIndexOf('@');
  const nameAndTag = at >= 0 ? ref.slice(0, at) : ref;
  const digest = at >= 0 ? ref.slice(at + 1) : '';
  const lastSlash = nameAndTag.lastIndexOf('/');
  const lastColon = nameAndTag.lastIndexOf(':');
  const tag = lastColon > lastSlash ? nameAndTag.slice(lastColon + 1) : '';
  const rawName = tag ? nameAndTag.slice(0, lastColon) : nameAndTag;
  const parts = rawName.split('/');
  const first = parts[0];
  const hasRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  const registry = canonicalRegistry(hasRegistry ? first.toLowerCase() : 'docker.io');
  let repositoryPath = hasRegistry ? parts.slice(1).join('/') : parts.join('/');
  if (registry === 'docker.io' && !repositoryPath.includes('/')) {
    repositoryPath = `library/${repositoryPath}`;
  }
  if (!repositoryPath) throw new Error(`${ref}: image repository is empty`);
  const repository = `${registry}/${repositoryPath}`;
  return { ref, registry, repositoryPath, repository, tag, digest };
}

export function classifyImageOccurrence(occurrence, { requirePinned = false } = {}) {
  const parsed = parseImageReference(occurrence.ref);
  const held =
    occurrence.target === 'infra/kubernetes/apps' &&
    HELD_APP_REPOSITORIES.has(parsed.repository) &&
    parsed.digest === ZERO_DIGEST;

  if (held) {
    if (requirePinned) {
      throw new Error(
        `${occurrence.target}:${occurrence.line}: ${parsed.repository} remains at the ` +
          'deliberately held all-zero digest',
      );
    }
    return { ...parsed, ...occurrence, held: true };
  }
  if (!parsed.tag) {
    throw new Error(`${occurrence.target}:${occurrence.line}: ${occurrence.ref} has no immutable tag@digest tag`);
  }
  if (!DIGEST_RE.test(parsed.digest) || parsed.digest === ZERO_DIGEST) {
    throw new Error(
      `${occurrence.target}:${occurrence.line}: ${occurrence.ref} is not pinned to a real sha256 digest`,
    );
  }
  return { ...parsed, ...occurrence, held: false };
}

function parseBearerChallenge(header) {
  if (!header || !/^Bearer\s+/i.test(header)) return null;
  const values = {};
  for (const match of header.slice(header.indexOf(' ') + 1).matchAll(/([a-z]+)="([^"]*)"/gi)) {
    values[match[1].toLowerCase()] = match[2];
  }
  if (!values.realm) return null;
  return values;
}

function registryCredentials(registry, env) {
  if (registry === 'ghcr.io') {
    const githubHosted = /github\.com$/i.test(
      new URL(env.GITHUB_SERVER_URL || 'https://example.invalid').hostname,
    );
    return {
      username:
        env.GHCR_USERNAME || env.CONTAINER_REGISTRY_USERNAME || env.GITHUB_ACTOR || '',
      password:
        env.GHCR_TOKEN ||
        env.CONTAINER_REGISTRY_PASSWORD ||
        (githubHosted ? env.GITHUB_TOKEN || '' : ''),
    };
  }
  if (registry === 'docker.io') {
    return {
      username: env.DOCKERHUB_USERNAME || env.DOCKER_USERNAME || '',
      password:
        env.DOCKERHUB_TOKEN || env.DOCKERHUB_PASSWORD || env.DOCKER_PASSWORD || '',
    };
  }
  return {
    username: env.CONTAINER_REGISTRY_USERNAME || '',
    password: env.CONTAINER_REGISTRY_PASSWORD || '',
  };
}

function registryHost(registry) {
  return registry === 'docker.io' ? 'registry-1.docker.io' : registry;
}

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.min(retryAfter * 1000, 10_000);
  }
  return Math.min(500 * 2 ** attempt, 4_000);
}

async function defaultSleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function fetchWithRetry(url, options, {
  fetchImpl,
  retries,
  sleep,
  timeoutMs,
}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(timeoutMs),
      });
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === retries) return response;
      await response.body?.cancel?.().catch(() => {});
      await sleep(retryDelayMs(response, attempt));
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(Math.min(500 * 2 ** attempt, 4_000));
    }
  }
  throw new Error(`network request failed after ${retries + 1} attempt(s): ${lastError?.message}`);
}

function rateLimitDetails(response) {
  const values = [
    ['ratelimit-limit', response.headers.get('ratelimit-limit')],
    ['ratelimit-remaining', response.headers.get('ratelimit-remaining')],
    ['retry-after', response.headers.get('retry-after')],
  ].filter(([, value]) => value);
  return values.length > 0 ? `; ${values.map(([key, value]) => `${key}=${value}`).join(', ')}` : '';
}

function responseFailure(label, response, { authenticated }) {
  const auth = response.status === 401 || response.status === 403
    ? `; credentials=${authenticated ? 'provided' : 'not provided'}`
    : '';
  const rate = response.status === 429 ? rateLimitDetails(response) : '';
  return `${label} -> HTTP ${response.status} ${response.statusText || ''}${auth}${rate}`.trim();
}

async function exchangeBearerToken(challenge, image, options) {
  const tokenUrl = new URL(challenge.realm);
  if (challenge.service) tokenUrl.searchParams.set('service', challenge.service);
  tokenUrl.searchParams.set('scope', challenge.scope || `repository:${image.repositoryPath}:pull`);
  const credentials = registryCredentials(image.registry, options.env);
  const headers = {};
  if (credentials.username && credentials.password) {
    headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  }
  const response = await fetchWithRetry(tokenUrl, { headers }, options);
  if (!response.ok) {
    throw new Error(responseFailure(`${image.registry} bearer-token exchange`, response, {
      authenticated: Boolean(headers.Authorization),
    }));
  }
  const body = await response.json();
  const token = body.token || body.access_token;
  if (!token) throw new Error(`${image.registry} bearer-token exchange returned no token`);
  return token;
}

async function fetchManifest(image, options) {
  const url = new URL(
    `https://${registryHost(image.registry)}/v2/${image.repositoryPath}/manifests/${image.digest}`,
  );
  const headers = { Accept: MANIFEST_ACCEPT };
  let response = await fetchWithRetry(url, { headers }, options);
  if (response.status === 401) {
    const challenge = parseBearerChallenge(response.headers.get('www-authenticate'));
    await response.body?.cancel?.().catch(() => {});
    if (!challenge) {
      throw new Error(
        responseFailure(`${image.repository}:${image.tag}@${image.digest}`, response, { authenticated: false }) +
          '; registry did not return a usable Bearer challenge',
      );
    }
    const token = await exchangeBearerToken(challenge, image, options);
    headers.Authorization = `Bearer ${token}`;
    response = await fetchWithRetry(url, { headers }, options);
  }
  if (!response.ok) {
    throw new Error(responseFailure(`${image.repository}:${image.tag}@${image.digest}`, response, {
      authenticated: Boolean(headers.Authorization),
    }));
  }
  return response;
}

function manifestPlatforms(manifest) {
  return [...new Set(
    (manifest.manifests || [])
      .map(({ platform = {} }) => {
        if (!platform.os || !platform.architecture || platform.os === 'unknown') return '';
        return [platform.os, platform.architecture, platform.variant].filter(Boolean).join('/');
      })
      .filter(Boolean),
  )].sort();
}

export async function verifyRegistryPin(image, {
  fetchImpl = fetch,
  env = process.env,
  retries = Number(process.env.VH_REGISTRY_RETRIES || 2),
  sleep = defaultSleep,
  timeoutMs = Number(process.env.VH_REGISTRY_TIMEOUT_MS || 30_000),
} = {}) {
  const options = { fetchImpl, env, retries, sleep, timeoutMs };
  const response = await fetchManifest(image, options);
  const resolvedDigest = response.headers.get('docker-content-digest');
  if (!DIGEST_RE.test(resolvedDigest || '')) {
    throw new Error(
      `${image.repository}:${image.tag}@${image.digest} returned no valid Docker-Content-Digest header`,
    );
  }
  if (resolvedDigest !== image.digest) {
    throw new Error(
      `${image.repository}:${image.tag}@${image.digest} returned manifest digest ${resolvedDigest}`,
    );
  }

  const manifest = await response.json();
  const mediaType = String(
    manifest.mediaType || response.headers.get('content-type') || '',
  ).split(';')[0];
  const platforms = manifestPlatforms(manifest);
  if (MULTI_ARCH_PLATFORM_REPOSITORIES.has(image.repository)) {
    if (!INDEX_MEDIA_TYPES.has(mediaType) || platforms.length < 2 || !platforms.includes('linux/amd64')) {
      throw new Error(
        `${image.repository}:${image.tag}@${image.digest} is not the required multi-architecture ` +
          `index with linux/amd64 (mediaType=${mediaType || 'missing'}, platforms=${platforms.join(',') || 'none'})`,
      );
    }
  }
  return { ...image, resolvedDigest, mediaType, platforms };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

export async function validateProductionImages({
  occurrences = renderProductionImages(),
  requirePinned = false,
  verify = verifyRegistryPin,
  concurrency = Number(process.env.VH_REGISTRY_CONCURRENCY || 4),
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`VH_REGISTRY_CONCURRENCY must be a positive integer; got ${concurrency}`);
  }
  const classified = occurrences.map((occurrence) =>
    classifyImageOccurrence(occurrence, { requirePinned }));
  const heldOccurrences = classified.filter((image) => image.held);
  const heldByRef = new Map();
  for (const image of heldOccurrences) {
    const existing = heldByRef.get(image.ref);
    if (existing) existing.occurrences += 1;
    else heldByRef.set(image.ref, { ...image, occurrences: 1 });
  }
  const held = [...heldByRef.values()];
  const activeByRef = new Map();
  for (const image of classified.filter((candidate) => !candidate.held)) {
    const existing = activeByRef.get(image.ref);
    if (existing) {
      existing.targets.add(image.target);
    } else {
      activeByRef.set(image.ref, { ...image, targets: new Set([image.target]) });
    }
  }
  const active = [...activeByRef.values()];
  const verified = await mapWithConcurrency(active, concurrency, verify);
  return { occurrences, heldOccurrences, held, active, verified };
}

function parseArgs(argv) {
  const args = { requirePinned: false, warnOnly: false };
  for (const arg of argv) {
    if (arg === '--require-pinned') args.requirePinned = true;
    else if (arg === '--warn-only') args.warnOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const { requirePinned, warnOnly } = parseArgs(process.argv.slice(2));
  try {
    const result = await validateProductionImages({ requirePinned });
    for (const image of result.verified) {
      const platformSummary = image.platforms.length > 0
        ? ` [${image.platforms.join(', ')}]`
        : '';
      console.log(`  OK   ${image.repository}:${image.tag}@${image.digest}${platformSummary}`);
    }
    for (const image of result.held) {
      console.log(
        `  HELD ${image.repository}@${image.digest} ` +
          `(${image.occurrences} rendered occurrence${image.occurrences === 1 ? '' : 's'})`,
      );
    }
    console.log(
      `[check-prod-digests] verified ${result.verified.length} active unique tag@digest pin(s) ` +
        `from ${PRODUCTION_ROOTS.length} rendered production roots; ` +
        `${result.held.length} platform-owned application pin(s) remain deliberately held ` +
        `fail-closed across ${result.heldOccurrences.length} rendered occurrence(s).`,
    );
  } catch (error) {
    const message = `[check-prod-digests] FAIL: ${error.message}`;
    if (warnOnly) {
      console.warn(`${message}\n  --warn-only was supplied; this invocation is informational.`);
      return;
    }
    throw new Error(message);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
