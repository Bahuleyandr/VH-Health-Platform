import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  ACCESS_POLICY_CODES,
  authorizePatientAccessRequest,
} = await import('../../services/security/accessDecisionService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';

function requestFor(role) {
  return {
    id: `verify-${role}`,
    method: 'PUT',
    originalUrl: '/api/v1/emr/orders/41/verify',
    params: { id: '41' },
    query: {},
    body: {},
    tenantId: TENANT_ID,
    user: {
      id: 9,
      uid: ACTOR_UID,
      role,
      rawRole: role,
      tenant_id: TENANT_ID,
    },
  };
}

function mockActiveAdmission() {
  prismaMock.$queryRawUnsafe.mockImplementation(async (sql) => {
    if (/FROM care_team_members/.test(sql)) return [];
    if (/SELECT id\s+FROM admissions/.test(sql)) return [{ id: 27 }];
    if (/FROM users/.test(sql)) return [{ id: 15, uid: PATIENT_UID }];
    return [];
  });
  prismaMock.$executeRawUnsafe.mockResolvedValue(undefined);
}

describe('clinical-order verification admission relationship', () => {
  afterEach(() => {
    prismaMock.$queryRawUnsafe.mockReset();
    prismaMock.$executeRawUnsafe.mockReset();
  });

  test.each(['PHARMACIST', 'ICU_INCHARGE'])(
    'allows %s through an active admission only for the dedicated verification policy',
    async (role) => {
      mockActiveAdmission();
      const verificationDecision = await authorizePatientAccessRequest(requestFor(role), {
        policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_VERIFY,
        recordType: 'CLINICAL_ORDER',
        patient: { uid: PATIENT_UID },
        resourceContext: { resourceType: 'clinical_order', resourceId: '41' },
        requireResolvedPatient: true,
      });

      expect(verificationDecision.allowed).toBe(true);
      expect(verificationDecision.accessSource).toBe('admission');

      prismaMock.$queryRawUnsafe.mockClear();
      prismaMock.$executeRawUnsafe.mockClear();
      mockActiveAdmission();
      const genericDecision = await authorizePatientAccessRequest(requestFor(role), {
        policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
        recordType: 'CLINICAL_ORDER',
        patient: { uid: PATIENT_UID },
        resourceContext: { resourceType: 'clinical_order', resourceId: '41' },
        requireResolvedPatient: true,
      });

      expect(genericDecision.allowed).toBe(false);
      expect(prismaMock.$queryRawUnsafe.mock.calls.some(
        ([sql]) => /SELECT id\s+FROM admissions/.test(sql),
      )).toBe(false);
    },
  );
});
