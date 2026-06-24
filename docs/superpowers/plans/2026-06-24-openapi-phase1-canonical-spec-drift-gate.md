# OpenAPI Phase 1 — Canonical Spec + Path-Set Drift Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild ONE regenerable canonical OpenAPI spec from the live Express-5 router, collapse the 6 forked/duplicate spec files to it, and add a regenerate-and-diff CI + lefthook gate so the spec can never silently drift from the real routes.

**Architecture:** A generator boots the Express app (dotenv preloaded), monkey-patches the *shared* `Router` prototype's `route()`/`use()` to capture each router's relative routes + parent→child mount edges, composes full paths from `app.router`, and emits a deterministic `src/docs/openapi.json` (curated base + sorted live-router paths). A drift checker regenerates into a temp file and string-compares against the committed spec, mirroring the repo's proven Prisma `check-schema-drift.mjs` gate.

**Tech Stack:** Node 22 ESM, Express 5.2.1, `@stoplight/spectral-cli`, lefthook, GitHub Actions reusable workflow. Pure-Node — no JVM, no openapi-generator (per the `build.yaml` ADR / decision D6).

**Scope (decisions locked in the epic spec `docs/superpowers/specs/2026-06-24-openapi-contract-pipeline-design.md`):** path-set + envelope only (D2); code-first derive-from-router (D1); one canonical `openapi.json` in backend (D4); commit-and-drift-check (D5); pure Node (D6); block-on-drift like Prisma (D8); backend-only (D9); internal-only surface (D10). Typed data payloads, admin-TS and Dart clients are **out of scope** (Phases 2–5).

**Verified facts (spike, this session):** the enumerator yields **2956 method+path pairs** at current `main`, including the drifted `/api/v1/pharmacy-orders` and nested `/api/v1/billing/v2/...`. Express 5 gives each router a fresh empty proto, so the patch must target the *shared* prototype that owns `route` (walk the chain). The reusable backend CI job has `DATABASE_URL`/`API_KEY`/`JWT_SECRET` at job scope + a pgvector postgres service; the generator only patches the router + reads `app.router` (no DB query) but transitively imports `src/lib/prisma.js`, so the drift step must run **after** `npx prisma generate`.

---

## File Structure

- Create `apps/backend/scripts/openapi/buildSpec.mjs` — pure transforms (path conversion, compose, document build). Unit-tested in isolation, no app boot.
- Create `apps/backend/scripts/openapi/base.mjs` — the curated OpenAPI base (info/servers/components/security). Phase 5's authored schemas will live here.
- Create `apps/backend/scripts/generate-openapi.mjs` — orchestrator: boot app, capture, compose, write `openapi.json` (honors `--out=`).
- Create `apps/backend/scripts/check-openapi-drift.mjs` — regenerate-to-temp + compare drift gate.
- Create `apps/backend/src/docs/openapi.json` — the single canonical spec (generated, committed).
- Create `apps/backend/src/tests/unit/openapiBuildSpec.test.js` — unit tests for `buildSpec.mjs`.
- Modify `apps/backend/src/utils/swaggerLoader.js` — repoint runtime loader to `openapi.json` (JSON).
- Modify `apps/backend/src/utils/infrastructure/swaggerUtils.js` + `src/services/infrastructure/swaggerService.js` — repoint the second `/api/v1/api-docs` surface.
- Modify `apps/backend/package.json` — `ci` line + replace `swagger:*` scripts with `openapi:generate`/`openapi:check`.
- Modify `apps/admin/package.json` — repoint `generate:types` source.
- Modify `.github/workflows/_reusable-backend-lint-test.yml` — swap the 2 swagger steps; add drift step after `prisma generate`.
- Modify `.forgejo/workflows/schema-policy-drift.yml` + `.forgejo/workflows/openapi-client-drift.yml` — Forgejo parity.
- Modify `lefthook.yml` — pre-push openapi drift hook.
- Delete `apps/backend/src/docs/{swagger.yaml,swagger.json,swagger-complete.yaml,swagger-complete.json,swagger-fixed.yaml,swagger-backup-20250703-181227.yaml}` and the 4 dead scripts.

