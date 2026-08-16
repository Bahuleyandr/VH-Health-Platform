import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const transactionMock = jest.fn();
const referralsCreateMock = jest.fn();
const dietOrdersCreateMock = jest.fn();
const dietOrdersFindFirstMock = jest.fn();
const dietOrdersUpdateMock = jest.fn();
const downtimeSnapshotsCreateMock = jest.fn();
const attendantPassesFindFirstMock = jest.fn();
const attendantPassesFindManyMock = jest.fn();
const attendantPassesUpdateMock = jest.fn();
const admissionsFindFirstMock = jest.fn();
const wardIndentsFindFirstMock = jest.fn();
const wardIndentsCreateMock = jest.fn();
const sendStaffNotificationsMock = jest.fn();
const sendPushNotificationMock = jest.fn();
const scheduleMedicationsMock = jest.fn();
const getUnifiedActiveAllergiesMock = jest.fn();

const prismaMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
  $transaction: transactionMock,
  referrals: { create: referralsCreateMock },
  diet_orders: {
    create: dietOrdersCreateMock,
    findFirst: dietOrdersFindFirstMock,
    update: dietOrdersUpdateMock,
  },
  downtime_snapshots: { create: downtimeSnapshotsCreateMock },
  attendant_passes: {
    findFirst: attendantPassesFindFirstMock,
    findMany: attendantPassesFindManyMock,
    update: attendantPassesUpdateMock,
  },
  admissions: { findFirst: admissionsFindFirstMock },
  ward_indents: {
    findFirst: wardIndentsFindFirstMock,
    create: wardIndentsCreateMock,
  },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(prismaMock),
  pickTenantClient: () => prismaMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: sendStaffNotificationsMock,
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: sendPushNotificationMock,
}));
jest.unstable_mockModule('../../services/billing/paymentLinkService.js', () => ({}));
jest.unstable_mockModule('../../services/gamification/pointService.js', () => ({
  getUserPointSummary: jest.fn(),
}));
jest.unstable_mockModule('../../services/portal/portalAccessService.js', () => ({
  evaluatePanelRelease: jest.fn(),
  getResultEpisodeReleaseDecision: jest.fn(async () => ({ outcome: 'unsupported_source' })),
  releaseVisibilitySql: jest.fn(() => 'TRUE'),
  structuredDiagnosticReleaseVisibilitySql: jest.fn(() => 'TRUE'),
  releaseDelayHours: jest.fn(() => 0),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  resolveTenantOrThrow: (req) => req?.tenantId || '00000000-0000-4000-8000-000000000001',
  requireTenantId: (tenantId) => tenantId || '00000000-0000-4000-8000-000000000001',
  // Phase 4: ledgerAuthoritativeMode (pulled in via the billing money-write path)
  // statically imports getTenantById; provide it for ESM linking.
  getTenantById: jest.fn(async () => ({ settings: {} })),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  completeWorkflowSla: jest.fn(),
  currentCanonicalTransactionRevision: jest.fn(async () => 1),
  recordClinicalAuditEvent: jest.fn(),
  recordCanonicalClinicalEvent: jest.fn(),
  recordTimelineEvent: jest.fn(),
  startWorkflowSla: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: getUnifiedActiveAllergiesMock,
  // kitchenService (statically imported by dietaryService) also pulls the
  // detailed variant; shape mirrors allergySourceService's empty result.
  getUnifiedActiveAllergiesDetailed: jest.fn(async () => ({
    allergies: [], sourcesFailed: [], patientResolved: true,
  })),
}));
jest.unstable_mockModule('../../services/clinical/marService.js', () => ({
  scheduleMedications: scheduleMedicationsMock,
}));

