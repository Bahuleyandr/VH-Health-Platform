import { jest } from '@jest/globals';

function passThroughWithMetadata(metadata) {
  const middleware = (_req, _res, next) => next();
  middleware.__patientGuard = metadata;
  return middleware;
}

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: (recordType, options = {}) => passThroughWithMetadata({
    recordType,
    ...options,
  }),
  patientAccessGuardForResource: (recordType, options = {}) => passThroughWithMetadata({
    recordType,
    ...options,
  }),
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));

for (const modulePath of [
  '../../services/clinical/handoverService.js',
  '../../services/clinical/marService.js',
  '../../services/clinical/marFiveRightsService.js',
  '../../services/clinical/marSupplyService.js',
  '../../services/clinical/drugChartService.js',
  '../../services/ai/voiceSoapService.js',
]) {
  jest.unstable_mockModule(modulePath, () => ({}));
}

jest.unstable_mockModule('../../services/clinical/news2Service.js', () => ({
  getPatientNEWS2History: jest.fn(),
  presentNews2Record: jest.fn((record) => record),
  recordNEWS2: jest.fn(),
}));

jest.unstable_mockModule('../../services/ai/sttService.js', () => ({
  describeSttConfig: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/polypharmacyAiService.js', () => ({
  reviewPolypharmacy: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/deteriorationEarlyWarningService.js', () => ({
  scoreDeterioration: jest.fn(),
}));
jest.unstable_mockModule('../../services/ai/ambientDocumentationService.js', () => ({
  createAmbientEncounter: jest.fn(),
  listAmbientEncounters: jest.fn(),
}));

const {
  ACCESS_POLICY_CODES,
  getAccessPolicy,
} = await import('../../services/security/accessPolicyRegistry.js');

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES,
}));

const [
  { default: router },
  { getRolePolicy },
  { FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES },
  { canonicalizeRequestRole, hasRole, normalizeRole },
] = await Promise.all([
  import('../../routes/clinical/clinicalRoutes.js'),
  import('../../config/rolePolicyGraph.js'),
  import('../../config/routeRolePolicy.js'),
  import('../../utils/roles.js'),
]);

function route(path, method) {
  return router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods?.[method],
  );
}

function namedMiddleware(path, method, name) {
  const layer = route(path, method);
  expect(layer).toBeDefined();
  const match = layer.route.stack.find((entry) => entry.handle?.name === name);
  expect(match).toBeDefined();
  return match.handle;
}

function runRoleMiddleware(middleware, role) {
  let statusCode = null;
  const body = jest.fn();
  const res = {
    req: { originalUrl: '/api/v1/clinical/mar/test' },
    status: jest.fn(function status(code) {
      statusCode = code;
      return this;
    }),
    json: body,
  };
  const next = jest.fn();
  middleware({ user: { role } }, res, next);
  return { body, next, statusCode };
}

function capabilityGroupsFor(roleCode) {
  return getRolePolicy().roles.find((role) => role.role_code === roleCode)
    ?.access?.route_capability_groups || [];
}

function hasPolicyCapability(roleCode, policy) {
  const actorGroups = capabilityGroupsFor(roleCode);
  return policy.capability_groups.some((group) => actorGroups.includes(group));
}

describe('MAR supply reconciliation authorization wiring', () => {
  const path = '/mar/:id/supply-overrides/:consumptionId/reconcile';

  test('uses one dedicated inpatient supply policy instead of the generic clinical write grant', () => {
    const layer = route(path, 'post');
    const guards = layer.route.stack
      .map((entry) => entry.handle?.__patientGuard)
      .filter(Boolean);

    expect(guards).toEqual([
      expect.objectContaining({
        recordType: 'MAR',
        resourceType: 'mar',
        policyCode: ACCESS_POLICY_CODES.PATIENT_MAR_SUPPLY_RECONCILIATION_WRITE,
      }),
    ]);
    expect(guards[0].policyCode)
      .not.toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE);

    const allDedicatedUses = router.stack.flatMap((routerLayer) => (
      routerLayer.route?.stack || []
    )).filter((entry) => (
      entry.handle?.__patientGuard?.policyCode
        === ACCESS_POLICY_CODES.PATIENT_MAR_SUPPLY_RECONCILIATION_WRITE
    ));
    expect(allDedicatedUses).toHaveLength(1);
    expect(getAccessPolicy(
      ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
    ).capability_groups).toEqual(['ip_flow', 'theatre', 'cath_lab']);

    expect(getAccessPolicy(
      ACCESS_POLICY_CODES.PATIENT_MAR_SUPPLY_RECONCILIATION_WRITE,
    )).toMatchObject({
      code: 'patient.mar_supply_reconciliation.write',
      resource_type: 'mar_supply_reconciliation',
      action: 'UPDATE',
      required_phi_level: 'patient_relationship_required',
      capability_groups: ['supply_chain', 'nursing_governance'],
      relationship_checks: ['care_team', 'admission', 'break_glass'],
      break_glass_allowed: true,
      audit_required: true,
    });
  });

  test.each([
    'PHARMACY_INCHARGE',
    'NURSING_INCHARGE',
    'IP_INCHARGE',
    'ADMIN',
    'SUPER_ADMIN',
  ])('allows the durable reconciliation owner %s through both route and capability gates', (role) => {
    const policy = getAccessPolicy(
      ACCESS_POLICY_CODES.PATIENT_MAR_SUPPLY_RECONCILIATION_WRITE,
    );
    const gate = namedMiddleware(path, 'post', 'requireMarSupplyReconciliationRole');
    const result = runRoleMiddleware(gate, role);

    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBeNull();
    expect(hasPolicyCapability(role, policy)).toBe(true);
  });

  test.each([
    'PHARMACY_STAFF',
    'NURSING_STAFF',
    'IP_STAFF_NURSE',
    'ICU_STAFF',
    'DOCTOR',
    'PATIENT',
    'CNO',
    'STORES_PURCHASE_INCHARGE',
    'HOUSEKEEPING_STAFF',
  ])('denies non-owner %s at the exact reconciliation route fence', (role) => {
    const gate = namedMiddleware(path, 'post', 'requireMarSupplyReconciliationRole');
    const result = runRoleMiddleware(gate, role);

    expect(result.next).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(403);
  });
});

