/**
 * Mount-level patientAccessGuard census — the durable gate for the
 * "guard that has never decided anything" class (re-audit 2026-08-23).
 *
 * THE DEFECT CLASS. app.js wraps routers in patientAccessGuard(...) at the
 * MOUNT. A mount-level middleware runs before Express matches a route inside
 * the router, so req.params is EMPTY there; when a route carries its patient
 * only in a path param (or carries no patient identifier at all),
 * resolvePatientForAccess finds nothing and authorizePatientAccessRequest
 * returns no_patient_context WITHOUT evaluating a policy — in shadow AND in
 * enforce. Those routes have never been policy-evaluated by their mount
 * guard. (Query/body identifiers ARE visible at mount time, and a mount path
 * that itself carries params — e.g. /api/v1/admissions/:admissionId/... —
 * DOES populate req.params for mount middleware; both are modelled below.)
 *
 * WHAT THIS TEST DOES.
 *  1. Parses src/app.js (comment- and regex-literal-aware) for every
 *     app.use(...) carrying patientAccessGuard / patientAccessGuardForPaths /
 *     patientAccessGuardForResource, or a local wrapper that delegates to one
 *     (clinicalParentPatientAccessGuard). Resolves each router argument
 *     through the import table — including NAMED imports, which is what the
 *     earlier quick script failed on: /api/v1/beds and /api/v1/wards come
 *     from `import { bedRouter, wardRouter } from './routes/bed/bedRoutes.js'`
 *     and were left UNRESOLVED-IMPORT there.
 *  2. Imports the real app and walks app.router.stack (same technique as
 *     phiMountAccessLogWiring.test.js): every mount found in text must have a
 *     matching runtime guard layer, and every top-level runtime guard layer
 *     must be accounted for by the text census. Router stacks are walked
 *     recursively, so barrel routers (routes/record/index.js,
 *     routes/pharmacy/index.js, …) and multiple mounts of one prefix
 *     (/api/v1/beds ×2, /api/v1/emr ×6, /api/v1/theatre ×2, /api/v1/lab ×2)
 *     are enumerated per (mount, router, recordType) pair.
 *  3. Classifies every route the guard scopes:
 *       param-only          patient identifier only in the ROUTE path
 *                           (:patientId/:patient_id/:patientUid/:patient_uid/
 *                           :uid) — invisible at mount time;
 *       query-body          the route's handler-chain source visibly reads a
 *                           resolver query/body patient key — the mount guard
 *                           CAN decide when the client sends it;
 *       no-patient-surface  neither — the guard can never see a patient here
 *                           (list/board/counter routes, or subject addressed
 *                           by a non-patient resource id such as a lab result
 *                           or schedule id).
 *     forPaths guards are first scoped by their path-matcher arrays (parsed
 *     element-wise from app.js, string AND regex elements); routes outside
 *     the matcher set are not that guard's problem. forResource guards that
 *     provably self-resolve (idSelector option, or idParam present in the
 *     mount path's own params) are treated as deciding for all routes.
 *
 * THE GATE. A (mount, router, recordType) pair is an OFFENDER when its guard
 * scopes at least one param-only or no-patient-surface route. Offenders MUST
 * be on the exemption list below with a stated reason — a NEW mount-level
 * guard over such a router fails this test. Exemptions for pairs that stop
 * being offenders (the Mounts phase moves guards into the routers) become
 * STALE and also fail, so the list shrinks to zero as fixes land (same
 * contract as tenantProvisioningRegistry.test.js). fixInFlight means a lane
 * is ACTIVELY converting that pair in the same change set; after the 2026-08
 * Mounts phase landed its 17 conversions, no entry below is in flight — the
 * remainder are FOLLOW-UPS, each stated as such in its reason. The marker is
 * a coordination hint — the stale-exemption failure is the enforcement.
 *
 * MEASURED FACTS (baseline census of 2026-08-26 on branch
 * fix/reaudit-m-mount-guards, taken BEFORE this lane's Mounts phase removed
 * 18 of these mount guards — the exemption list below is the live ledger):
 *   57 guard-carrying mounts; 944 routes walked; 56 of 57 pairs are
 *   offenders (the one clean pair is the forResource mount at
 *   /api/v1/admissions/:admissionId/tpa-enhancement, which resolves the
 *   admission from the mount param). 4 pairs run UNGOVERNED (legacy
 *   always-enforce — no careTeamModeGoverned option): /api/v1/records,
 *   /api/v1/clinical (wrapper), /api/v1/emr/mar, /api/v1/nursing/mar; mount
 *   replacements there must carry the mode decision deliberately.
 *
 * PARTIAL-RESOLVE SUB-CLASS (follow-up, NOT this lane): 27 of the 57 pairs
 * have at least one query/body-resolvable route ALONGSIDE undecided routes —
 * the guard really decides on some routes and silently passes others of the
 * same router (e.g. records: 4 query/body vs 17 undecided; clinicalRoutes:
 * 8 vs 18 on each of its three mounts; EMR CLINICAL_NOTE: 2 vs 11 in-scope).
 * The query-body evidence is a LOWER BOUND: handlers registered through
 * wrappers (e.g. wrapRoutesWithValidation in routes/investigation) hide
 * their source from Function.prototype.toString, so e.g. investigations
 * scans 0 query-body even though investigationController reads
 * req.query.patient_uid. That under-count only makes this gate stricter.
 *
 * Scope note: this census covers app.js app.use mounts (the audited class).
 * Router-INTERNAL `.use`-level guards (same empty-params hazard) are
 * collected as data during the walk and surfaced in failure diagnostics.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import app from '../../app.js';

const BACKEND_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_JS = path.join(BACKEND_SRC, 'app.js');

// ---------------------------------------------------------------------------
// Text side: comment- and regex-literal-aware scanning of src/app.js
// ---------------------------------------------------------------------------

/**
 * Blank comments (preserving offsets) while leaving strings AND regex
 * literals intact. Without the regex state, a matcher literal like
 * /^\/api\/v1\/emr\/\d+\//  reads as a line comment at its `\//` tail and
 * eats the rest of the line — which silently poisoned EMR_ADMISSION_PATHS in
 * the first cut of this census. `/` opens a regex only where the previous
 * non-whitespace char cannot end an expression.
 */
