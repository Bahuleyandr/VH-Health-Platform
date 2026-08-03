// apps/backend/scripts/generate-openapi.mjs
// Boots the Express app, captures the live routes by patching the shared Router
// prototype, composes full paths, and writes a deterministic openapi.json.
//   Usage: node scripts/generate-openapi.mjs [--out=<path>]
import 'dotenv/config'; // populate process.env from .env BEFORE app.js (-> prisma) loads
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  composeRoutes,
  buildOpenApiDocument,
  findEquivalentPathCollisions
} from './openapi/buildSpec.mjs';
import { OPENAPI_BASE } from './openapi/base.mjs';
import * as money from './openapi/schemas/money.mjs';
import * as appointments from './openapi/schemas/appointments.mjs';
import * as discharge from './openapi/schemas/discharge.mjs';
import * as payroll from './openapi/schemas/payroll.mjs';
import * as emr from './openapi/schemas/emr.mjs';
import * as clinicalAi from './openapi/schemas/clinicalAi.mjs';
import * as clinicalMar from './openapi/schemas/clinicalMar.mjs';
import * as pharmacy from './openapi/schemas/pharmacy.mjs';
import * as users from './openapi/schemas/users.mjs';
import * as config from './openapi/schemas/config.mjs';
import * as portal from './openapi/schemas/portal.mjs';
import * as cathConsumables from './openapi/schemas/cathConsumables.mjs';
import * as clinicalInbox from './openapi/schemas/clinicalInbox.mjs';
import * as lab from './openapi/schemas/lab.mjs';
import * as carePathways from './openapi/schemas/carePathways.mjs';
import * as outboxRecovery from './openapi/schemas/outboxRecovery.mjs';
import * as clientReadiness from './openapi/schemas/clientReadiness.mjs';
import * as clinicalContinuityPolicyDelivery from './openapi/schemas/clinicalContinuityPolicyDelivery.mjs';
import * as clinicalContinuityReconciliation from './openapi/schemas/clinicalContinuityReconciliation.mjs';

const SCHEMA_MODULES = [
  money,
  appointments,
  discharge,
  payroll,
  emr,
  clinicalAi,
  clinicalMar,
  pharmacy,
  users,
  config,
  portal,
  cathConsumables,
  clinicalInbox,
  lab,
  carePathways,
  outboxRecovery,
  clinicalContinuityPolicyDelivery,
  clientReadiness,
  clinicalContinuityReconciliation
];

/** Merge subsystem schema modules: base schemas first (order preserved), then the
 * union of module schemas sorted by name. Errors on duplicate names so two modules
 * can't silently clobber each other. Returns { schemas, overlay }. */
