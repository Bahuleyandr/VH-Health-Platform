import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const actionCommitPattern = /@[0-9a-f]{40}$/i;
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
  const value = `(?:"(?:\\\\.|[^"\\\\])*"|'(?:''|[^'])*'|(?:\\$\\{\\{[^}]*\\}\\}|[^,}\\]\\r\\n#])*)`;
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
    if (!rawValue && lines[index - 1]?.trim() === 'defaults:') continue;
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

const reviewedDockerSubcommands = new Set(['build', 'login', 'push', 'run', 'save', 'tag']);
const shellControlPrefixes = new Set(['!', 'do', 'elif', 'else', 'if', 'then', 'until', 'while']);
const lifecycleWords = new Set(['bootstrap', 'create', 'inspect', 'prune', 'rm', 'use']);
const shellPayloadCommands = new Set(['bash', 'sh']);
const nestedCommandWrappers = new Set(['command', 'env', 'exec', 'nice', 'nohup', 'sudo', 'time']);
const wrapperValueOptions = new Map([
  ['env', new Set(['-a', '--argv0', '-C', '--chdir', '-u', '--unset'])],
  ['exec', new Set(['-a'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['sudo', new Set([
    '-C', '--close-from', '-D', '--chdir', '-g', '--group', '-h', '--host', '-p', '--prompt',
    '-R', '--chroot', '-r', '--role', '-T', '--command-timeout', '-t', '--type', '-u', '--user',
  ])],
  ['time', new Set(['-f', '--format', '-o', '--output'])],
]);
const wrapperFlagOptions = new Map([
  ['command', new Set(['-p'])],
  ['env', new Set([
    '-0', '--null', '-i', '--ignore-environment', '-v', '--debug', '--block-signal',
    '--default-signal', '--ignore-signal',
  ])],
  ['exec', new Set(['-c', '-l'])],
  ['nice', new Set([])],
  ['nohup', new Set([])],
  ['sudo', new Set([
    '-A', '--askpass', '-b', '--background', '-E', '--preserve-env', '-e', '--edit', '-H', '--set-home',
    '-i', '--login', '-K', '--remove-timestamp', '-k', '--reset-timestamp', '-n', '--non-interactive',
    '-P', '--preserve-groups', '-S', '--stdin', '-s', '--shell', '-V', '--version', '-v', '--validate',
  ])],
  ['time', new Set(['-a', '--append', '-p', '-q', '--quiet', '-v', '--verbose'])],
]);

function skipShellExpansion(script, start, opener, closer) {
  let depth = 1;
  let index = start;
  let quote = null;
  while (index < script.length && depth > 0) {
    const character = script[index];
    if (quote) {
      if (character === '\\') index += 2;
      else {
        if (character === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
    } else if (character === '\\') index += 2;
    else if (character === opener) {
      depth += 1;
      index += 1;
    } else if (character === closer) {
      depth -= 1;
      index += 1;
    } else index += 1;
  }
  return index;
}

function readShellWord(script, start) {
  let index = start;
  let value = '';
  let canonical = true;
  let dynamic = false;

  while (index < script.length && !/[\s;&|()]/.test(script[index])) {
    const character = script[index];
    if (character === '\\') {
      canonical = false;
      if (script[index + 1] === '\r' && script[index + 2] === '\n') index += 3;
      else if (script[index + 1] === '\n') index += 2;
      else if (index + 1 < script.length) {
        value += script[index + 1];
        index += 2;
      } else index += 1;
      continue;
    }
    if (character === "'") {
      canonical = false;
      const end = script.indexOf("'", index + 1);
      if (end === -1) return { end: script.length, value, canonical: false, dynamic: true };
      value += script.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (character === '"') {
      canonical = false;
      index += 1;
      while (index < script.length && script[index] !== '"') {
        if (script[index] === '\\' && index + 1 < script.length) {
          value += script[index + 1];
          index += 2;
        } else if (script[index] === '$') {
          dynamic = true;
          if (script[index + 1] === '(') index = skipShellExpansion(script, index + 2, '(', ')');
          else if (script[index + 1] === '{') index = skipShellExpansion(script, index + 2, '{', '}');
          else {
            index += 1;
            while (/[A-Za-z0-9_@*#?$!~-]/.test(script[index] || '')) index += 1;
          }
        } else if (script[index] === '`') {
          dynamic = true;
          const end = script.indexOf('`', index + 1);
          index = end === -1 ? script.length : end + 1;
        } else {
          value += script[index];
          index += 1;
        }
      }
      if (script[index] === '"') index += 1;
      continue;
    }
    if (character === '$') {
      canonical = false;
      dynamic = true;
      if (script[index + 1] === "'") {
        const end = script.indexOf("'", index + 2);
        index = end === -1 ? script.length : end + 1;
      } else if (script[index + 1] === '(') {
        index = skipShellExpansion(script, index + 2, '(', ')');
      } else if (script[index + 1] === '{') {
        index = skipShellExpansion(script, index + 2, '{', '}');
      } else {
        index += 1;
        while (/[A-Za-z0-9_@*#?$!~-]/.test(script[index] || '')) index += 1;
      }
      continue;
    }
    if (character === '`') {
      canonical = false;
      dynamic = true;
      const end = script.indexOf('`', index + 1);
      index = end === -1 ? script.length : end + 1;
      continue;
    }
    if (/[*?\[\]{}~]/.test(character)) canonical = false;
    value += character;
    index += 1;
  }

  return { end: index, value, canonical, dynamic };
}

function shellCommands(script) {
  const commands = [];
  let words = [];
  let index = 0;
  const finish = () => {
    if (words.length > 0) commands.push(words);
    words = [];
  };

  while (index < script.length) {
    const character = script[index];
    if (character === ' ' || character === '\t' || character === '\r') {
      index += 1;
      continue;
    }
    if (character === '\n' || /[;&|()]/.test(character)) {
      finish();
      index += 1;
      continue;
    }
    if ((character === '{' || character === '}') && /\s/.test(script[index + 1] || ' ')) {
      finish();
      index += 1;
      continue;
    }
    if (character === '#') {
      const end = script.indexOf('\n', index);
      finish();
      index = end === -1 ? script.length : end + 1;
      continue;
    }
    const word = readShellWord(script, index);
    word.raw = script.slice(index, word.end);
    words.push(word);
    index = word.end;
  }
  finish();
  return commands;
}

function shellCommandPosition(words) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.raw)) index += 1;
    else if (word.canonical && shellControlPrefixes.has(word.value)) index += 1;
    else break;
  }
  return index;
}

function hasLifecycleShape(words) {
  const flattened = words.map((word) => word.value).join(' ');
  return words.some((word) => lifecycleWords.has(word.value)) ||
    /(?:^|[\s/])docker-buildx(?:\s|$)|\bbuildx\b.*\b(?:create|inspect|prune|rm|use)\b/i
      .test(flattened) ||
    /(?:--bootstrap|--buildkitd-config|--driver(?:-opt)?|buildx_buildkit_)/i.test(flattened);
}

function hasBuildxText(words) {
  return /(?:^|[\s/])(?:docker-)?buildx(?:\s|$)|(?:^|\s)--builder(?:=|\s|$)/i
    .test(words.map((word) => word.value).join(' '));
}

function shellWordBasename(word) {
  return word.value.split('/').at(-1);
}

function wrappedCommandIndex(words, commandIndex, wrapper) {
  let index = commandIndex + 1;
  while (index < words.length) {
    const word = words[index];
    if (wrapper === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value)) {
      index += 1;
      continue;
    }
    if (word.dynamic) return -1;
    if (word.value === '--') return index + 1;
    if (wrapper === 'command' && ['-v', '-V'].includes(word.value)) return words.length;
    if (word.value.startsWith('-')) {
      const [option, inlineValue] = word.value.split('=', 2);
      if (wrapperValueOptions.get(wrapper)?.has(option)) {
        if (inlineValue !== undefined) index += 1;
        else {
          if (!words[index + 1]) return -1;
          index += 2;
        }
        continue;
      }
      if (wrapperFlagOptions.get(wrapper)?.has(word.value) ||
          (wrapper === 'nice' && /^-\d+$/.test(word.value))) {
        index += 1;
        continue;
      }
      return -1;
    }
    break;
  }
  return index;
}

function envSplitPayload(words, commandIndex) {
  let index = commandIndex + 1;
  while (index < words.length) {
    const word = words[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value)) {
      index += 1;
      continue;
    }
    if (word.dynamic) return { unsafe: true };
    if (word.value === '-S' || word.value === '--split-string') {
      const payload = words[index + 1];
      if (!payload || payload.dynamic) return { unsafe: true };
      return { payload: payload.value };
    }
    if (word.value.startsWith('--split-string=') || /^-S.+/.test(word.value)) {
      const payload = word.value.startsWith('--split-string=')
        ? word.value.slice('--split-string='.length)
        : word.value.slice(2);
      return payload ? { payload } : { unsafe: true };
    }
    if (word.value === '--') return null;
    if (word.value.startsWith('-')) {
      const [option, inlineValue] = word.value.split('=', 2);
      if (wrapperValueOptions.get('env').has(option)) {
        if (inlineValue !== undefined) index += 1;
        else {
          if (!words[index + 1]) return { unsafe: true };
          index += 2;
        }
        continue;
      }
      if (wrapperFlagOptions.get('env').has(word.value)) {
        index += 1;
        continue;
      }
      return { unsafe: true };
    }
    return null;
  }
  return null;
}

function hasDynamicShellPayload(words, commandIndex, depth, { rejectUnknownDynamic = false } = {}) {
  const optionIndex = words.findIndex(
    (word, index) => index > commandIndex &&
      (word.value === '--command' || /^-[abefhkmnptuvxBCEHPTlO]*c[abefhkmnptuvxBCEHPTlO]*$/.test(word.value)),
  );
  if (optionIndex === -1) {
    return rejectUnknownDynamic && words.slice(commandIndex + 1).some((word) => word.dynamic);
  }
  const payload = words[optionIndex + 1];
  if (!payload || payload.dynamic) return true;
  return hasUnreviewedDockerCommand(payload.value, depth + 1);
}

function isReviewedDockerCommand(words, commandIndex) {
  const command = words[commandIndex];
  if (!command.canonical || command.value !== 'docker') return false;
  const subcommand = words[commandIndex + 1];
  if (!subcommand?.canonical) return false;
  if (reviewedDockerSubcommands.has(subcommand.value)) return true;
  if (subcommand.value === 'image') {
    return words[commandIndex + 2]?.canonical && words[commandIndex + 2].value === 'inspect';
  }
  return false;
}

function hasUnreviewedShellCommand(words, commandIndex, depth) {
  const command = words[commandIndex];
  if (!command) return false;
  const commandBasename = shellWordBasename(command);
  if (commandBasename === 'docker-buildx' || commandBasename === 'buildx') return true;
  if (commandBasename === 'docker' && command.value !== 'docker') return true;
  if (command.value === 'docker') return !isReviewedDockerCommand(words, commandIndex);

  if (shellPayloadCommands.has(commandBasename)) {
    return hasDynamicShellPayload(words, commandIndex, depth, { rejectUnknownDynamic: true });
  }
  if (commandBasename === 'eval') {
    const payload = words.slice(commandIndex + 1);
    if (payload.some((word) => word.dynamic)) return true;
    return hasUnreviewedDockerCommand(payload.map((word) => word.value).join(' '), depth + 1);
  }
  if (nestedCommandWrappers.has(commandBasename)) {
    if (commandBasename === 'env') {
      const split = envSplitPayload(words, commandIndex);
      if (split?.unsafe) return true;
      if (split?.payload) return hasUnreviewedDockerCommand(split.payload, depth + 1);
    }
    const nestedIndex = wrappedCommandIndex(words, commandIndex, commandBasename);
    if (nestedIndex === -1) return true;
    if (nestedIndex >= words.length) return false;
    if (words[nestedIndex].dynamic) return true;
    return hasUnreviewedShellCommand(words, nestedIndex, depth + 1);
  }
  if (
    command.dynamic &&
    (hasLifecycleShape(words.slice(commandIndex)) ||
      hasBuildxText(words.slice(commandIndex)) ||
      hasDynamicShellPayload(words, commandIndex, depth))
  ) {
    return true;
  }
  return false;
}

function hasUnreviewedDockerCommand(script, depth = 0) {
  if (depth > 8) return true;
  for (const words of shellCommands(script)) {
    const commandIndex = shellCommandPosition(words);
    if (hasUnreviewedShellCommand(words, commandIndex, depth)) return true;
  }
  return false;
}

function workflowBuildkitLifecycleViolations(content, file) {
  const { scripts, violations } = workflowRunScalars(content, file);
  for (const run of scripts) {
    if (hasUnreviewedDockerCommand(run.script) || /(?:buildx_buildkit_|BUILDX_BUILDER)/i.test(run.script)) {
      violations.push({
        file,
        line: run.line,
        message: 'Workflow Docker commands must use reviewed literal forms; BuildKit lifecycle belongs to the digest-pinned setup action',
      });
    }
  }
  return violations;
}

function pinnedPostgresInput(content) {
  return /^      postgres_image:\s*\n(?:(?:        [^\n]*|\s*)\n)*?        default: pgvector\/pgvector:[^\s]+@sha256:[a-f0-9]{64}\s*$/m.test(content);
}

function approvedCanaryImage(content, file) {
  return file === '.github/workflows/pg18-canary.yml' &&
    /if \[\[ ! "\$POSTGRES_IMAGE" =~ \^pgvector\/pgvector:pg18@sha256:\[a-f0-9\]\{64\}\$ \]\]; then\s+echo '[^'\n]+'\s+exit 1\s+fi\s+printf 'image=%s\\n' "\$POSTGRES_IMAGE" >> "\$GITHUB_OUTPUT"/.test(content) &&
    /needs:\s*validate-image/.test(content) &&
    /POSTGRES_IMAGE:\s*\$\{\{ inputs\.postgres_image \}\}/.test(content) &&
    content.includes("printf 'image=%s\\n'") &&
    /validate-image:[\s\S]*?outputs:[\s\S]*?image:/.test(content);
}

function buildkitStep(content, offset) {
  const lineStart = content.lastIndexOf('\n', offset) + 1;
  const lines = content.slice(lineStart).split('\n');
  const match = lines[0].match(/^( *)(?:- )?uses:/);
  if (!match) return '';
  const indent = lines[0].indexOf('uses:');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() && line.search(/\S/) < indent);
  return lines.slice(0, end < 0 ? undefined : end).join('\n');
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
      if (value.startsWith('docker/setup-buildx-action@')) {
        const step = buildkitStep(content, match.index);
        if (!/^\s+driver:\s*docker-container\s*$/m.test(step) ||
            (step.match(/^\s+driver:/gm) || []).length !== 1 ||
            (step.match(/\bimage=/g) || []).length !== 1 ||
            !/^\s+(?:driver-opts:\s*image=|image=)moby\/buildkit@sha256:[a-f0-9]{64}\s*$/m.test(step)) {
          violations.push({ file, line: lineNumberAt(content, match.index),
            message: 'BuildKit setup must use a direct mapping, docker-container and a literal digest-pinned image driver option' });
        }
      }
      if (!value.startsWith('./') && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/i.test(value)) {
        violations.push({
          file,
          line: lineNumberAt(content, match.index),
          message: `remote action must use a literal GitHub action and full 40-character commit SHA: ${value}`,
        });
      } else if (!value.startsWith('./') && !actionCommitPattern.test(value)) {
        violations.push({
          file,
          line: lineNumberAt(content, match.index),
          message: `remote action must use a full 40-character commit SHA: ${value}`,
        });
      }
    }

    const serviceInput = value === '${{ inputs.postgres_image }}' &&
      file === '.github/workflows/_reusable-backend-lint-test.yml' && pinnedPostgresInput(content);
    const builtImage = /^\$\{\{ steps\.images\.outputs\.(?:backend|admin|staff_web) \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}$/.test(value) &&
      file === '.github/workflows/release-images.yml' &&
      /uses: docker\/build-push-action@[a-f0-9]{40}/.test(content);
    const canaryOutput = value === '${{ steps.validate.outputs.image }}' && approvedCanaryImage(content, file);
    if (key === 'image' && value && !literalImageDigestPattern.test(value) &&
        !serviceInput && !builtImage && !canaryOutput) {
      violations.push({
        file,
        line: lineNumberAt(content, match.index),
        message: `workflow container image must use a sha256 digest: ${value}`,
      });
    }

    if (key === 'postgres_image' && value &&
        !literalImageDigestPattern.test(value) &&
        !(value === '${{ needs.validate-image.outputs.image }}' && approvedCanaryImage(content, file))) {
      violations.push({ file, line: lineNumberAt(content, match.index),
        message: 'Postgres workflow input must be digest-pinned or emitted by the fail-closed PG18 validation job' });
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

  violations.push(...workflowBuildkitLifecycleViolations(content, file));

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

export function findWorkflowSupplyChainViolations(rootDir) {
  const workflowDir = join(rootDir, '.github', 'workflows');
  const violations = [];

  if (!existsSync(workflowDir)) {
    return [{
      file: '.github/workflows',
      line: 1,
      message: 'Workflow directory is missing',
    }];
  }

  const files = workflowFiles(workflowDir);
  if (files.length === 0) {
    return [{ file: '.github/workflows', line: 1, message: 'No workflow files found' }];
  }
  for (const filePath of files) {
    violations.push(...scanWorkflow(filePath, rootDir));
  }

  return violations;
}

export function assertWorkflowSupplyChainPins(rootDir) {
  const violations = findWorkflowSupplyChainViolations(rootDir);
  if (violations.length === 0) return;

  const details = violations
    .map(({ file, line, message }) => `- ${file}:${line}: ${message}`)
    .join('\n');
  throw new Error(`Workflow supply-chain pin validation failed:\n${details}`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const repoRoot = resolve(dirname(scriptPath), '..');
  assertWorkflowSupplyChainPins(repoRoot);
  console.log('Workflow supply-chain pins are immutable.');
}
