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
    // Split a RUN of capitals from the word that follows it, so an acronym
    // butted against a word survives: 'tierAAssistants' -> 'tier-A-Assistants'
    // (without this it collapsed to the unreadable slug 'tier-aassistants').
    // A trailing acronym with nothing after it is left alone: 'clinicalAI' ->
    // 'clinical-ai'.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** The visible-debt tag. Used when no reliable signal names a domain — never
 * guess one. Its population is ratcheted (see UNCLASSIFIED_TAG_BUDGET in
 * base.mjs) so it can only shrink. */
export const UNCLASSIFIED_TAG = 'unclassified';

/** Derive a tag from a route module path relative to src/routes/, e.g.
 *   'appointment/appointmentRoutes.js' -> 'appointment'   (domain directory)
 *   'admin/tenantRoutes.js'            -> 'tenant'        (audience dir -> file)
 *   'admin/index.js'                   -> null            (barrel names nothing)
 *   'carePathwayRoutes.js'             -> 'care-pathway'  (top-level file)
 *
 * NOTE this is a BOOTSTRAP signal, deliberately ranked below explicit metadata
 * in resolveTags — deriving a published tag from a filename couples the API
 * contract to file layout. The curated registry in base.mjs is what stops a
 * rename from silently changing the contract: a renamed module yields an
 * unregistered slug, and generation fails rather than shipping a new taxonomy.
 * Returns null when there is nothing usable. */
export function tagFromSourceFile(srcFile) {
  if (!srcFile) return null;
  const segs = String(srcFile).split('/').filter(Boolean);
  if (!segs.length) return null;
  const base = kebabCase(
    segs[segs.length - 1].replace(/\.(js|mjs|cjs)$/, '').replace(/Routes?$/i, ''),
  );
  const dir = segs.length > 1 ? kebabCase(segs[0]) : null;
  if (dir && !AUDIENCE_ROUTE_DIRS.has(dir)) return dir;
  // An AUDIENCE directory never becomes a primary tag — `admin` and `staff`
  // say who is calling, not what the resource is. The file name carries the
  // domain instead, and a barrel (`admin/index.js`) names nothing at all, so it
  // yields no signal rather than the meaningless tag `index` or the audience.
  // The file name can ALSO be the bare audience word (`staff/staffRoutes.js`);
  // that is the same non-signal and is rejected too.
  if (!base || base === 'index' || AUDIENCE_ROUTE_DIRS.has(base)) return null;
  return base;
}

/** Last-resort tag from the URL itself. Skips the /api/v<n> prefix and any
 * leading AUDIENCE segment, so /api/v1/admin/clinical-ai/x -> 'clinical-ai',
 * never 'admin'. Returns null when nothing meaningful remains — including when
 * an audience segment is ALL there is (/api/v1/admin), which must not become a
 * primary tag. */
export function tagFromPath(openApiPath) {
  const segs = String(openApiPath).split('/').filter(Boolean);
  let i = 0;
  if (segs[i] === 'api') i++;
  if (/^v\d+$/.test(segs[i] || '')) i++;
  // Skip the whole RUN of audience segments, not just one: paths like
  // /api/v1/admin/staff/attendance/late-arrivals stack two of them before the
  // real domain (`attendance`). Stopping after the first would yield `staff`,
  // which is exactly the audience word that must never be a primary tag.
  while (AUDIENCE_PATH_SEGMENTS.has(segs[i])) {
    if (segs.length <= i + 1) return null;
    i++;
  }
  const seg = segs[i];
  if (!seg || seg.startsWith('{')) return null;
  const tag = kebabCase(seg);
  // Defence in depth: never let an audience word through as a primary tag.
  return tag && !AUDIENCE_PATH_SEGMENTS.has(tag) ? tag : null;
}

/** Resolve the PRIMARY domain tag for one operation. Exactly one, always.
 * Priority, most specific first:
 *   1. `ov.tags` / `ov.tag` — an overlay explicitly authored the tag (the same
 *      override seam as ov.summary / ov.description). Authored intent wins.
 *   2. `domain` — explicit router/mount metadata declared by the route module
 *      itself (see markRouterDomain in scripts/openapi/routerDomain.mjs). This
 *      is the intended long-term source: it pins the published tag in code, so
 *      it survives file moves and renames.
 *   3. the route module the operation registered from — BOOTSTRAP only.
 *   4. the URL path with audience prefixes skipped — heuristic last resort.
 *   5. `unclassified` — a visible, ratcheted debt tag. Never guess a domain.
 */
