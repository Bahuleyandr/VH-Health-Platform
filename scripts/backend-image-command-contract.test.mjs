// Backend runtime-image ↔ Kubernetes command contract.
//
// The production stage of apps/backend/Dockerfile deliberately strips npm and
// npx from the runtime image. Nothing enforced that the Kubernetes manifests
// which run that image only invoke things the image still contains, so the
// ArgoCD PreSync migration Job shipped `npm run db:ensure-pgvector` as step 1:
// syntactically fine, reviewed by humans, validated by kubeconform, and
// guaranteed to abort the whole sync with `npm: not found` on first contact
// with a real cluster. This suite closes that hole.
//
// How it works — nothing here is hardcoded about npm:
//   * parseRuntimeStage()/buildImageModel() read apps/backend/Dockerfile and
//     derive what the runtime image actually contains: the base-image binaries,
//     what `apk add` put in, what `rm -rf` took back out, and which repo paths
//     each COPY places under WORKDIR.
//   * extractContainers() reads every manifest in infra/kubernetes/apps/backend
//     and pulls out each container's image + command + args.
//   * For containers running the backend image, every command word the
//     container invokes (including inside `sh -c` scripts and command
//     substitutions) must resolve to a binary the image has, and every
//     `node <script>` target must be a file the Dockerfile copies in AND that
//     exists on disk.
//
// So if someone re-adds npm to the image, `npm run` stops being a violation on
// its own; if someone deletes another binary, its call sites start failing.
// The contract is the image, not a blocklist.
//
// SCOPE: infra/kubernetes/apps/backend/*.yaml (this lane's manifests) plus the
// Dockerfile's own CMD/HEALTHCHECK. Backend-image workloads outside that
// directory are NOT covered here.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = relative => readFileSync(path.join(repoRoot, relative), 'utf8');

const BACKEND_DIR = 'apps/backend';
const DOCKERFILE = `${BACKEND_DIR}/Dockerfile`;
const BACKEND_MANIFEST_DIR = 'infra/kubernetes/apps/backend';
const BACKEND_IMAGE_REPO = 'ghcr.io/bahuleyandr/vh-health-platform-backend';

// ---------------------------------------------------------------------------
// Dockerfile → image model
// ---------------------------------------------------------------------------

// alpine's busybox multi-call binary. Conservative: only applets this repo's
// manifests may legitimately reach for. An unlisted applet fails closed with a
// message telling you to extend this list deliberately.
const BUSYBOX_APPLETS = [
  'sh', 'ash', 'awk', 'base64', 'basename', 'cat', 'chmod', 'chown', 'cp',
  'cut', 'date', 'df', 'dirname', 'du', 'echo', 'env', 'expr', 'find', 'grep',
  'gzip', 'head', 'hostname', 'id', 'ln', 'ls', 'md5sum', 'mkdir', 'mktemp',
  'mv', 'nc', 'nslookup', 'printf', 'ps', 'pwd', 'readlink', 'rm', 'rmdir',
  'sed', 'seq', 'sha256sum', 'sleep', 'sort', 'stat', 'tail', 'tar', 'tee',
  'test', 'touch', 'tr', 'true', 'false', 'uname', 'uniq', 'wc', 'wget',
  'which', 'xargs',
];

// Only packages this Dockerfile actually installs. Unknown packages contribute
// nothing, so a command from an uninstalled package fails closed.
const APK_PACKAGE_BINARIES = {
  curl: ['curl'],
  'poppler-utils': [
    'pdftotext', 'pdftoppm', 'pdfimages', 'pdfinfo', 'pdftops', 'pdfunite',
    'pdfseparate',
  ],
  'tesseract-ocr': ['tesseract'],
  'tesseract-ocr-data-eng': [],
  libcrypto3: [],
  libssl3: [],
  'c-ares': [],
};

