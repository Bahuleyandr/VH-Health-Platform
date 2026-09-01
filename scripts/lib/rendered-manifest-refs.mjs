// Structural reader for kustomize-RENDERED manifests, used by the ArgoCD hook
// phase-ordering guard in scripts/validate-kubernetes-manifests.mjs.
//
// Why a parser at all, when the rest of validate-kubernetes-manifests.mjs
// matches regexes over whole documents: the thing this guard has to decide is
// "does THIS reference, nested somewhere under a pod template, carry
// `optional: true`?". A flat regex cannot bind a `name:` to the `optional:` in
// the SAME mapping — it would pass a manifest where some OTHER reference in the
// same document happened to be optional. That is precisely the shape of guard
// that reports green while guarding nothing, so the binding has to be real.
//
// Why not a YAML library: repository-root scripts run with no node_modules
// (there is no root package.json), so `scripts/*.mjs` may import `node:`
// builtins only.
//
// Scope: this parses the OUTPUT of `kustomize build`, not hand-written YAML.
// That output is machine-normalised — two-space indentation, block style, no
// anchors, aliases, tags, multi-key flow mappings, or `?` complex keys. The
// parser below covers exactly that subset and THROWS on anything it does not
// recognise rather than guessing, so an unparsed construct fails the build
// instead of silently reading as "no references here".

const CONTAINER_FIELDS = ['containers', 'initContainers', 'ephemeralContainers'];

// Block scalar bodies are skipped rather than reconstructed — nothing this
// guard inspects is ever written as one. The value is replaced by this
// sentinel so a caller that DOES end up comparing such a field compares an
// obvious placeholder it can reject, instead of silently finding two
// placeholders equal and reporting green.
export const BLOCK_SCALAR = Symbol('rendered-manifest-block-scalar');

function stripComment(value) {
  // Only an unquoted ` #` starts a comment; `#` inside a quoted scalar does not.
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !inDouble) inSingle = !inSingle;
    else if (character === '"' && !inSingle) inDouble = !inDouble;
    else if (character === '#' && !inSingle && !inDouble && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  return value;
}

function parseScalar(raw) {
  const value = stripComment(raw).trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '{}') return {};
  if (value === '[]') return [];
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

// Consumes a block scalar body (| > |- >- |+ etc.) and returns the index of the
// first line that is no longer part of it. The CONTENT is irrelevant to this
// guard — the point is to skip it so `name:` lines inside a shell script or an
// embedded node program are never mistaken for structure.
function skipBlockScalar(lines, start, parentIndent) {
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    if (line.search(/\S/) <= parentIndent) break;
    index += 1;
  }
  return index;
}

// Skip the wrapped remainder of a multi-line plain scalar: every following
// line indented deeper than the key that owns it.
function skipScalarContinuation(lines, start, indent) {
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') break;
    if (line.search(/\S/) <= indent) break;
    index += 1;
  }
  return index;
}

function parseBlock(lines, start, indent) {
  // Decide mapping vs sequence from the first significant line at this indent.
  let index = start;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  if (index >= lines.length) return [null, index];
  const isSequence = lines[index].slice(indent).startsWith('- ')
    || lines[index].slice(indent).trim() === '-';
  return isSequence ? parseSequence(lines, index, indent) : parseMapping(lines, index, indent);
}

function parseMapping(lines, start, indent) {
  const result = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const lineIndent = line.search(/\S/);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      throw new Error(`unexpected indentation at rendered line ${index + 1}: ${line}`);
    }
    const body = line.slice(indent);
    if (body.startsWith('- ')) break;
    const match = /^([^\s:][^:]*):(?:\s+(.*))?$/.exec(body);
    if (!match) throw new Error(`unparsed mapping line ${index + 1}: ${line}`);
    const key = parseScalar(match[1]);
    const inline = match[2] === undefined ? '' : match[2];
    if (/^[|>][+-]?\d*\s*$/.test(inline.trim())) {
      index = skipBlockScalar(lines, index + 1, indent);
      result[key] = BLOCK_SCALAR;
      continue;
    }
    if (stripComment(inline).trim() !== '') {
      result[key] = parseScalar(inline);
      // kustomize folds long PLAIN scalars across lines at its output width
      // (`description: Example ...\n      by default.`). Those continuation
      // lines are more-indented and are not structure. A nested block cannot
      // follow an inline value, so "more indented" is unambiguous here.
      index = skipScalarContinuation(lines, index + 1, indent);
      continue;
    }
    // Nested block: find its indentation from the next significant line.
    let lookahead = index + 1;
    while (lookahead < lines.length && lines[lookahead].trim() === '') lookahead += 1;
    if (lookahead >= lines.length) {
      result[key] = null;
      index = lookahead;
      continue;
    }
    const nextIndent = lines[lookahead].search(/\S/);
    // A block sequence may be indented at the SAME level as its key — the style
    // `kustomize build` emits — so `<= indent` alone would read it as an empty
    // value and skip every reference inside it.
    const sequenceAtSameIndent =
      nextIndent === indent && /^-(\s|$)/.test(lines[lookahead].slice(indent));
    if (nextIndent < indent || (nextIndent === indent && !sequenceAtSameIndent)) {
      result[key] = null;
      index = lookahead;
      continue;
    }
    const childIndent = nextIndent;
    const [value, next] = parseBlock(lines, lookahead, childIndent);
    result[key] = value;
    index = next;
  }
  return [result, index];
}

