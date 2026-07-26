import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const CLINICIAN_UID = '30000000-0000-4000-8000-000000000001';
const APPOINTMENT_ID = 71;
const PRIOR_APPOINTMENT_ID = 70;
const FOLLOW_UP_PLAN_ID = 91;

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: jest.fn(),
  requireTenantId: value => value,
}));
jest.unstable_mockModule(
  '../../services/clinical/canonicalClinicalPlatformService.js',
  () => ({
    recordCanonicalClinicalEvent: jest.fn(),
  }),
);
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(),
}));
jest.unstable_mockModule(
  '../../services/appointment/appointmentLifecycleService.js',
  () => ({
    appendAppointmentStatusHistoryTx: jest.fn(),
    lockAppointmentForLifecycleTx: jest.fn(),
  }),
);

const { __testing__: closureProducerTesting } = await import(
  '../../services/appointment/opVisitClosureEvidenceService.js'
);
const { __testing__: pathwayWorkTesting } = await import(
  '../../services/appointment/opPathwayWorkService.js'
);

test('closure recording rejects a same-patient follow-up plan from a prior appointment', async () => {
  const query = jest.fn(async (sql, _tenantId, _patientUid, _planId, appointmentId) => {
    if (!sql.includes('FROM follow_up_plans')) {
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    return appointmentId === PRIOR_APPOINTMENT_ID ? [{ id: FOLLOW_UP_PLAN_ID }] : [];
  });

  await expect(closureProducerTesting.validateFollowUpTx(
    { $queryRawUnsafe: query },
    {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: APPOINTMENT_ID,
      followUpPlanId: FOLLOW_UP_PLAN_ID,
    },
  )).rejects.toMatchObject({
    statusCode: 400,
    code: 'OP_CLOSURE_FOLLOW_UP_INVALID',
  });

  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("origin_kind = 'consultation'"),
    TENANT_ID,
    PATIENT_UID,
    FOLLOW_UP_PLAN_ID,
    APPOINTMENT_ID,
  );
  const sql = query.mock.calls[0][0];
  expect(sql).toContain("origin_resource_type = 'appointment'");
  expect(sql).toContain('origin_resource_id = $4::integer::text');
  expect(sql).toContain("status IN ('open', 'scheduled')");
});

test('closure re-evaluation blocks prior-appointment follow-up lineage for the same patient', async () => {
  const query = jest.fn(async (sql, ...params) => {
    if (sql.includes('FROM users')) {
      return [{ uid: CLINICIAN_UID, role: 'DOCTOR', is_active: true }];
    }
    if (sql.includes('FROM follow_up_plans')) {
      const requestedAppointmentId = params[3];
      return requestedAppointmentId === PRIOR_APPOINTMENT_ID
        ? [{ id: FOLLOW_UP_PLAN_ID }]
        : [];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const blockers = await pathwayWorkTesting.closureEvidenceBlockersTx(
    { $queryRawUnsafe: query },
    {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: APPOINTMENT_ID,
      doctorUid: CLINICIAN_UID,
      pathwayInstanceId: null,
      evidence: {
        clinician_uid: CLINICIAN_UID,
        follow_up_required: true,
        follow_up_plan_id: FOLLOW_UP_PLAN_ID,
        patient_next_steps: [{ label: 'Return for review' }],
        closure_basis: 'all_required_work_completed',
        accepted_handoff_id: null,
      },
    },
  );

  expect(blockers).toEqual([
    expect.objectContaining({
      code: 'APPOINTMENT_CLOSURE_FOLLOW_UP_INVALID',
    }),
  ]);
  const followUpCall = query.mock.calls.find(([sql]) => sql.includes('FROM follow_up_plans'));
  expect(followUpCall.slice(1)).toEqual([
    TENANT_ID,
    PATIENT_UID,
    FOLLOW_UP_PLAN_ID,
    APPOINTMENT_ID,
  ]);
});