// POSIX shell builtins / reserved words — never resolved against the image.
const SHELL_BUILTINS = new Set([
  ':', '.', 'source', 'alias', 'bg', 'break', 'cd', 'command', 'continue',
  'echo', 'eval', 'exec', 'exit', 'export', 'false', 'fg', 'getopts', 'hash',
  'jobs', 'kill', 'local', 'printf', 'pwd', 'read', 'readonly', 'return',
  'set', 'shift', 'test', 'times', 'trap', 'true', 'type', 'ulimit', 'umask',
  'unalias', 'unset', 'wait', '[',
]);

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'in', 'function', 'select', 'time', '{', '}', '!', '(', ')',
  '[[', ']]',
]);

const SHELL_EXECUTABLES = new Set(['sh', 'ash', 'bash', 'dash']);

/** Split a Dockerfile into logical instructions, joining `\` continuations. */
export function dockerfileInstructions(text) {
  const raw = [];
  let buffer = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (buffer === null) {
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      buffer = trimmed;
    } else {
      if (trimmed.startsWith('#')) continue;
      buffer += ` ${trimmed}`;
    }
    if (buffer.endsWith('\\')) {
      buffer = buffer.slice(0, -1);
      continue;
    }
    raw.push(buffer);
    buffer = null;
  }
  if (buffer !== null) raw.push(buffer);

  return raw.map(instruction => {
    const match = instruction.match(/^(\S+)\s+([\s\S]*)$/);
    return match
      ? { keyword: match[1].toUpperCase(), value: match[2].trim() }
      : { keyword: instruction.toUpperCase(), value: '' };
  });
}

const expandArgs = (value, args) =>
  value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => args.get(name) ?? whole)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => args.get(name) ?? whole);

/** Return the stage that produces the shipped runtime image. */
export function parseRuntimeStage(dockerfileText) {
  const args = new Map();
  const stages = [];
  let current = null;

  for (const instruction of dockerfileInstructions(dockerfileText)) {
    if (instruction.keyword === 'ARG') {
      const match = instruction.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/);
      if (match) args.set(match[1], match[2].trim());
      continue;
    }
    if (instruction.keyword === 'FROM') {
      const match = instruction.value.match(/^(\S+)(?:\s+AS\s+(\S+))?\s*$/i);
      assert.ok(match, `unparseable FROM: ${instruction.value}`);
      current = {
        base: expandArgs(match[1], args),
        name: match[2] ? match[2].toLowerCase() : null,
        instructions: [],
      };
      stages.push(current);
      continue;
    }
    if (current) current.instructions.push(instruction);
  }

  assert.ok(stages.length > 0, 'Dockerfile declares no build stage');
  return stages.find(stage => stage.name === 'production') ?? stages.at(-1);
}

function baseImageCommands(baseImage) {
  const commands = new Set();
  const reference = baseImage.split('@')[0];
  if (/(^|\/)node:/.test(reference)) {
    for (const binary of ['node', 'npm', 'npx', 'corepack', 'yarn']) commands.add(binary);
  }
  if (/alpine/.test(reference)) {
    for (const applet of BUSYBOX_APPLETS) commands.add(applet);
    commands.add('busybox');
  }
  assert.ok(commands.size > 0, `unrecognised base image, cannot model contents: ${baseImage}`);
  return commands;
}

function applyRunInstruction(value, commands) {
  for (const match of value.matchAll(/\bapk\s+add\s+([^&|;]+)/g)) {
    for (const token of match[1].trim().split(/\s+/)) {
      if (!token || token.startsWith('-')) continue;
      for (const binary of APK_PACKAGE_BINARIES[token] ?? []) commands.add(binary);
    }
  }
  for (const match of value.matchAll(/\brm\s+(?:-\S+\s+)*([^&|;]+)/g)) {
    for (const token of match[1].trim().split(/\s+/)) {
      if (!token || token.startsWith('-')) continue;
      if (/\/bin\/[^/]+$/.test(token)) commands.delete(path.posix.basename(token));
      if (/\/node_modules\/npm\/?$/.test(token)) {
        commands.delete('npm');
        commands.delete('npx');
      }
    }
  }
}

function parseExecForm(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return null;
  return JSON.parse(trimmed);
}