export function resolveTags({ ov, domain, srcFile, path }) {
  const explicit = ov?.tags ?? (ov?.tag ? [ov.tag] : null);
  if (Array.isArray(explicit) && explicit.length) return [...explicit];
  if (typeof explicit === 'string' && explicit) return [explicit];
  const tag = domain || tagFromSourceFile(srcFile) || tagFromPath(path) || UNCLASSIFIED_TAG;
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
 *   routerRoutes:  Map<router, [{ relPath, route:{ methods }, srcFile? }]>
 *   edges:         Map<router, [{ prefix, child }]>
 *   routerDomains: Map<router, slug> — explicit domain declarations
 *                  (src/config/openapiDomain.js markRouterDomain).
 * `srcFile` (the route module the registration came from, relative to
 * src/routes/) and `domain` are carried through — they are what tags resolve
 * from. `domain` is the NEAREST, most specific declared ancestor: a child
 * router's own declaration overrides whatever it was mounted under.
 * Returns a de-duped, SORTED array of { method, path, srcFile, domain }.
 */
export function composeRoutes({ routerRoutes, edges, root, routerDomains }) {
  const out = [];
  const seen = new Set();
  const domainOf = (router) => (routerDomains ? routerDomains.get(router) : null) ?? null;
  const visit = (router, prefix, depth, inheritedDomain) => {
    if (depth > 12) return; // cycle guard
    const domain = domainOf(router) ?? inheritedDomain ?? null;
    for (const { relPath, route, srcFile } of routerRoutes.get(router) || []) {
      const full = expressPathToOpenApi(joinPath(prefix, relPath));
      const methods = Object.keys(route.methods || {}).filter((m) => m !== '_all');
      for (const method of methods) {
        const key = `${method.toUpperCase()} ${full}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ method: method.toLowerCase(), path: full, srcFile: srcFile ?? null, domain });
        }
      }
    }
    for (const { prefix: p, child } of edges.get(router) || []) {
      visit(child, joinPath(prefix, p), depth + 1, domain);
    }
  };
  visit(root, '', 0, null);
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
  const domainByOp = new Map();
  for (const { method, path, srcFile, domain } of routes) {
    const s = pathSignature(path);
    if (!bySig.has(s)) bySig.set(s, { canonical: path, methods: new Set() });
    const e = bySig.get(s);
    if (path < e.canonical) e.canonical = path;
    e.methods.add(method);
    const k = `${method} ${s}`;
    if (srcFile) {
      const cur = srcByOp.get(k);
      if (cur === undefined || cmp(srcFile, cur) < 0) srcByOp.set(k, srcFile);
    }
    if (domain) {
      const cur = domainByOp.get(k);
      if (cur === undefined || cmp(domain, cur) < 0) domainByOp.set(k, domain);
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
      const key = `${method} ${sig}`;
      const tags = resolveTags({
        ov,
        domain: domainByOp.get(key),
        srcFile: srcByOp.get(key),
        path: canonical,
      });
      for (const t of tags) usedTags.add(t);
      ops[method] = buildOperation(method, canonical, uniqueOpId(method, canonical), ov, tags);
    }
    sortedPaths[canonical] = ops;
  }

  // THE REGISTRY GATE. Every tag an operation uses must be declared in the
  // curated registry; an undeclared slug FAILS generation rather than silently
  // publishing a new taxonomy. This is what makes the filename bootstrap safe:
  // renaming a route module produces an unregistered slug and stops the build,
  // instead of quietly changing the published contract. It is also what keeps
  // `clinical-ai` / `clinicalAi` / `clinical_ai` from becoming three groups.
  const registry = base.tagRegistry || [];
  const registered = new Map(registry.map((t) => [t.slug, t]));
  const unregistered = [...usedTags].filter((t) => !registered.has(t)).sort(cmp);
  if (unregistered.length) {
    throw new Error(
      `openapi: ${unregistered.length} tag slug(s) are not declared in OPENAPI_TAG_REGISTRY `
        + '(scripts/openapi/base.mjs). Add them there — a tag is part of the published API '
        + 'contract and must be curated, not inferred:\n'
        + unregistered.map((s) => `  { slug: '${s}' },`).join('\n'),
    );
  }

  // `unclassified` is visible debt, and ratcheted: it may shrink, never grow.
  const unclassifiedCount = Object.values(sortedPaths)
    .flatMap((p) => Object.values(p))
    .filter((op) => (op.tags || []).includes(UNCLASSIFIED_TAG)).length;
  const budget = base.unclassifiedTagBudget;
  if (typeof budget === 'number' && unclassifiedCount > budget) {
    throw new Error(
      `openapi: ${unclassifiedCount} operations are tagged '${UNCLASSIFIED_TAG}', over the `
        + `declared budget of ${budget} (UNCLASSIFIED_TAG_BUDGET in scripts/openapi/base.mjs). `
        + 'Give the new operations a real domain — the budget only ratchets DOWN.',
    );
  }

  // Top-level `tags` MUST cover every tag any operation uses, or Spectral's
  // `operation-tag-defined` fires once per uncovered operation — trading one
  // warning class for another. Emit the union of what was actually USED (a
  // declared-but-unused slug is not emitted), sorted by code-unit compare,
  // carrying the curated description when the registry supplies one.
  // (`spectral:oas` does not require tag descriptions, so an undescribed tag is
  // clean — descriptions accrue in the registry as owners write them.)
  const tags = [...usedTags].sort(cmp).map((name) => {
    const entry = registered.get(name);
    return entry?.description ? { name, description: entry.description } : { name };
  });

  const doc = { ...base, tags, paths: sortedPaths };
  // Registry + budget are generator-side curation inputs, not OpenAPI fields.
  delete doc.tagRegistry;
  delete doc.unclassifiedTagBudget;
  return doc;
}
