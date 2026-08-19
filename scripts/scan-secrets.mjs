#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const skippedDirs = new Set([
  '.git',
  // Local agent/session state (e.g. .claude/worktrees holds full checkouts of
  // in-flight branches, including copies of this scanner whose PEM regex
  // self-matches). Never present in CI checkouts; machine-local only.
  '.claude',
  '.dart_tool',
  '.idea',
  '.vscode',
  'build',
  'node_modules',
  'output',
  'tmp',
]);

const skippedFilePatterns = [
  /package-lock\.json$/i,
  /pubspec\.lock$/i,
  /^scripts\/scan-secrets\.mjs$/i,
];

const filenameDetectors = [
  {
    name: 'Firebase Admin SDK service account JSON filename',
    pattern: /(^|[/\\])[^/\\]*firebase-adminsdk[^/\\]*\.json$/i,
  },
  {
    name: 'service account JSON filename',
    pattern: /(^|[/\\])[^/\\]*service[-_]account[^/\\]*\.json$/i,
  },
  {
    name: 'Google application credentials JSON filename',
    pattern: /(^|[/\\])[^/\\]*google-application-credentials[^/\\]*\.json$/i,
  },
];

const contentDetectors = [
  {
    name: 'service account private key JSON',
    pattern: /"type"\s*:\s*"service_account"[\s\S]*"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----/i,
  },
  {
    name: 'raw PEM private key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  },
  {
    name: 'Google service account private key fields',
    pattern: /"private_key_id"\s*:\s*"[a-f0-9]{20,}"[\s\S]*"client_email"\s*:\s*"[^"]+@[^"]+\.iam\.gserviceaccount\.com"/i,
  },
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skippedDirs.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

function shouldSkipFile(path) {
  return skippedFilePatterns.some((pattern) => pattern.test(path));
}

const findings = [];

for await (const file of walk(repoRoot)) {
  const displayPath = relative(repoRoot, file).replace(/\\/g, '/');
  if (shouldSkipFile(displayPath)) continue;

  for (const detector of filenameDetectors) {
    if (detector.pattern.test(displayPath)) {
      findings.push({ path: displayPath, detector: detector.name });
    }
  }

  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    continue;
  }

  for (const detector of contentDetectors) {
    if (detector.pattern.test(text)) {
      findings.push({ path: displayPath, detector: detector.name });
    }
  }
}

if (findings.length > 0) {
  console.error('Potential secret material found:');
  for (const finding of findings) {
    console.error(`- ${finding.path}: ${finding.detector}`);
  }
  process.exit(1);
}

console.log('Secret scan passed: no service-account private keys found in the working tree.');