---

## Task 1: Pure spec-build helpers (TDD)

**Files:**
- Create: `apps/backend/scripts/openapi/buildSpec.mjs`
- Test: `apps/backend/src/tests/unit/openapiBuildSpec.test.js`

- [ ] **Step 1: Write the failing test**

```js
// apps/backend/src/tests/unit/openapiBuildSpec.test.js
import {
  expressPathToOpenApi, joinPath, pathParamNames, operationId,
  composeRoutes, buildOpenApiDocument,
} from '../../../scripts/openapi/buildSpec.mjs';

describe('openapi buildSpec helpers', () => {
  test('expressPathToOpenApi converts :param and *splat to {brace}', () => {
    expect(expressPathToOpenApi('/users/:id')).toBe('/users/{id}');
    expect(expressPathToOpenApi('/a/:x/b/:y')).toBe('/a/{x}/b/{y}');
    expect(expressPathToOpenApi('/files/*splat')).toBe('/files/{splat}');
    expect(expressPathToOpenApi('/already/{id}')).toBe('/already/{id}');
  });

  test('joinPath normalizes slashes and root', () => {
    expect(joinPath('/api/v1/users', '/')).toBe('/api/v1/users');
    expect(joinPath('/api/v1/users', '/:id')).toBe('/api/v1/users/:id');
    expect(joinPath('', '/')).toBe('/');
    expect(joinPath('/a/', 'b')).toBe('/a/b');
  });

  test('pathParamNames + operationId', () => {
    expect(pathParamNames('/users/{id}/notes/{noteId}')).toEqual(['id', 'noteId']);
    expect(operationId('GET', '/users/{id}')).toBe('get_users_by_id');
    expect(operationId('POST', '/')).toBe('post_root');
  });

  test('composeRoutes walks mount edges and sorts + dedupes', () => {
    const root = { id: 'root' };
    const usersR = { id: 'users' };
    const route = (methods) => ({ methods });
    const routerRoutes = new Map([
      [root, [{ relPath: '/', route: route({ get: true }) }]],
      [usersR, [
        { relPath: '/', route: route({ get: true, post: true }) },
        { relPath: '/:id', route: route({ get: true }) },
      ]],
    ]);
    const edges = new Map([[root, [{ prefix: '/api/v1/users', child: usersR }]]]);
    expect(composeRoutes({ routerRoutes, edges, root })).toEqual([
      { method: 'get', path: '/' },
      { method: 'get', path: '/api/v1/users' },
      { method: 'post', path: '/api/v1/users' },
      { method: 'get', path: '/api/v1/users/{id}' },
    ]);
  });

  test('buildOpenApiDocument produces sorted paths, unique operationIds, path params', () => {
    const routes = [
      { method: 'get', path: '/users/{id}' },
      { method: 'get', path: '/a-b' },
      { method: 'get', path: '/a_b' },
    ];
    const doc = buildOpenApiDocument(routes, { openapi: '3.0.3', paths: { IGNORED: true } });
    expect(Object.keys(doc.paths)).toEqual(['/a-b', '/a_b', '/users/{id}']);
    const ids = Object.values(doc.paths).flatMap((p) => Object.values(p).map((op) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(doc.paths['/users/{id}'].get.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
    expect(doc.paths['/users/{id}'].get.responses['200'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/Success' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiBuildSpec.test.js`
Expected: FAIL — `Cannot find module '../../../scripts/openapi/buildSpec.mjs'`.

