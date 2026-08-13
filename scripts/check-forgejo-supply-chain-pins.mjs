import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const actionCommitPattern = /@[0-9a-f]{40}$/i;
const imageDigestPattern = /@sha256:[0-9a-f]{64}$/i;

function lineNumberAt(content, offset) {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function parseYamlScalar(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const closingIndex = value.indexOf(quote, 1);
    return closingIndex === -1 ? value : value.slice(1, closingIndex);
  }
  return value.split(/\s+#/, 1)[0].trim();
}

function scalarPairs(content) {
  const key = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:''|[^'])*'|[A-Za-z_][A-Za-z0-9_.-]*)`;
  const value = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:''|[^'])*'|[^,}\\]\\r\\n#]*)`;
  const pattern = new RegExp(
    `(?=(?:^|[ \\t,{\\[])(?<key>${key})[ \\t]*:[ \\t]*(?<value>${value}))`,
    'gim',
  );
  return content.matchAll(pattern);
}

function parseYamlKey(rawKey) {
  if (rawKey.startsWith('"')) {
    try {
      return JSON.parse(rawKey);
    } catch {
      return null;
    }
  }
  if (rawKey.startsWith("'")) return rawKey.slice(1, -1).replaceAll("''", "'");
  return rawKey;
}

function isCommentedMatch(content, offset) {
  const lineStart = content.lastIndexOf('\n', offset) + 1;
  return content.slice(lineStart, offset).trimStart().startsWith('#');
}

function scanWorkflow(filePath, rootDir) {
  const content = readFileSync(filePath, 'utf8');
  const violations = [];
  const file = relative(rootDir, filePath).replaceAll('\\', '/');

  for (const match of content.matchAll(/^.*(?:^|[\s[{,])(?:\?(?=\s)|\*[A-Za-z0-9_.-]+\s*:(?=\s)).*$/gim)) {
    if (match[0].trimStart().startsWith('#')) continue;
    violations.push({
      file,
      line: lineNumberAt(content, match.index),
      message: 'workflow mappings must use direct scalar keys, not explicit or aliased keys',
    });
  }

  for (const match of scalarPairs(content)) {
    if (isCommentedMatch(content, match.index)) continue;
    const rawKey = match.groups.key;
    const key = parseYamlKey(rawKey);
    const value = parseYamlScalar(match.groups.value);

    if (key === null) {
      violations.push({
        file,
        line: lineNumberAt(content, match.index),
        message: `workflow keys must not use unsupported escapes: ${rawKey}`,
      });
      continue;
    }

    if (key.toLowerCase() === 'uses' && value) {
      if (!value.startsWith('./') && !/^https?:\/\//i.test(value)) {
        violations.push({
          file,
          line: lineNumberAt(content, match.index),
          message: `remote action must use a literal HTTPS URL and full commit SHA: ${value}`,
        });
      } else if (/^https?:\/\//i.test(value) && !actionCommitPattern.test(value)) {
        violations.push({
          file,
          line: lineNumberAt(content, match.index),
          message: `remote action must use a full 40-character commit SHA: ${value}`,
        });
      }
    }

    if (key.toLowerCase() === 'image' && value && !imageDigestPattern.test(value)) {
      violations.push({
        file,
        line: lineNumberAt(content, match.index),
        message: `workflow container image must use a sha256 digest: ${value}`,
      });
    }

    if (key.toLowerCase() === 'version' && /^(?:latest|stable|main|master)$/i.test(value)) {
      violations.push({
        file,
        line: lineNumberAt(content, match.index),
        message: `workflow tool version must be exact, not a movable channel: ${value}`,
      });
    }
  }

  for (const match of content.matchAll(/^.*\bnpx\b.*@latest\b.*$/gim)) {
    if (match[0].trimStart().startsWith('#')) continue;
    violations.push({
      file: relative(rootDir, filePath).replaceAll('\\', '/'),
      line: lineNumberAt(content, match.index),
      message: 'npx must execute an exact package version, not @latest',
    });
  }

  return violations;
}

function workflowFiles(workflowDir) {
  const files = [];
  for (const entry of readdirSync(workflowDir, { withFileTypes: true })) {
    const entryPath = join(workflowDir, entry.name);
    if (entry.isDirectory()) files.push(...workflowFiles(entryPath));
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function scanDockerfile(filePath, rootDir) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const violations = [];
  const fromPattern = /^\s*FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+\S+)?\s*$/gim;

  for (const match of content.matchAll(fromPattern)) {
    const image = match[1];
    if (!imageDigestPattern.test(image)) {
      violations.push({
        file: relative(rootDir, filePath).replaceAll('\\', '/'),
        line: lineNumberAt(content, match.index),
        message: `Forgejo runner base image must use a sha256 digest: ${image}`,
      });
    }
  }

  return violations;
}

export function findForgejoSupplyChainViolations(rootDir) {
  const workflowDir = join(rootDir, '.forgejo', 'workflows');
  const violations = [];

  if (!existsSync(workflowDir)) {
    return [{
      file: '.forgejo/workflows',
      line: 1,
      message: 'Forgejo workflow directory is missing',
    }];
  }

  for (const filePath of workflowFiles(workflowDir)) {
    violations.push(...scanWorkflow(filePath, rootDir));
  }

  violations.push(
    ...scanDockerfile(join(rootDir, 'infra', 'forgejo', 'ci-image', 'Dockerfile'), rootDir),
  );
  return violations;
}

export function assertForgejoSupplyChainPins(rootDir) {
  const violations = findForgejoSupplyChainViolations(rootDir);
  if (violations.length === 0) return;

  const details = violations
    .map(({ file, line, message }) => `- ${file}:${line}: ${message}`)
    .join('\n');
  throw new Error(`Forgejo supply-chain pin validation failed:\n${details}`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const repoRoot = resolve(dirname(scriptPath), '..');
  assertForgejoSupplyChainPins(repoRoot);
  console.log('Forgejo supply-chain pins are immutable.');
}
