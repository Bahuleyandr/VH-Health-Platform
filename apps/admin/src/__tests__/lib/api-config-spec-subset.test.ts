import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { API_ENDPOINTS } from '@/lib/api-config';

// Real nav/mount-base prefixes (router mounts with children but no bare op) +
// non-/api/v1 infra. Allowlisted because the gate is a subset check on leaf
// operation paths, and these are legitimately not standalone operations.
const ALLOWLIST = new Set<string>([
  '/api-docs', '/ws',
  '/api/v1/admin/analytics', '/api/v1/admin/appointments', '/api/v1/admin/departments',
  '/api/v1/admin/investigations', '/api/v1/admin/pharmacy', '/api/v1/admin/records',
  '/api/v1/admin/sos', '/api/v1/admin/users', '/api/v1/staff/admin',
  '/api/v1/devices', '/api/v1/pharmacy-orders/inventory',
]);

const SENTINEL = '__P__';
const normApi = (p: string) =>
  p.split('?')[0]
    .replace(/:[A-Za-z0-9_]+/g, '{X}')
    .replace(/__P__/g, '{X}')
    .replace(/\$\{[^}]*\}/g, '{X}');
const normSpec = (p: string) => p.replace(/\{[^}]+\}/g, '{X}');

function collectLeaves(obj: unknown, keyPath: string, out: { key: string; path: string }[]) {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const kp = keyPath ? `${keyPath}.${k}` : k;
    if (typeof v === 'string') out.push({ key: kp, path: v });
    else if (typeof v === 'function') {
      try {
        const r = (v as (x: string) => string)(SENTINEL);
        if (typeof r === 'string') out.push({ key: kp, path: r });
      } catch { /* skip non-path-producing fns */ }
    } else if (v && typeof v === 'object') collectLeaves(v, kp, out);
  }
}

describe('api-config paths are a subset of the canonical OpenAPI spec', () => {
  it('every API_ENDPOINTS leaf path exists in apps/backend/src/docs/openapi.json', () => {
    const specPath = resolve(__dirname, '../../../../backend/src/docs/openapi.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { paths: Record<string, unknown> };
    const specNorm = new Set(Object.keys(spec.paths).map(normSpec));

    const leaves: { key: string; path: string }[] = [];
    collectLeaves(API_ENDPOINTS, '', leaves);

    const missing = leaves
      .filter((l) => l.path.startsWith('/'))
      .filter((l) => !ALLOWLIST.has(l.path.split('?')[0]))
      .filter((l) => !specNorm.has(normApi(l.path)));

    if (missing.length > 0) {
      const report = missing.map((m) => `  ${m.key}: ${m.path}`).join('\n');
      throw new Error(
        `${missing.length} api-config path(s) absent from the canonical OpenAPI spec — `
        + `fix the path, or (only for a real nav/mount base) add it to ALLOWLIST:\n${report}`,
      );
    }
    expect(missing).toEqual([]);
  });
});