function parseCopyInstruction(value) {
  const tokens = value.split(/\s+/).filter(Boolean);
  const flags = tokens.filter(token => token.startsWith('--'));
  const operands = tokens.filter(token => !token.startsWith('--'));
  assert.ok(operands.length >= 2, `unparseable COPY: ${value}`);
  const fromFlag = flags.find(flag => flag.startsWith('--from='));
  return {
    from: fromFlag ? fromFlag.slice('--from='.length) : null,
    sources: operands.slice(0, -1),
    destination: operands.at(-1),
    raw: `COPY ${value}`,
  };
}

export function buildImageModel(dockerfileText) {
  const stage = parseRuntimeStage(dockerfileText);
  const commands = baseImageCommands(stage.base);
  const copies = [];
  let workdir = '/';
  let cmd = null;
  let healthcheck = null;

  for (const instruction of stage.instructions) {
    switch (instruction.keyword) {
      case 'WORKDIR':
        workdir = instruction.value.trim();
        break;
      case 'RUN':
        applyRunInstruction(instruction.value, commands);
        break;
      case 'COPY':
        copies.push(parseCopyInstruction(instruction.value));
        break;
      case 'CMD':
        cmd = parseExecForm(instruction.value);
        break;
      case 'HEALTHCHECK':
        healthcheck = instruction.value;
        break;
      default:
        break;
    }
  }

  return { base: stage.base, workdir, commands, copies, cmd, healthcheck };
}

const normaliseDestination = destination =>
  destination.replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * Resolve a path as the container sees it (relative to WORKDIR, or absolute)
 * back to the repo file the Dockerfile copies there.
 * Returns null when nothing in the runtime stage puts that path in the image.
 */
