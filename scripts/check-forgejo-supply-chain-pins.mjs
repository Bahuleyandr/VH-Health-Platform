import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const actionCommitPattern = /@[0-9a-f]{40}$/i;
const imageDigestPattern = /@sha256:[0-9a-f]{64}$/i;
const literalImageDigestPattern = /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/i;

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

function foldYamlBlockLines(lines) {
  return lines.reduce((result, line, index) => {
    if (index === 0) return line;
    const previous = lines[index - 1];
    const separator =
      previous.trim() === '' ||
      line.trim() === '' ||
      previous.startsWith(' ') ||
      line.startsWith(' ')
        ? '\n'
        : ' ';
    return `${result}${separator}${line}`;
  }, '');
}

function decodeInlineRunScalar(rawValue) {
  const anchoredValue = rawValue.trim().replace(/^&[A-Za-z0-9_.-]+\s+/, '');
  if (!anchoredValue || /^(?:\*|!|\$\{\{)/.test(anchoredValue)) return null;

  if (anchoredValue.startsWith('"')) {
    const match = anchoredValue.match(/^("(?:\\.|[^"\\])*")(?:\s+#.*)?$/);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
  if (anchoredValue.startsWith("'")) {
    const match = anchoredValue.match(/^('(?:''|[^'])*')(?:\s+#.*)?$/);
    return match ? match[1].slice(1, -1).replaceAll("''", "'") : null;
  }
  return anchoredValue;
}

function workflowRunScalars(content, file) {
  const lines = content.split(/\r?\n/);
  const scripts = [];
  const violations = [];
  const handledLines = new Set();
  const blockRanges = [];
  const key = `(?<key>"(?:\\\\.|[^"\\\\])*"|'(?:''|[^'])*'|[A-Za-z_][A-Za-z0-9_.-]*)`;
  const directMapping = new RegExp(`^(?<indent> *)(?:-\\s*)?${key}\\s*:\\s*(?<value>.*)$`);
  const blockHeader = /^(?<style>[>|])(?<modifiers>[+-]|[1-9]|[+-][1-9]|[1-9][+-])?(?:\s+#.*)?$/;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith('#')) continue;
    const mapping = line.match(directMapping);
    if (!mapping) continue;
    const parsedKey = parseYamlKey(mapping.groups.key);
    if (parsedKey?.toLowerCase() !== 'run') continue;

    const lineNumber = index + 1;
    handledLines.add(lineNumber);
    const rawValue = mapping.groups.value.trim();
    const unanchoredValue = rawValue.replace(/^&[A-Za-z0-9_.-]+\s+/, '');
    const header = unanchoredValue.match(blockHeader);
    const parentIndent = line.indexOf(mapping.groups.key);
    if (header) {
      let firstContent = index + 1;
      while (firstContent < lines.length && lines[firstContent].trim() === '') {
        firstContent += 1;
      }

      const contentIndent = firstContent < lines.length
        ? lines[firstContent].match(/^ */)[0].length
        : 0;
      if (contentIndent <= parentIndent) {
        scripts.push({ script: '', line: lineNumber });
        continue;
      }

      const blockLines = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        if (lines[cursor].trim() === '') {
          blockLines.push('');
          continue;
        }
        const indentation = lines[cursor].match(/^ */)[0].length;
        if (indentation < contentIndent) break;
        blockLines.push(lines[cursor].slice(contentIndent));
      }
      blockRanges.push([index + 2, cursor]);
      if (/\d/.test(header.groups.modifiers || '')) {
        violations.push({
          file,
          line: lineNumber,
          message: 'workflow run commands must use direct, supported scalar values',
        });
      } else {
        const script = header.groups.style === '>'
          ? foldYamlBlockLines(blockLines)
          : blockLines.join('\n');
        scripts.push({ script, line: lineNumber });
      }
      index = cursor - 1;
      continue;
    }

    let continuation = index + 1;
    while (
      continuation < lines.length &&
      (lines[continuation].trim() === '' || lines[continuation].trimStart().startsWith('#'))
    ) {
      continuation += 1;
    }
    if (
      continuation < lines.length &&
      lines[continuation].match(/^ */)[0].length > parentIndent
    ) {
      let cursor = continuation + 1;
      while (
        cursor < lines.length &&
        (lines[cursor].trim() === '' || lines[cursor].match(/^ */)[0].length > parentIndent)
      ) {
        cursor += 1;
      }
      blockRanges.push([index + 2, cursor]);
      violations.push({
        file,
        line: lineNumber,
        message: 'workflow run commands must use direct, supported scalar values',
      });
      index = cursor - 1;
      continue;
    }

    const script = decodeInlineRunScalar(rawValue);
    if (script === null || /^[>|]/.test(unanchoredValue)) {
      violations.push({
        file,
        line: lineNumber,
        message: 'workflow run commands must use direct, supported scalar values',
      });
      continue;
    }
    scripts.push({ script, line: lineNumber });
  }

  for (const match of scalarPairs(content)) {
    if (isCommentedMatch(content, match.index)) continue;
    const parsedKey = parseYamlKey(match.groups.key);
    if (parsedKey?.toLowerCase() !== 'run') continue;
    const line = lineNumberAt(content, match.index);
    if (handledLines.has(line)) continue;
    if (blockRanges.some(([start, end]) => line >= start && line <= end)) continue;
    violations.push({
      file,
      line,
      message: 'workflow run commands must use direct, supported scalar values',
    });
  }

  return { scripts, violations };
}

function shellCommands(script) {
  const commands = [];
  let words = [];
  let continuationBoundaries = [];
  let word = null;
  let quote = null;

  const startWord = () => {
    if (!word) word = { value: '', simple: true, dynamic: false };
  };
  const finishWord = () => {
    if (!word) return;
    words.push(word);
    word = null;
  };
  const finishCommand = () => {
    finishWord();
    if (words.length > 0) commands.push({ words, continuationBoundaries });
    words = [];
    continuationBoundaries = [];
  };

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];

    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        word.value += character;
      }
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === '\\') {
        word.simple = false;
        if (script[index + 1] === '\r' && script[index + 2] === '\n') {
          index += 2;
        } else if (script[index + 1] === '\n') {
          index += 1;
        } else if (index + 1 < script.length) {
          word.value += script[index + 1];
          index += 1;
        }
      } else {
        if (character === '$' || character === '`') word.dynamic = true;
        word.value += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      startWord();
      word.simple = false;
      quote = character;
      continue;
    }

    if (character === '\\') {
      const hasCrLf = script[index + 1] === '\r' && script[index + 2] === '\n';
      const hasLf = script[index + 1] === '\n';
      if (hasCrLf || hasLf) {
        if (word) word.simple = false;
        else continuationBoundaries.push(words.length);
        index += hasCrLf ? 2 : 1;
      } else {
        startWord();
        word.simple = false;
        if (index + 1 < script.length) {
          word.value += script[index + 1];
          index += 1;
        }
      }
      continue;
    }

    if (character === '#' && !word) {
      while (index + 1 < script.length && !/[\r\n]/.test(script[index + 1])) index += 1;
      finishCommand();
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      if (character === '\n' || character === '\r') finishCommand();
      continue;
    }
    if (character === ';' || character === '|' || character === '&') {
      finishCommand();
      continue;
    }

    startWord();
    if (character === '$' || character === '`') word.dynamic = true;
    word.value += character;
  }
  finishCommand();
  return commands;
}

