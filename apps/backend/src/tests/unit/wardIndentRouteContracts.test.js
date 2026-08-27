import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = 'a7410000-0000-4000-8000-000000000005';

const prismaMock = { $queryRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  prismaReadOnly: prismaMock,
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: (_recordType, _options) => {
    const middleware = (_req, _res, next) => next();
    return middleware;
  },
}));

jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  requireRole: (...roles) => {
    const middleware = (_req, _res, next) => next();
    middleware.__roles = roles;
    return middleware;
  },
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: (options) => {
    const middleware = (_req, _res, next) => next();
    middleware.__idempotency = options;
    return middleware;
  },
}));

jest.unstable_mockModule('../../middleware/sanitizeMiddleware.js', () => ({
  sanitizeAllBodyStrings: (_req, _res, next) => next(),
}));

const controllerNames = [
  'listIndents',
  'getIndent',
  'createIndent',
  'reserveIndent',
  'markShortSupply',
  'proposeSubstitution',
  'approveSubstitution',
  'rejectSubstitution',
  'approveIndent',
  'rejectIndent',
  'recordControlledHandoff',
  'issueIndent',
  'receiveIndent',
  'requestReturn',
  'reportDiscrepancy',
  'reconcileIndent',
  'cancelIndent',
  'closeIndent',
];
jest.unstable_mockModule('../../controllers/pharmacy/wardIndentController.js', () => (
  Object.fromEntries(controllerNames.map((name) => [name, jest.fn()]))
));

const guards = await import('../../routes/pharmacy/wardIndentPatientGuards.js');
const { default: router } = await import('../../routes/pharmacy/wardIndentRoutes.js');
const ipdAliasSource = readFileSync(
  new URL('../../routes/ipd/ipdSupportRoutes.js', import.meta.url),
  'utf8',
);

function route(path, method) {
  return router.stack.find((layer) => layer.route?.path === path && layer.route.methods?.[method]);
}

function metadata(path, method, key) {
  const layer = route(path, method);
  expect(layer).toBeDefined();
  return layer.route.stack.map((stack) => stack.handle?.[key]).filter(Boolean);
}

const MUTATIONS = [
  ['/', 'ward_indent_create'],
  ['/:id/reserve', 'ward_indent_reserve'],
  ['/:id/short-supply', 'ward_indent_short_supply'],
  ['/:id/substitutions', 'ward_indent_substitution_propose'],
  ['/:id/substitutions/approve', 'ward_indent_substitution_approve'],
  ['/:id/substitutions/reject', 'ward_indent_substitution_reject'],
  ['/:id/approve', 'ward_indent_approve'],
  ['/:id/reject', 'ward_indent_reject'],
  ['/:id/controlled-handoff', 'ward_indent_controlled_handoff'],
  ['/:id/issue', 'ward_indent_issue'],
  ['/:id/receive', 'ward_indent_receive'],
  ['/:id/returns', 'ward_indent_return_request'],
  ['/:id/discrepancies', 'ward_indent_discrepancy'],
  ['/:id/reconcile', 'ward_indent_reconcile'],
  ['/:id/cancel', 'ward_indent_cancel'],
  ['/:id/close', 'ward_indent_close'],
];