describe('legacy ICU staff MAR-only role equivalence', () => {
  test('preserves ICU_STAFF identity and its clinical-document denial', () => {
    expect(normalizeRole('ICU_STAFF')).toBe('ICU_STAFF');
    expect(canonicalizeRequestRole('ICU_STAFF')).toBe('ICU_STAFF');
    expect(FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES).not.toContain('ICU_STAFF');
    expect(hasRole('ICU_STAFF', FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES)).toBe(false);
  });

  test.each([
    ['/mar/:id/administer', 'post', 'requireMedicationAdministrationRole'],
    ['/mar/:id/administer-with-scan', 'post', 'requireMedicationAdministrationRole'],
    ['/mar/:id/miss', 'post', 'requireMedicationAdministrationRole'],
    ['/mar/:id/hold', 'post', 'requireMedicationAdministrationRole'],
    ['/mar/overdue', 'get', 'requireMarDueListRole'],
    ['/mar/due', 'get', 'requireMarDueListRole'],
  ])('admits ICU_STAFF at the MAR-only role fence for %s', (path, method, middlewareName) => {
    const gate = namedMiddleware(path, method, middlewareName);
    const result = runRoleMiddleware(gate, 'ICU_STAFF');

    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBeNull();
  });

  test('does not turn the ICU alias into pharmacy reconciliation authority', () => {
    const gate = namedMiddleware(
      '/mar/:id/supply-overrides/:consumptionId/reconcile',
      'post',
      'requireMarSupplyReconciliationRole',
    );
    const result = runRoleMiddleware(gate, 'ICU_STAFF');

    expect(result.next).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(403);
  });
});

describe('prescriber MAR exception authorization wiring', () => {
  test.each([
    ['/mar/exceptions', 'get'],
    ['/mar/exceptions/:caseId/claim', 'post'],
    ['/mar/exceptions/:caseId/disposition', 'post'],
    ['/mar/:id/release-hold', 'post'],
  ])('admits exact prescriber tiers and denies nursing/admin roles at %s', (path, method) => {
    const gate = namedMiddleware(path, method, 'requirePrescriberRole');
    for (const role of ['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT']) {
      const result = runRoleMiddleware(gate, role);
      expect(result.next).toHaveBeenCalledTimes(1);
      expect(result.statusCode).toBeNull();
    }
    for (const role of ['NURSING_STAFF', 'NURSING_INCHARGE', 'ADMIN', 'SUPER_ADMIN']) {
      const result = runRoleMiddleware(gate, role);
      expect(result.next).not.toHaveBeenCalled();
      expect(result.statusCode).toBe(403);
    }
  });

  test.each([
    ['/mar/exceptions/:caseId/claim', 'post'],
    ['/mar/exceptions/:caseId/disposition', 'post'],
    ['/mar/:id/release-hold', 'post'],
  ])('keeps %s on the exact prescriber-domain authority instead of a generic patient guard', (
    path,
    method,
  ) => {
    const layer = route(path, method);
    const genericMarGuards = layer.route.stack.filter(
      (entry) => entry.handle?.__patientGuard?.resourceType === 'mar',
    );

    expect(namedMiddleware(path, method, 'requirePrescriberRole')).toBeDefined();
    expect(genericMarGuards).toHaveLength(0);
  });
});
