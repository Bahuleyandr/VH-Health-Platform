#!/usr/bin/env node
// scripts/update-prod-digests.mjs
//
// Pins released images in a kustomization images block to immutable @sha256
// digests. For the production tree the pinned digest MUST be the digest the
// release build job emitted, threaded through via --expected-digest or
// --expected-digest-file — never a fresh resolution of the mutable tag, which
// would permit pinning (rolling back to) any previously-signed image (audit
// finding #20, Sol-Ultra 2026-07-11). The tag is still resolved from the
// registry, but only as a cross-check: if it no longer agrees with the
// build-emitted digest the script refuses loudly and writes nothing.
// Every accepted digest is cosign-verified before the kustomization is
// rewritten. By default this targets infra/kubernetes/apps/kustomization.yaml,
// the tree the ArgoCD `apps` Application syncs for production (audit finding
// H11). Pass --kustomization for staging/repair paths.
//
// Usage (release pipelines / operator, prod tree — expected digest REQUIRED):
//   COSIGN_PUBLIC_KEY=... node scripts/update-prod-digests.mjs \
//     --tag backend-v1.2.3 --expected-digest sha256:<build-emitted digest>
//   node scripts/update-prod-digests.mjs \
//     --tag backend-v1.2.3 --expected-digest-file output/release-artifact/image-ref.txt
//   (--expected-digest[-file] accepts a bare sha256:<hex> digest or a full
//   <image>@sha256:<hex> ref; the image part must then match the target.)
//
// Staging overlay only (legacy tag resolution; REFUSED for the prod tree):
//   node scripts/update-prod-digests.mjs \
//     --kustomization infra/kubernetes/overlays/staging/apps/kustomization.yaml \
//     --tag backend-v1.2.3 --allow-tag-resolution
//
// --dry-run runs the full pipeline (registry cross-check + cosign verify) but
// writes no files — use it to prove the wiring during a release run.
//
// Auth: uses GHCR_TOKEN or CONTAINER_REGISTRY_PASSWORD from the env. GitHub
// Actions may still fall back to its GITHUB_TOKEN; Forgejo must use explicit
// GHCR/registry credentials.
// Run by .forgejo/workflows/release-images.yml after each signed release
// (expected digest from the build job's image-ref.txt artifact), with
// .forgejo/workflows/release-pin-digests.yml as the manual repair path
// (operator pastes the digest from the original release run's evidence).
// Also runnable by an operator from a workstation.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_KUSTOMIZATION = path.resolve(
  __dirname,
  '../infra/kubernetes/apps/kustomization.yaml',
);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const OWNER = (process.env.IMAGE_OWNER || 'bahuleyandr').toLowerCase();
const REGISTRY = 'ghcr.io';

const TAG_PREFIX_TO_IMAGE = {
  'backend-v': `${REGISTRY}/${OWNER}/vh-health-platform-backend`,
  'admin-v': `${REGISTRY}/${OWNER}/vh-health-platform-adminportal`,
  'staff-web-v': `${REGISTRY}/${OWNER}/vhhealth-staff-web`,
};

// Parses an expected-digest value: either a bare `sha256:<64 hex>` digest or
// a full `<image>@sha256:<64 hex>` ref (the build jobs' image-ref.txt format).
// Exactly one line; anything else is rejected.
export function parseExpectedDigestRef(text, source = '--expected-digest') {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    throw new Error(`${source}: empty value`);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error(
      `${source}: expected a single sha256:<64 hex> digest or <image>@sha256:<digest> line`,
    );
  }
  const atIdx = trimmed.lastIndexOf('@');
  const image = atIdx > 0 ? trimmed.slice(0, atIdx) : null;
  const digest = atIdx > 0 ? trimmed.slice(atIdx + 1) : trimmed;
  if (!DIGEST_RE.test(digest)) {
    throw new Error(`${source}: '${digest}' is not a sha256:<64 hex> digest`);
  }
  return { image, digest };
}

