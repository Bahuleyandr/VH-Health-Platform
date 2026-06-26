// apps/backend/scripts/generate-openapi.mjs
// Boots the Express app, captures the live routes by patching the shared Router
// prototype, composes full paths, and writes a deterministic openapi.json.
//   Usage: node scripts/generate-openapi.mjs [--out=<path>]
import 'dotenv/config'; // populate process.env from .env BEFORE app.js (-> prisma) loads
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { composeRoutes, buildOpenApiDocument, findEquivalentPathCollisions } from './openapi/buildSpec.mjs';
import { OPENAPI_BASE } from './openapi/base.mjs';
import * as money from './openapi/schemas/money.mjs';
import * as appointments from './openapi/schemas/appointments.mjs';
import * as discharge from './openapi/schemas/discharge.mjs';
import * as payroll from './openapi/schemas/payroll.mjs';
import * as emr from './openapi/schemas/emr.mjs';

const SCHEMA_MODULES = [money, appointments, discharge, payroll, emr];

/** Merge subsystem schema modules: base schemas first (order preserved), then the
 * union of module schemas sorted by name. Errors on duplicate names so two modules
 * can't silently clobber each other. Returns { schemas, overlay }. */
function mergeSchemaModules(baseSchemas) {
  const added = {};
  const overlay = {};
  for (const mod of SCHEMA_MODULES) {
    for (const [name, schema] of Object.entries(mod.schemas || {})) {
      if (baseSchemas[name] || added[name]) throw new Error(`openapi: duplicate schema name "${name}"`);
      added[name] = schema;
    }
    for (const [key, ov] of Object.entries(mod.operations || {})) {
      if (overlay[key]) throw new Error(`openapi: duplicate operation overlay "${key}"`);
      overlay[key] = ov;
    }
  }
  const sortedAdded = Object.fromEntries(Object.keys(added).sort().map((k) => [k, added[k]]));
  return { schemas: { ...baseSchemas, ...sortedAdded }, overlay };
}

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
// Prefixes (per parent router) whose mount carries the __openapiSkipMount marker
// (a runtime req.url-rewrite alias). Express 5 splits a multi-handler app.use
// into one router.use call PER handler, so the marker handler and the child
// router arrive in SEPARATE calls at the same prefix — record the marked prefix
// when seen, then skip the child-router edge mounted at it.
const skipPrefixes = new Map();
// A router is either a function with its own .stack, OR a wrapAsync wrapper that
// tagged the underlying router on __wrappedFn (routeWrapper.js) — the latter
// happens for sub-routers mounted via wrapAutoRBAC/wrapRoutes `use:` maps.
const asRouter = (h) => {
  if (typeof h !== 'function' || !h) return null;
  if (Array.isArray(h.stack)) return h;
  if (h.__wrappedFn && Array.isArray(h.__wrappedFn.stack)) return h.__wrappedFn;
  return null;
};
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
  // Skip alias mounts that rewrite req.url at runtime (e.g. the MAR
  // discoverability aliases in app.js). The rewrite makes the real served path
  // differ from mount+route, so walking them would emit unreachable artifact
  // paths (/api/v1/emr/mar/mar/*). The marker handler (__openapiSkipMount) and
  // the child router arrive in separate per-handler calls at the same prefix.
  if (handlers.some((h) => typeof h === 'function' && h.__openapiSkipMount)) {
    if (!skipPrefixes.has(this)) skipPrefixes.set(this, new Set());
    skipPrefixes.get(this).add(prefix);
  }
  const skipThisMount = skipPrefixes.has(this) && skipPrefixes.get(this).has(prefix);
  if (!skipThisMount) {
    for (const h of handlers) {
      const child = asRouter(h);
      if (child) {
        if (!edges.has(this)) edges.set(this, []);
        edges.get(this).push({ prefix, child });
      }
    }
  }
  return origUse.call(this, first, ...rest);
};

const app = (await import('../src/app.js')).default;
proto.route = origRoute;
proto.use = origUse;

const root = app.router || app._router;
const routes = composeRoutes({ routerRoutes, edges, root });

// Param-equivalent paths (same URL template, different param names) shadow each
// other at the URL level and can't both live in one OpenAPI doc — report them
// (they're a real follow-up finding) before collapsing.
const collisions = findEquivalentPathCollisions(routes);
if (collisions.length) {
  console.log(`openapi: ${collisions.length} param-equivalent path collision(s) collapsed (URL-shadowing routes):`);
  for (const c of collisions.slice(0, 20)) console.log(`  ${c.signature}  <-  ${c.paths.join(' , ')}`);
}

const { schemas: mergedSchemas, overlay } = mergeSchemaModules(OPENAPI_BASE.components.schemas);
const augmentedBase = {
  ...OPENAPI_BASE,
  components: { ...OPENAPI_BASE.components, schemas: mergedSchemas },
};
const doc = buildOpenApiDocument(routes, augmentedBase, overlay);

const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = outArg ? resolve(outArg.slice('--out='.length)) : resolve(__dirname, '../src/docs/openapi.json');
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`openapi: wrote ${routes.length} operations / ${Object.keys(doc.paths).length} paths -> ${outPath}`);
process.exit(0);
