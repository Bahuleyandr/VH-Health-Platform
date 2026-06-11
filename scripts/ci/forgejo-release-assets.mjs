#!/usr/bin/env node
// Upload files to a Forgejo/Gitea release.
//
// The Android release workflows use this instead of GitHub Releases so Forgejo
// can own mobile CD. It creates the release if the tag does not already have
// one, replaces same-named assets, and fails closed when no token is available.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function usage() {
  console.error(
    'Usage: forgejo-release-assets.mjs --tag <tag> --name <release name> --file <path> [--file <path>...]',
  );
}

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tag') args.tag = argv[++i];
    else if (arg === '--name') args.name = argv[++i];
    else if (arg === '--body') args.body = argv[++i];
    else if (arg === '--file') args.files.push(argv[++i]);
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.tag || !args.name || args.files.length === 0) {
    usage();
    process.exit(2);
  }
  return args;
}

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function apiBase() {
  const explicit = env('FORGEJO_API_URL') || env('GITHUB_API_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  const server = env('GITHUB_SERVER_URL');
  if (!server) throw new Error('GITHUB_SERVER_URL or FORGEJO_API_URL is required');
  return `${server.replace(/\/$/, '')}/api/v1`;
}

function repoPath() {
  const repo = env('GITHUB_REPOSITORY');
  if (!repo || !repo.includes('/')) {
    throw new Error('GITHUB_REPOSITORY must be set to owner/repo');
  }
  return repo;
}

function authHeaders() {
  const token = env('FORGEJO_TOKEN') || env('GITHUB_TOKEN');
  if (!token) {
    throw new Error('FORGEJO_TOKEN or GITHUB_TOKEN is required to upload release assets');
  }
  return {
    Authorization: `token ${token}`,
  };
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  return res;
}

async function getReleaseByTag(base, repo, tag) {
  const res = await request(`${base}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`release lookup failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function createRelease(base, repo, { tag, name, body }) {
  const res = await request(`${base}/repos/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      target_commitish: env('GITHUB_SHA'),
      name,
      body: body || `Release ${tag}`,
      draft: false,
      prerelease: false,
    }),
  });
  if (!res.ok) throw new Error(`release create failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function deleteExistingAsset(base, repo, release, assetName) {
  const asset = (release.assets || []).find((item) => item.name === assetName);
  if (!asset) return;
  const res = await request(`${base}/repos/${repo}/releases/assets/${asset.id}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`asset delete failed for ${assetName}: HTTP ${res.status} ${await res.text()}`);
  }
}

async function uploadAsset(base, repo, releaseId, filePath) {
  const fileName = path.basename(filePath);
  const form = new FormData();
  const bytes = fs.readFileSync(filePath);
  form.append('attachment', new Blob([bytes]), fileName);

  const res = await request(
    `${base}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
    {
      method: 'POST',
      body: form,
    },
  );
  if (!res.ok) throw new Error(`asset upload failed for ${fileName}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const args = parseArgs(process.argv.slice(2));
const base = apiBase();
const repo = repoPath();

let release = await getReleaseByTag(base, repo, args.tag);
if (!release) {
  release = await createRelease(base, repo, args);
  console.log(`Created Forgejo release ${args.tag}`);
} else {
  console.log(`Using existing Forgejo release ${args.tag}`);
}

for (const file of args.files) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`release asset does not exist: ${file}`);
  const assetName = path.basename(absolute);
  await deleteExistingAsset(base, repo, release, assetName);
  const uploaded = await uploadAsset(base, repo, release.id, absolute);
  console.log(`Uploaded ${assetName}: ${uploaded.browser_download_url || uploaded.name}`);
}
