import { buildCacheKey } from '../../middleware/cacheMiddleware.js';

describe('cache key tenant isolation', () => {
  it('two tenants on the same path+query get different keys', () => {
    const a = buildCacheKey('appts', { tenantId: 'tA', method: 'GET', path: '/x', query: 'p=1' });
    const b = buildCacheKey('appts', { tenantId: 'tB', method: 'GET', path: '/x', query: 'p=1' });
    expect(a).not.toBe(b);
    expect(a).toContain(':tA:');
    expect(b).toContain(':tB:');
  });

  it('omitted tenant uses the default label (never a tenant-blind key)', () => {
    expect(buildCacheKey('appts', { method: 'GET', path: '/x', query: '' })).toContain(':default:');
  });

  it('composes prefix:tenant:method:path:query deterministically', () => {
    expect(
      buildCacheKey('appts', { tenantId: 'tA', method: 'GET', path: '/x', query: 'p=1' }),
    ).toBe('appts:tA:GET:/x:p=1');
  });
});
