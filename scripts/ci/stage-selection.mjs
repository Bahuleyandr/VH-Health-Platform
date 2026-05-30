import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const fullRunPatterns = [
  /^\.forgejo\/workflows\//,
  /^\.github\/workflows\//,
  /^scripts\/ci\//,
  /^scripts\/local-ci\.mjs$/,
];

const backendPatterns = [/^apps\/backend\//];
const adminPatterns = [/^apps\/admin\//];
const flutterPatterns = [
  /^apps\/patient\//,
  /^apps\/staff\//,
  /^packages\//,
  /^pubspec\.ya?ml$/,
  /^pubspec\.lock$/,
  /^scripts\/dart-format-check\.mjs$/,
];
const fhirPatterns = [
  /^apps\/backend\/src\/services\/fhir\//,
  /^scripts\/ci\/fhir\.mjs$/,
];
const infraPatterns = [
  /^infra\/kubernetes\//,
  /^scripts\/validate-kubernetes-manifests\.mjs$/,
];
const securityOnlyPatterns = [
  /^docs\//,
  /^README\.md$/i,
  /^LICENSE$/i,
  /^AGENTS\.md$/i,
  /^\.gitignore$/,
  /^\.gitleaks\.toml$/,
  /^lefthook\.yml$/,
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function gitMaybe(args) {
  try {
    return git(args);
  } catch {
    return '';
  }
}

function hasCommit(ref) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function eventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return {};
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return {};
  }
}

function isZeroSha(value) {
  return Boolean(value) && /^0+$/.test(value);
}

function diffBaseForBranchPush() {
  const payload = eventPayload();
  const before = payload.before || process.env.GITHUB_BEFORE;
  if (before && !isZeroSha(before) && hasCommit(before)) return before;

  return gitMaybe(['merge-base', 'HEAD', 'origin/main']) || gitMaybe(['rev-parse', 'HEAD~1']) || 'HEAD';
}

export function shouldSelectChangedStages() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  const ref = process.env.GITHUB_REF || '';
  return eventName === 'push' && ref.startsWith('refs/heads/') && ref !== 'refs/heads/main';
}

export function changedFilesForBranchPush() {
  const base = diffBaseForBranchPush();
  const output = git(['diff', '--name-only', `${base}..HEAD`]);
  return output
    .split(/\r?\n/)
    .map((file) => file.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

function matchesAny(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

function isKnownSecurityOnly(file) {
  return matchesAny(file, securityOnlyPatterns) || /\.md$/i.test(file);
}

export function stagesForChangedFiles(files, stageOrder) {
  if (files.length === 0) return [...stageOrder];
  if (files.some((file) => matchesAny(file, fullRunPatterns))) return [...stageOrder];

  const selected = new Set(['security']);
  let unknownRiskyFile = false;

  for (const file of files) {
    if (matchesAny(file, backendPatterns)) selected.add('backend');
    if (matchesAny(file, adminPatterns)) selected.add('admin');
    if (matchesAny(file, flutterPatterns)) selected.add('flutter');
    if (matchesAny(file, fhirPatterns)) selected.add('fhir');
    if (matchesAny(file, infraPatterns)) selected.add('infra');

    const known =
      matchesAny(file, backendPatterns) ||
      matchesAny(file, adminPatterns) ||
      matchesAny(file, flutterPatterns) ||
      matchesAny(file, fhirPatterns) ||
      matchesAny(file, infraPatterns) ||
      isKnownSecurityOnly(file);

    if (!known) unknownRiskyFile = true;
  }

  if (unknownRiskyFile) return [...stageOrder];
  return stageOrder.filter((stage) => selected.has(stage));
}
