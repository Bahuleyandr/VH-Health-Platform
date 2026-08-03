// apps/backend/scripts/openapi/buildSpec.mjs
// Pure, side-effect-free helpers: captured Express routes -> OpenAPI 3.0.3.
// No app boot here — unit-testable in isolation. Deterministic output.

// Locale-INDEPENDENT code-unit comparator. localeCompare() varies by the host
// locale (e.g. '-' vs '_' ordering) which would make the spec — and therefore
// the drift gate — flap between machines. Sort everything with this instead.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Route directories that name the AUDIENCE a route is served to, not the domain
// it belongs to. `src/routes/admin/` alone holds 39 route files and 895
// operations (24.6% of the API); tagging all of them `admin` would rebuild the
// junk drawer this taxonomy exists to avoid. For these, the FILE name carries
// the real subsystem (admin/tenantRoutes.js -> `tenant`), so we descend one
// level. Every other directory IS the domain and is used as-is.
const AUDIENCE_ROUTE_DIRS = new Set(['admin', 'staff', 'portal']);

// Same idea one level down, for the last-resort path derivation: these URL
// prefixes say who is calling, not what the resource is.
const AUDIENCE_PATH_SEGMENTS = new Set(['admin', 'staff', 'portal']);

/** camelCase/snake_case -> kebab-case, lowercase ASCII. Tag names stay in this
 * shape so the code-unit sort used everywhere else is also alphabetical. */