export function resolveImagePath(model, containerPath) {
  let relative = containerPath;
  const workdir = model.workdir.replace(/\/+$/, '');
  if (relative.startsWith('/')) {
    if (workdir && relative.startsWith(`${workdir}/`)) relative = relative.slice(workdir.length + 1);
    else return null;
  }
  relative = relative.replace(/^\.\//, '');

  for (const copy of model.copies) {
    const destination = normaliseDestination(copy.destination);
    if (copy.from) {
      // Copied from another build stage — present in the image, but there is no
      // repo file to stat.
      if (destination !== '' && (relative === destination || relative.startsWith(`${destination}/`))) {
        return { repoPath: null, copy };
      }
      continue;
    }
    if (destination === '' || destination === '.') {
      for (const source of copy.sources) {
        const literal = source.replace(/\*+$/, '');
        if (path.posix.basename(literal) === relative) {
          return { repoPath: `${BACKEND_DIR}/${literal}`, copy };
        }
      }
      continue;
    }
    if (copy.sources.length === 1) {
      const source = copy.sources[0];
      if (relative === destination) return { repoPath: `${BACKEND_DIR}/${source}`, copy };
      if (relative.startsWith(`${destination}/`)) {
        const remainder = relative.slice(destination.length + 1);
        return { repoPath: `${BACKEND_DIR}/${source}/${remainder}`, copy };
      }
      continue;
    }
    for (const source of copy.sources) {
      const candidate = `${destination}/${path.posix.basename(source)}`;
      if (relative === candidate) return { repoPath: `${BACKEND_DIR}/${source}`, copy };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manifest → containers
// ---------------------------------------------------------------------------

const indentOf = line => line.match(/^(\s*)/)[1].length;
const isBlankLine = line => line.trim() === '';
const isCommentLine = line => line.trim().startsWith('#');

function stripInlineComment(value) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === '#' && !inSingle && !inDouble && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function parseFlowSequence(text) {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  const items = [];
  let token = '';
  let quote = null;
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ',') { items.push(token.trim()); token = ''; continue; }
    token += char;
  }
  if (token.trim() !== '') items.push(token.trim());
  return items;
}

function parseScalar(text) {
  const value = stripInlineComment(text).trim();
  if (value.startsWith('[')) return parseFlowSequence(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function dedent(lines) {
  const meaningful = lines.filter(line => !isBlankLine(line));
  if (meaningful.length === 0) return lines.map(() => '');
  const width = Math.min(...meaningful.map(indentOf));
  return lines.map(line => (isBlankLine(line) ? '' : line.slice(width)));
}

function collectNested(lines, start) {
  const nested = [];
  let index = start;
  while (index < lines.length && (isBlankLine(lines[index]) || indentOf(lines[index]) > 0)) {
    nested.push(lines[index]);
    index += 1;
  }
  return { nested, next: index };
}

function parseSequence(lines) {
  const items = [];
  const first = lines.find(line => !isBlankLine(line) && line.trim().startsWith('- '));
  if (first === undefined) return items;
  const itemIndent = indentOf(first);

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlankLine(line) || indentOf(line) !== itemIndent || !line.trim().startsWith('- ')) {
      index += 1;
      continue;
    }
    const head = line.trim().slice(2);
    const body = [];
    let cursor = index + 1;
    while (cursor < lines.length && (isBlankLine(lines[cursor]) || indentOf(lines[cursor]) > itemIndent)) {
      body.push(lines[cursor]);
      cursor += 1;
    }
    if (/^[|>][-+]?$/.test(head.trim())) {
      items.push(dedent(body).join('\n'));
    } else if (/^[A-Za-z0-9_.\-/]+:(\s|$)/.test(head)) {
      items.push(parseBlock(dedent([`  ${head}`, ...body])));
    } else {
      items.push(parseScalar(head));
    }
    index = cursor;
  }
  return items;
}

function parseNested(lines) {
  const dedented = dedent(lines);
  // Comment lines are never removed — inside a block scalar they are content.
  const first = dedented.find(line => !isBlankLine(line) && !isCommentLine(line));
  if (first === undefined) return null;
  if (first.trim().startsWith('- ')) return parseSequence(dedented);
  return parseBlock(dedented);
}

/** Parse a block mapping whose keys sit at column 0. */
export function parseBlock(lines) {
  const result = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (isBlankLine(line) || indentOf(line) !== 0) { index += 1; continue; }
    if (isCommentLine(line)) { index += 1; continue; }
    const match = line.match(/^([A-Za-z0-9_.\-/]+):(?:\s+([\s\S]*))?$/);
    if (!match) { index += 1; continue; }
    const key = match[1];
    const inline = (match[2] ?? '').trim();
    const { nested, next } = collectNested(lines, index + 1);
    if (inline !== '' && !/^[|>][-+]?$/.test(inline)) {
      result[key] = parseScalar(inline);
    } else if (/^[|>][-+]?$/.test(inline)) {
      result[key] = dedent(nested).join('\n');
    } else {
      result[key] = parseNested(nested);
    }
    index = next;
  }
  return result;
}

/** Pull every container/initContainer out of a Kubernetes manifest. */
export function extractContainers(manifestText) {
  const lines = manifestText.split(/\r?\n/);
  const containers = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(initContainers|containers):\s*$/);
    if (!match) continue;
    const sectionIndent = match[1].length;
    const body = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (isBlankLine(line)) { body.push(line); cursor += 1; continue; }
      if (indentOf(line) <= sectionIndent) break;
      body.push(line);
      cursor += 1;
    }
    for (const entry of parseSequence(dedent(body))) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        containers.push({ kind: match[2], ...entry });
      }
    }
  }
  return containers;
}

// ---------------------------------------------------------------------------
// Shell script → invoked command words
// ---------------------------------------------------------------------------

function readBalanced(text, start, open, close) {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') { index += 2; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(start + 1, index), end: index + 1 };
    }
    index += 1;
  }
  return { inner: text.slice(start + 1), end: text.length };
}

/**
 * Tokenise a POSIX shell script into simple commands. Quote-aware (so a
 * multi-line `node -e "…"` heredoc-style argument stays one token) and it
 * recurses into `$(…)` / backtick substitutions so those commands are checked
 * too.
 */