- [ ] **Step 3: Implement `buildSpec.mjs`**

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiBuildSpec.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/scripts/openapi/buildSpec.mjs apps/backend/src/tests/unit/openapiBuildSpec.test.js
git commit -m "feat(openapi): pure spec-build helpers + unit tests"
```

---

## Task 2: Curated base + generator orchestrator

**Files:**
- Create: `apps/backend/scripts/openapi/base.mjs`
- Create: `apps/backend/scripts/generate-openapi.mjs`

- [ ] **Step 1: Create the curated base** (schemas + securitySchemes lifted verbatim from `swagger.yaml`; `info`/`servers` refreshed to current truth)

```js
// apps/backend/scripts/openapi/base.mjs
// Curated, hand-authored OpenAPI base. The generator merges live-router-derived
// `paths` over this. Phase 5 enriches `components.schemas` with per-subsystem
// request/response types. (schemas + securitySchemes carried from the legacy
// swagger.yaml; info/servers refreshed off the Render-era values.)
export const OPENAPI_BASE = {
  openapi: '3.0.3',
  info: {
    title: 'VH Health API',
    version: '2.0.0',
    description:
      'VH Health platform REST API. Paths are generated from the live Express '
      + 'router by scripts/generate-openapi.mjs and gated by '
      + 'scripts/check-openapi-drift.mjs. Operation request/response payloads are '
      + 'enriched per subsystem in later phases — see '
      + 'docs/superpowers/specs/2026-06-24-openapi-contract-pipeline-design.md.',
    contact: { name: 'VH Health Tech Team', email: 'api@vhhealth.com', url: 'https://vhhealth.com' },
    license: { name: 'Proprietary', url: 'https://vhhealth.com/license' },
  },
  servers: [
    { url: 'https://api.vhhealth.app/api/v1', description: 'Production' },
    { url: 'http://localhost:5000/api/v1', description: 'Development' },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'API key (API_KEY env var)' },
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT user token' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string', example: 'Error message' },
          error: { type: 'string', example: 'Error details' },
          details: { type: 'object' },
        },
      },
      Success: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string', example: 'Operation successful' },
          data: { type: 'object', description: 'Response data (varies by endpoint)' },
        },
      },
      PaginatedResponse: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          message: { type: 'string' },
          data: {
            type: 'object',
            properties: {
              items: { type: 'array', items: { type: 'object' } },
              pagination: {
                type: 'object',
                properties: {
                  page: { type: 'integer', example: 1 },
                  limit: { type: 'integer', example: 10 },
                  total: { type: 'integer', example: 100 },
                  totalPages: { type: 'integer', example: 10 },
                },
              },
            },
          },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
};
```

- [ ] **Step 2: Create the generator orchestrator**

```js
// apps/backend/scripts/generate-openapi.mjs
// Boots the Express app, captures the live routes by patching the shared Router
// prototype, composes full paths, and writes a deterministic openapi.json.
//   Usage: node scripts/generate-openapi.mjs [--out=<path>]
import 'dotenv/config'; // populate process.env from .env BEFORE app.js (-> prisma) loads
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { composeRoutes, buildOpenApiDocument } from './openapi/buildSpec.mjs';
import { OPENAPI_BASE } from './openapi/base.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Express 5 gives each router a fresh empty proto chaining up to the shared
// methods object — walk up to the object that actually OWNS `route`.
function protoOwning(obj, prop) {
  let o = obj;
  while (o && !Object.getOwnPropertyDescriptor(o, prop)) o = Object.getPrototypeOf(o);
  return o;
}
const proto = protoOwning(express.Router(), 'route');

const routerRoutes = new Map();
const edges = new Map();
const isRouter = (h) => typeof h === 'function' && h && Array.isArray(h.stack);
const normPrefix = (p) =>
  typeof p === 'string' ? p : Array.isArray(p) ? p.find((x) => typeof x === 'string') ?? '/' : '/';