const portalService = await import('../../services/portal/patientPortalService.js');
const referralService = (await import('../../services/referral/referralService.js')).default;
const dietaryService = (await import('../../services/dietary/dietaryService.js')).default;
const theatreService = (await import('../../services/theatre/theatreService.js')).default;
const schedulingService = await import('../../services/scheduling/schedulingOptimizationService.js');
const smartPhrasesService = await import('../../services/productivity/smartPhrasesService.js');
const downtimeService = await import('../../services/downtime/wardDowntimePackService.js');
const credentialingService = await import('../../services/staff/credentialingService.js');
const ipdSupportService = (await import('../../services/ipd/ipdSupportService.js')).default;
const icuService = await import('../../services/clinical/icuService.js');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const STAFF_UID = '33333333-3333-4333-8333-333333333333';
const OTHER_STAFF_UID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  for (const fn of [
    queryRawUnsafeMock,
    executeRawUnsafeMock,
    transactionMock,
    referralsCreateMock,
    dietOrdersCreateMock,
    dietOrdersFindFirstMock,
    dietOrdersUpdateMock,
    downtimeSnapshotsCreateMock,
    attendantPassesFindFirstMock,
    attendantPassesFindManyMock,
    attendantPassesUpdateMock,
    admissionsFindFirstMock,
    wardIndentsFindFirstMock,
    wardIndentsCreateMock,
    sendStaffNotificationsMock,
    sendPushNotificationMock,
    scheduleMedicationsMock,
    getUnifiedActiveAllergiesMock,
  ]) {
    fn.mockReset();
  }
});

describe('Worker P portal patient-message authorization', () => {
  it('scopes non-manager staff inboxes to the viewer assignee', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await portalService.listStaffInbox({
      tenantId: TENANT_ID,
      viewer_uid: STAFF_UID,
      can_view_all: false,
    });

    const [sql, ...params] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain('tenant_id = $1::uuid');
    expect(sql).toContain('assigned_staff_uid');
    expect(params).toEqual([TENANT_ID, STAFF_UID, 100]);
  });

  it('blocks staff replies to patient threads assigned to another staff member', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      id: 9,
      patient_uid: PATIENT_UID,
      assigned_staff_uid: OTHER_STAFF_UID,
    }]);

    await expect(portalService.appendMessage({
      tenantId: TENANT_ID,
      thread_id: 9,
      sender_kind: 'staff',
      sender_uid: STAFF_UID,
      body: 'I can help.',
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Assigned staff access required',
    });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('Worker P referral creation authorization', () => {
  it('requires an active patient relationship before creating a referral', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce([]);

    await expect(referralService.createReferral({
      tenant_id: TENANT_ID,
      patient_uid: PATIENT_UID,
      requester_id: STAFF_UID,
      referring_doctor: STAFF_UID,
      actor_role: 'DOCTOR',
      referred_to_department: 'Cardiology',
      reason: 'Review for chest pain',
    })).rejects.toMatchObject({
      statusCode: 403,
      message: 'Referral creation requires an active patient relationship',
    });
    expect(referralsCreateMock).not.toHaveBeenCalled();
  });
});

describe('Worker P dietary authorization', () => {
  it('verifies patient tenant before creating a diet order and persists tenant_id', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    dietOrdersCreateMock.mockResolvedValueOnce({ id: 12, tenant_id: TENANT_ID });

    await dietaryService.createDietOrder({
      tenant_id: TENANT_ID,
      patient_uid: PATIENT_UID,
      diet_type: 'renal',
      ordered_by: STAFF_UID,
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([TENANT_ID, PATIENT_UID]);
    expect(dietOrdersCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenant_id: TENANT_ID, patient_uid: PATIENT_UID }),
    }));
  });

  it('tenant-checks patients before returning dietary history', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce([{ count: '0' }])
      .mockResolvedValueOnce([]);

    await dietaryService.getPatientDietHistory(PATIENT_UID, { tenantId: TENANT_ID });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('tenant_id = $1::uuid AND patient_uid = $2::uuid');
    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain('tenant_id = $1::uuid AND patient_uid = $2::uuid');
  });
});

describe('Worker P theatre authorization', () => {
  it('tenant-checks the patient before inserting an OT schedule', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce([{ id: 31, patient_uid: PATIENT_UID, tenant_id: TENANT_ID }]);

    await theatreService.scheduleSurgery({
      tenantId: TENANT_ID,
      patient_uid: PATIENT_UID,
      surgeon: STAFF_UID,
      procedure_name: 'Appendectomy',
      scheduled_date: '2026-06-12',
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $1::uuid');
    const [insertSql, ...insertParams] = queryRawUnsafeMock.mock.calls[1];
    expect(insertSql).toContain('tenant_id');
    expect(insertParams.at(-1)).toBe(TENANT_ID);
  });
});

describe('Worker P scheduling authorization', () => {
  it('tenant-checks patient and doctor before creating a waitlist entry', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce([{ id: 77, tenant_id: TENANT_ID }]);

    await schedulingService.addToWaitlist({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      doctorId: 42,
      preferredWindow: 'am',
    }, { actorUid: STAFF_UID });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain('(tenant_id, patient_uid, doctor_id');
    expect(queryRawUnsafeMock.mock.calls[2][1]).toBe(TENANT_ID);
  });

  it('creates bookable resources inside the caller tenant namespace', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 6, tenant_id: TENANT_ID }]);

    await schedulingService.createResource({
      tenantId: TENANT_ID,
      kind: 'room',
      name: 'Procedure Room 1',
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('(tenant_id, kind, name, location, service_code');
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(TENANT_ID);
  });
});