function mergeSchemaModules(baseSchemas) {
  const added = {};
  const overlay = {};
  for (const mod of SCHEMA_MODULES) {
    for (const [name, schema] of Object.entries(mod.schemas || {})) {
      if (baseSchemas[name] || added[name])
        throw new Error(`openapi: duplicate schema name "${name}"`);
      added[name] = schema;
    }
    for (const [key, ov] of Object.entries(mod.operations || {})) {
      if (overlay[key]) throw new Error(`openapi: duplicate operation overlay "${key}"`);
      overlay[key] = ov;
    }
  }
  const sortedAdded = Object.fromEntries(
    Object.keys(added)
      .sort()
      .map(k => [k, added[k]])
  );
  const merged = { ...baseSchemas, ...sortedAdded };
  // swagger_dart_code_generator (the Flutter codegen) cannot emit a class for a
  // top-level schema whose entire body is a bare `$ref` alias — it references the
  // aliased type but never defines a class, so json_serializable fails with
  // `InvalidType`. Wrapping the alias in a single-member `allOf` is semantically
  // identical (OpenAPI treats `{$ref:X}` and `{allOf:[{$ref:X}]}` the same) but
  // makes the generator emit a proper class. Normalize here so the `<Name>Data`
  // envelope-payload aliases — and any future bare-$ref schema — stay codegen-safe.
  for (const [name, schema] of Object.entries(merged)) {
    if (
      schema &&
      typeof schema === 'object' &&
      Object.keys(schema).length === 1 &&
      '$ref' in schema
    ) {
      merged[name] = { allOf: [{ $ref: schema.$ref }] };
    }
  }
  return { schemas: merged, overlay };
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
const asRouter = h => {
  if (typeof h !== 'function' || !h) return null;
  if (Array.isArray(h.stack)) return h;
  if (h.__wrappedFn && Array.isArray(h.__wrappedFn.stack)) return h.__wrappedFn;
  return null;
};
const normPrefix = p =>
  typeof p === 'string' ? p : Array.isArray(p) ? (p.find(x => typeof x === 'string') ?? '/') : '/';

// Which route MODULE registered this operation. Routes are grouped by domain on
// disk (src/routes/<domain>/...), so the owning file is a curated taxonomy the
// generator already has at capture time — that is what OpenAPI `tags` are
// derived from (see resolveTags in openapi/buildSpec.mjs). Deriving tags from
// the URL instead would put 895 operations (24.6% of the API) under `admin`,
// which is an AUDIENCE prefix, not a domain.
//
// Registration reaches us through several layers — wrapAutoRBAC/wrapRoutes call
// `router[method](path, ...)` in src/config/routeWrapper.js, which calls
// `this.route(path)` inside Express — so we walk OUT to the first frame that
// lives under src/routes/ rather than trusting any fixed stack depth. Uses
// structured CallSite objects (not stack-string parsing) and returns a path
// relative to src/routes/, so absolute paths and drive letters never leak into
// the spec.
function captureRouteSourceFile() {
  const prevPrepare = Error.prepareStackTrace;
  const prevLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  Error.prepareStackTrace = (_err, frames) => frames;
  const frames = new Error().stack;
  Error.prepareStackTrace = prevPrepare;
  Error.stackTraceLimit = prevLimit;
  if (!Array.isArray(frames)) return null;
  for (const frame of frames) {
    let file = frame.getFileName?.();
    if (!file) continue;
    if (file.startsWith('file:')) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    const norm = file.replace(/\\/g, '/');
    const at = norm.indexOf('/src/routes/');
    if (at !== -1) return norm.slice(at + '/src/routes/'.length);
  }
  return null;
}

const origRoute = proto.route;
proto.route = function patchedRoute(path) {
  const r = origRoute.call(this, path);
  if (!routerRoutes.has(this)) routerRoutes.set(this, []);
  routerRoutes.get(this).push({
    relPath: typeof path === 'string' ? path : '/',
    route: r,
    srcFile: captureRouteSourceFile()
  });
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
  if (handlers.some(h => typeof h === 'function' && h.__openapiSkipMount)) {
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

// Explicit domain declarations (src/config/openapiDomain.js markRouterDomain).
// These outrank the filename bootstrap: they pin the published tag in code, so
// it survives a route module being moved, renamed or re-mounted. Collected from
// every router we captured — the root, anything that registered a route, and
// every mount child. `asRouter` already unwrapped wrapAsync wrappers, so the
// object here is the same one the route module marked.
const { getRouterDomain } = await import('../src/config/openapiDomain.js');
const routerDomains = new Map();
const noteDomain = r => {
  const slug = getRouterDomain(r);
  if (slug) routerDomains.set(r, slug);
};
noteDomain(root);
for (const r of routerRoutes.keys()) noteDomain(r);
for (const list of edges.values()) for (const { child } of list) noteDomain(child);

const routes = composeRoutes({ routerRoutes, edges, root, routerDomains });

// Param-equivalent paths (same URL template, different param names) shadow each
// other at the URL level and can't both live in one OpenAPI doc — report them
// (they're a real follow-up finding) before collapsing.
const collisions = findEquivalentPathCollisions(routes);
if (collisions.length) {
  console.log(
    `openapi: ${collisions.length} param-equivalent path collision(s) collapsed (URL-shadowing routes):`
  );
  for (const c of collisions.slice(0, 20))
    console.log(`  ${c.signature}  <-  ${c.paths.join(' , ')}`);
}

const { schemas: mergedSchemas, overlay } = mergeSchemaModules(OPENAPI_BASE.components.schemas);
const augmentedBase = {
  ...OPENAPI_BASE,
  components: { ...OPENAPI_BASE.components, schemas: mergedSchemas }
};
const doc = buildOpenApiDocument(routes, augmentedBase, overlay);

const outArg = process.argv.find(a => a.startsWith('--out='));
const outPath = outArg
  ? resolve(outArg.slice('--out='.length))
  : resolve(__dirname, '../src/docs/openapi.json');
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(
  `openapi: wrote ${routes.length} operations / ${Object.keys(doc.paths).length} paths -> ${outPath}`
);
process.exit(0);
