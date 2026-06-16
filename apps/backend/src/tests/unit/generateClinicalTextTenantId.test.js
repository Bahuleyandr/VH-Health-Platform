import fs from 'node:fs';
import path from 'node:path';

/**
 * Tenant-override correctness guard.
 *
 * generateClinicalText({ ..., tenantId }) resolves each module's
 * enable/provider/tier via getClinicalAiModule(taskType, { tenantId }). If a
 * caller omits tenantId it defaults to null and reads the GLOBAL
 * clinical_ai_modules row, silently ignoring a per-tenant override (a module a
 * tenant enabled would template-fall-back). Every caller must forward tenantId.
 *
 * This test scans the service source and fails if any generateClinicalText(...)
 * call (other than the definition itself) is missing `tenantId`, so the fix
 * can never silently regress as new AI services are added.
 */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : walk(p);
    return entry.name.endsWith('.js') ? [p] : [];
  });
}

function findCallsMissingTenantId(source) {
  const misses = [];
  const token = 'generateClinicalText(';
  let i = 0;
  while ((i = source.indexOf(token, i)) !== -1) {
    const isDefinition = /function\s+generateClinicalText/.test(source.slice(Math.max(0, i - 60), i));
    // Paren-depth match the call so nested objects/arrays don't end it early.
    let depth = 0;
    let j = i + token.length;
    let inStr = false;
    let quote = '';
    for (; j < source.length; j += 1) {
      const c = source[j];
      if (inStr) {
        if (c === quote && source[j - 1] !== '\\') inStr = false;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') { if (depth === 0) break; depth -= 1; }
    }
    const call = source.slice(i, j);
    const line = source.slice(0, i).split('\n').length;
    // Only real calls take an object arg; skip doc/comment references like
    // `generateClinicalText()` (e.g. the JSDoc on the definition).
    if (!isDefinition && call.includes('{') && !/\btenantId\b/.test(call)) {
      misses.push(line);
    }
    i = j;
  }
  return misses;
}

describe('generateClinicalText tenant-override correctness', () => {
  it('every generateClinicalText call forwards tenantId', () => {
    const servicesDir = path.resolve(process.cwd(), 'src/services');
    const files = walk(servicesDir);
    const offenders = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('generateClinicalText(')) continue;
      const missing = findCallsMissingTenantId(source);
      for (const line of missing) {
        offenders.push(`${path.relative(process.cwd(), file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
