import { jest } from '@jest/globals';

let denyPatientGuard = false;
let idempotencyInvocations = 0;

function passThroughWithMetadata(metadata) {
  const middleware = (_req, res, next) => {
    if (metadata.__patientGuard && denyPatientGuard) {
      return res.status(403).json({
        success: false,
        code: 'PATIENT_RELATIONSHIP_REQUIRED',
        message: 'Current patient relationship is required',
      });
    }
    return next();
  };
  Object.assign(middleware, metadata);
  return middleware;
}

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: (recordType, options = {}) => passThroughWithMetadata({
    __patientGuard: { recordType, ...options },
  }),
  patientAccessGuardForResource: (recordType, options = {}) => passThroughWithMetadata({
    __patientGuard: { recordType, ...options },
  }),
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: (options = {}) => {
    const middleware = (_req, _res, next) => {
      idempotencyInvocations += 1;
      return next();
    };
    Object.assign(middleware, { __idempotency: options });
    return middleware;
  },
}));

const [
  { default: router },
  { canVerifyClinicalOrderType, canVerifyMedicationOrderRole },
  { getRolePolicy },
  { ACCESS_POLICY_CODES, getAccessPolicy },
] = await Promise.all([
  import('../../routes/emr/orderRoutes.js'),
  import('../../services/emr/orderEntryService.js'),
  import('../../config/rolePolicyGraph.js'),
  import('../../services/security/accessPolicyRegistry.js'),
]);

function route(path, method) {
  return router.stack.find(
    (layer) => layer.route?.path === path && layer.route.methods?.[method],
  );
}

function runRoleMiddleware(middleware, role) {
  let statusCode = null;
  const res = {
    req: { originalUrl: '/api/v1/emr/orders/41/verify' },
    status(code) {
      statusCode = code;
      return this;
    },
    json: jest.fn(),
  };
  const next = jest.fn();
  middleware({ user: { role } }, res, next);
  return { next, statusCode };
}

function capabilityGroupsFor(roleCode) {
  return getRolePolicy().roles.find((role) => role.role_code === roleCode)
    ?.access?.route_capability_groups || [];
}

