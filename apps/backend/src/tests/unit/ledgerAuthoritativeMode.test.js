import { jest } from '@jest/globals';

// Mock the tenant service so we control what tenants.settings the resolver sees.
const getTenantByIdMock = jest.fn();
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: getTenantByIdMock,
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  resolveTenantOrThrow: (req) => req?.tenantId || '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const {
  LEDGER_AUTHORITATIVE_MODES,
  DEFAULT_LEDGER_MODE,
  normalizeLedgerMode,
  envLedgerMode,
  resolveLedgerModeForTenant,
} = await import('../../services/billing/ledger/ledgerAuthoritativeMode.js');

const TENANT = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  getTenantByIdMock.mockReset();
  delete process.env.LEDGER_AUTHORITATIVE_MODE;
});

describe('ledgerAuthoritativeMode.normalizeLedgerMode', () => {
  it('accepts the three valid modes case-insensitively', () => {
    expect(normalizeLedgerMode('off')).toBe('off');
    expect(normalizeLedgerMode('SHADOW')).toBe('shadow');
    expect(normalizeLedgerMode('  Enforce ')).toBe('enforce');
  });
  it('rejects unknown / empty values', () => {
    expect(normalizeLedgerMode('strict')).toBeNull();
    expect(normalizeLedgerMode('')).toBeNull();
    expect(normalizeLedgerMode(null)).toBeNull();
    expect(normalizeLedgerMode(undefined)).toBeNull();
  });
});

describe('ledgerAuthoritativeMode.resolveLedgerModeForTenant', () => {
  it('defaults to shadow when the tenant has no setting', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: {} });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('shadow');
    expect(DEFAULT_LEDGER_MODE).toBe(LEDGER_AUTHORITATIVE_MODES.SHADOW);
  });

  it('reads enforce from tenants.settings.ledger_authoritative_mode', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: { ledger_authoritative_mode: 'enforce' } });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('enforce');
  });

  it('reads off from tenants.settings', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: { ledger_authoritative_mode: 'off' } });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('off');
  });

  it('tolerates settings stored as a JSON string', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: JSON.stringify({ ledger_authoritative_mode: 'enforce' }) });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('enforce');
  });

  it('ignores an invalid per-tenant value and falls back to default', async () => {
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: { ledger_authoritative_mode: 'banana' } });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('shadow');
  });

  it('uses the LEDGER_AUTHORITATIVE_MODE env var as the fallback when no tenant setting', async () => {
    process.env.LEDGER_AUTHORITATIVE_MODE = 'enforce';
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: {} });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('enforce');
    expect(envLedgerMode()).toBe('enforce');
  });

  it('per-tenant setting overrides the env var', async () => {
    process.env.LEDGER_AUTHORITATIVE_MODE = 'off';
    getTenantByIdMock.mockResolvedValueOnce({ id: TENANT, settings: { ledger_authoritative_mode: 'enforce' } });
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('enforce');
  });

  it('FAIL-SAFE: resolves to the default (shadow) when the tenant lookup throws', async () => {
    getTenantByIdMock.mockRejectedValueOnce(new Error('db down'));
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('shadow');
  });

  it('FAIL-SAFE: resolves to default when the tenant row is missing', async () => {
    getTenantByIdMock.mockResolvedValueOnce(null);
    await expect(resolveLedgerModeForTenant(TENANT)).resolves.toBe('shadow');
  });
});
