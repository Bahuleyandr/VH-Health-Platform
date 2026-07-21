// apps/backend/scripts/openapi/buildSpec.mjs
// Pure, side-effect-free helpers: captured Express routes -> OpenAPI 3.0.3.
// No app boot here — unit-testable in isolation. Deterministic output.

// Locale-INDEPENDENT code-unit comparator. localeCompare() varies by the host
// locale (e.g. '-' vs '_' ordering) which would make the spec — and therefore
// the drift gate — flap between machines. Sort everything with this instead.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Convert Express path param syntax to OpenAPI: ':id'->'{id}', '*splat'->'{splat}'. */
export function expressPathToOpenApi(p) {
  return String(p)
    .replace(/\{\*?([A-Za-z0-9_]+)\}/g, '{$1}') // {id} / {*splat} -> {id}/{splat}
    .replace(/\*([A-Za-z0-9_]+)/g, '{$1}')      // *splat -> {splat}
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}');      // :id -> {id}
}

/** Join a mount prefix and a relative path into one normalized path. */
export function joinPath(a, b) {
  const left = a.endsWith('/') ? a.slice(0, -1) : a;
  const right = b === '/' || b === '' ? '' : b.startsWith('/') ? b : `/${b}`;
  const out = `${left}${right}`;
  return out === '' ? '/' : out;
}

/** Extract {param} names from an OpenAPI path. */
export function pathParamNames(openApiPath) {
  return [...openApiPath.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
}

/** A stable, readable operationId from method + OpenAPI path. */
export function operationId(method, openApiPath) {
  const slug = openApiPath
    .replace(/^\//, '')
    .replace(/\{([A-Za-z0-9_]+)\}/g, 'by_$1')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${method.toLowerCase()}_${slug || 'root'}`;
}

/** Build one OpenAPI operation. With an overlay entry (`ov`), attach a typed
 * requestBody and/or typed success response; otherwise the generic Success envelope. */
function buildOperation(method, openApiPath, opId, ov) {
  const responseStatus = String(ov?.responseStatus ?? 200);
  const op = {
    operationId: opId,
    responses: {
      [responseStatus]: {
        description: 'Successful response',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
      },
    },
  };
  if (ov && ov.summary) op.summary = ov.summary;
  if (ov && ov.description) op.description = ov.description;
  if (ov && ov.responseDescription) {
    op.responses[responseStatus].description = ov.responseDescription;
  }
  const params = pathParamNames(openApiPath).map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: ov?.pathParameters?.[name] ?? { type: 'string' },
  }));
  if (params.length) op.parameters = params;
  if (ov && Array.isArray(ov.parameters) && ov.parameters.length) {
    op.parameters = [...params, ...ov.parameters];
  }
  if (ov && ov.response) {
    op.responses[responseStatus].content['application/json'].schema = {
      $ref: `#/components/schemas/${ov.response}`,
    };
  }
  if (ov && ov.request) {
    op.requestBody = {
      required: ov.requestRequired !== false,
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${ov.request}` } } },
    };
  }
  return op;
}

/**
 * Compose full method+path pairs from captured registration data.
 *   routerRoutes: Map<router, [{ relPath, route:{ methods } }]>
 *   edges:        Map<router, [{ prefix, child }]>
 * Returns a de-duped, SORTED array of { method, path } (OpenAPI paths).
 */
export function composeRoutes({ routerRoutes, edges, root }) {
  const out = [];
  const seen = new Set();
  const visit = (router, prefix, depth) => {
    if (depth > 12) return; // cycle guard
    for (const { relPath, route } of routerRoutes.get(router) || []) {
      const full = expressPathToOpenApi(joinPath(prefix, relPath));
      const methods = Object.keys(route.methods || {}).filter((m) => m !== '_all');
      for (const method of methods) {
        const key = `${method.toUpperCase()} ${full}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ method: method.toLowerCase(), path: full });
        }
      }
    }
    for (const { prefix: p, child } of edges.get(router) || []) {
      visit(child, joinPath(prefix, p), depth + 1);
    }
  };
  visit(root, '', 0);
  out.sort((a, b) => (a.path === b.path ? cmp(a.method, b.method) : cmp(a.path, b.path)));
  return out;
}

/** Path "template signature": param names removed, so two paths that differ
 * only in param NAMES (e.g. /d/{id} vs /d/{deptId}) share a signature. */
export function pathSignature(p) {
  return p.replace(/\{[^}]+\}/g, '{}');
}

/** Find param-equivalent path groups (same signature, >1 distinct path). These
 * routes shadow each other at the URL-template level — OpenAPI forbids keeping
 * both, so buildOpenApiDocument collapses them; this reports them for follow-up. */
export function findEquivalentPathCollisions(routes) {
  const bySig = new Map();
  for (const { path } of routes) {
    const s = pathSignature(path);
    if (!bySig.has(s)) bySig.set(s, new Set());
    bySig.get(s).add(path);
  }
  const collisions = [];
  for (const [signature, paths] of bySig) {
    if (paths.size > 1) collisions.push({ signature, paths: [...paths].sort() });
  }
  return collisions.sort((a, b) => cmp(a.signature, b.signature));
}

/** Build the full OpenAPI document: base + deterministically-sorted paths.
 * Param-equivalent paths are collapsed to one canonical path (lexicographically
 * smallest) carrying the UNION of methods, so the document is valid OpenAPI. */
export function buildOpenApiDocument(routes, base, overlay = {}) {
  // Group by template signature; pick the smallest path string as canonical.
  const bySig = new Map(); // signature -> { canonical, methods:Set }
  for (const { method, path } of routes) {
    const s = pathSignature(path);
    if (!bySig.has(s)) bySig.set(s, { canonical: path, methods: new Set() });
    const e = bySig.get(s);
    if (path < e.canonical) e.canonical = path;
    e.methods.add(method);
  }

  const usedIds = new Set();
  const uniqueOpId = (method, path) => {
    const baseId = operationId(method, path);
    let id = baseId;
    let n = 2;
    while (usedIds.has(id)) id = `${baseId}_${n++}`;
    usedIds.add(id);
    return id;
  };

  // Deterministic: iterate canonical paths sorted, methods sorted.
  const entries = [...bySig.values()].sort((a, b) => cmp(a.canonical, b.canonical));
  const sortedPaths = {};
  for (const { canonical, methods } of entries) {
    const ops = {};
    for (const method of [...methods].sort()) {
      const ov = overlay[`${method.toUpperCase()} ${canonical}`];
      ops[method] = buildOperation(method, canonical, uniqueOpId(method, canonical), ov);
    }
    sortedPaths[canonical] = ops;
  }
  return { ...base, paths: sortedPaths };
}