const origRoute = proto.route;
proto.route = function patchedRoute(path) {
  const r = origRoute.call(this, path);
  if (!routerRoutes.has(this)) routerRoutes.set(this, []);
  routerRoutes.get(this).push({ relPath: typeof path === 'string' ? path : '/', route: r });
  return r;
};
const origUse = proto.use;
proto.use = function patchedUse(first, ...rest) {
  let prefix = '/';
  let handlers;
  if (typeof first === 'string' || Array.isArray(first) || first instanceof RegExp) {
    prefix = normPrefix(first);
    handlers = rest;
  } else {
    handlers = [first, ...rest];
  }
  for (const h of handlers) {
    if (isRouter(h)) {
      if (!edges.has(this)) edges.set(this, []);
      edges.get(this).push({ prefix, child: h });
    }
  }
  return origUse.call(this, first, ...rest);
};

const app = (await import('../src/app.js')).default;
proto.route = origRoute;
proto.use = origUse;

const root = app.router || app._router;
const routes = composeRoutes({ routerRoutes, edges, root });
const doc = buildOpenApiDocument(routes, OPENAPI_BASE);

const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = outArg ? resolve(outArg.slice('--out='.length)) : resolve(__dirname, '../src/docs/openapi.json');
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`openapi: wrote ${routes.length} operations / ${Object.keys(doc.paths).length} paths -> ${outPath}`);
process.exit(0);
```

- [ ] **Step 3: Run the generator + verify it produces the expected spec**

Run: `cd apps/backend && node scripts/generate-openapi.mjs && node -e "const d=require('./src/docs/openapi.json'); const ops=Object.values(d.paths).reduce((n,p)=>n+Object.keys(p).length,0); console.log('paths',Object.keys(d.paths).length,'ops',ops); console.log('pharmacy-orders?', !!d.paths['/api/v1/pharmacy-orders']); console.log('billing v2?', Object.keys(d.paths).some(p=>p.startsWith('/api/v1/billing/v2'))); console.log('has Success schema?', !!d.components.schemas.Success);"`
Expected: ~2000+ ops, `pharmacy-orders? true`, `billing v2? true`, `has Success schema? true`.

- [ ] **Step 4: Verify DETERMINISM (regenerate twice, must be byte-identical)**

Run: `cd apps/backend && node scripts/generate-openapi.mjs --out=/tmp/o1.json && node scripts/generate-openapi.mjs --out=/tmp/o2.json && diff -q /tmp/o1.json /tmp/o2.json && echo DETERMINISTIC`
Expected: `DETERMINISTIC` (no diff). If it differs, the sort in `buildOpenApiDocument`/`composeRoutes` is incomplete — fix before proceeding.

- [ ] **Step 5: Verify the generated spec passes Spectral (no ERROR-level violations)**

Run: `cd apps/backend && npx spectral lint src/docs/openapi.json; echo "exit: $?"`
Expected: exit 0 (warnings about operation `description`/`tags` are acceptable; there must be no errors — especially no duplicate-operationId or undeclared-path-param errors).

- [ ] **Step 6: Commit** (the generator + base + the generated spec together)

```bash
git add apps/backend/scripts/openapi/base.mjs apps/backend/scripts/generate-openapi.mjs apps/backend/src/docs/openapi.json
git commit -m "feat(openapi): live-router spec generator + canonical openapi.json"
```

---

## Task 3: Repoint runtime loaders to openapi.json

**Files:**
- Modify: `apps/backend/src/utils/swaggerLoader.js`
- Modify: `apps/backend/src/utils/infrastructure/swaggerUtils.js:17`
- Modify: `apps/backend/src/services/infrastructure/swaggerService.js:351`

- [ ] **Step 1: Repoint the primary loader** — replace the body of `apps/backend/src/utils/swaggerLoader.js`

Replace line 6 (`import YAML from 'yaml';`) — delete it — and lines 20-21:

```js
    const filePath = path.resolve(__dirname, '../docs/openapi.json');
    const swaggerDocument = JSON.parse(fs.readFileSync(filePath, 'utf8'));