export function parseArgs(
  argv,
  {
    cwd = process.cwd(),
    env = process.env,
    readFile = (file) => fs.readFileSync(file, 'utf8'),
  } = {},
) {
  const targets = [];
  let kustomization = DEFAULT_KUSTOMIZATION;
  let evidenceFile = '';
  let allowTagResolution = false;
  let dryRun = false;
  const verification = {
    cosignExe: env.COSIGN_EXE || env.COSIGN_BINARY || 'cosign',
    key: env.COSIGN_PUBLIC_KEY ? 'env://COSIGN_PUBLIC_KEY' : '',
    certificateIdentityRegexp: env.COSIGN_CERTIFICATE_IDENTITY_REGEXP || '',
    certificateOidcIssuer: env.COSIGN_CERTIFICATE_OIDC_ISSUER || '',
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') {
      const tag = argv[++i];
      const prefix = Object.keys(TAG_PREFIX_TO_IMAGE).find((p) => tag?.startsWith(p));
      if (!prefix) {
        throw new Error(`--tag ${tag}: expected backend-v* / admin-v* / staff-web-v*`);
      }
      targets.push({ image: TAG_PREFIX_TO_IMAGE[prefix], tag });
    } else if (argv[i] === '--image') {
      const ref = argv[++i];
      const idx = ref?.lastIndexOf(':');
      if (!ref || idx < 0) throw new Error(`--image ${ref}: expected <image>:<tag>`);
      targets.push({ image: ref.slice(0, idx), tag: ref.slice(idx + 1) });
    } else if (argv[i] === '--expected-digest' || argv[i] === '--expected-digest-file') {
      const flag = argv[i];
      const value = argv[++i];
      if (!value) {
        throw new Error(`${flag} requires a value`);
      }
      const target = targets[targets.length - 1];
      if (!target) {
        throw new Error(`${flag} must follow the --tag/--image target it verifies`);
      }
      if (target.expectedDigest) {
        throw new Error(
          `${flag}: ${target.image}:${target.tag} already has an expected digest`,
        );
      }
      const raw = flag === '--expected-digest-file'
        ? readFile(path.resolve(cwd, value))
        : value;
      const source = flag === '--expected-digest-file' ? `${flag} ${value}` : flag;
      const { image, digest } = parseExpectedDigestRef(raw, source);
      target.expectedDigest = digest;
      if (image) target.expectedImage = image;
    } else if (argv[i] === '--allow-tag-resolution') {
      allowTagResolution = true;
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    } else if (argv[i] === '--kustomization') {
      const requestedPath = argv[++i];
      if (!requestedPath) {
        throw new Error('--kustomization requires a path');
      }
      kustomization = path.resolve(cwd, requestedPath);
    } else if (argv[i] === '--evidence-file') {
      const requestedPath = argv[++i];
      if (!requestedPath) {
        throw new Error('--evidence-file requires a path');
      }
      evidenceFile = path.resolve(cwd, requestedPath);
    } else if (argv[i] === '--cosign-key') {
      verification.key = argv[++i];
      if (!verification.key) throw new Error('--cosign-key requires a key reference');
    } else if (argv[i] === '--certificate-identity-regexp') {
      verification.certificateIdentityRegexp = argv[++i];
      if (!verification.certificateIdentityRegexp) {
        throw new Error('--certificate-identity-regexp requires a pattern');
      }
    } else if (argv[i] === '--certificate-oidc-issuer') {
      verification.certificateOidcIssuer = argv[++i];
      if (!verification.certificateOidcIssuer) {
        throw new Error('--certificate-oidc-issuer requires an issuer URL');
      }
    } else if (argv[i] === '--cosign-exe') {
      verification.cosignExe = argv[++i];
      if (!verification.cosignExe) throw new Error('--cosign-exe requires a path or command');
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (targets.length === 0) {
    throw new Error('No targets. Pass at least one --tag or --image.');
  }
  return {
    targets,
    kustomization,
    evidenceFile,
    allowTagResolution,
    dryRun,
    verification: normalizeVerificationPolicy(verification),
  };
}

// True when the target file is the production tree ArgoCD syncs. The digest
// policy below keys on this: prod pins may only come from a build-emitted
// digest, never from mutable-tag resolution.
export function isProdKustomization(kustomization, prodPath = DEFAULT_KUSTOMIZATION) {
  const normalize = (p) => {
    const resolved = path.normalize(path.resolve(p));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(kustomization) === normalize(prodPath);
}

// Digest-source policy (audit finding #20). Enforced by updateDigests before
// any registry or cosign call, so it cannot be bypassed by programmatic use:
//   - the prod tree REQUIRES a build-emitted expected digest per target and
//     refuses --allow-tag-resolution outright;
//   - non-prod trees may use legacy tag resolution only with the explicit
//     --allow-tag-resolution opt-in;
//   - an expected ref that names a different image than its target is refused
//     (wrong artifact wired into the pin step).
export function assertDigestSourcePolicy({
  targets,
  kustomization,
  allowTagResolution = false,
  prodPath = DEFAULT_KUSTOMIZATION,
}) {
  const isProd = isProdKustomization(kustomization, prodPath);
  if (allowTagResolution && isProd) {
    throw new Error(
      'SECURITY: --allow-tag-resolution is refused for the production kustomization. ' +
        'Prod digests must be the digest emitted by the build job of this release run ' +
        '(audit finding #20) — pass --expected-digest / --expected-digest-file instead.',
    );
  }
  for (const target of targets) {
    if (target.expectedDigest) {
      if (target.expectedImage && target.expectedImage !== target.image) {
        throw new Error(
          `SECURITY: expected digest ref names image ${target.expectedImage} but the target is ` +
            `${target.image}:${target.tag} — refusing to pin a digest that belongs to a ` +
            'different image (wrong release artifact wired into the pin step?).',
        );
      }
      continue;
    }
    if (isProd) {
      throw new Error(
        `${target.image}:${target.tag}: no build-emitted digest provided for a production pin. ` +
          'Re-resolving a mutable tag at pin time permits rolling back to any previously-signed ' +
          'image (audit finding #20). Thread the digest emitted by the release build job through ' +
          '--expected-digest or --expected-digest-file.',
      );
    }
    if (!allowTagResolution) {
      throw new Error(
        `${target.image}:${target.tag}: no expected digest provided. Pass --expected-digest / ` +
          '--expected-digest-file (preferred), or --allow-tag-resolution for non-production ' +
          'kustomizations only.',
      );
    }
  }
  return { isProd };
}

// Pure accept/reject decision for one target. Accepts ONLY when the registry
// still resolves the tag to the exact digest the build job emitted; the
// build-emitted digest is what gets pinned.
export function decidePinnedDigest({ image, tag, expectedDigest, resolvedDigest }) {
  if (!DIGEST_RE.test(expectedDigest || '')) {
    throw new Error(
      `${image}:${tag}: expected digest '${expectedDigest}' is not a sha256:<64 hex> digest`,
    );
  }
  if (!DIGEST_RE.test(resolvedDigest || '')) {
    throw new Error(
      `${image}:${tag}: registry resolved the tag to malformed digest '${resolvedDigest}'`,
    );
  }
  if (resolvedDigest !== expectedDigest) {
    throw new Error(
      `SECURITY: refusing to pin ${image}:${tag}. The registry now resolves this tag to\n` +
        `  ${resolvedDigest}\n` +
        'but this release run built and signed\n' +
        `  ${expectedDigest}\n` +
        'The tag no longer points at the just-built image (possible tag rebind / rollback, ' +
        'audit finding #20). Nothing was written; investigate the registry before retrying.',
    );
  }
  return expectedDigest;
}

export function normalizeVerificationPolicy(verification) {
  if (verification.key) {
    return {
      mode: 'key',
      cosignExe: verification.cosignExe,
      key: verification.key,
    };
  }

  if (verification.certificateIdentityRegexp && verification.certificateOidcIssuer) {
    return {
      mode: 'keyless',
      cosignExe: verification.cosignExe,
      certificateIdentityRegexp: verification.certificateIdentityRegexp,
      certificateOidcIssuer: verification.certificateOidcIssuer,
    };
  }

  throw new Error(
    'Cosign verification is required before digest pinning. Set COSIGN_PUBLIC_KEY, ' +
      'or set COSIGN_CERTIFICATE_IDENTITY_REGEXP and COSIGN_CERTIFICATE_OIDC_ISSUER.',
  );
}

async function ghcrToken(repoPath, { fetchImpl = fetch, env = process.env } = {}) {
  // GHCR requires an exchange token for registry API calls. Forgejo cannot use
  // its own GITHUB_TOKEN for GHCR, so prefer explicit GHCR/registry secrets.
  const githubHosted = /github\.com$/i.test(new URL(env.GITHUB_SERVER_URL || 'https://example.invalid').hostname);
  const envToken = env.GHCR_TOKEN
    || env.CONTAINER_REGISTRY_PASSWORD
    || (githubHosted ? env.GITHUB_TOKEN : '');
  const username = env.GHCR_USERNAME
    || env.CONTAINER_REGISTRY_USERNAME
    || env.GITHUB_ACTOR
    || OWNER;
  const headers = {};
  if (envToken) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${envToken}`).toString('base64')}`;
  }
  const res = await fetchImpl(
    `https://${REGISTRY}/token?service=${REGISTRY}&scope=repository:${repoPath}:pull`,
    { headers },
  );
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
  return (await res.json()).token;
}

export async function resolveDigest(image, tag, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const repoPath = image.replace(`${REGISTRY}/`, '');
  const token = await ghcrToken(repoPath, { ...options, fetchImpl });
  const res = await fetchImpl(`https://${REGISTRY}/v2/${repoPath}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ].join(','),
    },
  });
  if (!res.ok) {
    throw new Error(`${image}:${tag} -> HTTP ${res.status} (check GHCR_TOKEN has read:packages)`);
  }
  const digest = res.headers.get('docker-content-digest');
  if (!digest?.startsWith('sha256:')) {
    throw new Error(`${image}:${tag} -> no docker-content-digest header`);
  }
  return digest;
}

export function cosignVerifyArgs(imageRef, verification) {
  if (verification.mode === 'key') {
    return ['verify', '--key', verification.key, imageRef];
  }
  if (verification.mode === 'keyless') {
    return [
      'verify',
      '--certificate-identity-regexp',
      verification.certificateIdentityRegexp,
      '--certificate-oidc-issuer',
      verification.certificateOidcIssuer,
      imageRef,
    ];
  }
  throw new Error(`Unsupported cosign verification mode: ${verification.mode}`);
}

export function verifyDigest(image, digest, verification, { execFile = execFileSync, env = process.env } = {}) {
  const imageRef = `${image}@${digest}`;
  const args = cosignVerifyArgs(imageRef, verification);
  execFile(verification.cosignExe, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log(`${imageRef} signature verified with cosign ${verification.mode} policy`);
  return imageRef;
}

export function writeDigest(yamlText, image, digest, kustomization) {
  // Replace the digest line that immediately follows the matching name line.
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `- name: ${image}`) {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (/^\s*-\s*name:\s*/.test(lines[j])) break;
        if (/^\s*digest:\s*sha256:[0-9a-f]{64}\s*$/.test(lines[j])) {
          const indent = lines[j].match(/^\s*/)[0];
          lines[j] = `${indent}digest: ${digest}`;
          return lines.join('\n');
        }
      }
      throw new Error(`images entry for ${image} has no digest line to update`);
    }
  }
  throw new Error(`no images entry found for ${image} in ${kustomization}`);
}

function evidencePolicySummary(verification) {
  if (verification.mode === 'key') {
    return {
      mode: 'key',
      keyRef: verification.key.startsWith('env://') ? verification.key : '[file-or-kms-ref]',
    };
  }
  return {
    mode: 'keyless',
    certificateIdentityRegexp: verification.certificateIdentityRegexp,
    certificateOidcIssuer: verification.certificateOidcIssuer,
  };
}

export async function updateDigests({
  targets,
  kustomization,
  evidenceFile = '',
  verification,
  allowTagResolution = false,
  dryRun = false,
  fetchImpl = fetch,
  execFile = execFileSync,
  env = process.env,
} = {}) {
  // Refuse disallowed digest sources before touching the registry, cosign,
  // or the filesystem (audit finding #20).
  assertDigestSourcePolicy({ targets, kustomization, allowTagResolution });

  let yamlText = fs.readFileSync(kustomization, 'utf8');
  const evidence = [];

  for (const { image, tag, expectedDigest } of targets) {
    const resolvedDigest = await resolveDigest(image, tag, { fetchImpl, env });
    let digest;
    let pinSource;
    if (expectedDigest) {
      digest = decidePinnedDigest({ image, tag, expectedDigest, resolvedDigest });
      pinSource = 'build-emitted';
    } else {
      digest = resolvedDigest;
      pinSource = 'tag-resolution';
      console.warn(
        `WARNING: ${image}:${tag} pinned from mutable-tag resolution (no build-emitted ` +
          'digest supplied). Permitted for non-production kustomizations only.',
      );
    }
    const verifiedRef = verifyDigest(image, digest, verification, { execFile, env });
    yamlText = writeDigest(yamlText, image, digest, kustomization);
    evidence.push({
      image,
      tag,
      digest,
      pinSource,
      tagResolvedDigest: resolvedDigest,
      verifiedRef,
      verification: evidencePolicySummary(verification),
      verifiedAt: new Date().toISOString(),
    });
    console.log(`${image}: ${tag} -> ${digest}${dryRun ? ' (dry run)' : ''}`);
  }

  if (dryRun) {
    console.log(
      `DRY RUN: verified ${evidence.length} pin(s); ` +
        `${path.relative(process.cwd(), kustomization)} NOT written`,
    );
    if (evidenceFile) {
      console.log(`DRY RUN: evidence file ${path.relative(process.cwd(), evidenceFile)} NOT written`);
    }
    return { evidence, dryRun: true };
  }

  fs.writeFileSync(kustomization, yamlText);

  if (evidenceFile) {
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    fs.writeFileSync(evidenceFile, `${JSON.stringify({ kustomization, evidence }, null, 2)}\n`);
    console.log(`Wrote verification evidence to ${path.relative(process.cwd(), evidenceFile)}`);
  }

  console.log(`Updated ${path.relative(process.cwd(), kustomization)}`);
  return { evidence, dryRun: false };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv, options);
  return updateDigests({ ...parsed, ...options });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
