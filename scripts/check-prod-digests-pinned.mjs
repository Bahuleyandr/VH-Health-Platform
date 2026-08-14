#!/usr/bin/env node
// Render every Kustomize-controlled root — the two ArgoCD production roots plus
// the staging and dev overlays — inventory every rendered image-reference field
// plus the JSON runtime manifests synthesized by the scheduled restore proof,
// and verify every active tag@digest against its registry.
// Four placeholders are an explicit held state, accepted only as the exact full
// all-zero fail-closed references below: the three platform-owned application
// images in the apps root, and the active PostgreSQL 17 database pin in the prod
// root (audit 2026-08-13, P1).
// The non-production overlays are deliberately NOT exempt. The database hold was
// placed in base/cnpg/, so it rendered into them too; because this gate built
// only the production roots, dev and staging silently lost their database. Their
// PostgreSQL 17 pin is now a real, registry-verified digest, and an all-zero
// digest reaching them is a hard failure.

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

// Audit 2026-08-13 (P1) follow-up. The database hold was placed in
// `base/cnpg/`, so its all-zero, unpullable digest rendered into EVERY overlay
// — but this gate only ever built the production roots, so dev and staging lost
// their database with nothing red. They are verified here too: an all-zero
// digest outside the exact HELD_APP_OCCURRENCES inventory below is rejected,
// and every real pin is re-resolved against its registry.
export const ENVIRONMENT_ROOTS = [
  'infra/kubernetes/overlays/staging',
  'infra/kubernetes/overlays/dev',
];

// Staging app-tier overlay. deploy-staging.yml writes its `images:` digests;
// until a manual staging dispatch resolves signed/scanned release tags they
// are the same deliberate all-zero fail-closed holds as the production apps
// root, so its rendered occurrences carry the mirrored held inventory below.
// Verified here so a drifting or unauthorized staging pin is caught exactly
// like a production one.
export const STAGING_APP_ROOTS = [
  'infra/kubernetes/overlays/staging/apps',
];

export const VERIFIED_ROOTS = [...PRODUCTION_ROOTS, ...ENVIRONMENT_ROOTS, ...STAGING_APP_ROOTS];

export const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const heldBackend = `ghcr.io/bahuleyandr/vh-health-platform-backend@${ZERO_DIGEST}`;
const heldAdmin = `ghcr.io/bahuleyandr/vh-health-platform-adminportal@${ZERO_DIGEST}`;
const heldStaffWeb = `ghcr.io/bahuleyandr/vhhealth-staff-web@${ZERO_DIGEST}`;
// Audit 2026-08-13 (P1). The live database's declared generation is
// PostgreSQL 17, but its exact qualified minor + digest are operator evidence
// this repository does not hold (docs/CNPG_POSTGRES_18_QUALIFICATION.md §1
// requires capturing it off the running cluster). It therefore carries the same
// fail-closed all-zero hold as the application images: unpullable, so the
// platform overlay cannot be synced until an operator pins the real digest —
// and, critically, cannot carry the PostgreSQL 18.4 cutover target, which would
// have made an ordinary sync perform an irreversible pg_upgrade.
const heldActivePostgres = `ghcr.io/cloudnative-pg/postgresql:17.10-standard-bookworm@${ZERO_DIGEST}`;

const HELD_APPS_ROOT_OCCURRENCES = Object.freeze([
  {
    target: 'infra/kubernetes/apps',
    resourceKind: 'Deployment',
    resourceNamespace: 'vhhealth',
    resourceName: 'vhhealth-admin',
    container: 'admin',
    field: 'image',
    ref: heldAdmin,
  },
  {
    target: 'infra/kubernetes/apps',
    resourceKind: 'Deployment',
    resourceNamespace: 'vhhealth',
    resourceName: 'vhhealth-backend',
    container: 'backend',
    field: 'image',
    ref: heldBackend,
  },
  {
    target: 'infra/kubernetes/apps',
    resourceKind: 'Deployment',
    resourceNamespace: 'vhhealth',
    resourceName: 'vhhealth-staff-web',
    container: 'nginx',
    field: 'image',
    ref: heldStaffWeb,
  },
  {
    target: 'infra/kubernetes/apps',
    resourceKind: 'CronJob',
    resourceNamespace: 'vhhealth',
    resourceName: 'ward-downtime-packs',
    container: 'ward-downtime-packs',
    field: 'image',
    ref: heldBackend,
  },
  {
    target: 'infra/kubernetes/apps',
    resourceKind: 'Job',
    resourceNamespace: 'vhhealth',
    resourceName: 'vhhealth-backend-migrate',
    container: 'migrate',
    field: 'image',
    ref: heldBackend,
  },
  {
    target: 'infra/kubernetes/apps',
    resourceKind: 'Job',
    resourceNamespace: 'vhhealth',
    resourceName: 'vhhealth-backend-migrate',
    container: 'wait-owner-bypassrls',
    field: 'image',
    ref: heldBackend,
  },
]);