```

(Keep the try/catch, the `return null` on failure, and the default-export signature exactly as-is. `app.js` consumes the parsed object directly.)

- [ ] **Step 2: Repoint the second `/api/v1/api-docs` surface**

In `apps/backend/src/utils/infrastructure/swaggerUtils.js` line 17, change `'../../docs/swagger.yaml'` → `'../../docs/openapi.json'`, and change its `YAML.parse(...)` read to `JSON.parse(...)` (and drop the now-unused YAML import in that file if present). In `apps/backend/src/services/infrastructure/swaggerService.js` line 351, change the `swaggerPath` `'../../docs/swagger.yaml'` → `'../../docs/openapi.json'` (and its parse to JSON if it parses inline).

- [ ] **Step 3: Verify the app boots and serves the spec**

Run: `cd apps/backend && node -r dotenv/config -e "import('./src/utils/swaggerLoader.js').then(m=>{const d=m.default(); if(!d||!d.openapi){console.error('LOADER FAILED');process.exit(1)} console.log('loader OK, paths', Object.keys(d.paths).length); process.exit(0)})"`
Expected: `loader OK, paths <N>`.

- [ ] **Step 4: Lint the changed files (the `ci` lint step runs eslint with zero-warning tolerance)**

Run: `cd apps/backend && npx eslint src/utils/swaggerLoader.js src/utils/infrastructure/swaggerUtils.js src/services/infrastructure/swaggerService.js`
Expected: clean (no unused-import warnings — the `yaml` import must be gone where unused).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/utils/swaggerLoader.js apps/backend/src/utils/infrastructure/swaggerUtils.js apps/backend/src/services/infrastructure/swaggerService.js
git commit -m "refactor(openapi): repoint runtime loaders to canonical openapi.json"
```

---

## Task 4: Delete legacy spec files + dead scripts; rewire package.json

**Files:**
- Delete: 6 spec files + 4 scripts (below)
- Modify: `apps/backend/package.json`, `apps/admin/package.json`

- [ ] **Step 1: Delete the 6 legacy spec files + 4 dead scripts**

```bash
cd "apps/backend"
git rm src/docs/swagger.yaml src/docs/swagger.json src/docs/swagger-complete.yaml src/docs/swagger-complete.json src/docs/swagger-fixed.yaml src/docs/swagger-backup-20250703-181227.yaml
git rm src/scripts/validate-swagger.js src/scripts/yaml-to-json-swagger.js src/scripts/generate-complete-swagger.js src/scripts/fix-swagger-validation.js
```

- [ ] **Step 2: Edit `apps/backend/package.json`** — the `ci` line (line 35):

Replace:
```
    "ci": "npm run lint && npx --yes audit-ci --config .audit-ci.jsonc && npm run swagger:validate && npx spectral lint src/docs/swagger-complete.yaml && npm run ci:backend:docker",
```
with:
```
    "ci": "npm run lint && npx --yes audit-ci --config .audit-ci.jsonc && npm run openapi:check && npx spectral lint src/docs/openapi.json && npm run ci:backend:docker",
```

And replace the three `swagger:*` script lines (50-52):
```
    "swagger:validate": "node src/scripts/validate-swagger.js",
    "swagger:generate": "node src/scripts/yaml-to-json-swagger.js",
    "swagger:generate-complete": "node src/scripts/generate-complete-swagger.js",
```
with:
```
    "openapi:generate": "node scripts/generate-openapi.mjs",
    "openapi:check": "node scripts/check-openapi-drift.mjs",
```

- [ ] **Step 3: Edit `apps/admin/package.json`** — `generate:types` (line 29):

Replace `../backend/src/docs/swagger-complete.yaml` with `../backend/src/docs/openapi.json` so it reads:
```
    "generate:types": "npx openapi-typescript ../backend/src/docs/openapi.json -o src/lib/api-types.generated.ts",
```

- [ ] **Step 4: Verify the new scripts resolve + the app still boots**

