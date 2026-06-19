#!/usr/bin/env node
// check-no-default-tenant-fallback.mjs
//
// Multi-tenancy W1 guard (docs/superpowers/specs/2026-06-19-w1-fail-closed-
// tenant-resolution-design.md). Tenant resolution must FAIL CLOSED: a request
// or service that resolves no tenant must 403 (via resolveTenantOrThrow /
// requireTenantId), never silently fall back to the literal default tenant.
//
// This guard bans the `|| DEFAULT_TENANT_ID` / `?? DEFAULT_TENANT_ID` (and the
// literal `|| '00000000-0000-4000-8000-000000000001'`) SHORT-CIRCUIT FALLBACK
// pattern in backend source. Those were swept to requireTenantId(...) in W1
// phases 1b/1c; this stops the silent-default pattern from re-appearing.
//
// In scope: the `||`/`??` fallback expression only. NOT flagged (deliberately,
// distinct syntax — tracked as W1 residuals to tighten before the multi-tenant
// cutover, see the W1 design doc):
//   - default PARAMETERS `function f(..., tenantId = DEFAULT_TENANT_ID)`
//   - raw-SQL `COALESCE(<col>, '...'::uuid)` filters (revisited in W2 once the
//     per-tenant-identity NOT NULL columns land)
//
// Allowlisted files legitimately reference the default for the single-tenant
// floor itself.
//
// Exit codes: 0 = clean · 1 = banned fallback found · 2 = unreadable tree.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', 'src');

// Files that legitimately own the default-tenant floor (the only sanctioned
// `|| DEFAULT_TENANT_ID` sites — gated by ALLOW_DEFAULT_TENANT).
const ALLOWLIST = new Set([
  path.join('services', 'tenant', 'tenantService.js'),
  path.join('middleware', 'tenantContextMiddleware.js'),
]);

// `|| DEFAULT_TENANT_ID`, `?? DEFAULT_TENANT_ID`, `|| TENANT_FALLBACK*`,
// `|| '0000...'`, `?? '0000...'` — the short-circuit fallback, not `= default`.
const FALLBACK_RE = /(\|\||\?\?)\s*(DEFAULT_TENANT_ID|DEFAULT_TENANT\b|TENANT_FALLBACK\w*|TENANT_DEFAULT\w*|['"]00000000-0000-4000-8000-000000000001['"])/;

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name === '__tests__') continue;
      walk(full, acc);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      acc.push(full);
    }
  }
  return acc;
}

let files;
try {
  files = walk(SRC_DIR);
} catch (err) {
  console.error(`check-no-default-tenant-fallback: cannot read ${SRC_DIR}: ${err.message}`);
  process.exit(2);
}

const violations = [];
for (const file of files) {
  const rel = path.relative(SRC_DIR, file);
  if (ALLOWLIST.has(rel)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return; // skip comments
    if (FALLBACK_RE.test(line)) {
      violations.push(`  apps/backend/src/${rel.replace(/\\/g, '/')}:${i + 1}  ${trimmed.slice(0, 120)}`);
    }
  });
}

if (violations.length > 0) {
  console.error(
    `\ncheck-no-default-tenant-fallback: ${violations.length} silent default-tenant fallback(s) found.\n` +
    `Replace \`x || DEFAULT_TENANT_ID\` with resolveTenantOrThrow(req) (request path) or\n` +
    `requireTenantId(x) (service layer) so tenant resolution fails closed. (W1)\n\n` +
    violations.join('\n') + '\n',
  );
  process.exit(1);
}

console.log(`check-no-default-tenant-fallback: clean (${files.length} files scanned, no silent default-tenant fallbacks).`);
process.exit(0);
