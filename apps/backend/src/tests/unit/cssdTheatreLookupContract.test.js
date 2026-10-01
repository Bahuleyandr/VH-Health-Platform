import { jest } from '@jest/globals';

const queryRaw = jest.fn();
const setTenant = jest.fn((tenant, fn) => fn({ $queryRawUnsafe: queryRaw }));
jest.unstable_mockModule('../../lib/prisma.js', () => ({ setTenant }));
jest.unstable_mockModule('../../utils/securityAuditLogger.js', () => ({ logSecurityEvent: jest.fn() }));

const { listCssdTheatreOptions } = await import('../../services/cssd/cssdTheatreLookupService.js');
const { listLinenWardOptions } = await import('../../services/linen/linenWardLookupService.js');
const { CSSD_THEATRE_LOOKUP_ROUTE_ROLES } = await import('../../config/routeRolePolicy.js');
const { requireRole } = await import('../../middleware/rbacMiddleware.js');

const TENANT = '10000000-0000-4000-8000-000000000001';
const FOREIGN_TENANT = '10000000-0000-4000-8000-000000000002';
const ALLOWED = [
  'ADMIN',
  'ANAESTHETIST',
  'ANESTHETIST',
  'CONSULTANT',
  'DOCTOR',
  'DUTY_DOCTOR',
  'INFECTION_CONTROL_OFFICER',
  'JUNIOR_DOCTOR',
  'NURSING_STAFF',
  'OT_INCHARGE',
  'OT_NURSE',
  'OT_STAFF',
  'QUALITY_OFFICER',
  'RESIDENT',
  'SUPER_ADMIN'
];
const filters = { date: '2001-01-01' };
const row = { id: 7, scheduled_date: '2001-01-01', scheduled_time: null };

function authorize(user) {
  const req = { user, headers: {}, method: 'GET', originalUrl: '/lookup' };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  requireRole(...CSSD_THEATRE_LOOKUP_ROUTE_ROLES)(req, res, next);
  return { res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryRaw.mockResolvedValue([]);
});

describe('CssdTheatre lookup authorization contract', () => {
  it('pins the exact approved audience independently of the console audience', () => {
    expect([...CSSD_THEATRE_LOOKUP_ROUTE_ROLES].sort()).toEqual([...ALLOWED].sort());
  });

  it.each(ALLOWED)('admits %s to the lookup role gate', role => {
    expect(authorize({ role, uid: 'actor', scope: 'full' }).next).toHaveBeenCalledTimes(1);
  });

  it.each(['PATIENT','COMPLIANCE_OFFICER','DATA_PROTECTION_OFFICER','HR_STAFF','PHARMACY_INCHARGE','STORES_PURCHASE_INCHARGE'])('denies %s', role => {
    const { res, next } = authorize({ role, uid: 'actor' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated and setup-only callers', () => {
    expect(authorize(undefined).res.status).toHaveBeenCalledWith(401);
    expect(authorize({ role: 'SUPER_ADMIN', scope: 'mfa_setup' }).res.status).toHaveBeenCalledWith(403);
  });

  it.each([undefined, null, '', 'bypass', 'not-a-tenant'])('requires explicit tenant context: %s', async tenantId => {
    await expect(listCssdTheatreOptions({ tenantId, query: filters }))
      .rejects.toMatchObject({ statusCode: 403, code: 'TENANT_CONTEXT_REQUIRED' });
    expect(setTenant).not.toHaveBeenCalled();
  });

  it('uses a tenant transaction and explicit SQL scope, projecting exact fields', async () => {
    queryRaw.mockResolvedValue([{ ...row, patient_uid: 'sensitive-canary', occupancy: 999,
      procedure_name: 'clinical-canary', ot_room: 'room-canary', tenant_id: FOREIGN_TENANT }]);
    const result = await listCssdTheatreOptions({ tenantId: TENANT, query: filters });
    expect(result).toEqual({ items: [row], next_cursor: null });
    expect(setTenant).toHaveBeenCalledWith(TENANT, expect.any(Function), { readOnly: true });
    const [sql, tenant] = queryRaw.mock.calls[0];
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(sql).not.toMatch(/SELECT\s+\*/i);
    expect(tenant).toBe(TENANT);
    expect(JSON.stringify(result)).not.toContain('canary');
  });

  it('returns an explicit empty page', async () => {
    await expect(listCssdTheatreOptions({ tenantId: TENANT, query: filters }))
      .resolves.toEqual({ items: [], next_cursor: null });
  });

  it.each([
    { limit: '0' }, { limit: '201' }, { limit: '1.5' }, { limit: ['1', '2'] },
    { tenant_id: FOREIGN_TENANT }, { facility_id: '1' }, { patient_uid: 'canary' },
    { cursor: '' }, { cursor: 'malformed' }, { cursor: 'a'.repeat(2049) },
    { date: '' }, { date: '2001-02-29' }, { date: ['2001-01-01'] }, { q: 'patient' }
  ])('rejects malformed or expanded queries %j before reading', async extra => {
    await expect(listCssdTheatreOptions({ tenantId: TENANT, query: { ...filters, ...extra } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_LOOKUP_QUERY' });
    expect(setTenant).not.toHaveBeenCalled();
  });

  it('binds continuation to tenant, endpoint, filters and limit and rejects tampering', async () => {
    queryRaw.mockResolvedValue([row, { ...row, id: 8 }]);
    const first = await listCssdTheatreOptions({ tenantId: TENANT, query: { ...filters, limit: '1' } });
    expect(first.items).toEqual([row]);
    expect(first.next_cursor).toMatch(/^[\w-]+\.[\w-]+$/);
    const cursor = first.next_cursor;
    queryRaw.mockResolvedValue([]);
    await listCssdTheatreOptions({ tenantId: TENANT, query: { ...filters, limit: '1', cursor } });
    expect(queryRaw.mock.calls.at(-1)[3]).toBe(row.id);
    for (const input of [
      { tenantId: FOREIGN_TENANT, query: { ...filters, limit: '1', cursor } },
      { tenantId: TENANT, query: { ...filters, limit: '2', cursor } },
      { tenantId: TENANT, query: { ...filters, limit: '1', cursor: 'a' + cursor } },
      { tenantId: TENANT, query: { ...filters, limit: '1', cursor, date: '2001-01-02' } },
    ]) {
      await expect(listCssdTheatreOptions(input)).rejects.toMatchObject({ statusCode: 400 });
    }
  });

  it('distinguishes dependency failure from an empty page and unexpected defects', async () => {
    queryRaw.mockRejectedValueOnce(Object.assign(new Error('private database details'), { code: 'P1001' }));
    await expect(listCssdTheatreOptions({ tenantId: TENANT, query: filters }))
      .rejects.toMatchObject({ statusCode: 503, code: 'LOOKUP_UNAVAILABLE' });
    const defect = new Error('unexpected failure');
    queryRaw.mockRejectedValueOnce(defect);
    await expect(listCssdTheatreOptions({ tenantId: TENANT, query: filters })).rejects.toBe(defect);
  });

  it('rejects a cursor issued by the other lookup', async () => {
    queryRaw.mockResolvedValue([{ id: 1, name: 'Ward A' }, { id: 2, name: 'Ward B' }]);
    const first = await listLinenWardOptions({ tenantId: TENANT, query: { limit: '1' } });
    await expect(listCssdTheatreOptions({
      tenantId: TENANT, query: { ...filters, limit: '1', cursor: first.next_cursor },
    })).rejects.toMatchObject({ statusCode: 400 });
  });
});