Run: `cd apps/backend && npm run openapi:generate && node -e "console.log('regenerated ok')"`
Expected: regenerates `src/docs/openapi.json`; `git diff --stat src/docs/openapi.json` shows no change (spec already current).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/package.json apps/admin/package.json apps/backend/src/docs apps/backend/src/scripts
git commit -m "chore(openapi): collapse to one canonical spec; drop dead swagger scripts"
```

---

## Task 5: Drift checker (TDD via route mutation)

**Files:**
- Create: `apps/backend/scripts/check-openapi-drift.mjs`

- [ ] **Step 1: Create the drift checker** (mirrors `scripts/check-schema-drift.mjs`)

```js
#!/usr/bin/env node
// apps/backend/scripts/check-openapi-drift.mjs
//
// Regenerates the live-router OpenAPI spec into a temp file and compares it
// against the committed src/docs/openapi.json. Fails (exit 1) on drift so a
// route added/changed without regenerating the spec is caught at review time.
//
// Exit codes (mirror check-schema-drift.mjs):
//   0 — spec matches live routes
//   1 — drift detected (diff printed)
//   2 — infrastructure error (generator failed)
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(__dirname, '..');
const committedSpecPath = join(backendRoot, 'src', 'docs', 'openapi.json');

const workDir = mkdtempSync(join(tmpdir(), 'openapi-drift-'));
const tmpSpecPath = join(workDir, 'openapi.json');

function canonicalise(source) {
  return `${JSON.stringify(JSON.parse(source), null, 2)}\n`;
}

