#!/usr/bin/env node
// scripts/update-prod-digests.mjs
//
// Resolves released image tags to immutable @sha256 digests, verifies each
// resolved digest with cosign, and only then writes the kustomization images
// block. By default this targets infra/kubernetes/apps/kustomization.yaml, the
// tree the ArgoCD `apps` Application syncs for production (audit finding H11).
// Pass --kustomization for staging/repair paths.
//
// Usage:
//   COSIGN_PUBLIC_KEY=... node scripts/update-prod-digests.mjs --tag backend-v1.2.3
//   COSIGN_CERTIFICATE_IDENTITY_REGEXP='^https://github.com/OWNER/REPO/.github/workflows/release-images.yml@.*$' \
//     COSIGN_CERTIFICATE_OIDC_ISSUER=https://token.actions.githubusercontent.com \
//     node scripts/update-prod-digests.mjs --tag backend-v1.2.3
//   node scripts/update-prod-digests.mjs --image ghcr.io/<owner>/vh-health-platform-backend:backend-v1.2.3
//
// Auth: uses GHCR_TOKEN or CONTAINER_REGISTRY_PASSWORD from the env. GitHub
// Actions may still fall back to its GITHUB_TOKEN; Forgejo must use explicit
// GHCR/registry credentials.
// Run by .forgejo/workflows/release-images.yml after each signed release,
// with .forgejo/workflows/release-pin-digests.yml as the manual repair path.
// Also runnable by an operator from a workstation.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_KUSTOMIZATION = path.resolve(
  __dirname,
  '../infra/kubernetes/apps/kustomization.yaml',
);

const OWNER = (process.env.IMAGE_OWNER || 'bahuleyandr').toLowerCase();
const REGISTRY = 'ghcr.io';

const TAG_PREFIX_TO_IMAGE = {
  'backend-v': `${REGISTRY}/${OWNER}/vh-health-platform-backend`,
  'admin-v': `${REGISTRY}/${OWNER}/vh-health-platform-adminportal`,
  'staff-web-v': `${REGISTRY}/${OWNER}/vhhealth-staff-web`,
};

export function parseArgs(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const targets = [];
  let kustomization = DEFAULT_KUSTOMIZATION;
  let evidenceFile = '';
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
    verification: normalizeVerificationPolicy(verification),
  };
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
  fetchImpl = fetch,
  execFile = execFileSync,
  env = process.env,
} = {}) {
  let yamlText = fs.readFileSync(kustomization, 'utf8');
  const evidence = [];

  for (const { image, tag } of targets) {
    const digest = await resolveDigest(image, tag, { fetchImpl, env });
    const verifiedRef = verifyDigest(image, digest, verification, { execFile, env });
    yamlText = writeDigest(yamlText, image, digest, kustomization);
    evidence.push({
      image,
      tag,
      digest,
      verifiedRef,
      verification: evidencePolicySummary(verification),
      verifiedAt: new Date().toISOString(),
    });
    console.log(`${image}: ${tag} -> ${digest}`);
  }

  fs.writeFileSync(kustomization, yamlText);

  if (evidenceFile) {
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    fs.writeFileSync(evidenceFile, `${JSON.stringify({ kustomization, evidence }, null, 2)}\n`);
    console.log(`Wrote verification evidence to ${path.relative(process.cwd(), evidenceFile)}`);
  }

  console.log(`Updated ${path.relative(process.cwd(), kustomization)}`);
  return { evidence };
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
