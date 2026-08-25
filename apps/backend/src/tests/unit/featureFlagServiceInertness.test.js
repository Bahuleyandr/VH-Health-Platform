// apps/backend/src/tests/unit/featureFlagServiceInertness.test.js
//
// The feature-flag console is inert: `isEnabled()` has no call sites, so
// flipping a flag changes no runtime behaviour. Retiring the console spans the
// admin portal and the entitlement catalog (parked in docs/ROADMAP.md), so the
// backend's obligation in the meantime is to stop implying an effect it does
// not have. These tests pin exactly that, and pin `isEnabled()`'s semantics so
// nobody "fixes" the inertness by bolting the gate onto a working path — with
// an empty table that would switch a feature OFF for every tenant.

import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const executeRawUnsafe = jest.fn(async () => 1);
const warn = jest.fn();
const info = jest.fn();
const errorLog = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: executeRawUnsafe },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn, info, error: errorLog, debug: jest.fn() },
}));

const flagRow = (name, overrides = {}) => ({
  id: 1,
  name,
  enabled: true,
  is_enabled: true,
  description: 'a flag',
  rollout_percentage: 100,
  allowed_roles: [],
  created_at: new Date('2026-08-24T00:00:00.000Z'),
  updated_at: new Date('2026-08-24T00:00:00.000Z'),
  ...overrides,
});

/** Fresh module instance each test — the flag cache is module-level state. */
async function loadService(rows) {
  jest.resetModules();
  queryRawUnsafe.mockReset();
  executeRawUnsafe.mockClear();
  warn.mockClear();
  info.mockClear();
  queryRawUnsafe.mockImplementation(async (sql) => (
    String(sql).includes('INSERT INTO feature_flags') ? [rows[0]] : rows
  ));
  return import('../../services/featureFlags/featureFlagService.js');
}

describe('featureFlagService — the console must not claim an effect it lacks', () => {
  it('declares no wired flags', async () => {
    const svc = await loadService([]);
    expect(svc.WIRED_FEATURE_FLAGS).toEqual([]);
  });

  it('stamps every listed flag inert with a note naming the reason', async () => {
    const svc = await loadService([flagRow('new-portal'), flagRow('beta-search', { id: 2 })]);
    const flags = await svc.getFlags();

    expect(flags).toHaveLength(2);
    for (const flag of flags) {
      expect(flag.inert).toBe(true);
      expect(flag.runtime_effect).toBe('none');
      expect(flag.runtime_note).toMatch(/no runtime behaviour/i);
      expect(flag.runtime_note).toMatch(/ROADMAP/);
    }
    // The stored columns still come through untouched — the annotation is
    // additive, so the console keeps rendering name/enabled/description.
    expect(flags.map((f) => f.name)).toEqual(['new-portal', 'beta-search']);
    expect(flags[0].enabled).toBe(true);
  });

  it('warns once, by name, when the table holds flags that gate nothing', async () => {
    const svc = await loadService([flagRow('new-portal')]);
    await svc.getFlags();

    const inertWarnings = warn.mock.calls.filter(([msg]) => /inert/i.test(String(msg)));
    expect(inertWarnings).toHaveLength(1);
    expect(String(inertWarnings[0][0])).toContain('new-portal');
  });

  it('warns at the moment an operator flips something that the flip is a no-op', async () => {
    const svc = await loadService([flagRow('new-portal')]);
    warn.mockClear();

    const saved = await svc.setFlag('new-portal', { enabled: true });

    expect(saved.inert).toBe(true);
    expect(saved.runtime_effect).toBe('none');
    expect(warn.mock.calls.some(([msg]) => /no-op/i.test(String(msg)))).toBe(true);
  });

  it('keeps isEnabled() unknown-flag-is-false — the reason a new gate would fail closed', async () => {
    const svc = await loadService([]);
    await expect(svc.isEnabled('anything')).resolves.toBe(false);
  });

  it('keeps the existing isEnabled() role and rollout semantics', async () => {
    const svc = await loadService([
      flagRow('role-scoped', { allowed_roles: ['ADMIN'] }),
      flagRow('half-rollout', { id: 2, rollout_percentage: 50 }),
      flagRow('switched-off', { id: 3, enabled: false, is_enabled: false }),
    ]);

    await expect(svc.isEnabled('role-scoped', { role: 'ADMIN' })).resolves.toBe(true);
    await expect(svc.isEnabled('role-scoped', { role: 'NURSE' })).resolves.toBe(false);
    await expect(svc.isEnabled('half-rollout', { id: 10 })).resolves.toBe(true);
    await expect(svc.isEnabled('half-rollout', { id: 70 })).resolves.toBe(false);
    await expect(svc.isEnabled('switched-off')).resolves.toBe(false);
  });
});