function blankComments(source) {
  const out = source.split('');
  let i = 0;
  let state = 'code'; // code | line | block | squote | dquote | template | regex
  let inClass = false;
  let prevNonWs = '';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (ch === '/' && (prevNonWs === '' || /[(,=:[!&|?{;+\-*%~^<>]/.test(prevNonWs))) {
        state = 'regex';
        inClass = false;
        i += 1; continue;
      }
      if (ch === "'") state = 'squote';
      else if (ch === '"') state = 'dquote';
      else if (ch === '`') state = 'template';
      if (!/\s/.test(ch)) prevNonWs = ch;
      i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') state = 'code';
      else out[i] = ' ';
      i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (ch !== '\n') out[i] = ' ';
      i += 1; continue;
    }
    if (state === 'regex') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { state = 'code'; prevNonWs = '/'; }
      else if (ch === '\n') { state = 'code'; } // was a division after all — bail
      i += 1; continue;
    }
    // inside a string literal
    if (ch === '\\') { i += 2; continue; }
    if ((state === 'squote' && ch === "'") || (state === 'dquote' && ch === '"') || (state === 'template' && ch === '`')) {
      state = 'code';
      prevNonWs = ch;
    }
    i += 1;
  }
  return out.join('');
}

/** From an opening bracket index, index just past the balanced close. */
function sliceBalanced(code, openIndex) {
  const open = code[openIndex];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  let i = openIndex;
  let state = 'code';
  while (i < code.length) {
    const ch = code[i];
    if (state === 'code') {
      if (ch === open) depth += 1;
      else if (ch === close) { depth -= 1; if (depth === 0) return i + 1; }
      else if (ch === "'") state = 'squote';
      else if (ch === '"') state = 'dquote';
      else if (ch === '`') state = 'template';
    } else {
      if (ch === '\\') { i += 2; continue; }
      if ((state === 'squote' && ch === "'") || (state === 'dquote' && ch === '"') || (state === 'template' && ch === '`')) state = 'code';
    }
    i += 1;
  }
  throw new Error(`census parser: unbalanced ${open} at offset ${openIndex} of app.js`);
}

/** Split call-args text at top-level commas (comment-blanked input). */
function splitTopLevel(argsText) {
  const parts = [];
  let depth = 0;
  let state = 'code';
  let start = 0;
  for (let i = 0; i < argsText.length; i += 1) {
    const ch = argsText[i];
    if (state === 'code') {
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      else if (ch === "'") state = 'squote';
      else if (ch === '"') state = 'dquote';
      else if (ch === '`') state = 'template';
      else if (ch === ',' && depth === 0) { parts.push(argsText.slice(start, i)); start = i + 1; }
    } else {
      if (ch === '\\') { i += 1; continue; }
      if ((state === 'squote' && ch === "'") || (state === 'dquote' && ch === '"') || (state === 'template' && ch === '`')) state = 'code';
    }
  }
  parts.push(argsText.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function firstStringLiteral(text) {
  const m = text.match(/['"]([^'"]*)['"]/);
  return m ? m[1] : null;
}

function parseImports(code) {
  const map = new Map(); // local identifier -> { spec, imported }
  const re = /import\s+([^;]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const clause = m[1].trim();
    const spec = m[2];
    const named = clause.match(/\{([^}]*)\}/);
    const withoutNamed = clause.replace(/\{[^}]*\}/, '').trim();
    const star = withoutNamed.match(/\*\s+as\s+([A-Za-z0-9_$]+)/);
    if (star) map.set(star[1], { spec, imported: '*' });
    const def = withoutNamed.replace(/\*\s+as\s+[A-Za-z0-9_$]+/, '').replace(/,/g, ' ').trim();
    if (def && /^[A-Za-z0-9_$]+$/.test(def)) map.set(def, { spec, imported: 'default' });
    if (named) {
      for (const piece of named[1].split(',')) {
        const p = piece.trim();
        if (!p) continue;
        const asMatch = p.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
        if (asMatch) map.set(asMatch[2], { spec, imported: asMatch[1] });
        else if (/^[A-Za-z0-9_$]+$/.test(p)) map.set(p, { spec, imported: p });
      }
    }
  }
  return map;
}