function parseSequence(lines, start, indent) {
  const result = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const lineIndent = line.search(/\S/);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      throw new Error(`unexpected indentation at rendered line ${index + 1}: ${line}`);
    }
    const body = line.slice(indent);
    if (!body.startsWith('- ') && body.trim() !== '-') break;
    const inline = body.trim() === '-' ? '' : body.slice(2);
    // A block scalar as a sequence item (`- |`) — e.g. a container's `args`
    // carrying a shell script or an embedded node program. Its body must be
    // skipped wholesale, or `name:` lines inside it read as structure.
    if (/^[|>][+-]?\d*\s*$/.test(inline.trim())) {
      index = skipBlockScalar(lines, index + 1, indent);
      result.push(BLOCK_SCALAR);
      continue;
    }
    if (inline.trim() === '') {
      let lookahead = index + 1;
      while (lookahead < lines.length && lines[lookahead].trim() === '') lookahead += 1;
      if (lookahead >= lines.length || lines[lookahead].search(/\S/) <= indent) {
        result.push(null);
        index = lookahead;
        continue;
      }
      const childIndent = lines[lookahead].search(/\S/);
      const [value, next] = parseBlock(lines, lookahead, childIndent);
      result.push(value);
      index = next;
      continue;
    }
    // `- key: value` — an inline mapping opening the item. Re-parse the item as
    // a mapping whose indentation starts just after the "- ".
    if (/^[^\s:][^:]*:(\s|$)/.test(inline)) {
      const rewritten = lines.slice();
      rewritten[index] = ' '.repeat(indent + 2) + inline;
      const [value, next] = parseMapping(rewritten, index, indent + 2);
      result.push(value);
      index = next;
      continue;
    }
    result.push(parseScalar(inline));
    index = skipScalarContinuation(lines, index + 1, indent);
  }
  return [result, index];
}

/** Parse one rendered YAML document into a plain object. */
export function parseRenderedDocument(document) {
  const lines = document.replace(/\r\n/g, '\n').split('\n').filter((line) => !/^\s*#/.test(line));
  const [value] = parseBlock(lines, 0, 0);
  return value ?? {};
}

/** Split a `kustomize build` stream into documents and parse each one. */
export function parseRenderedManifests(rendered) {
  return rendered
    .split(/^---\s*$/m)
    .map((document) => document.trim())
    .filter(Boolean)
    .map((document) => parseRenderedDocument(document));
}

/**
 * ArgoCD sync phase for a resource. Resources with no `argocd.argoproj.io/hook`
 * annotation are ordinary Sync-phase resources.
 * https://argo-cd.readthedocs.io/en/stable/user-guide/resource_hooks/
 */
export function syncPhasesOf(resource) {
  const hook = resource?.metadata?.annotations?.['argocd.argoproj.io/hook'];
  if (typeof hook !== 'string' || hook.trim() === '') return ['Sync'];
  return hook
    .split(',')
    .map((phase) => phase.trim())
    .filter(Boolean);
}

function podSpecOf(resource) {
  const kind = resource?.kind;
  if (kind === 'Pod') return resource.spec;
  if (kind === 'CronJob') return resource?.spec?.jobTemplate?.spec?.template?.spec;
  return resource?.spec?.template?.spec;
}

/**
 * Every ConfigMap/Secret this resource's pod spec depends on, with whether the
 * reference tolerates the object being absent.
 *
 * Covers envFrom, env[].valueFrom, volumes, and imagePullSecrets — the four
 * places where a missing object stops the kubelet from starting the container.
 */
export function objectReferencesOf(resource) {
  const spec = podSpecOf(resource);
  if (!spec || typeof spec !== 'object') return [];
  const references = [];
  const add = (kind, name, optional, site) => {
    if (typeof name === 'string' && name !== '') {
      references.push({ kind, name, optional: optional === true, site });
    }
  };

  for (const field of CONTAINER_FIELDS) {
    for (const container of spec[field] ?? []) {
      const where = `${field}[${container?.name ?? '?'}]`;
      for (const source of container?.envFrom ?? []) {
        add('ConfigMap', source?.configMapRef?.name, source?.configMapRef?.optional, `${where}.envFrom`);
        add('Secret', source?.secretRef?.name, source?.secretRef?.optional, `${where}.envFrom`);
      }
      for (const entry of container?.env ?? []) {
        const from = entry?.valueFrom;
        add('ConfigMap', from?.configMapKeyRef?.name, from?.configMapKeyRef?.optional, `${where}.env[${entry?.name}]`);
        add('Secret', from?.secretKeyRef?.name, from?.secretKeyRef?.optional, `${where}.env[${entry?.name}]`);
      }
    }
  }
  for (const volume of spec.volumes ?? []) {
    const where = `volumes[${volume?.name ?? '?'}]`;
    add('ConfigMap', volume?.configMap?.name, volume?.configMap?.optional, where);
    add('Secret', volume?.secret?.secretName, volume?.secret?.optional, where);
    for (const projected of volume?.projected?.sources ?? []) {
      add('ConfigMap', projected?.configMap?.name, projected?.configMap?.optional, `${where}.projected`);
      add('Secret', projected?.secret?.name, projected?.secret?.optional, `${where}.projected`);
    }
  }
  // imagePullSecrets have no `optional` field; a missing one only delays the
  // pull rather than blocking container creation, so they are reported as
  // optional and left to the image-pull guards.
  for (const pullSecret of spec.imagePullSecrets ?? []) {
    add('Secret', pullSecret?.name, true, 'imagePullSecrets');
  }
  return references;
}