function canonicalDockerIndex(words, buildxIndex) {
  const prefixes = [
    [],
    ['if'],
    ['elif'],
    ['while'],
    ['until'],
    ['!'],
    ['if', '!'],
    ['elif', '!'],
    ['while', '!'],
    ['until', '!'],
  ];

  for (const prefix of prefixes) {
    const dockerIndex = prefix.length;
    if (buildxIndex !== dockerIndex + 1) continue;
    if (prefix.every((value, index) => words[index]?.simple && words[index].value === value)) {
      return dockerIndex;
    }
  }
  return -1;
}

function buildxCommands(script, line) {
  const commands = [];
  const supportedSubcommands = new Set(['build', 'create', 'inspect', 'rm', 'use']);

  for (const command of shellCommands(script)) {
    const { words, continuationBoundaries } = command;
    for (let buildxIndex = 0; buildxIndex < words.length; buildxIndex += 1) {
      const buildxWord = words[buildxIndex];
      const normalizedWord = buildxWord.value.toLowerCase();
      const embeddedDockerBuildx = /(?:^|=)docker\s+buildx(?:\s|$)/.test(normalizedWord);
      if (normalizedWord !== 'buildx' && !embeddedDockerBuildx) continue;

      const dockerIndex = canonicalDockerIndex(words, buildxIndex);
      const dockerWord = words[dockerIndex];
      const subcommand = words[buildxIndex + 1];
      const splitCoreToken = continuationBoundaries.some(
        (boundary) => boundary > dockerIndex && boundary <= buildxIndex + 1,
      );
      const canonical =
        dockerIndex >= 0 &&
        dockerWord?.simple &&
        dockerWord.value === 'docker' &&
        buildxWord.simple &&
        buildxWord.value === 'buildx' &&
        subcommand?.simple &&
        !subcommand.dynamic &&
        supportedSubcommands.has(subcommand.value) &&
        !splitCoreToken;

      commands.push({
        canonical,
        line,
        subcommand: canonical ? subcommand.value : null,
        words: canonical ? words.slice(buildxIndex + 2) : [],
      });
    }
  }
  return commands;
}

