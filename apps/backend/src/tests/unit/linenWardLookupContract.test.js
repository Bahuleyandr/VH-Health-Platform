import { jest } from '@jest/globals';

const queryRaw = jest.fn();
const setTenant = jest.fn((tenant, fn) => fn({ $queryRawUnsafe: queryRaw }));
jest.unstable_mockModule('../../lib/prisma.js', () => ({ setTenant }));
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({ logSecurityEvent: jest.fn() }));

const { listLinenWardOptions } = await import('../../services/linen/linenWardLookupService.js');
const { LINEN_WARD_LOOKUP_ROUTE_ROLES } = await import('../../config/routeRolePolicy.js');
const { requireRole } = await import('../../middleware/rbacMiddleware.js');

const TENANT = '10000000-0000-4000-8000-000000000001';
const FOREIGN_TENANT = '10000000-0000-4000-8000-000000000002';
const ALLOWED = [
  'ADMIN',
  'ADMISSION_OFFICER',
  'CONSULTANT',
  'DOCTOR',
  'DUTY_DOCTOR',
  'HOUSEKEEPING_INCHARGE',
  'HOUSEKEEPING_STAFF',
  'ICU_INCHARGE',
  'ICU_NURSE',
  'ICU_STAFF',
  'IPD_COUNSELLOR',
  'IP_INCHARGE',
  'IP_STAFF_NURSE',
  'JUNIOR_DOCTOR',
  'NURSING_INCHARGE',
  'NURSING_STAFF',
  'PHARMACY_INCHARGE',
  'RESIDENT',
  'SENIOR_DOCTOR',
  'STORES_PURCHASE_INCHARGE',
  'SUPER_ADMIN'
];
const filters = {};
const row = { id: 7, name: 'Unmapped first-use ward' };

function authorize(user) {
  const req = { user, headers: {}, method: 'GET', originalUrl: '/lookup' };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  requireRole(...LINEN_WARD_LOOKUP_ROUTE_ROLES)(req, res, next);
  return { res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryRaw.mockResolvedValue([]);
});

describe('LinenWard lookup authorization contract', () => {
  it('pins the exact approved audience independently of the console audience', () => {
    expect([...LINEN_WARD_LOOKUP_ROUTE_ROLES].sort()).toEqual([...ALLOWED].sort());
  });

  it.each(ALLOWED)('admits %s to the lookup role gate', role => {
    expect(authorize({ role, uid: 'actor', scope: 'full' }).next).toHaveBeenCalledTimes(1);
  });

  it.each(['PATIENT','RECEPTIONIST','HR_STAFF'])('denies %s', role => {
    const { res, next } = authorize({ role, uid: 'actor' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated and setup-only callers', () => {
    expect(authorize(undefined).res.status).toHaveBeenCalledWith(401);
    expect(authorize({ role: 'SUPER_ADMIN', scope: 'mfa_setup' }).res.status).toHaveBeenCalledWith(403);
  });

  it.each([undefined, null, '', 'bypass', 'not-a-tenant'])('requires explicit tenant context: %s', async tenantId => {
    await expect(listLinenWardOptions({ tenantId, query: filters }))
      .rejects.toMatchObject({ statusCode: 403, code: 'TENANT_CONTEXT_REQUIRED' });
    expect(setTenant).not.toHaveBeenCalled();
  });

  it('uses a tenant transaction and explicit SQL scope, projecting exact fields', async () => {
    queryRaw.mockResolvedValue([{ ...row, patient_uid: 'sensitive-canary', occupancy: 999,
      procedure_name: 'clinical-canary', ot_room: 'room-canary', tenant_id: FOREIGN_TENANT }]);
    const result = await listLinenWardOptions({ tenantId: TENANT, query: filters });
    expect(result).toEqual({ items: [row], next_cursor: null });
    expect(setTenant).toHaveBeenCalledWith(TENANT, expect.any(Function), { readOnly: true });
    const [sql, tenant] = queryRaw.mock.calls[0];
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(tenant).toBe(TENANT);
    expect(JSON.stringify(result)).not.toContain('canary');
  });

  it('returns an explicit empty page', async () => {
    await expect(listLinenWardOptions({ tenantId: TENANT, query: filters }))
      .resolves.toEqual({ items: [], next_cursor: null });
  });

  it.each([
    { limit: '0' }, { limit: '201' }, { limit: '1.5' }, { limit: ['1', '2'] },
    { tenant_id: FOREIGN_TENANT }, { facility_id: '1' }, { patient_uid: 'canary' },
    { cursor: '' }, { cursor: 'malformed' }, { cursor: 'a'.repeat(2049) },
    { q: ['a', 'b'] }, { q: 'a'.repeat(81) }
  ])('rejects malformed or expanded queries %j before reading', async extra => {
    await expect(listLinenWardOptions({ tenantId: TENANT, query: { ...filters, ...extra } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_LOOKUP_QUERY' });
    expect(setTenant).not.toHaveBeenCalled();
  });

  it('binds continuation to tenant, endpoint, filters and limit and rejects tampering', async () => {
    queryRaw.mockResolvedValue([row, { ...row, id: 8 }]);
    const first = await listLinenWardOptions({ tenantId: TENANT, query: { ...filters, limit: '1' } });
    expect(first.items).toEqual([row]);
    expect(first.next_cursor).toMatch(/^[\w-]+\.[\w-]+$/);
    const cursor = first.next_cursor;
    queryRaw.mockResolvedValue([]);
    await listLinenWardOptions({ tenantId: TENANT, query: { ...filters, limit: '1', cursor } });
    expect(queryRaw.mock.calls.at(-1)[3]).toBe(row.id);
    for (const input of [
      { tenantId: FOREIGN_TENANT, query: { ...filters, limit: '1', cursor } },
      { tenantId: TENANT, query: { ...filters, limit: '2', cursor } },
      { tenantId: TENANT, query: { ...filters, limit: '1', cursor: 'a' + cursor } },
      { tenantId: TENANT, query: { ...filters, limit: '1', cursor, q: 'other' } },
    ]) {
      await expect(listLinenWardOptions(input)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('distinguishes dependency failure from an empty page and unexpected defects', async () => {
    queryRaw.mockRejectedValueOnce(Object.assign(new Error('private database details'), { code: 'P1001' }));
    await expect(listLinenWardOptions({ tenantId: TENANT, query: filters }))
      .rejects.toMatchObject({ statusCode: 503, code: 'LOOKUP_UNAVAILABLE' });
    const defect = new Error('unexpected failure');
    queryRaw.mockRejectedValueOnce(defect);
    await expect(listLinenWardOptions({ tenantId: TENANT, query: filters })).rejects.toBe(defect);
  });
});