describe('Worker P smart phrase ownership', () => {
  it('blocks non-admin creation of tenant-shared smart phrases', async () => {
    await expect(smartPhrasesService.create({
      tenantId: TENANT_ID,
      owner_uid: STAFF_UID,
      code: '.handoff',
      title: 'Handoff',
      body: 'Handoff body',
      scope: 'tenant_shared',
      can_manage_shared: false,
    })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('limits shared phrase updates to owner or admin', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 5, tenant_id: TENANT_ID }]);

    await smartPhrasesService.update({
      tenantId: TENANT_ID,
      id: 5,
      owner_uid: STAFF_UID,
      title: 'Updated',
    });

    const [sql] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toContain("scope = 'tenant_shared' AND owner_uid");
    expect(sql).toContain("scope = 'private' AND owner_uid");
    expect(sql).toContain('tenant_id');
    expect(sql).toContain('RETURNING *');
  });
});

describe('Worker P downtime authorization', () => {
  it('generates ward packs only from occupied beds in the caller tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    executeRawUnsafeMock.mockResolvedValueOnce({ count: 0 });

    await downtimeService.generateWardDowntimePacks({ tenantId: TENANT_ID, generatedBy: STAFF_UID });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('b.tenant_id = $1::uuid');
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(TENANT_ID);
    expect(executeRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(executeRawUnsafeMock.mock.calls[0][2]).toBe(TENANT_ID);
  });
});

describe('Worker P credentialing authorization', () => {
  it('requires staff to exist in the caller tenant before adding credentials', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    // Non-privilege evidence still goes through addCredential (privileges are
    // approval-only). This exercises the staff-in-tenant guard.
    await expect(credentialingService.addCredential({
      tenantId: TENANT_ID,
      staffUid: STAFF_UID,
      credentialType: 'registration',
      name: 'State Medical Council Registration',
    }, { actorUid: OTHER_STAFF_UID })).rejects.toMatchObject({
      statusCode: 404,
      code: 'CRED_STAFF_NOT_FOUND',
    });

    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });
});

describe('Worker P IPD support authorization', () => {
  it('filters attendant pass reads by admission and tenant', async () => {
    attendantPassesFindManyMock.mockResolvedValueOnce([]);

    await ipdSupportService.listAdmissionPasses(88, { tenantId: TENANT_ID });

    expect(attendantPassesFindManyMock).toHaveBeenCalledWith({
      where: { admission_id: 88, tenant_id: TENANT_ID },
      orderBy: { pass_index: 'asc' },
    });
  });

  it('does not revoke an attendant pass outside the caller tenant', async () => {
    attendantPassesFindFirstMock.mockResolvedValueOnce(null);

    await expect(ipdSupportService.revokeAttendantPass({
      tenantId: TENANT_ID,
      passId: 17,
      revokedBy: STAFF_UID,
    })).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(attendantPassesUpdateMock).not.toHaveBeenCalled();
  });

  it('filters ward indent detail reads by tenant', async () => {
    wardIndentsFindFirstMock.mockResolvedValueOnce(null);

    await ipdSupportService.getWardIndent(45, { tenantId: TENANT_ID });

    expect(wardIndentsFindFirstMock).toHaveBeenCalledWith({
      where: { id: 45, tenant_id: TENANT_ID },
      include: { items: true },
    });
  });
});

describe('Worker P ICU authorization', () => {
  it('checks ICU admission tenant before writing flowsheet child rows', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);

    await expect(icuService.logFlowsheet({
      tenantId: TENANT_ID,
      icu_admission_id: 55,
      recorded_by: STAFF_UID,
      hr: 90,
    })).rejects.toMatchObject({
      statusCode: 404,
      message: 'ICU admission not found',
    });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('tenant_id = $2::uuid');
  });
});