function buildkitDriverImageViolations(content, file) {
  const { scripts, violations } = workflowRunScalars(content, file);

  for (const run of scripts) {
    for (const command of buildxCommands(run.script, run.line)) {
      if (!command.canonical) {
        violations.push({
          file,
          line: command.line,
          message: 'Buildx commands must use a canonical literal docker buildx invocation',
        });
        continue;
      }
      if (command.subcommand !== 'create') continue;

      const drivers = [];
      const driverOptions = [];
      let invalidControlOption = false;
      let unsupportedArgument = false;
      const positionals = [];
      for (let index = 0; index < command.words.length; index += 1) {
        const option = command.words[index];
        const optionName = option.value.toLowerCase();
        if (optionName === '--driver') {
          const value = command.words[index + 1];
          if (!option.simple || !value || value.dynamic) invalidControlOption = true;
          else drivers.push(value.value);
          index += 1;
        } else if (optionName.startsWith('--driver=')) {
          if (!option.simple || option.dynamic) invalidControlOption = true;
          else drivers.push(option.value.slice('--driver='.length));
        } else if (optionName === '--driver-opt') {
          const value = command.words[index + 1];
          if (!option.simple || !value || value.dynamic) invalidControlOption = true;
          else driverOptions.push(value.value);
          index += 1;
        } else if (optionName.startsWith('--driver-opt=')) {
          if (!option.simple || option.dynamic) invalidControlOption = true;
          else driverOptions.push(option.value.slice('--driver-opt='.length));
        } else if (['--name', '--buildkitd-config'].includes(optionName)) {
          if (!command.words[index + 1]) unsupportedArgument = true;
          index += 1;
        } else if (optionName.startsWith('--name=') || optionName.startsWith('--buildkitd-config=')) {
          if (option.dynamic) unsupportedArgument = true;
        } else if (optionName === '--use') {
          if (!option.simple) unsupportedArgument = true;
        } else if (optionName.startsWith('-') || option.dynamic) {
          unsupportedArgument = true;
        } else {
          positionals.push(option.value);
        }
      }

      if (invalidControlOption) {
        violations.push({
          file,
          line: command.line,
          message: 'docker-container BuildKit image must use a direct literal sha256 digest option value',
        });
        continue;
      }
      if (drivers.length > 1) {
        violations.push({
          file,
          line: command.line,
          message: 'docker buildx create must set --driver at most once',
        });
        continue;
      }

      const driver = drivers[0]?.toLowerCase();
      if (
        unsupportedArgument ||
        (positionals.length > 0 && !['cloud', 'kubernetes', 'remote'].includes(driver))
      ) {
        violations.push({
          file,
          line: command.line,
          message: 'docker buildx create must use only the supported direct argument form',
        });
        continue;
      }
      if (driver && ['cloud', 'docker', 'kubernetes', 'remote'].includes(driver)) continue;

      const driverImages = driverOptions.flatMap((option) =>
        option
          .split(',')
          .filter((field) => /^image=/i.test(field))
          .map((field) => field.slice('image='.length)),
      );
      if (driverImages.length === 0) {
        violations.push({
          file,
          line: command.line,
          message: 'docker-container BuildKit image must be explicit and use a sha256 digest',
        });
        continue;
      }
      if (driverImages.length !== 1 || !literalImageDigestPattern.test(driverImages[0])) {
        violations.push({
          file,
          line: command.line,
          message: `docker-container BuildKit image must use a sha256 digest: ${driverImages.join(', ')}`,
        });
      }
    }
  }

  return violations;
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

  violations.push(...buildkitDriverImageViolations(content, file));

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