export function kebabCase(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Derive a tag from a route module path relative to src/routes/, e.g.
 *   'appointment/appointmentRoutes.js' -> 'appointment'   (domain directory)
 *   'admin/tenantRoutes.js'            -> 'tenant'        (audience dir -> file)
 *   'admin/index.js'                   -> 'admin'         (barrel -> back to dir)
 *   'carePathwayRoutes.js'             -> 'care-pathway'  (top-level file)
 * Returns null when there is nothing usable. */
export function tagFromSourceFile(srcFile) {
  if (!srcFile) return null;
  const segs = String(srcFile).split('/').filter(Boolean);
  if (!segs.length) return null;
  const base = kebabCase(
    segs[segs.length - 1].replace(/\.(js|mjs|cjs)$/, '').replace(/Routes?$/i, ''),
  );
  const dir = segs.length > 1 ? kebabCase(segs[0]) : null;
  // A barrel file names nothing — `admin/index.js` would otherwise yield the
  // meaningless tag `index` for the 46 operations registered directly in it.
  // Fall back to the directory, even an audience one: those really are the
  // admin console's own aggregate endpoints and have no narrower domain.
  const usableBase = base && base !== 'index' ? base : null;
  if (dir && !AUDIENCE_ROUTE_DIRS.has(dir)) return dir;
  return usableBase ?? dir;
}

/** Last-resort tag from the URL itself. Skips the /api/v<n> prefix and any
 * leading AUDIENCE segment, so /api/v1/admin/clinical-ai/x -> 'clinical-ai',
 * never 'admin'. Returns null when nothing meaningful remains. */
export function tagFromPath(openApiPath) {
  const segs = String(openApiPath).split('/').filter(Boolean);
  let i = 0;
  if (segs[i] === 'api') i++;
  if (/^v\d+$/.test(segs[i] || '')) i++;
  if (AUDIENCE_PATH_SEGMENTS.has(segs[i]) && segs.length > i + 1) i++;
  const seg = segs[i];
  if (!seg || seg.startsWith('{')) return null;
  return kebabCase(seg) || null;
}

/** Resolve the tag for one operation. Priority:
 *   1. `ov.tags` — an overlay explicitly authored the tag (same override seam
 *      as ov.summary / ov.description). Authored intent always wins.
 *   2. the route module the operation was registered from — a curated,
 *      on-disk taxonomy the generator already knows at capture time.
 *   3. the URL path, audience prefixes skipped — heuristic last resort.
 * Always returns a non-empty array so `operation-tags` is satisfiable. */
export function resolveTags({ ov, srcFile, path }) {
  if (ov && Array.isArray(ov.tags) && ov.tags.length) return [...ov.tags];
  const tag = tagFromSourceFile(srcFile) ?? tagFromPath(path) ?? 'api';
  return [tag];
}

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
function buildOperation(method, openApiPath, opId, ov, tags) {
  const responseStatus = String(ov?.responseStatus ?? 200);
  const responseContentType = ov?.responseContentType ?? 'application/json';
  const op = {
    operationId: opId,
    ...(tags && tags.length ? { tags } : {}),
    responses: {
      [responseStatus]: {
        description: 'Successful response',
        content: { [responseContentType]: { schema: { $ref: '#/components/schemas/Success' } } },
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
    op.responses[responseStatus].content[responseContentType].schema = {
      $ref: `#/components/schemas/${ov.response}`,
    };
  }
  if (ov && ov.additionalResponses) {
    for (const [status, response] of Object.entries(ov.additionalResponses)) {
      op.responses[String(status)] = response;
    }
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
 *   routerRoutes: Map<router, [{ relPath, route:{ methods }, srcFile? }]>
 *   edges:        Map<router, [{ prefix, child }]>
 * `srcFile` (the route module the registration came from, relative to
 * src/routes/) is carried through untouched — it is what tags are derived from.
 * Returns a de-duped, SORTED array of { method, path, srcFile } (OpenAPI paths).
 */
export function composeRoutes({ routerRoutes, edges, root }) {
  const out = [];
  const seen = new Set();
  const visit = (router, prefix, depth) => {
    if (depth > 12) return; // cycle guard
    for (const { relPath, route, srcFile } of routerRoutes.get(router) || []) {
      const full = expressPathToOpenApi(joinPath(prefix, relPath));
      const methods = Object.keys(route.methods || {}).filter((m) => m !== '_all');
      for (const method of methods) {
        const key = `${method.toUpperCase()} ${full}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ method: method.toLowerCase(), path: full, srcFile: srcFile ?? null });
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
  // Source module per (method, signature). Collapsed param-equivalent paths can
  // come from DIFFERENT route modules and a signature can carry several methods,
  // so attribution is tracked per operation, not per path. Ties resolve to the
  // code-unit-smallest file so the choice is deterministic across machines.
  const srcByOp = new Map();
  for (const { method, path, srcFile } of routes) {
    const s = pathSignature(path);
    if (!bySig.has(s)) bySig.set(s, { canonical: path, methods: new Set() });
    const e = bySig.get(s);
    if (path < e.canonical) e.canonical = path;
    e.methods.add(method);
    if (srcFile) {
      const k = `${method} ${s}`;
      const cur = srcByOp.get(k);
      if (cur === undefined || cmp(srcFile, cur) < 0) srcByOp.set(k, srcFile);
    }
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
  const usedTags = new Set();
  for (const { canonical, methods } of entries) {
    const ops = {};
    const sig = pathSignature(canonical);
    for (const method of [...methods].sort()) {
      const ov = overlay[`${method.toUpperCase()} ${canonical}`];
      const tags = resolveTags({ ov, srcFile: srcByOp.get(`${method} ${sig}`), path: canonical });
      for (const t of tags) usedTags.add(t);
      ops[method] = buildOperation(method, canonical, uniqueOpId(method, canonical), ov, tags);
    }
    sortedPaths[canonical] = ops;
  }

  // Top-level `tags` MUST cover every tag any operation uses, or Spectral's
  // `operation-tag-defined` fires once per uncovered operation — trading one
  // warning class for another. Emit the union of what was actually used, sorted
  // by code-unit compare, carrying any curated description from the base doc.
  // (`spectral:oas` does not require tag descriptions, so an undescribed tag is
  // clean — descriptions accrue in base.mjs as subsystem owners write them.)
  const describedTags = new Map((base.tags || []).map((t) => [t.name, t]));
  const tags = [...usedTags].sort(cmp).map((name) => {
    const described = describedTags.get(name);
    return described?.description ? { name, description: described.description } : { name };
  });

  return { ...base, tags, paths: sortedPaths };
}