export const HELD_APP_OCCURRENCES = Object.freeze([
  ...HELD_APPS_ROOT_OCCURRENCES,
  {
    target: 'infra/kubernetes/overlays/prod',
    resourceKind: 'Cluster',
    resourceNamespace: 'vhhealth-platform',
    resourceName: 'vhhealth-pg',
    container: null,
    field: 'imageName',
    ref: heldActivePostgres,
  },
  // The staging app-tier overlay re-renders the apps root workloads with its
  // own (currently also all-zero fail-closed) digests, so every held
  // apps-root occurrence appears exactly once more under the staging target.
  // Derived, not restated, so the two inventories cannot drift apart.
  ...HELD_APPS_ROOT_OCCURRENCES.map((occurrence) =>
    Object.freeze({ ...occurrence, target: 'infra/kubernetes/overlays/staging/apps' })),
]);

export const HELD_APP_REFERENCES = new Set(HELD_APP_OCCURRENCES.map(({ ref }) => ref));

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

function scalarValue(raw) {
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/);
  if (quoted) return quoted[1] ?? quoted[2];
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function containerNameAfterImage(lines, index, field) {
  if (field !== 'image') return '';
  const leading = lines[index].match(/^\s*/)?.[0].length || 0;
  const sequence = /^\s*-\s*/.test(lines[index]);
  const propertyIndent = leading + (sequence ? 2 : 0);
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (/^---\s*$/.test(lines[cursor])) break;
    if (!lines[cursor].trim()) continue;
    const indent = lines[cursor].match(/^\s*/)?.[0].length || 0;
    if (indent < propertyIndent) break;
    const match = lines[cursor].match(new RegExp(`^\\s{${propertyIndent}}name:\\s*(\\S+)\\s*$`));
    if (match) return scalarValue(match[1]);
  }
  return '';
}

export function extractRenderedImages(rendered, target) {
  const images = [];
  const lines = rendered.split(/\r?\n/);
  let resourceKind = '';
  let resourceName = '';
  let resourceNamespace = '';
  let inMetadata = false;
  for (const [index, line] of lines.entries()) {
    if (/^---\s*$/.test(line)) {
      resourceKind = '';
      resourceName = '';
      resourceNamespace = '';
      inMetadata = false;
      continue;
    }
    const kindMatch = line.match(/^kind:\s*(\S+)\s*$/);
    if (kindMatch) resourceKind = scalarValue(kindMatch[1]);
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
    } else if (inMetadata) {
      if (line.trim() && !/^\s/.test(line)) {
        inMetadata = false;
      } else {
        const nameMatch = line.match(/^  name:\s*(\S+)\s*$/);
        const namespaceMatch = line.match(/^  namespace:\s*(\S+)\s*$/);
        if (nameMatch) resourceName = scalarValue(nameMatch[1]);
        if (namespaceMatch) resourceNamespace = scalarValue(namespaceMatch[1]);
      }
    }
    // Keep this field contract aligned with extractImageRefs in
    // check-c1-1-manifest-contract.mjs. `imageName` is used by CNPG CRDs and
    // operator/bootstrap configuration uses keys such as `operatorImage`.
    const match = line.match(
      /^\s*(?:-\s*)?((?:image|imageName)|(?:[A-Za-z0-9_-]+Image)):\s*(.*?)\s*$/,
    );
    if (!match) continue;
    images.push({
      field: match[1],
      ref: scalarValue(match[2]),
      target,
      line: index + 1,
      source: 'rendered',
      resourceKind,
      resourceNamespace,
      resourceName,
      container: containerNameAfterImage(lines, index, match[1]),
    });
  }
  return images;
}

function literalEnvironment(lines) {
  const values = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)-\s+name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (!match) continue;
    let cursor = index + 1;
    while (cursor < lines.length && (!lines[cursor].trim() || /^\s*#/.test(lines[cursor]))) cursor += 1;
    const valueMatch = lines[cursor]?.match(
      new RegExp(`^\\s{${match[1].length + 2}}value:\\s*(.*?)\\s*$`),
    );
    if (!valueMatch) continue;
    const value = scalarValue(valueMatch[1]);
    if (!values.has(match[2])) values.set(match[2], new Set());
    values.get(match[2]).add(value);
  }
  return values;
}