describe('ward-indent patient selectors', () => {
  beforeEach(() => prismaMock.$queryRawUnsafe.mockReset());

  test('row selector is tenant-bound and resolves only PATIENT identities', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 7, uid: PATIENT }]);
    const row = await guards.selectWardIndentPatient((req) => req.params.id)({
      params: { id: '41' },
      tenantId: TENANT,
    });
    expect(row).toEqual({ id: 7, uid: PATIENT });
    const [sql, tenantId, indentId] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('indent.tenant_id = $1::uuid');
    expect(sql).toContain('LEFT JOIN admissions admission');
    expect(sql).toContain('COALESCE(indent.patient_uid, admission.patient_uid)');
    expect(sql).toContain("patient.role = 'PATIENT'");
    expect([tenantId, indentId]).toEqual([TENANT, 41]);
  });

  test('create selector resolves an admission authoritatively and rejects junk before querying', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([{ id: 7, uid: PATIENT }]);
    await expect(guards.selectWardIndentCreatePatient({
      body: { admission_id: '12' },
      tenantId: TENANT,
    })).resolves.toEqual({ id: 7, uid: PATIENT });
    const [sql, tenantId, admissionId] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('admission.tenant_id = $1::uuid');
    expect(sql).toContain("patient.role = 'PATIENT'");
    expect([tenantId, admissionId]).toEqual([TENANT, 12]);
    prismaMock.$queryRawUnsafe.mockClear();
    await expect(guards.selectWardIndentCreatePatient({
      body: { admission_id: 'not-an-id' },
      tenantId: TENANT,
    })).resolves.toBeNull();
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('authoritative pharmacy ward-indent router', () => {
  test.each(MUTATIONS)('%s is patient-guarded and fail-closed idempotent', (path, scope) => {
    expect(metadata(path, 'post', '__patientGuard')).toEqual([
      expect.objectContaining({
        recordType: 'PHARMACY_ORDER',
        careTeamModeGoverned: true,
        hasSelector: true,
      }),
    ]);
    expect(metadata(path, 'post', '__idempotency')).toEqual([
      expect.objectContaining({ required: true, retainOnServerError: true, scope }),
    ]);
  });

  test('canonical idempotency paths are identical across pharmacy aliases', () => {
    const create = metadata('/', 'post', '__idempotency')[0];
    const receive = metadata('/:id/receive', 'post', '__idempotency')[0];
    expect(create.requestPathForIdempotency).toBe('/api/v1/pharmacy-orders/ward-indents');
    expect(receive.requestPathForIdempotency({ params: { id: 71 } }))
      .toBe('/api/v1/pharmacy-orders/ward-indents/71/receive');
  });

  test('supply, prescriber, receipt, and reconciliation roles remain separated', () => {
    const issue = metadata('/:id/issue', 'post', '__roles')[0];
    expect(issue).toEqual(expect.arrayContaining(['PHARMACIST', 'PHARMACY_INCHARGE']));
    expect(issue).not.toContain('NURSING_STAFF');
    const substitution = metadata('/:id/substitutions/approve', 'post', '__roles')[0];
    expect(substitution).toEqual(expect.arrayContaining(['DOCTOR', 'CONSULTANT']));
    expect(substitution).not.toContain('PHARMACY_STAFF');
    const receive = metadata('/:id/receive', 'post', '__roles')[0];
    expect(receive).toEqual(expect.arrayContaining(['NURSING_STAFF', 'ICU_NURSE']));
    expect(receive).not.toContain('PHARMACY_STAFF');
    expect(metadata('/:id/reconcile', 'post', '__roles')[0]).toEqual([
      'PHARMACY_INCHARGE',
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      'ICU_INCHARGE',
    ]);
  });
});

describe('IPD compatibility alias', () => {
  test('carries a row guard and the same durable idempotency contract on every mutation', () => {
    for (const [path, scope] of MUTATIONS.slice(1)) {
      const ipdPath = path.replace('/:id', '/ward-indents/:indentId');
      const start = ipdAliasSource.indexOf(`  '${ipdPath}',`);
      const end = ipdAliasSource.indexOf('\nrouter.', start + 1);
      expect(start).toBeGreaterThan(-1);
      const block = ipdAliasSource.slice(start, end < 0 ? undefined : end);
      expect(block).toContain('guardWardIndentRow');
      expect(block).toContain(`wardIndentIdempotency('${scope.replace('ward_indent_', '')}'`);
    }
  });

  test('guards create, filtered list, admission list, and row reads by the same subject', () => {
    expect(ipdAliasSource).toMatch(/'\/ward-indents',[\s\S]*?wardIndentCreateGuard\(\)[\s\S]*?wardIndentIdempotency\('create'\)/);
    expect(ipdAliasSource).toMatch(/router\.get\([\s\S]*?'\/ward-indents',[\s\S]*?wardIndentListGuard\(\)/);
    expect(ipdAliasSource).toMatch(/'\/admissions\/:id\/ward-indents',[\s\S]*?wardIndentAdmissionGuard/);
    expect(ipdAliasSource).toMatch(/'\/ward-indents\/:indentId',[\s\S]*?guardWardIndentRow/);
  });
});
