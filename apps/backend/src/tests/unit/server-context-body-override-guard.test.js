// Guardrail against the server-context body-override footgun (Sol Ultra audit
// 2026-07-11, systemic finding; delta reviews LD-RRB-01, NICU/PICU, ambulance).
//
// Route handlers build a service-input object like:
//     svc.create({ tenantId: tenantOf(req), actorUid: req.user?.uid, ...req.body })
// JavaScript's LAST property wins, so spreading `...req.body` AFTER a
// server-derived field (tenant, authenticated actor, or a route-param id) lets a
// caller override that trusted value from the JSON body — selecting another
// tenant, forging the recorded actor/signer, or retargeting the URL's resource.
// Services then honour the overridden value (e.g. setTenantTx(input.tenantId)),
// so RLS follows the attacker-selected tenant rather than repairing it.
//
// The safe ordering spreads the body FIRST and assigns immutable server fields
// LAST:  svc.create({ ...req.body, tenantId: tenantOf(req), actorUid: ... }).
//
// This test statically scans every route file and fails if any object literal
// that spreads `...req.body` assigns a server-derived value (req.user / req.params
// / tenantOf() / resolveTenantOrThrow()) BEFORE that spread. Fix = move the spread
// to the top of the object. A genuinely intentional case must be reordered or
// added to ALLOWLIST with justification.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, '../../routes');

// Allowlisted intentional cases: "<relpath>:<lineno>". Keep empty; every entry
// needs a comment explaining why body-override of a server field is safe there.
const ALLOWLIST = new Set([]);

// Signals that a value in the object prefix was derived server-side (and must
// therefore not be overridable by the request body that follows).
const SERVER_DERIVED = /req\.user\b|req\.params\b|tenantOf\s*\(|resolveTenantOrThrow\s*\(|\b(tenantId|tenant_id|actorUid|actor_uid|actorRole|actor_role)\s*:/;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Strip block + line comments so patterns mentioned in prose aren't matched.
// Preserves `://` (URLs) by requiring the `//` not be preceded by ':'.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Given the index of a `...req.body` spread, return the text of the innermost
// enclosing object literal from its opening `{` up to the spread — i.e. the
// properties declared BEFORE the body spread. Returns null if the spread is not
// directly inside an object literal (e.g. a call/array spread).
function objectPrefixBeforeSpread(src, spreadIdx) {
  let depth = 0;
  for (let k = spreadIdx - 1; k >= 0; k--) {
    const c = src[k];
    if (c === '}' || c === ')' || c === ']') depth++;
    else if (c === '{' || c === '(' || c === '[') {
      if (depth === 0) return c === '{' ? src.slice(k + 1, spreadIdx) : null;
      depth--;
    }
  }
  return null;
}

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

describe('server-context body-override guard', () => {
  it('no route object literal spreads ...req.body after a server-derived field', () => {
    const offenders = [];
    const spread = /\.\.\.req\.body\b/g;
    for (const file of walk(ROUTES_DIR)) {
      const rel = path.relative(ROUTES_DIR, file).replace(/\\/g, '/');
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      let m;
      spread.lastIndex = 0;
      while ((m = spread.exec(src)) !== null) {
        const prefix = objectPrefixBeforeSpread(src, m.index);
        if (prefix == null) continue;
        if (!SERVER_DERIVED.test(prefix)) continue;
        const line = lineOf(src, m.index);
        if (ALLOWLIST.has(`${rel}:${line}`)) continue;
        offenders.push(`${rel}:${line} — ...req.body spread AFTER a server-derived field (tenant/actor/params override)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