describe('clinical-order verification authorization', () => {
  const path = '/orders/:id/verify';
  const allowedRoles = [
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'ICU_NURSE',
    'ICU_INCHARGE',
    'PHARMACY_STAFF',
    'PHARMACY_INCHARGE',
    'PHARMACIST',
  ];

  afterEach(() => {
    denyPatientGuard = false;
    idempotencyInvocations = 0;
  });

  test.each([
    {
      path: '/orders',
      method: 'post',
      scope: 'clinical_order',
      roleFence: 'requireMedicationOrderWriteRoleForBody',
      authorityFence: null,
      patientFence: '__patientGuard',
      deviceFence: 'enforceStaffClinicalWriteDevicePosture',
    },
    {
      path: '/orders/apply-set',
      method: 'post',
      scope: 'clinical_order_apply_set',
      roleFence: 'requireMedicationOrderWriteRole',
      authorityFence: null,
      patientFence: '__patientGuard',
      deviceFence: 'enforceStaffClinicalWriteDevicePosture',
    },
    {
      path: '/orders/bulk',
      method: 'post',
      scope: 'clinical_order_bulk',
      roleFence: 'requireMedicationOrderWriteRoleForBulk',
      authorityFence: 'guardBulkOrderPatients',
      patientFence: null,
      deviceFence: 'enforceStaffClinicalWriteDevicePosture',
    },
    {
      path: '/orders/:id/retry-mar-scheduling',
      method: 'post',
      scope: 'clinical_order_mar_retry',
      roleFence: 'requireMedicationOrderWriteRole',
      authorityFence: 'requireMedicationOrderMarRecoveryAuthority',
      patientFence: '__patientGuard',
      deviceFence: 'enforceStaffClinicalWriteDevicePosture',
    },
    {
      path: '/orders/:id/verify',
      method: 'put',
      scope: 'clinical_order_verify',
      roleFence: 'requireMedicationOrderVerificationRole',
      authorityFence: 'requireClinicalOrderVerificationAuthority',
      patientFence: '__patientGuard',
      deviceFence: 'enforceStaffClinicalWriteDevicePosture',
    },
    ...['complete', 'cancel', 'discontinue'].map((action) => ({
      path: `/orders/:id/${action}`,
      method: 'put',
      scope: 'clinical_order_terminal',
      roleFence: null,
      authorityFence: 'requireClinicalOrderTerminalAuthority',
      patientFence: '__patientGuard',
      deviceFence: 'rejectMobileClinicalWrite',
    })),
  ])(
    '$method $path rechecks device, role, and patient/order authority before replay',
    ({
      path: routePath,
      method,
      scope,
      roleFence,
      authorityFence,
      patientFence,
      deviceFence,
    }) => {
      const layer = route(routePath, method);
      const idempotencyIndex = layer.route.stack.findIndex(
        (entry) => entry.handle?.__idempotency?.scope === scope,
      );
      const deviceIndex = layer.route.stack.findIndex(
        (entry) => entry.handle?.name === deviceFence,
      );
      const roleIndex = roleFence
        ? layer.route.stack.findIndex((entry) => entry.handle?.name === roleFence)
        : -1;
      const authorityIndex = authorityFence
        ? layer.route.stack.findIndex((entry) => entry.handle?.name === authorityFence)
        : -1;
      const patientIndex = patientFence
        ? layer.route.stack.findIndex((entry) => entry.handle?.[patientFence])
        : -1;

      expect(idempotencyIndex).toBeGreaterThanOrEqual(0);
      expect(
        layer.route.stack[idempotencyIndex].handle.__idempotency.required,
      ).toBe(true);
      expect(deviceIndex).toBeGreaterThanOrEqual(0);
      expect(idempotencyIndex).toBeGreaterThan(deviceIndex);
      if (roleFence) {
        expect(roleIndex).toBeGreaterThanOrEqual(0);
        expect(idempotencyIndex).toBeGreaterThan(roleIndex);
      }
      if (authorityFence) {
        expect(authorityIndex).toBeGreaterThanOrEqual(0);
        expect(idempotencyIndex).toBeGreaterThan(authorityIndex);
      }
      if (patientFence) {
        expect(patientIndex).toBeGreaterThanOrEqual(0);
        expect(idempotencyIndex).toBeGreaterThan(patientIndex);
      }
    },
  );

  test('revoked MAR-recovery patient authority stops before cached replay', () => {
    const layer = route('/orders/:id/retry-mar-scheduling', 'post');
    const guard = layer.route.stack.find((entry) => entry.handle?.__patientGuard).handle;
    const idempotency = layer.route.stack.find((entry) => (
      entry.handle?.__idempotency?.scope === 'clinical_order_mar_retry'
    )).handle;
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    denyPatientGuard = true;

    expect(guard.__patientGuard).toMatchObject({
      recordType: 'CLINICAL_ORDER',
      resourceType: 'clinical_order',
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_MAR_RECOVERY,
    });
    expect(getAccessPolicy(
      ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_MAR_RECOVERY,
    )).toMatchObject({
      code: 'patient.clinical_order.mar_recovery',
      resource_type: 'clinical_order_mar_recovery',
      action: 'UPDATE',
      required_phi_level: 'patient_relationship_required',
      capability_groups: ['ip_flow'],
      relationship_checks: ['admission', 'break_glass'],
    });

    guard({}, res, () => idempotency({}, res, jest.fn()));

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'PATIENT_RELATIONSHIP_REQUIRED' });
    expect(idempotencyInvocations).toBe(0);
  });

  test.each(['complete', 'cancel', 'discontinue'])(
    'revoked patient authority stops %s before terminal receipt replay',
    (action) => {
      const layer = route(`/orders/:id/${action}`, 'put');
      const guard = layer.route.stack.find((entry) => entry.handle?.__patientGuard).handle;
      const idempotency = layer.route.stack.find((entry) => (
        entry.handle?.__idempotency?.scope === 'clinical_order_terminal'
      )).handle;
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        },
      };
      denyPatientGuard = true;

      guard({}, res, () => idempotency({}, res, jest.fn()));

      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ code: 'PATIENT_RELATIONSHIP_REQUIRED' });
      expect(idempotencyInvocations).toBe(0);
    },
  );

  test('uses a dedicated role, capability, relationship, and required-command fence', () => {
    const layer = route(path, 'put');
    expect(layer).toBeDefined();

    const roleIndex = layer.route.stack.findIndex(
      (entry) => entry.handle?.name === 'requireMedicationOrderVerificationRole',
    );
    const deviceIndex = layer.route.stack.findIndex(
      (entry) => entry.handle?.name === 'enforceStaffClinicalWriteDevicePosture',
    );
    const idempotencyIndex = layer.route.stack.findIndex(
      (entry) => entry.handle?.__idempotency,
    );
    const guardIndex = layer.route.stack.findIndex(
      (entry) => entry.handle?.__patientGuard,
    );
    const authorityIndex = layer.route.stack.findIndex(
      (entry) => entry.handle?.name === 'requireClinicalOrderVerificationAuthority',
    );
    expect(roleIndex).toBeGreaterThanOrEqual(0);
    expect(deviceIndex).toBeGreaterThan(roleIndex);
    expect(guardIndex).toBeGreaterThan(deviceIndex);
    expect(authorityIndex).toBeGreaterThan(guardIndex);
    expect(idempotencyIndex).toBeGreaterThan(authorityIndex);
    expect(layer.route.stack[idempotencyIndex].handle.__idempotency).toMatchObject({
      required: true,
      scope: 'clinical_order_verify',
    });
    expect(layer.route.stack[idempotencyIndex].handle.__idempotency.requestBodyForIdempotency({
      user: { role: ' pharmacy_staff ' },
      body: { changed: true },
    })).toEqual({
      actor_role: 'PHARMACY_STAFF',
      body: { changed: true },
    });
    expect(layer.route.stack[guardIndex].handle.__patientGuard).toMatchObject({
      recordType: 'CLINICAL_ORDER',
      resourceType: 'clinical_order',
      policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_VERIFY,
    });

    expect(getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_VERIFY)).toMatchObject({
      code: 'patient.clinical_order.verify',
      resource_type: 'clinical_order_verification',
      action: 'UPDATE',
      required_phi_level: 'patient_relationship_required',
      capability_groups: ['ip_flow', 'pharmacy'],
      relationship_checks: ['care_team', 'admission', 'break_glass'],
    });
    expect(getAccessPolicy(
      ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
    ).capability_groups).toEqual(['ip_flow', 'theatre', 'cath_lab']);
  });

  test.each(allowedRoles)('allows %s through both the exact role and capability fences', (role) => {
    const layer = route(path, 'put');
    const roleFence = layer.route.stack.find(
      (entry) => entry.handle?.name === 'requireMedicationOrderVerificationRole',
    ).handle;
    const policy = getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_VERIFY);
    const result = runRoleMiddleware(roleFence, role);

    expect(canVerifyMedicationOrderRole(role)).toBe(true);
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(result.statusCode).toBeNull();
    expect(policy.capability_groups.some(
      (group) => capabilityGroupsFor(role).includes(group),
    )).toBe(true);
  });

  test('limits pharmacy verification to medication while nursing remains generic', () => {
    for (const role of ['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST']) {
      expect(canVerifyClinicalOrderType(role, 'medication')).toBe(true);
      for (const orderType of ['investigation', 'radiology', 'procedure', 'diet', 'nursing']) {
        expect(canVerifyClinicalOrderType(role, orderType)).toBe(false);
      }
    }
    expect(canVerifyClinicalOrderType('IP_STAFF_NURSE', 'investigation')).toBe(true);
    expect(canVerifyClinicalOrderType('ICU_INCHARGE', 'procedure')).toBe(true);
    expect(canVerifyClinicalOrderType('IP_STAFF_NURSE', 'unknown')).toBe(false);
  });

  test.each([
    'DOCTOR',
    'DUTY_DOCTOR',
    'ADMIN',
    'SUPER_ADMIN',
    'OP_STAFF_NURSE',
    'CNO',
    'ICU_STAFF',
    'LAB_STAFF',
    'PATIENT',
  ])('denies non-verifier %s at the exact route fence', (role) => {
    const layer = route(path, 'put');
    const roleFence = layer.route.stack.find(
      (entry) => entry.handle?.name === 'requireMedicationOrderVerificationRole',
    ).handle;
    const result = runRoleMiddleware(roleFence, role);

    expect(canVerifyMedicationOrderRole(role)).toBe(false);
    expect(result.next).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(403);
  });
});