const GUARD_CALL_RE = /\bpatientAccessGuard(ForPaths|ForResource)?\s*\(/;

/** Local identifiers in app.js whose definition wraps patientAccessGuard. */
function findLocalGuardWrappers(code) {
  const wrappers = new Map(); // name -> body text
  const scan = (re) => {
    let m;
    while ((m = re.exec(code)) !== null) {
      const bodyOpen = code.indexOf('{', m.index + m[0].length - 1);
      const end = sliceBalanced(code, bodyOpen);
      const body = code.slice(bodyOpen, end);
      if (GUARD_CALL_RE.test(body)) wrappers.set(m[1], body);
    }
  };
  scan(/function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/g);
  scan(/const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{/g);
  return wrappers;
}

/**
 * const NAME = [ ... ] path-matcher arrays, parsed ELEMENT-WISE: each
 * top-level element must be a string literal or a regex literal; anything
 * else poisons the array so a forPaths lookup fails LOUDLY (null matchers
 * assert below) instead of silently mis-scoping a guard.
 */
function findPathArrayConsts(code) {
  const map = new Map();
  const re = /const\s+([A-Za-z0-9_$]+)\s*=\s*\[/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf('[', m.index + m[0].length - 1);
    const end = sliceBalanced(code, open);
    const body = code.slice(open + 1, end - 1);
    const matchers = [];
    let poisoned = false;
    for (const el of splitTopLevel(body)) {
      const str = el.match(/^['"]([^'"]*)['"]$/);
      if (str) { matchers.push(str[1]); continue; }
      const rx = el.match(/^\/((?:[^/\\\n]|\\.)+)\/([a-z]*)$/);
      if (rx) {
        try { matchers.push(new RegExp(rx[1], rx[2])); continue; } catch { poisoned = true; break; }
      }
      poisoned = true;
      break;
    }
    if (!poisoned && matchers.length > 0) map.set(m[1], matchers);
  }
  return map;
}

function extractMounts(rawSource) {
  const code = blankComments(rawSource);
  const imports = parseImports(code);
  const wrappers = findLocalGuardWrappers(code);
  const pathArrays = findPathArrayConsts(code);
  const mounts = [];
  const useRe = /\bapp\.use\s*\(/g;
  let m;
  while ((m = useRe.exec(code)) !== null) {
    const open = code.indexOf('(', m.index + m[0].length - 1);
    const end = sliceBalanced(code, open);
    const args = splitTopLevel(code.slice(open + 1, end - 1));
    if (args.length === 0) continue;

    let guard = null;
    let guardArgIndex = -1;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      const call = arg.match(GUARD_CALL_RE);
      if (call && /^patientAccessGuard(?:ForPaths|ForResource)?\s*\(/.test(arg)) {
        const variant = call[1] === 'ForPaths' ? 'forPaths' : call[1] === 'ForResource' ? 'forResource' : 'plain';
        const callOpen = arg.indexOf('(');
        const callEnd = sliceBalanced(arg, callOpen);
        const callArgs = splitTopLevel(arg.slice(callOpen + 1, callEnd - 1));
        guard = {
          variant,
          recordType: firstStringLiteral(callArgs[0] ?? '') ?? null,
          optionsText: callArgs.slice(1).join(','),
          pathMatchers: variant === 'forPaths' ? (pathArrays.get((callArgs[1] ?? '').trim()) ?? null) : null,
          wrapperName: null,
        };
        guardArgIndex = i;
        break;
      }
      if (wrappers.has(arg)) {
        // recordType comes from the INNER patientAccessGuard(...) call the
        // wrapper delegates to, not from unrelated literals in its body.
        const body = wrappers.get(arg);
        const innerAt = body.search(GUARD_CALL_RE);
        let innerRecordType = null;
        let innerOptions = '';
        if (innerAt >= 0) {
          const innerOpen = body.indexOf('(', innerAt);
          const innerEnd = sliceBalanced(body, innerOpen);
          const innerArgs = splitTopLevel(body.slice(innerOpen + 1, innerEnd - 1));
          innerRecordType = firstStringLiteral(innerArgs[0] ?? '');
          innerOptions = innerArgs.slice(1).join(',');
        }
        guard = { variant: 'wrapper', recordType: innerRecordType, optionsText: innerOptions, pathMatchers: null, wrapperName: arg };
        guardArgIndex = i;
        break;
      }
    }
    if (!guard) continue;

    const mountPath = /^['"]/.test(args[0]) ? firstStringLiteral(args[0]) : null;
    // A phiContext BRIDGE is middleware mounted BEFORE the guard whose module
    // writes req.phiContext (fhirPatientContext translating FHIR path/query/
    // body addressing) — it can hand the mount guard a patient the generic
    // resolver would never see.
    const bridgeIdents = args.slice(1, guardArgIndex)
      .filter((a) => /^[A-Za-z0-9_$]+$/.test(a))
      .filter((a) => {
        const imp = imports.get(a);
        if (!imp || !imp.spec.startsWith('./')) return false;
        const abs = path.join(BACKEND_SRC, imp.spec.replace(/^\.\//, ''));
        if (!fs.existsSync(abs)) return false;
        return /req\.phiContext\s*=/.test(fs.readFileSync(abs, 'utf8'));
      });
    const routerIdents = args.slice(guardArgIndex + 1)
      .filter((a) => /^[A-Za-z0-9_$]+$/.test(a))
      .filter((a) => {
        const imp = imports.get(a);
        return imp && /routes/.test(imp.spec);
      });
    mounts.push({
      mountPath,
      mountParams: mountPath ? [...mountPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((x) => x[1]) : [],
      guard,
      governed: /careTeamModeGoverned\s*:\s*true/.test(guard.optionsText ?? ''),
      bridgeIdents,
      routerIdents,
      routerImports: routerIdents.map((r) => ({ ident: r, ...imports.get(r) })),
    });
  }
  return { mounts, wrappers };
}

// ---------------------------------------------------------------------------
// Runtime side: walk the real app's router stack
// ---------------------------------------------------------------------------

function guardVariantOfHandle(handle, wrapperNames) {
  if (typeof handle !== 'function') return null;
  if (handle.name === 'patientAccessGuardMiddleware') return 'plain';
  if (handle.name === 'patientAccessGuardForResourceMiddleware') return 'forResource';
  if (wrapperNames.has(handle.name)) return 'wrapper';
  let src = '';
  try { src = String(handle); } catch { return null; }
  if (src.includes('shouldLogPhiAccessPath') && src.includes('guardMiddleware(')) return 'forPaths';
  return null;
}

/**
 * Recursively enumerate a router's routes. Nested sub-router prefixes are not
 * recoverable from router@2 layers (matchers close over the compiled path),
 * so they render as '<nested>'. That cannot weaken the gate: a prefix can
 * only ADD path params, and path params never make a route resolvable at
 * mount time — ignoring them can only shift a route between the two
 * undecided classes, never out of them.
 */
function walkRouter(routerHandle, wrapperNames, prefix = '') {
  const routes = [];
  const internalUseGuards = [];
  for (const layer of routerHandle.stack ?? []) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods).filter((k) => k !== '_all');
      const chain = (layer.route.stack ?? []).map((l) => l.handle);
      for (const p of paths) {
        routes.push({
          path: `${prefix}${typeof p === 'string' ? p : '<regex>'}`,
          methods,
          chainSources: chain.map((h) => { try { return String(h); } catch { return ''; } }),
          perRouteGuard: chain.some((h) => guardVariantOfHandle(h, wrapperNames) !== null),
        });
      }
    } else if (typeof layer.handle === 'function' && Array.isArray(layer.handle.stack)) {
      const nested = walkRouter(layer.handle, wrapperNames, `${prefix}<nested>`);
      routes.push(...nested.routes);
      internalUseGuards.push(...nested.internalUseGuards);
    } else if (guardVariantOfHandle(layer.handle, wrapperNames) !== null) {
      internalUseGuards.push({ prefix: prefix || '/', variant: guardVariantOfHandle(layer.handle, wrapperNames) });
    }
  }
  return { routes, internalUseGuards };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

// Param names resolvePatientForAccess / requestedPatientToken read from
// req.params (services/security/accessDecisionService.js).
const PATIENT_PARAM_NAMES = new Set(['patientId', 'patient_id', 'patientUid', 'patient_uid', 'uid']);
// Resolver query/body keys. Bare `phone` is deliberately excluded — any
// staff-phone destructure would count as false evidence, and excluding it
// only makes the gate stricter.
const QUERY_BODY_KEYS = ['patient_uid', 'patientUid', 'patientId', 'patient_id', 'patient_phone', 'patientPhone'];

function hasQueryBodyEvidence(chainSources) {
  const joined = chainSources.join('\n');
  return QUERY_BODY_KEYS.some((key) => (
    new RegExp(`req\\s*\\.\\s*(?:query|body)\\s*(?:\\?\\.|\\.|\\[)\\s*['"]?${key}\\b`).test(joined)
    || new RegExp(`\\{[^{}]*\\b${key}\\b[^{}]*\\}\\s*=\\s*req\\s*(?:\\?\\.|\\.)\\s*(?:query|body)\\b`, 's').test(joined)
  ));
}

function routeParams(routePath) {
  return [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

function pathMatchesPrefix(p, prefix) {
  return p === prefix || p.startsWith(`${prefix}/`);
}

function inForPathsScope(fullPath, matchers) {
  const lc = fullPath.toLowerCase();
  return matchers.some((mm) => (mm instanceof RegExp ? mm.test(lc) : pathMatchesPrefix(lc, mm)));
}

function classifyRoute(mount, route) {
  if (mount.mountParams.some((p) => PATIENT_PARAM_NAMES.has(p))) return 'query-body'; // mount-path patient param IS visible at mount
  if (routeParams(route.path).some((p) => PATIENT_PARAM_NAMES.has(p))) return 'param-only';
  if (hasQueryBodyEvidence(route.chainSources)) return 'query-body';
  return 'no-patient-surface';
}

function forResourceSelfResolves(mount) {
  const opts = mount.guard.optionsText ?? '';
  if (/idSelector\s*:/.test(opts)) return true;
  const idParamMatch = opts.match(/idParam\s*:\s*['"]([A-Za-z0-9_]+)['"]/);
  const idParam = idParamMatch ? idParamMatch[1] : 'id';
  return mount.mountParams.includes(idParam);
}

// ---------------------------------------------------------------------------
// Build the census once
// ---------------------------------------------------------------------------

function buildCensus() {
  const raw = fs.readFileSync(APP_JS, 'utf8');
  const { mounts, wrappers } = extractMounts(raw);
  const wrapperNames = new Set(wrappers.keys());
  const stack = app.router.stack;

  const runtimeGuardLayerCount = stack.filter((l) => guardVariantOfHandle(l.handle, wrapperNames) !== null).length;

  const mountLayersAt = (mountPath) => {
    const substituted = mountPath.replace(/:[A-Za-z0-9_]+/g, '__p__');
    const probe = `${substituted}/__census_probe__`;
    return stack
      .map((layer, index) => ({ layer, index }))
      .filter(({ layer }) => layer.matchers?.some((mm) => {
        const r = mm(probe);
        return r && r.path === substituted;
      }));
  };

  // Group runtime layers at each mount path into guard->routers pairs, in
  // stack order (app.use order), then zip with the text mounts of that path.
  const runtimePairsByPath = new Map();
  const textByPath = new Map();
  for (const mt of mounts) {
    if (!textByPath.has(mt.mountPath)) textByPath.set(mt.mountPath, []);
    textByPath.get(mt.mountPath).push(mt);
    if (!runtimePairsByPath.has(mt.mountPath)) {
      const pairs = [];
      let current = null;
      for (const e of mountLayersAt(mt.mountPath)) {
        const variant = guardVariantOfHandle(e.layer.handle, new Set(wrappers.keys()));
        if (variant !== null) { current = { variant, routers: [] }; pairs.push(current); continue; }
        if (typeof e.layer.handle === 'function' && Array.isArray(e.layer.handle.stack)) {
          if (current) current.routers.push(e.layer.handle);
        }
      }
      runtimePairsByPath.set(mt.mountPath, pairs);
    }
  }

  const pairs = [];
  const associationErrors = [];
  for (const [mountPath, textMounts] of textByPath) {
    const runtimePairs = runtimePairsByPath.get(mountPath) ?? [];
    if (runtimePairs.length !== textMounts.length) {
      associationErrors.push(`${mountPath}: text census sees ${textMounts.length} guard mount(s), runtime stack has ${runtimePairs.length}`);
      continue;
    }
    for (let i = 0; i < textMounts.length; i += 1) {
      const mt = textMounts[i];
      const rt = runtimePairs[i];
      if (rt.variant !== mt.guard.variant) {
        associationErrors.push(`${mountPath}[${i}]: text variant ${mt.guard.variant} != runtime variant ${rt.variant}`);
      }
      const allRoutes = [];
      const internalUseGuards = [];
      for (const r of rt.routers) {
        const w = walkRouter(r, wrapperNames);
        allRoutes.push(...w.routes);
        internalUseGuards.push(...w.internalUseGuards);
      }
      let inScope = allRoutes;
      let outOfScope = [];
      if (mt.guard.variant === 'forPaths') {
        if (mt.guard.pathMatchers === null) {
          associationErrors.push(`${mountPath}[${i}] (${mt.guard.recordType}): forPaths matcher array did not parse — census cannot scope this guard`);
        } else {
          inScope = allRoutes.filter((r) => inForPathsScope(`${mountPath}${r.path === '/' ? '' : r.path.replaceAll('<nested>', '')}`, mt.guard.pathMatchers));
          outOfScope = allRoutes.filter((r) => !inScope.includes(r));
        }
      }
      const byClass = { 'param-only': [], 'query-body': [], 'no-patient-surface': [] };
      for (const r of inScope) byClass[classifyRoute(mt, r)].push(r);
      const selfResolves = mt.guard.variant === 'forResource' && forResourceSelfResolves(mt);
      const undecided = selfResolves ? [] : [...byClass['param-only'], ...byClass['no-patient-surface']];
      pairs.push({
        key: `${mountPath} :: ${mt.routerImports.map((r) => `${r.spec}#${r.imported}`).join('+')} :: ${mt.guard.recordType}`,
        mountPath,
        routerImports: mt.routerImports,
        recordType: mt.guard.recordType,
        variant: mt.guard.variant,
        governed: mt.governed,
        bridgeIdents: mt.bridgeIdents,
        routes: allRoutes,
        inScope,
        outOfScope,
        byClass,
        internalUseGuards,
        selfResolves,
        undecided,
        offender: undecided.length > 0,
      });
    }
  }

  return { mounts, pairs, associationErrors, runtimeGuardLayerCount, wrapperNames };
}

const CENSUS = buildCensus();

// ---------------------------------------------------------------------------
// Exemption list — CURRENT offenders, each with a stated reason.
//
// Key format: '<mountPath> :: <routerSpec>#<importedName> :: <recordType>'.
// fixInFlight marks a pair a lane is converting IN ITS OWN change set (none
// today); when a lane lands and the mount guard leaves
// app.js, the pair stops being an offender, its entry turns STALE, and the
// stale-exemption test fails until the entry is deleted. That failure is the
// designed hand-off — delete the entry in the same change that moves the
// guard. Counts quoted in reasons are the 2026-08-26 census (prose, not
// assertions; the offender/stale sets are what is machine-checked).
// ---------------------------------------------------------------------------

const EXEMPT_MOUNT_PAIR_ENTRIES = [
  ['/api/v1/records :: ./routes/record/index.js#default :: MEDICAL_RECORD',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): Barrel router: 4 param-only reads (/uid/:uid, /patient/:patient_id…) and 13 no-surface routes vs 4 query/body-resolvable; UNGOVERNED legacy-enforce mount — replacement per-route guards must carry the mode decision deliberately.' }],
  ['/api/v1/beds :: ./routes/bed/bedRoutes.js#bedRouter :: BED_BOARD',
    { fixInFlight: false, reason: 'Board/master-data router (NAMED import — the census regression the quick script missed). No single-patient subject on any route; patient-linked writes already carry patientAccessGuardForResource in-router (guardBedWrite/guardBedAdmitPatient). Right shape: role gate at mount, guards stay in-router.' }],
  ['/api/v1/beds :: ./routes/bed/bedManagementRoutes.js#default :: BED_MANAGEMENT',
    { fixInFlight: false, reason: 'Occupancy/availability boards + discharge/transfer ops addressed by bed :id; 3 routes already carry in-router resource guards. Mount guard has never decided here.' }],
  ['/api/v1/wards :: ./routes/bed/bedRoutes.js#wardRouter :: WARD_BOARD',
    { fixInFlight: false, reason: 'Ward CRUD board (NAMED import wardRouter); no patient subject exists on any route — mount guard can never decide; role gate is the control.' }],
  ['/api/v1/fhir :: ./routes/fhir/fhirRoutes.js#default :: FHIR_RESOURCE',
    { fixInFlight: false, reason: 'PERMANENT-SHAPE exemption: fhirPatientContext (a req.phiContext bridge, detected pre-guard) translates FHIR path/query/body addressing so the mount guard CAN resolve; requireFhirSearchPatientContext denies unscoped searches; residual no-context routes (e.g. /metadata) are the documented pass-through.' }],
  ['/api/v1/clinical :: ./routes/clinical/clinicalRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'clinicalParentPatientAccessGuard wrapper (progress-notes bypass) — UNGOVERNED legacy-enforce; 20 of 26 routes already carry per-route guards (CAN-013/014 era); undecided remainder is 4 param-only + 14 no-surface. Mount removal must preserve the wrapper’s appointment-scoped bypass semantics.' }],
  ['/api/v1/encounters :: ./routes/clinical/encounterRoutes.js#default :: CLINICAL_ENCOUNTER',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): 10 of 12 routes already carry per-route guards; the undecided set is :id reads/templates/downtime-policy utilities. Mount guard never decides — remove after covering the 2 unguarded routes appropriately.' }],
  ['/api/v1/burns :: ./routes/clinical/burnRoutes.js#default :: BURN_CHART',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): Charts addressed by chart :id (8 no-surface routes); selectors must resolve chart→patient tenant-scoped; GET /charts list keeps role gate only.' }],
  ['/api/v1/emr/mar :: ./routes/clinical/clinicalRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'MAR discoverability alias of clinicalRoutes (rewriteToMarPrefix) — UNGOVERNED legacy-enforce; same undecided census as /api/v1/clinical; all three clinicalRoutes mounts go stale together when the guard moves in-router.' }],
  ['/api/v1/nursing/mar :: ./routes/clinical/clinicalRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'Second MAR alias of clinicalRoutes — see /api/v1/emr/mar; identical undecided census, UNGOVERNED legacy-enforce.' }],
  ['/api/v1/problems :: ./routes/clinical/problemListRoutes.js#default :: PROBLEM_LIST',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): All 5 routes already per-route guarded in-router; mount guard is redundant and undecided on 4 of 5 (param-only /patient/:patientUid + :id writes). Mount removal only.' }],
  ['/api/v1/allergies :: ./routes/clinical/allergyRoutes.js#default :: ALLERGY',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): Single route GET /patient/:patientUid/unified is param-only and ALREADY carries its own per-route guard; the mount guard has never decided anything on this router.' }],
  ['/api/v1/bcma :: ./routes/clinical/bcmaRoutes.js#default :: BCMA',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): The reference pattern lives here: guardWristbandView per-route guard is the authority (owner’s 2026-08-25 admin grant on PATIENT_WRISTBAND_PRINT); the mount guard sees no :patientUid and is documented in app.js as never firing. Mount removal only.' }],
  ['/api/v1/med-rec :: ./routes/clinical/medRecRoutes.js#default :: MED_REC',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): All 5 routes already per-route guarded; mount guard undecided on the 4 param-only/:id routes. Mount removal only.' }],
  ['/api/v1/pacs :: ./routes/radiology/pacsRoutes.js#default :: RADIOLOGY_PACS',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): studies/patient/:patientUid is param-only (per-route guarded already, as is order link); /config and /worklist have no single subject — role gate suffices there.' }],
  ['/api/v1/research :: ./routes/research/researchRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'Registry/forms surface addressed by registry :id; enrolment carries patient in body (1 query/body route measured). Needs a design pass on which routes have a single patient subject before selectors are written.' }],
  ['/api/v1/radiation-oncology :: ./routes/clinical/radiationOncologyRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'Specialty workflow addressed by referral/plan :id (14 no-surface); dept-gated at mount (specialtyDepartmentGuard). Selector fixes = resolve referral/plan→patient; settings/worklist keep role+dept gates.' }],
  ['/api/v1/transplant :: ./routes/transplant/transplantRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'Program/candidate workflow (10 no-surface routes addressed by candidate :id or program-level); dept-gated. Same selector recipe as radiation-oncology when its lane runs.' }],
  ['/api/v1/dental :: ./routes/clinical/dentalRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'patients/:uid chart+procedures are param-only; findings/procedures transitions by :id; 2 query/body routes measured. Dept-gated elective module per the dept-gating design.' }],
  ['/api/v1/ophthalmology :: ./routes/clinical/ophthalmologyRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'patients/:uid/history param-only; exam sub-writes by exam :id (4 no-surface). Dept-gated elective module; selector recipe: exam→patient.' }],
  ['/api/v1/physio :: ./routes/clinical/physioRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'patients/:uid/summary param-only; assessments/plans created with patient in body outside resolver keys; worklist has no subject.' }],
  ['/api/v1/emr :: ./routes/emr/clinicalNotesRoutes.js#default :: CLINICAL_NOTE',
    { fixInFlight: false, reason: 'forPaths guard (notes/timeline/downtime-snapshot): 3 param-only + 8 no-surface in scope; 13/13 routes already carry per-route guards — the mount layer is the redundant undecided one.' }],
  ['/api/v1/emr :: ./routes/emr/admissionRoutes.js#default :: ADMISSION',
    { fixInFlight: false, reason: 'forPaths guard: 7 routes in matcher scope (46 out of scope by design), 1 param-only + 6 no-surface (command-board has no single subject). Numeric-prefix regex matcher parses element-wise — poisoning fails loud.' }],
  ['/api/v1/emr :: ./routes/emr/orderRoutes.js#default :: CLINICAL_ORDER',
    { fixInFlight: false, reason: 'forPaths guard: order transitions address orders by :id (19 no-surface); 8 routes per-route guarded already; bulk create resolves from body payloads outside resolver keys.' }],
  ['/api/v1/emr :: ./routes/emr/vitalsRoutes.js#default :: VITAL_SIGN',
    { fixInFlight: false, reason: 'forPaths guard: 5 param-only vitals/io reads (all 9 in-scope routes already per-route guarded). Mount layer redundant and undecided.' }],
  ['/api/v1/emr :: ./routes/emr/cdsRoutes.js#default :: CLINICAL_DECISION',
    { fixInFlight: false, reason: 'forPaths guard: cds alerts/protocols per patient are param-only (2); acknowledge by alert :id; protocols list has no subject.' }],
  ['/api/v1/emr :: ./routes/emr/diagnosisRoutes.js#default :: DIAGNOSIS',
    { fixInFlight: false, reason: 'forPaths guard: diagnosis/patient/:uid reads param-only (2); status updates by diagnosis :id; encounter-scoped read has no direct patient key.' }],
  ['/api/v1/radiology :: ./routes/radiology/radiologyRoutes.js#default :: RADIOLOGY',
    { fixInFlight: false, reason: 'patient/:uid read param-only; worklist/templates/peer-reviews and report writes by :id (13 no-surface). Selector recipe: study/report→patient.' }],
  ['/api/v1/dietary :: ./routes/dietary/dietaryRoutes.js#default :: CLINICAL_WORKFLOW',
    { fixInFlight: false, reason: 'patient/:uid read param-only; menu-items master data and worklist have no subject (9 no-surface).' }],
  ['/api/v1/ctvs :: ./routes/theatre/ctvsPerfusionRoutes.js#default :: CTVS_PERFUSION',
    { fixInFlight: false, reason: 'Perfusion records/signoffs by :id or OT schedule id (6 no-surface); 2 query/body routes measured. Selector recipe: record/schedule→patient.' }],
  ['/api/v1/surgical :: ./routes/admin/surgicalDocumentationRoutes.js#default :: SURGICAL_DOCUMENTATION',
    { fixInFlight: false, reason: 'Pre/intra/post-op docs addressed by schedule :id (19 no-surface); 2 query/body routes measured. Selector recipe: schedule→patient.' }],
  ['/api/v1/microbiology :: ./routes/lab/microbiologyRoutes.js#default :: MICROBIOLOGY',
    { fixInFlight: false, reason: 'Orders workflow addressed by order :id (8 no-surface). Selector recipe: order→patient; list keeps role gate.' }],
  ['/api/v1/stroke-pathway :: ./routes/clinical/strokePathwayRoutes.js#default :: STROKE_PATHWAY',
    { fixInFlight: false, reason: 'Acute pathway activations by :id + settings (9 no-surface). Acute modules stay care-team-governed per the dept-gating decision; selectors resolve activation→patient.' }],
  ['/api/v1/stemi-pathway :: ./routes/clinical/stemiPathwayRoutes.js#default :: STEMI_PATHWAY',
    { fixInFlight: false, reason: 'Mirror of stroke-pathway: activations by :id + settings (9 no-surface).' }],
  ['/api/v1/blood-bank :: ./routes/bloodbank/bloodBankRoutes.js#default :: BLOOD_BANK',
    { fixInFlight: false, reason: 'Donor/inventory surfaces have no patient subject; transfusion/crossmatch routes address requests by :id (26 no-surface; 1 query/body measured). Selector recipe: request→patient.' }],
  ['/api/v1/lab :: ./routes/lab/labPanelRoutes.js#default :: LAB_RESULT',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): panels/patient/:patientUid and trends/:patientUid/:testCode are param-only; panel CRUD by :panelId (4 no-surface).' }],
  ['/api/v1/paediatric :: ./routes/paediatric/paediatricImmunisationRoutes.js#default :: PAEDIATRIC_IMMUNISATION',
    { fixInFlight: false, reason: 'FOLLOW-UP (not converted by the 2026-08 lane): immunisations/patient/:patientUid(+/due) are param-only; catalogue/seed are master data with no subject.' }],
  ['/api/v1/referrals :: ./routes/referral/referralRoutes.js#default :: REFERRAL',
    { fixInFlight: false, reason: 'patient/:uid read param-only; incoming/outgoing worklists have no subject; referral transitions by :id (17 no-surface; 2 query/body measured). NOTE: this mount carries no requireRole — roles are enforced per-handler inside the router — so after the swap the per-route patient guards are the only patient-access control on this surface.' }],
];

const EXEMPT_MOUNT_PAIRS = new Map();
for (const [key, entry] of EXEMPT_MOUNT_PAIR_ENTRIES) {
  if (EXEMPT_MOUNT_PAIRS.has(key)) throw new Error(`duplicate exemption key: ${key}`);
  EXEMPT_MOUNT_PAIRS.set(key, entry);
}

function describePair(p) {
  const c = p.byClass;
  const examples = p.undecided.slice(0, 3).map((r) => `${r.methods.join('|').toUpperCase()} ${r.path}`).join(', ');
  const internal = p.internalUseGuards.length > 0 ? `; router-internal use-level guards: ${p.internalUseGuards.length}` : '';
  return `${p.key} [${p.variant}${p.governed ? '' : ', UNGOVERNED'}] — in-scope ${p.inScope.length} (param-only ${c['param-only'].length}, query/body ${c['query-body'].length}, no-surface ${c['no-patient-surface'].length}); e.g. ${examples || '(none)'}${internal}`;
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe('mount-level patientAccessGuard census — the durable gate', () => {
  it('parses app.js and matches the runtime stack (the enumeration is not silently empty or drifting)', () => {
    // Both directions: every text mount has its runtime guard layer at the
    // same path in the same order/variant, and no top-level guard layer
    // exists that the text census did not see.
    expect(CENSUS.associationErrors).toEqual([]);
    expect(CENSUS.pairs.length).toBe(CENSUS.mounts.length);
    expect(CENSUS.runtimeGuardLayerCount).toBe(CENSUS.mounts.length);
    // Anchors that survive the Mounts phase (their guards are correct where
    // they are), so this census can never quietly parse to nothing: the
    // bridged FHIR mount and the self-resolving forResource mount.
    expect(CENSUS.pairs.some((p) => p.mountPath === '/api/v1/fhir' && p.variant === 'plain')).toBe(true);
    expect(CENSUS.pairs.some((p) => p.variant === 'forResource' && p.mountPath.includes(':admissionId'))).toBe(true);
    // Every censused mount resolved at least one router import, and every
    // walked router yielded routes.
    for (const p of CENSUS.pairs) {
      expect(p.routerImports.length).toBeGreaterThan(0);
      expect(p.routes.length).toBeGreaterThan(0);
    }
  });

  it('resolves routers reached through NAMED imports (the beds/wards gap the quick script left UNRESOLVED-IMPORT)', () => {
    const keys = CENSUS.pairs.map((p) => p.key);
    expect(keys).toContain('/api/v1/beds :: ./routes/bed/bedRoutes.js#bedRouter :: BED_BOARD');
    expect(keys).toContain('/api/v1/beds :: ./routes/bed/bedManagementRoutes.js#default :: BED_MANAGEMENT');
    expect(keys).toContain('/api/v1/wards :: ./routes/bed/bedRoutes.js#wardRouter :: WARD_BOARD');
  });

  it('handles barrel routers, multiple mounts of one prefix, and local guard wrappers', () => {
    // Multiple mounts of one prefix: two distinct guarded routers at
    // /api/v1/beds, six forPaths families at /api/v1/emr. The two /api/v1/theatre
    // mounts moved their guards in-router in the 2026-08 Mounts phase, so that
    // prefix is pinned to ZERO mount-level guards — a re-added one fails here
    // as well as at the GATE.
    expect(CENSUS.pairs.filter((p) => p.mountPath === '/api/v1/beds').length).toBe(2);
    expect(CENSUS.pairs.filter((p) => p.mountPath === '/api/v1/theatre').length).toBe(0);
    expect(CENSUS.pairs.filter((p) => p.mountPath === '/api/v1/emr' && p.variant === 'forPaths').length).toBe(6);
    // Barrel/nested routers walk recursively. Pinned against ANY pair that
    // exhibits nesting rather than one named mount: this pin has already
    // broken once by anchoring on cath-lab (converted by the 2026-08 lane)
    // and would break again on records when its follow-up lands. The
    // invariant is that the walker sees THROUGH barrels, not that any
    // particular barrel stays unconverted forever.
    const nestedBarrels = CENSUS.pairs.filter((p) =>
      p.routes.some((r) => r.path.includes('<nested>')));
    expect(nestedBarrels.length).toBeGreaterThan(0);
    // The clinicalParentPatientAccessGuard wrapper is a census entry with the
    // record type of the guard it delegates to.
    const wrapperPair = CENSUS.pairs.find((p) => p.mountPath === '/api/v1/clinical');
    expect(wrapperPair).toBeDefined();
    expect(wrapperPair.variant).toBe('wrapper');
    expect(wrapperPair.recordType).toBe('CLINICAL_WORKFLOW');
    // One router mounted under multiple prefixes: clinicalRoutes carries its
    // census at /api/v1/clinical and both MAR aliases.
    const clinicalMounts = CENSUS.pairs.filter((p) => p.routerImports.some((r) => r.spec === './routes/clinical/clinicalRoutes.js'));
    expect(clinicalMounts.map((p) => p.mountPath).sort()).toEqual(['/api/v1/clinical', '/api/v1/emr/mar', '/api/v1/nursing/mar']);
  });

  it('scopes forPaths guards by their parsed matcher arrays (string AND regex elements)', () => {
    for (const p of CENSUS.pairs.filter((x) => x.variant === 'forPaths')) {
      // A matcher array that fails to parse lands in associationErrors; here
      // we additionally pin that scoping does real work where the router is
      // wider than the guard: the ADMISSION family's router carries many
      // routes the matcher list deliberately excludes.
      expect(p.inScope.length).toBeGreaterThan(0);
    }
    const admission = CENSUS.pairs.find((p) => p.variant === 'forPaths' && p.recordType === 'ADMISSION');
    expect(admission).toBeDefined();
    expect(admission.outOfScope.length).toBeGreaterThan(0);
  });

  it('treats a forResource guard whose selector runs off the mount path params as deciding (the one clean mount)', () => {
    const tpa = CENSUS.pairs.find((p) => p.variant === 'forResource');
    expect(tpa).toBeDefined();
    expect(tpa.mountPath).toBe('/api/v1/admissions/:admissionId/tpa-enhancement');
    expect(tpa.selfResolves).toBe(true);
    expect(tpa.offender).toBe(false);
  });

  it('GATE: no mount-level patientAccessGuard covers a router with mount-undecidable routes without an exemption', () => {
    const unexempted = CENSUS.pairs
      .filter((p) => p.offender)
      .filter((p) => !EXEMPT_MOUNT_PAIRS.has(p.key))
      .map(describePair);
    // A new entry here means a mount-level guard was added (or re-shaped)
    // over routes it can never decide: either move the guard into the router
    // with a per-route patientSelector (bcmaRoutes guardWristbandView /
    // abdmHiuRoutes are the reference), or exempt it above WITH a reason.
    expect(unexempted).toEqual([]);
  });

  it('fails on stale exemptions so the list shrinks to zero as the Mounts phase lands', () => {
    const offenderKeys = new Set(CENSUS.pairs.filter((p) => p.offender).map((p) => p.key));
    const stale = [...EXEMPT_MOUNT_PAIRS.keys()].filter((key) => !offenderKeys.has(key));
    // A stale exemption is a licence for the next mount-level guard to slip
    // through unread — delete the entry in the change that removed its mount
    // guard (this failure is the designed hand-off, not a regression).
    expect(stale).toEqual([]);
  });

  it('states a substantive reason for every exemption', () => {
    for (const [key, entry] of EXEMPT_MOUNT_PAIRS) {
      expect(key).toMatch(/^\/api\/v1\/[^ ]+ :: \.\/routes\/[^ ]+#[A-Za-z0-9_$*]+ :: [A-Z0-9_]+$/);
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.trim().length).toBeGreaterThan(25);
      expect(typeof entry.fixInFlight).toBe('boolean');
    }
  });
});
