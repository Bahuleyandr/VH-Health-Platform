// Guardrail against the no-op wrapAutoRBAC footgun (3rd recurrence: CAN-003,
// HEAD-003, HEAD-006). wrapAutoRBAC(router, key, routeMap, opts) only attaches
// role middleware while iterating routeMap entries — so a call with an ABSENT or
// EMPTY ({}) routeMap (or a subrouter passed as the 1st arg with no routeMap)
// attaches NOTHING, silently leaving the routes ungated while LOOKING protected.
//
// This test statically scans every route file and fails if a wrapAutoRBAC call
// has an empty/absent routeMap and is not explicitly allowlisted. A new
// empty-routeMap call must EITHER use a real routeMap ({ use: [['/', r]] } / a
// method map), OR be added to ALLOWLIST below with justification that an explicit
// mount-level gate (requireRole / requireProductionInfrastructureAdmin) protects
// those routes. (We do NOT make wrapAutoRBAC throw, because the empty-map +
// explicit-mount-gate pattern is legitimate — e.g. the public auth module.)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, '../../routes');

// Allowlisted intentional empty-routeMap calls: "<relpath>::<configKey>".
// authenticationModule: auth/login/refresh routes are PUBLIC/self-authenticating
// (requiring a role would break login); RBAC is per-route inside the auth flow.
const ALLOWLIST = new Set([
  'auth/index.js::authenticationModule',
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Strip block + line comments so `wrapAutoRBAC(` mentioned in explanatory
// comments isn't mistaken for a real call. The line-comment pattern preserves
// `://` (URLs) by requiring the `//` not be preceded by ':'.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Extract the args text inside each `wrapAutoRBAC(...)` call (balanced parens,
// string-aware).
function extractCallArgs(rawSrc) {
  const src = stripComments(rawSrc);
  const calls = [];
  const token = 'wrapAutoRBAC(';
  let i = 0;
  while ((i = src.indexOf(token, i)) !== -1) {
    let j = i + token.length - 1; // index of '('
    const start = j;
    let depth = 0;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "'" || c === '"' || c === '`') {
        const q = c; j++;
        while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
    }
    calls.push(src.slice(start + 1, j));
    i = j + 1;
  }
  return calls;
}

// Split a call's arg list on top-level commas (string/bracket aware).
function splitTopLevel(s) {
  const args = [];
  let depth = 0, cur = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; cur += c; k++;
      while (k < s.length && s[k] !== q) { if (s[k] === '\\') { cur += s[k]; k++; } cur += s[k]; k++; }
      cur += s[k] ?? '';
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

describe('wrapAutoRBAC no-op guard', () => {
  it('no route file has an un-allowlisted empty/absent-routeMap wrapAutoRBAC call', () => {
    const offenders = [];
    for (const file of walk(ROUTES_DIR)) {
      const rel = path.relative(ROUTES_DIR, file).replace(/\\/g, '/');
      const src = fs.readFileSync(file, 'utf8');
      for (const argText of extractCallArgs(src)) {
        const args = splitTopLevel(argText);
        const configKey = (args[1] || '').replace(/['"`]/g, '').trim();
        const routeMapArg = args[2] || '';
        const opts = args[3] || '';
        // A call attaches RBAC only if its routeMap literally declares at least
        // one route-method / use entry (routeWrapper iterates those to attach
        // rbac). We therefore treat as a no-op anything that does NOT contain a
        // method/use key — this covers an absent 3rd arg, {}, spread-only objects
        // ({ ...{} }), AND a routeMap passed as a bare variable/identifier (which
        // we cannot statically verify is non-empty — flag it for review/allowlist
        // rather than trust it). Known residual: a literal { get: [] } with an
        // empty array would pass here but be a runtime no-op — exotic enough to
        // accept; routeWrapper's own routeMapHasEntries is the runtime backstop.
        const hasRouteEntries = /\b(get|post|put|patch|delete|all|use)\s*:/i.test(routeMapArg);
        const skipRBAC = /skipRBAC\s*:\s*true/.test(opts);
        if (!hasRouteEntries && !skipRBAC && !ALLOWLIST.has(`${rel}::${configKey}`)) {
          offenders.push(`${rel} :: wrapAutoRBAC('${configKey || '?'}') attaches NO RBAC (empty/absent/variable routeMap)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
