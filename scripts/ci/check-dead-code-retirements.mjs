#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { repoRoot } from './lib.mjs';

export const manifestPath = resolve(
  repoRoot,
  'scripts/ci/dead-code-retirements.json',
);

function isSafeRepoPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !isAbsolute(value) &&
    !value.includes('\\') &&
    !value.split('/').includes('..') &&
    value !== '.'
  );
}

function validateEntry(
  entry,
  kind,
  seenIds,
  seenTargets,
  violations,
  findingIds,
) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    violations.push(`${kind} entry must be an object`);
    return false;
  }

  if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
    violations.push(`${kind} entry has an invalid id: ${String(entry.id)}`);
  } else if (seenIds.has(entry.id)) {
    violations.push(`duplicate retirement entry id: ${entry.id}`);
  } else {
    seenIds.add(entry.id);
  }

  if (!isSafeRepoPath(entry.path)) {
    violations.push(
      `${entry.id || kind} has an unsafe repository path: ${String(entry.path)}`,
    );
  } else if (seenTargets.has(`${kind}:${entry.path}`)) {
    violations.push(`duplicate ${kind} target: ${entry.path}`);
  } else {
    seenTargets.add(`${kind}:${entry.path}`);
  }

  if (!Array.isArray(entry.findingIds) || entry.findingIds.length === 0) {
    violations.push(`${entry.id || kind} must name at least one finding id`);
  } else {
    for (const findingId of entry.findingIds) {
      if (typeof findingId !== 'string' || findingId.length === 0) {
        violations.push(`${entry.id || kind} has an invalid finding id`);
      } else {
        findingIds.add(findingId);
      }
    }
  }

  return isSafeRepoPath(entry.path);
}

export function evaluateDeadCodeRetirements(
  manifest,
  { rootDir = repoRoot } = {},
) {
  const violations = [];
  const seenIds = new Set();
  const seenTargets = new Set();
  const findingIds = new Set();

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['dead-code retirement manifest must be a JSON object'];
  }
  if (manifest.schemaVersion !== 1) {
    violations.push(
      `unsupported dead-code retirement schema: ${String(manifest.schemaVersion)}`,
    );
  }
  if (
    !Number.isInteger(manifest.expectedAbsentPathCount) ||
    manifest.expectedAbsentPathCount < 1
  ) {
    violations.push('expectedAbsentPathCount must be a positive integer');
  }
  if (!Array.isArray(manifest.absentPaths)) {
    violations.push('absentPaths must be an array');
  }
  if (!Array.isArray(manifest.forbiddenFragments)) {
    violations.push('forbiddenFragments must be an array');
  }
  if (
    !Array.isArray(manifest.requiredFindingIds) ||
    manifest.requiredFindingIds.length === 0
  ) {
    violations.push('requiredFindingIds must be a non-empty array');
  }

  const absentPaths = Array.isArray(manifest.absentPaths)
    ? manifest.absentPaths
    : [];
  const forbiddenFragments = Array.isArray(manifest.forbiddenFragments)
    ? manifest.forbiddenFragments
    : [];

  if (absentPaths.length !== manifest.expectedAbsentPathCount) {
    violations.push(
      `retired-file census changed: expected ${String(manifest.expectedAbsentPathCount)}, got ${absentPaths.length}`,
    );
  }

  for (const entry of absentPaths) {
    const pathIsSafe = validateEntry(
      entry,
      'absent path',
      seenIds,
      seenTargets,
      violations,
      findingIds,
    );
    if (pathIsSafe && existsSync(resolve(rootDir, entry.path))) {
      violations.push(`${entry.id}: retired path exists: ${entry.path}`);
    }
  }

  for (const entry of forbiddenFragments) {
    const pathIsSafe = validateEntry(
      entry,
      'forbidden fragment',
      seenIds,
      seenTargets,
      violations,
      findingIds,
    );
    if (!Array.isArray(entry?.fragments) || entry.fragments.length === 0) {
      violations.push(
        `${entry?.id || 'forbidden fragment'} must declare at least one fragment`,
      );
      continue;
    }
    if (!pathIsSafe) continue;

    const target = resolve(rootDir, entry.path);
    if (!existsSync(target)) {
      violations.push(
        `${entry.id}: fragment guard target is missing: ${entry.path}`,
      );
      continue;
    }
    const source = readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    const seenFragments = new Set();
    for (const fragment of entry.fragments) {
      if (typeof fragment !== 'string' || fragment.length === 0) {
        violations.push(`${entry.id}: fragments must be non-empty strings`);
      } else if (seenFragments.has(fragment)) {
        violations.push(
          `${entry.id}: duplicate forbidden fragment: ${JSON.stringify(fragment)}`,
        );
      } else {
        seenFragments.add(fragment);
        if (source.includes(fragment)) {
          violations.push(
            `${entry.id}: retired fragment restored in ${entry.path}: ${JSON.stringify(fragment)}`,
          );
        }
      }
    }
  }

  const requiredFindingIds = Array.isArray(manifest.requiredFindingIds)
    ? manifest.requiredFindingIds
    : [];
  if (new Set(requiredFindingIds).size !== requiredFindingIds.length) {
    violations.push('requiredFindingIds contains duplicates');
  }
  for (const findingId of requiredFindingIds) {
    if (typeof findingId !== 'string' || findingId.length === 0) {
      violations.push('requiredFindingIds contains an invalid id');
    } else if (!findingIds.has(findingId)) {
      violations.push(`required finding has no retirement rule: ${findingId}`);
    }
  }

  return violations;
}

export function loadDeadCodeRetirementManifest(path = manifestPath) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function main() {
  const manifest = loadDeadCodeRetirementManifest();
  const violations = evaluateDeadCodeRetirements(manifest);
  if (violations.length > 0) {
    console.error(
      'Dead-code retirement regressions found:\n' +
        violations.map((violation) => `  - ${violation}`).join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Dead-code retirement check passed (${manifest.absentPaths.length} paths, ` +
      `${manifest.forbiddenFragments.length} scoped fragment guards).`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
