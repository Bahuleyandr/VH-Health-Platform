#!/usr/bin/env node
// scripts/update-prod-digests.mjs
//
// Resolves released image tags to their immutable @sha256 digests and writes
// them into infra/kubernetes/apps/kustomization.yaml — the tree the ArgoCD
// `apps` Application syncs (audit finding H11 — prod must deploy digests,
// never mutable tags).
//
// Usage:
//   node scripts/update-prod-digests.mjs --tag backend-v1.2.3 [--tag admin-v1.2.0] [--tag staff-web-v1.0.4]
//   node scripts/update-prod-digests.mjs --image ghcr.io/<owner>/vh-health-platform-backend:backend-v1.2.3
//
// Auth: uses GHCR_TOKEN or CONTAINER_REGISTRY_PASSWORD from the env. GitHub
// Actions may still fall back to its GITHUB_TOKEN; Forgejo must use explicit
// GHCR/registry credentials.
// Run by .forgejo/workflows/release-images.yml after each signed release,
// with .forgejo/workflows/release-pin-digests.yml as the manual repair path.
// Also runnable by an operator from a workstation.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KUSTOMIZATION = path.resolve(
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

function parseArgs(argv) {
  const targets = [];
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
    }
  }
  if (targets.length === 0) {
    throw new Error('No targets. Pass at least one --tag or --image.');
  }
  return targets;
}

async function ghcrToken(repoPath) {
  // GHCR requires an exchange token for registry API calls. Forgejo cannot use
  // its own GITHUB_TOKEN for GHCR, so prefer explicit GHCR/registry secrets.
  const githubHosted = /github\.com$/i.test(new URL(process.env.GITHUB_SERVER_URL || 'https://example.invalid').hostname);
  const envToken = process.env.GHCR_TOKEN
    || process.env.CONTAINER_REGISTRY_PASSWORD
    || (githubHosted ? process.env.GITHUB_TOKEN : '');
  const username = process.env.GHCR_USERNAME
    || process.env.CONTAINER_REGISTRY_USERNAME
    || process.env.GITHUB_ACTOR
    || OWNER;
  const headers = {};
  if (envToken) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${envToken}`).toString('base64')}`;
  }
  const res = await fetch(
    `https://${REGISTRY}/token?service=${REGISTRY}&scope=repository:${repoPath}:pull`,
    { headers },
  );
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
  return (await res.json()).token;
}

async function resolveDigest(image, tag) {
  const repoPath = image.replace(`${REGISTRY}/`, '');
  const token = await ghcrToken(repoPath);
  const res = await fetch(`https://${REGISTRY}/v2/${repoPath}/manifests/${tag}`, {
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
    throw new Error(`${image}:${tag} → HTTP ${res.status} (check GHCR_TOKEN has read:packages)`);
  }
  const digest = res.headers.get('docker-content-digest');
  if (!digest?.startsWith('sha256:')) {
    throw new Error(`${image}:${tag} → no docker-content-digest header`);
  }
  return digest;
}

function writeDigest(yamlText, image, digest) {
  // Replace the digest line that immediately follows the matching name line.
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === `- name: ${image}`) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        if (/^\s*digest:\s*sha256:[0-9a-f]{64}\s*$/.test(lines[j])) {
          const indent = lines[j].match(/^\s*/)[0];
          lines[j] = `${indent}digest: ${digest}`;
          return lines.join('\n');
        }
      }
      throw new Error(`images entry for ${image} has no digest line to update`);
    }
  }
  throw new Error(`no images entry found for ${image} in ${KUSTOMIZATION}`);
}

const targets = parseArgs(process.argv.slice(2));
let yamlText = fs.readFileSync(KUSTOMIZATION, 'utf8');
for (const { image, tag } of targets) {
  const digest = await resolveDigest(image, tag);
  yamlText = writeDigest(yamlText, image, digest);
  console.log(`${image}: ${tag} → ${digest}`);
}
fs.writeFileSync(KUSTOMIZATION, yamlText);
console.log(`Updated ${path.relative(process.cwd(), KUSTOMIZATION)}`);