function resolveSynthesizedImage(value, variables, target, line) {
  const variable = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!variable) {
    if (value.includes('${')) {
      throw new Error(
        `${target}:${line}: synthesized runtime image ${value} is not one exactly resolvable variable`,
      );
    }
    return value;
  }
  const candidates = [...(variables.get(variable[1]) || [])];
  if (candidates.length !== 1) {
    throw new Error(
      `${target}:${line}: synthesized runtime image ${value} must resolve to exactly one rendered ` +
        `literal; found ${candidates.length}`,
    );
  }
  return candidates[0];
}

export function extractSynthesizedImages(rendered, target) {
  const images = [];
  const lines = rendered.split(/\r?\n/);
  const variables = literalEnvironment(lines);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(
      /"((?:image|imageName)|(?:[A-Za-z0-9_-]+Image))"\s*:\s*"([^"]*)"/g,
    )) {
      const expression = match[2];
      const prefix = line.slice(0, match.index);
      const names = [...prefix.matchAll(/"name":"([^"]+)"/g)];
      images.push({
        field: match[1],
        ref: resolveSynthesizedImage(expression, variables, target, index + 1),
        target,
        line: index + 1,
        source: 'synthesized',
        runtimeExpression: expression,
        resourceKind: line.match(/"kind":"([^"]+)"/)?.[1] || '',
        resourceNamespace: line.match(/"namespace":"([^"]+)"/)?.[1] || '',
        resourceName: line.match(/"metadata":\{"name":"([^"]+)"/)?.[1] || '',
        container: match[1] === 'image' ? names.at(-1)?.[1] || '' : '',
      });
    }
  }
  return images;
}