try {
  const gen = spawnSync(
    process.execPath,
    [join(backendRoot, 'scripts', 'generate-openapi.mjs'), `--out=${tmpSpecPath}`],
    { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
  if (gen.status !== 0) {
    console.error('generate-openapi.mjs failed:');
    console.error(gen.stderr || gen.stdout);
    process.exit(2);
  }

  const committed = canonicalise(readFileSync(committedSpecPath, 'utf8'));
  const generated = canonicalise(readFileSync(tmpSpecPath, 'utf8'));

  if (committed === generated) {
    console.log('✓ openapi.json matches live routes — no drift');
    process.exit(0);
  }

  console.error('✗ openapi.json drift detected');
  console.error('');
  console.error('The committed src/docs/openapi.json is out of sync with the live');
  console.error('Express routes. Regenerate and commit it:');
  console.error('');
  console.error('  npm --prefix apps/backend run openapi:generate');
  console.error('  git add apps/backend/src/docs/openapi.json');
  console.error('');
  const diff = spawnSync('diff', ['-u', committedSpecPath, tmpSpecPath], {
    cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
  const lines = (diff.stdout || '').split('\n');
  console.error(lines.slice(0, 200).join('\n'));
  if (lines.length > 200) console.error(`... (${lines.length - 200} more diff lines)`);
  process.exit(1);
} finally {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* cleanup */ }
}
```

- [ ] **Step 2: Verify the gate is GREEN on a clean tree**

Run: `cd apps/backend && node scripts/check-openapi-drift.mjs; echo "exit: $?"`
Expected: `✓ openapi.json matches live routes — no drift` / `exit: 0`.

- [ ] **Step 3: Verify the gate goes RED on a real route change (then revert)**

Run:
```bash
cd apps/backend
node -e "const fs=require('fs');const p='src/routes/health/uptimeRoutes.js';let s=fs.readFileSync(p,'utf8');fs.writeFileSync(p+'.bak',s);s=s.replace(/export default router;?\s*$/m, \"router.get('/__drift_probe__', (req,res)=>res.json({}));\nexport default router;\");fs.writeFileSync(p,s);"
node scripts/check-openapi-drift.mjs; echo "drift-exit: $?"
mv src/routes/health/uptimeRoutes.js.bak src/routes/health/uptimeRoutes.js
node scripts/check-openapi-drift.mjs; echo "clean-exit: $?"
```
Expected: `drift-exit: 1` (drift printed, mentions `/api/v1/health/__drift_probe__`), then `clean-exit: 0`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/scripts/check-openapi-drift.mjs
git commit -m "feat(openapi): regenerate-and-diff drift gate (mirrors prisma schema-drift)"
```

---

## Task 6: Wire CI + Forgejo + lefthook

**Files:**
- Modify: `.github/workflows/_reusable-backend-lint-test.yml`
- Modify: `.forgejo/workflows/schema-policy-drift.yml`, `.forgejo/workflows/openapi-client-drift.yml`
- Modify: `lefthook.yml`

- [ ] **Step 1: GitHub reusable workflow** — in `.github/workflows/_reusable-backend-lint-test.yml`:

Replace the two existing swagger steps:
```yaml
      - name: Validate Swagger structure
        run: npm run swagger:validate

      - name: Lint OpenAPI with Spectral
        run: npx spectral lint src/docs/swagger-complete.yaml
```
with a single repointed spectral step:
```yaml
      - name: Lint OpenAPI with Spectral
        run: npx spectral lint src/docs/openapi.json
```
and add the drift step **immediately after the existing `Generate Prisma client` step** (`run: npx prisma generate`):
```yaml
      - name: OpenAPI drift check (regenerate live-router spec + diff)
        run: node scripts/check-openapi-drift.mjs
```

- [ ] **Step 2: Forgejo parity** — in `.forgejo/workflows/schema-policy-drift.yml`, add `node scripts/check-openapi-drift.mjs` to the guardrails run block right after the existing `node scripts/ci-schema-drift.mjs` line (confirm `DATABASE_URL`/`JWT_SECRET`/`API_KEY` + a postgres service are present in that job; the schema-drift step already needs a DB, so they are).

In `.forgejo/workflows/openapi-client-drift.yml`: repoint `npx spectral lint src/docs/swagger-complete.yaml` → `src/docs/openapi.json`; replace the `npm run swagger:generate-complete` regen call with `npm run openapi:generate`; repoint the hard-fail `git diff --exit-code -- ...swagger-complete.{yaml,json}` to `src/docs/openapi.json`. If this job has no postgres service / `DATABASE_URL`, add a `pgvector/pgvector:pg16` service + `DATABASE_URL`/`JWT_SECRET`/`API_KEY` env (the generator boots Express). Leave its Dart spec-copy step warn-only (that's Phase 2).

- [ ] **Step 3: lefthook pre-push hook** — in `lefthook.yml`, add under `pre-push:` `commands:` (gated so it only runs when backend routes/app changed; booting Express on every push is too heavy otherwise):

```yaml
    openapi-drift:
      run: |
        if git diff --name-only @{u}..HEAD 2>/dev/null | grep -qE '^apps/backend/(src/routes/|src/app\.js)'; then
          (cd apps/backend && node scripts/check-openapi-drift.mjs)
        else
          echo "lefthook pre-push: no backend route changes — skipping openapi drift"
        fi
```

- [ ] **Step 4: Verify lefthook config parses**

Run: `cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && npx lefthook validate 2>/dev/null || lefthook validate`
Expected: no parse error (or `lefthook: configuration is valid`).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/_reusable-backend-lint-test.yml .forgejo/workflows/schema-policy-drift.yml .forgejo/workflows/openapi-client-drift.yml lefthook.yml
git commit -m "ci(openapi): drift gate in backend CI + Forgejo + lefthook pre-push"
```

---

## Task 7: Docs + end-to-end verification + finish

**Files:**
- Modify: `apps/backend/README.md:79`, `apps/backend/docs/README.md:31`, `SYSTEM-ARCHITECTURE.md`

- [ ] **Step 1: Repoint stale doc references** — change `swagger.yaml` mentions to `openapi.json` in `apps/backend/README.md` (line ~79), `apps/backend/docs/README.md` (line ~31), and `SYSTEM-ARCHITECTURE.md` (grep for `swagger`). Cosmetic; no build impact.

- [ ] **Step 2: End-to-end verification** (the gates that actually changed)

Run each; all must pass:
```bash
cd apps/backend
npx eslint src scripts                                              # lint (swaggerLoader + new scripts)
npx spectral lint src/docs/openapi.json                            # spec lints clean
node scripts/check-openapi-drift.mjs                               # drift gate green
node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/unit/openapiBuildSpec.test.js   # unit tests
node --experimental-vm-modules node_modules/jest/bin/jest.js src/tests/production-hardening.test.js     # /api/v1/api-docs/spec still green
```
Expected: eslint clean; spectral exit 0; drift `no drift`; both jest suites pass.

- [ ] **Step 3: Confirm no stray references to deleted files remain**

Run: `cd "D:/Dev/Projects/VH Health/VH-Health-Platform" && grep -rnE "swagger-complete|swagger-fixed|swagger\.yaml|validate-swagger|yaml-to-json-swagger|generate-complete-swagger" apps .github .forgejo lefthook.yml --include='*.js' --include='*.mjs' --include='*.json' --include='*.yml' --include='*.yaml' | grep -vE "node_modules|/logs/|openapi"`
Expected: no results (all references repointed/removed).

- [ ] **Step 4: Commit docs**

```bash
git add apps/backend/README.md apps/backend/docs/README.md SYSTEM-ARCHITECTURE.md
git commit -m "docs(openapi): repoint swagger.yaml references to openapi.json"
```

- [ ] **Step 5: Finish the branch** — merge `--no-ff` to `main`, push `origin` + `github`, delete branch. Update `docs/ROADMAP.md` §0 T2 #5 (Phase 1 done) + memory.

---

## Self-Review

- **Spec coverage (epic §4 Phase 1 + D1–D10):** canonical spec rebuilt from live router ✓ (Tasks 1-2); collapse 5+ forked files to one ✓ (Task 4); regenerate-and-diff CI gate mirroring Prisma ✓ (Tasks 5-6); lefthook ✓ (Task 6). D4 one-file ✓; D5 commit-and-drift-check ✓; D6 pure-Node ✓; D8 block-on-drift ✓; D9 backend-only ✓ (admin `generate:types` repoint is a 1-line breakage-prevention, not a client build); D10 internal-only ✓ (no served-prod change). Out of scope (typed payloads, Dart/admin client gen) correctly deferred.
- **Key-risk coverage (from the change inventory):** boot-crash-if-spec-missing → openapi.json committed *with* the loader edit (Tasks 2-3 commit the spec first, Task 3 repoints, Task 4 deletes old) ✓; second `/api-docs` surface → repointed (Task 3 Step 2) ✓; generator boot env in CI → step placed after `prisma generate`, job env confirmed ✓; determinism → explicit twice-and-diff check (Task 2 Step 4) ✓; spectral-must-pass → explicit lint (Task 2 Step 5) ✓; curated-base-loss → base embedded verbatim (Task 2 Step 1) ✓; admin generate:types → repointed (Task 4 Step 3) ✓; Forgejo action refs → not copied to GitHub, only the reusable workflow's stock steps used ✓.
- **Placeholder scan:** none — all code, paths, commands, and expected outputs are concrete.
- **Type/name consistency:** `expressPathToOpenApi`/`joinPath`/`pathParamNames`/`operationId`/`composeRoutes`/`buildOpenApiDocument` defined in Task 1 and consumed verbatim in Tasks 1-2; `OPENAPI_BASE` defined in Task 2 Step 1 and imported in Step 2; `--out=` honored by the generator (Task 2) and used by the drift checker (Task 5); script names `openapi:generate`/`openapi:check` consistent across package.json (Task 4), CI (Task 6), and the drift-checker's printed remediation.
- **Ordering safety:** spec generated+committed (Task 2) → loaders repointed (Task 3) → old files deleted (Task 4), so the served `/api-docs` never points at a missing file mid-sequence.
