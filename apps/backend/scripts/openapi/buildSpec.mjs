// apps/backend/scripts/openapi/buildSpec.mjs
// Pure, side-effect-free helpers: captured Express routes -> OpenAPI 3.0.3.
// No app boot here — unit-testable in isolation. Deterministic output.

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

/** Build one OpenAPI operation (v1: generic Success-envelope response). */
function buildOperation(method, openApiPath, opId) {
  const op = {
    operationId: opId,
    responses: {
      200: {
        description: 'Successful response',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
      },
    },
  };
  const params = pathParamNames(openApiPath).map((name) => ({
    name, in: 'path', required: true, schema: { type: 'string' },
  }));
  if (params.length) op.parameters = params;
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
  out.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  return out;
}

/** Build the full OpenAPI document: base + deterministically-sorted paths. */
export function buildOpenApiDocument(routes, base) {
  const usedIds = new Set();
  const uniqueOpId = (method, path) => {
    const baseId = operationId(method, path);
    let id = baseId;
    let n = 2;
    while (usedIds.has(id)) id = `${baseId}_${n++}`;
    usedIds.add(id);
    return id;
  };
  // `routes` is pre-sorted by composeRoutes; iterate in that order so opId
  // collision suffixes are deterministic.
  const paths = {};
  for (const { method, path } of routes) {
    if (!paths[path]) paths[path] = {};
    paths[path][method] = buildOperation(method, path, uniqueOpId(method, path));
  }
  // Re-key in sorted order (defensive determinism).
  const sortedPaths = {};
  for (const p of Object.keys(paths).sort()) {
    const methods = paths[p];
    const sorted = {};
    for (const m of Object.keys(methods).sort()) sorted[m] = methods[m];
    sortedPaths[p] = sorted;
  }
  return { ...base, paths: sortedPaths };
}