export function renderProductionImages({
  roots = VERIFIED_ROOTS,
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
    const targetImages = [
      ...extractRenderedImages(rendered, target),
      ...extractSynthesizedImages(rendered, target),
    ];
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
  if (!repositoryPath) throw new Error(`${ref}: image repository is empty`);
  if (registry === 'docker.io' && !repositoryPath.includes('/')) {
    repositoryPath = `library/${repositoryPath}`;
  }
  const repository = `${registry}/${repositoryPath}`;
  return { ref, registry, repositoryPath, repository, tag, digest };
}

function heldOccurrenceKey(occurrence) {
  return [
    occurrence.target,
    occurrence.resourceKind,
    occurrence.resourceNamespace,
    occurrence.resourceName,
    occurrence.container,
    occurrence.field,
    occurrence.ref,
  ].join('|');
}

const HELD_APP_OCCURRENCE_KEYS = new Set(HELD_APP_OCCURRENCES.map(heldOccurrenceKey));

export function classifyImageOccurrence(occurrence, { requirePinned = false } = {}) {
  const parsed = parseImageReference(occurrence.ref);
  const held = HELD_APP_OCCURRENCE_KEYS.has(heldOccurrenceKey(occurrence));

  if (held) {
    if (requirePinned) {
      throw new Error(
        `${occurrence.target}:${occurrence.line}: ${parsed.repository} remains at the ` +
          'deliberately held all-zero digest',
      );
    }
    return { ...parsed, ...occurrence, held: true };
  }
  if (parsed.digest === ZERO_DIGEST) {
    throw new Error(
      `${occurrence.target}:${occurrence.line}: ${occurrence.ref} is an unauthorized all-zero ` +
        `image occurrence at ${occurrence.resourceKind || '(unknown kind)'}/` +
        `${occurrence.resourceName || '(unknown name)'} container ${occurrence.container || '(none)'}`,
    );
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

export function assertHeldOccurrenceInventory(heldOccurrences) {
  const actualKeys = heldOccurrences.map(heldOccurrenceKey);
  const actualSet = new Set(actualKeys);
  const missing = HELD_APP_OCCURRENCES
    .filter((expected) => !actualSet.has(heldOccurrenceKey(expected)))
    .map(heldOccurrenceKey);
  const extras = actualKeys.filter(
    (key, index) => !HELD_APP_OCCURRENCE_KEYS.has(key) || actualKeys.indexOf(key) !== index,
  );
  if (actualKeys.length !== HELD_APP_OCCURRENCES.length || missing.length > 0 || extras.length > 0) {
    throw new Error(
      'held all-zero occurrence inventory must be the exact expected ' +
        `${HELD_APP_OCCURRENCES.length}` +
        `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}` +
        `${extras.length > 0 ? `; extra: ${extras.join(', ')}` : ''}`,
    );
  }
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
    return {
      username: env.GHCR_USERNAME || '',
      password: env.GHCR_TOKEN || '',
    };
  }
  if (registry === 'docker.io') {
    return {
      username: env.DOCKERHUB_USERNAME || '',
      password: env.DOCKERHUB_TOKEN || '',
    };
  }
  return { username: '', password: '' };
}

function registryHost(registry) {
  return registry === 'docker.io' ? 'registry-1.docker.io' : registry;
}

function tokenAuthority(registry) {
  return registry === 'docker.io' ? 'auth.docker.io' : registryHost(registry);
}

function tokenService(registry) {
  return registry === 'docker.io' ? 'registry.docker.io' : registryHost(registry);
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

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchManifestWithSafeRedirects(url, headers, options) {
  let current = new URL(url);
  let currentHeaders = { ...headers };
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchWithRetry(
      current,
      { headers: currentHeaders, redirect: 'manual' },
      options,
    );
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel?.().catch(() => {});
    if (!location) throw new Error(`${current.origin} returned a redirect without Location`);
    if (redirects === 5) throw new Error(`${current.origin} exceeded five manifest redirects`);
    const next = new URL(location, current);
    if (next.protocol !== 'https:' || next.username || next.password) {
      throw new Error(
        `${current.origin} manifest redirect must use credential-free HTTPS; got ` +
          `${next.protocol}//${next.host || '(missing)'}`,
      );
    }
    if (next.origin !== current.origin && currentHeaders.Authorization) {
      currentHeaders = { ...currentHeaders };
      delete currentHeaders.Authorization;
    }
    current = next;
  }
  throw new Error('unreachable manifest redirect state');
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
  let tokenUrl;
  try {
    tokenUrl = new URL(challenge.realm);
  } catch {
    throw new Error(`${image.registry} returned an invalid bearer-token realm`);
  }
  if (
    tokenUrl.protocol !== 'https:' ||
    tokenUrl.username ||
    tokenUrl.password ||
    tokenUrl.host.toLowerCase() !== tokenAuthority(image.registry).toLowerCase()
  ) {
    throw new Error(
      `${image.registry} bearer-token realm must use HTTPS authority ` +
        `${tokenAuthority(image.registry)}; got ${tokenUrl.protocol}//${tokenUrl.host || '(missing)'}`,
    );
  }
  tokenUrl.search = '';
  tokenUrl.hash = '';
  tokenUrl.searchParams.set('service', tokenService(image.registry));
  tokenUrl.searchParams.set('scope', `repository:${image.repositoryPath}:pull`);
  const credentials = registryCredentials(image.registry, options.env);
  if (Boolean(credentials.username) !== Boolean(credentials.password)) {
    throw new Error(`${image.registry} credentials require both the registry-specific username and token`);
  }
  const headers = {};
  if (credentials.username && credentials.password) {
    headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
  }
  const response = await fetchWithRetry(tokenUrl, { headers, redirect: 'error' }, options);
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
  let response = await fetchManifestWithSafeRedirects(url, headers, options);
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
    response = await fetchManifestWithSafeRedirects(url, headers, options);
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
  assertHeldOccurrenceInventory(heldOccurrences);
  const heldByRef = new Map();
  for (const image of heldOccurrences) {
    const existing = heldByRef.get(image.ref);
    if (existing) existing.occurrences += 1;
    else heldByRef.set(image.ref, { ...image, occurrences: 1 });
  }
  const held = [...heldByRef.values()];
  const activeOccurrences = classified.filter((candidate) => !candidate.held);
  const activeByRef = new Map();
  for (const image of activeOccurrences) {
    const existing = activeByRef.get(image.ref);
    if (existing) {
      existing.targets.add(image.target);
      if (image.field) existing.fields.add(image.field);
      existing.occurrences += 1;
    } else {
      activeByRef.set(image.ref, {
        ...image,
        targets: new Set([image.target]),
        fields: new Set(image.field ? [image.field] : []),
        occurrences: 1,
      });
    }
  }
  const active = [...activeByRef.values()];
  const verified = await mapWithConcurrency(active, concurrency, verify);
  return { occurrences, heldOccurrences, held, activeOccurrences, active, verified };
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
    const activeFields = [...new Set(
      result.activeOccurrences.map(({ field }) => field).filter(Boolean),
    )].sort();
    console.log(
      `[check-prod-digests] verified ${result.verified.length} active unique tag@digest pin(s) ` +
        `across ${result.activeOccurrences.length} Kustomize-controlled or scheduled-proof-synthesized ` +
        `image-field occurrence(s) (${activeFields.join(', ')}) from ${PRODUCTION_ROOTS.length} ` +
        `production + ${ENVIRONMENT_ROOTS.length + STAGING_APP_ROOTS.length} non-production roots; ` +
        `${result.held.length} platform-owned application/database pin(s) remain deliberately held ` +
        `fail-closed across the exact ${result.heldOccurrences.length} rendered workload occurrence(s). ` +
        `Helm chart-generated workloads are outside this proof.`,
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