export function parseShellScript(script) {
  const commands = [];
  let current = [];
  let token = '';
  let hasToken = false;
  let index = 0;

  const endToken = () => {
    if (hasToken) { current.push(token); token = ''; hasToken = false; }
  };
  const endCommand = () => {
    endToken();
    if (current.length > 0) commands.push(current);
    current = [];
  };

  while (index < script.length) {
    const char = script[index];

    if (char === '\\') {
      if (script[index + 1] === '\n') { index += 2; continue; }
      token += script[index + 1] ?? '';
      hasToken = true;
      index += 2;
      continue;
    }
    if (char === "'") {
      let end = script.indexOf("'", index + 1);
      if (end === -1) end = script.length;
      token += script.slice(index + 1, end);
      hasToken = true;
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      while (cursor < script.length && script[cursor] !== '"') {
        if (script[cursor] === '\\') { token += script[cursor + 1] ?? ''; cursor += 2; continue; }
        if (script[cursor] === '$' && script[cursor + 1] === '(') {
          const { inner, end } = readBalanced(script, cursor + 1, '(', ')');
          commands.push(...parseShellScript(inner));
          cursor = end;
          continue;
        }
        token += script[cursor];
        cursor += 1;
      }
      hasToken = true;
      index = cursor + 1;
      continue;
    }
    if (char === '$' && script[index + 1] === '(') {
      const { inner, end } = readBalanced(script, index + 1, '(', ')');
      commands.push(...parseShellScript(inner));
      hasToken = true;
      index = end;
      continue;
    }
    if (char === '`') {
      let end = script.indexOf('`', index + 1);
      if (end === -1) end = script.length;
      commands.push(...parseShellScript(script.slice(index + 1, end)));
      hasToken = true;
      index = end + 1;
      continue;
    }
    if (char === '#' && !hasToken) {
      const end = script.indexOf('\n', index);
      index = end === -1 ? script.length : end;
      continue;
    }
    if (char === '\n' || char === ';') { endCommand(); index += 1; continue; }
    if (char === '&' || char === '|') {
      endCommand();
      index += script[index + 1] === char ? 2 : 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') { endToken(); index += 1; continue; }

    token += char;
    hasToken = true;
    index += 1;
  }
  endCommand();
  return commands;
}

/** First token of a simple command that is neither an assignment nor a redirect. */
export function commandWordOf(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (/^\d*[<>]/.test(token)) { index += 1; continue; }
    return { word: token, args: tokens.slice(index + 1) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

function npmScriptHint(word, args) {
  if (args[0] !== 'run' && args[0] !== 'run-script') return '';
  const scripts = JSON.parse(readRepo(`${BACKEND_DIR}/package.json`)).scripts ?? {};
  const target = scripts[args[1]];
  return target
    ? ` (\`${[word, ...args.slice(0, 2)].join(' ')}\` maps to \`${target}\` in ${BACKEND_DIR}/package.json — invoke that entrypoint directly)`
    : '';
}

function checkInvocation(model, tokens, where, violations) {
  const parsed = commandWordOf(tokens);
  if (!parsed) return;
  const { word, args } = parsed;
  if (word === '' || SHELL_KEYWORDS.has(word) || SHELL_BUILTINS.has(word)) return;

  const basename = path.posix.basename(word);
  const looksLikePath = word.includes('/');

  if (!model.commands.has(basename)) {
    if (looksLikePath && !word.startsWith('/')) {
      // A relative path inside the image, e.g. ./scripts/thing.sh
      if (!resolveImagePath(model, word)) {
        violations.push(`${where}: \`${word}\` is not present in the runtime image`);
      }
      return;
    }
    violations.push(
      `${where}: \`${word}\` is not an executable in the runtime image built by ${DOCKERFILE}${
        basename === 'npm' || basename === 'npx' ? npmScriptHint(word, args) : ''
      }`,
    );
    return;
  }

  if (basename === 'node') {
    const inlineFlags = new Set(['-e', '--eval', '-p', '--print', '--input-type=module']);
    let scriptArg = null;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (inlineFlags.has(arg)) return;
      if (arg.startsWith('--input-type=')) return;
      if (arg.startsWith('-')) continue;
      scriptArg = arg;
      break;
    }
    if (scriptArg === null) return;
    const resolved = resolveImagePath(model, scriptArg);
    if (!resolved) {
      violations.push(
        `${where}: \`node ${scriptArg}\` — no COPY in the ${DOCKERFILE} runtime stage places that path in the image`,
      );
      return;
    }
    if (resolved.repoPath && !existsSync(path.join(repoRoot, resolved.repoPath))) {
      violations.push(
        `${where}: \`node ${scriptArg}\` resolves to ${resolved.repoPath}, which does not exist`,
      );
    }
    return;
  }

  if (SHELL_EXECUTABLES.has(basename)) {
    const flagIndex = args.indexOf('-c');
    if (flagIndex !== -1 && args[flagIndex + 1] !== undefined) {
      for (const command of parseShellScript(args[flagIndex + 1])) {
        checkInvocation(model, command, `${where} → sh -c`, violations);
      }
    }
  }
}

/** Every violation of the image↔manifest command contract for one container. */
export function checkContainer(model, container, where) {
  const violations = [];
  const command = Array.isArray(container.command) ? container.command : [];
  const args = Array.isArray(container.args) ? container.args : [];
  const invocation = [...command, ...args];
  if (invocation.length === 0) return violations;

  const basename = path.posix.basename(invocation[0]);
  if (SHELL_EXECUTABLES.has(basename) && invocation.includes('-c')) {
    if (!model.commands.has(basename)) {
      violations.push(`${where}: shell \`${invocation[0]}\` is not present in the runtime image`);
      return violations;
    }
    const script = invocation[invocation.indexOf('-c') + 1];
    if (typeof script !== 'string') return violations;
    for (const simple of parseShellScript(script)) {
      checkInvocation(model, simple, where, violations);
    }
    return violations;
  }

  checkInvocation(model, invocation, where, violations);
  return violations;
}

const backendImageContainers = () => {
  const found = [];
  for (const file of readdirSync(path.join(repoRoot, BACKEND_MANIFEST_DIR)).sort()) {
    if (!file.endsWith('.yaml') || file.endsWith('.yaml.example')) continue;
    const relative = `${BACKEND_MANIFEST_DIR}/${file}`;
    for (const container of extractContainers(readRepo(relative))) {
      if (typeof container.image !== 'string') continue;
      if (!container.image.startsWith(`${BACKEND_IMAGE_REPO}:`)
        && !container.image.startsWith(`${BACKEND_IMAGE_REPO}@`)) continue;
      found.push({ ...container, file: relative });
    }
  }
  return found;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('the runtime image model is derived, not assumed', () => {
  const model = buildImageModel(readRepo(DOCKERFILE));

  assert.equal(model.workdir, '/app');
  assert.ok(model.commands.has('node'), 'node must be modelled as present');
  assert.ok(model.commands.has('sh'), 'the alpine shell must be modelled as present');
  assert.ok(model.commands.has('curl'), '`apk add curl` must be modelled as present');
  assert.ok(model.copies.length >= 4, 'runtime stage COPY instructions were not parsed');

  // This is the property that makes the manifest contract load-bearing. It is
  // asserted so that re-adding npm to the image is a deliberate, reviewed
  // change rather than something that silently relaxes this suite.
  assert.equal(
    model.commands.has('npm'), false,
    `${DOCKERFILE} is expected to strip npm from the runtime image (supply-chain hardening)`,
  );
  assert.equal(model.commands.has('npx'), false, `${DOCKERFILE} is expected to strip npx`);
});

test('the migration Job is parsed into real containers (no vacuous pass)', () => {
  const containers = extractContainers(readRepo(`${BACKEND_MANIFEST_DIR}/migration-job.yaml`));
  const names = containers.map(container => container.name);

  assert.deepEqual(names, ['wait-owner-bypassrls', 'migrate']);

  const gate = containers.find(container => container.name === 'wait-owner-bypassrls');
  assert.equal(gate.kind, 'initContainers');
  assert.deepEqual(gate.command, ['node']);
  assert.equal(gate.args[0], '-e');
  assert.match(gate.args[1], /rolbypassrls/);

  const migrate = containers.find(container => container.name === 'migrate');
  assert.equal(migrate.kind, 'containers');
  assert.deepEqual(migrate.command, ['/bin/sh', '-c']);
  assert.match(migrate.args[0], /ci-setup-db\.mjs/);

  const words = parseShellScript(migrate.args[0])
    .map(commandWordOf)
    .filter(Boolean)
    .map(parsed => parsed.word);
  assert.deepEqual(words, ['set', 'echo', 'node', 'echo', 'node', 'echo', 'node', 'echo']);
});

test('every migration Job command exists in the built runtime image', () => {
  const model = buildImageModel(readRepo(DOCKERFILE));
  const manifest = `${BACKEND_MANIFEST_DIR}/migration-job.yaml`;
  const containers = extractContainers(readRepo(manifest));
  assert.ok(containers.length >= 2);

  const violations = containers.flatMap(container =>
    checkContainer(model, container, `${manifest} [${container.name}]`));

  assert.deepEqual(violations, []);
});

test('every backend-image container in this app directory honours the contract', () => {
  const model = buildImageModel(readRepo(DOCKERFILE));
  const containers = backendImageContainers();

  // Vacuity guard: the discovery must keep finding the workloads we know run
  // the backend image, so a manifest rename cannot silently empty this gate.
  const seen = containers.map(container => `${container.file}#${container.name}`);
  for (const expected of [
    `${BACKEND_MANIFEST_DIR}/migration-job.yaml#wait-owner-bypassrls`,
    `${BACKEND_MANIFEST_DIR}/migration-job.yaml#migrate`,
    `${BACKEND_MANIFEST_DIR}/ward-downtime-packs-cronjob.yaml#ward-downtime-packs`,
  ]) {
    assert.ok(seen.includes(expected), `expected to discover ${expected}; found ${seen.join(', ')}`);
  }

  const violations = containers.flatMap(container =>
    checkContainer(model, container, `${container.file} [${container.name}]`));

  assert.deepEqual(violations, []);
});

test('the Dockerfile default command and healthcheck resolve inside the image', () => {
  const model = buildImageModel(readRepo(DOCKERFILE));

  assert.ok(Array.isArray(model.cmd) && model.cmd.length > 0, 'runtime stage declares no CMD');
  assert.deepEqual(checkContainer(model, { command: model.cmd }, `${DOCKERFILE} [CMD]`), []);

  assert.ok(model.healthcheck, 'runtime stage declares no HEALTHCHECK');
  const shellForm = model.healthcheck.slice(model.healthcheck.indexOf('CMD ') + 4);
  const violations = [];
  for (const simple of parseShellScript(shellForm)) {
    checkInvocation(model, simple, `${DOCKERFILE} [HEALTHCHECK]`, violations);
  }
  assert.deepEqual(violations, []);
});

test('inline `node -e` code only requires production dependencies', () => {
  const manifest = `${BACKEND_MANIFEST_DIR}/migration-job.yaml`;
  const packageJson = JSON.parse(readRepo(`${BACKEND_DIR}/package.json`));
  const production = new Set(Object.keys(packageJson.dependencies ?? {}));

  for (const container of extractContainers(readRepo(manifest))) {
    const invocation = [...(container.command ?? []), ...(container.args ?? [])];
    const evalIndex = invocation.findIndex(token => token === '-e' || token === '--eval');
    if (evalIndex === -1) continue;
    const code = invocation[evalIndex + 1] ?? '';
    const specifiers = [
      ...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map(match => match[1]);
    assert.ok(specifiers.length > 0, `no module specifiers parsed out of ${container.name} inline code`);

    for (const specifier of specifiers) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      assert.ok(
        production.has(packageName),
        `${manifest} [${container.name}] requires '${specifier}', which is not a production dependency — `
          + 'the runtime image installs with `npm ci --omit=dev`',
      );
    }
  }
});

test('the gate catches the exact regression it was written for', () => {
  const model = buildImageModel(readRepo(DOCKERFILE));
  const manifest = readRepo(`${BACKEND_MANIFEST_DIR}/migration-job.yaml`);

  // Re-introduce the shipped defect: the npm alias instead of the entrypoint.
  // Anchored on the shell step, not the prose above it.
  const regressed = manifest.replace(
    /^(\s+)node scripts\/ensure-pgvector-extension\.mjs$/m,
    '$1npm run db:ensure-pgvector',
  );
  assert.notEqual(regressed, manifest, 'fixture rewrite did not apply');

  const containers = extractContainers(regressed);
  const migrate = containers.find(container => container.name === 'migrate');
  assert.match(migrate.args[0], /npm run db:ensure-pgvector/, 'fixture did not reach the shell step');

  const violations = containers.flatMap(container =>
    checkContainer(model, container, `[${container.name}]`));

  assert.equal(violations.length, 1, `expected exactly one violation, got: ${violations.join(' | ')}`);
  assert.match(violations[0], /`npm` is not an executable in the runtime image/);
  assert.match(
    violations[0],
    /`npm run db:ensure-pgvector` maps to `node scripts\/ensure-pgvector-extension\.mjs`/,
  );
});

test('the gate catches a missing script and a stripped binary', () => {
  const model = buildImageModel(readRepo(DOCKERFILE));

  const missingScript = checkContainer(
    model,
    { name: 'x', command: ['/bin/sh', '-c'], args: ['node scripts/does-not-exist.mjs'] },
    '[fixture]',
  );
  assert.equal(missingScript.length, 1, missingScript.join(' | '));
  assert.match(missingScript[0], /does not exist/);

  const uncopiedPath = checkContainer(
    model,
    { name: 'x', command: ['node', 'tools/not-copied.mjs'] },
    '[fixture]',
  );
  assert.equal(uncopiedPath.length, 1, uncopiedPath.join(' | '));
  assert.match(uncopiedPath[0], /no COPY in the .* runtime stage places that path in the image/);

  const strippedBinary = checkContainer(
    model,
    { name: 'x', command: ['/bin/sh', '-c'], args: ['npx prisma migrate deploy'] },
    '[fixture]',
  );
  assert.equal(strippedBinary.length, 1, strippedBinary.join(' | '));
  assert.match(strippedBinary[0], /`npx` is not an executable/);

  const absentBinary = checkContainer(
    model,
    { name: 'x', command: ['/bin/sh', '-c'], args: ['psql -c "select 1"'] },
    '[fixture]',
  );
  assert.equal(absentBinary.length, 1, absentBinary.join(' | '));
  assert.match(absentBinary[0], /`psql` is not an executable/);
});

test('the manifest may not document an invocation the image cannot run', () => {
  const model = buildImageModel(readRepo(DOCKERFILE));
  if (model.commands.has('npm')) return;

  // A backticked command is how the stale header used to describe step 1
  // (`npm run db:ensure-pgvector`), so it is flagged even in a comment. Bare
  // prose naming npm/npx — which is how a comment legitimately explains WHY
  // they are absent — is only flagged on live YAML lines.
  const quotedInvocation = /`(?:npm\s+(?:run|run-script|ci|install|exec|start|test)|npx\s+[A-Za-z@])/;
  const bareInvocation = /\b(?:npm\s+(?:run|run-script|ci|install|exec|start|test)|npx\s+[A-Za-z@])/;

  const manifest = readRepo(`${BACKEND_MANIFEST_DIR}/migration-job.yaml`);
  for (const [index, line] of manifest.split(/\r?\n/).entries()) {
    assert.doesNotMatch(
      line,
      quotedInvocation,
      `migration-job.yaml:${index + 1} documents an npm/npx invocation, but the runtime image has neither`,
    );
    if (line.trimStart().startsWith('#')) continue;
    assert.doesNotMatch(
      line,
      bareInvocation,
      `migration-job.yaml:${index + 1} invokes npm/npx, but the runtime image has neither`,
    );
  }
});
