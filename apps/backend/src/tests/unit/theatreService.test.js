import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Canonical timeline/audit writes are emitted in the same tx as each mutation
// (audit 2026-06-18 §3 fix #1). They are exercised end-to-end in the deep
// integration suite (theatre-clinical-safety.deep.test.js); here they are
// mocked so the unit tests keep asserting the detail-row SQL without the
// canonical-event queries consuming the mock sequence.
const recordCanonicalClinicalEventMock = jest.fn(async () => ({ timeline: null, audit: null }));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const theatreService = (await import('../../services/theatre/theatreService.js')).default;

const SURGEON_UID = 'ba000000-0000-4000-8000-00000000a002';
const OTHER_SURGEON_UID = 'ba000000-0000-4000-8000-00000000a006';
const ANESTHETIST_UID = 'ba000000-0000-4000-8000-00000000a003';
const ADMIN_UID = 'ba000000-0000-4000-8000-00000000a004';
const NURSE_UID = 'ba000000-0000-4000-8000-00000000a005';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  recordCanonicalClinicalEventMock.mockClear();
});

function rightEyeSchedule() {
  return {
    id: 3,
    tenant_id: TENANT_ID,
    status: 'pre_op',
    patient_uid: 'ba000000-0000-4000-8000-00000000a001',
    procedure_name: 'Right eye cataract surgery',
    procedure_code: null,
  };
}

describe('theatreService.completeChecklist', () => {
  it('rejects OT-ready when the surgical site is not marked', async () => {
    queryUnsafeMock.mockResolvedValueOnce([rightEyeSchedule()]);

    await expect(theatreService.completeChecklist(3, {
      ot_ready: true,
      fasting_confirmed: true,
      site_marked: false,
      site_marked_eye: 'right',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'SURGICAL_SITE_MARK_REQUIRED',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects OT-ready when the marked side does not match the procedure', async () => {
    queryUnsafeMock.mockResolvedValueOnce([rightEyeSchedule()]);

    await expect(theatreService.completeChecklist(3, {
      ot_ready: true,
      fasting_confirmed: true,
      site_marked: true,
      site_marked_eye: 'left',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'SURGICAL_SITE_SIDE_MISMATCH',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('persists OT-ready when the site mark matches the scheduled side', async () => {
    const checklist = {
      ot_ready: true,
      fasting_confirmed: true,
      site_marked: true,
      site_marked_eye: 'right',
      blood_glucose_mg_dl: 142,
      eye_dilatation_drops: true,
    };
    queryUnsafeMock
      .mockResolvedValueOnce([rightEyeSchedule()])
      .mockResolvedValueOnce([{ id: 3, pre_op_checklist: checklist }])
      .mockResolvedValueOnce([{ id: 88 }]);

    const result = await theatreService.completeChecklist(3, checklist, {
      tenantId: TENANT_ID,
      completedBy: NURSE_UID,
    });

    expect(result.id).toBe(3);
    expect(result.pre_op_check_id).toBe(88);
    expect(JSON.parse(queryUnsafeMock.mock.calls[1][1])).toMatchObject(checklist);
    const [sql, ...params] = queryUnsafeMock.mock.calls[2];
    expect(sql).toMatch(/INSERT INTO preop_checklists/);
    expect(sql).toMatch(/ON CONFLICT \(tenant_id, ot_schedule_id\)/);
    expect(params).toContain(142);
    expect(params).toContain(NURSE_UID);
  });

  it('rejects OT-ready when the checklist itself marks the patient diabetic without glucose', async () => {
    queryUnsafeMock.mockResolvedValueOnce([rightEyeSchedule()]);

    await expect(theatreService.completeChecklist(3, {
      ot_ready: true,
      fasting_confirmed: true,
      site_marked: true,
      site_marked_eye: 'right',
      diabetic_patient: true,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'DIABETIC_GLUCOSE_CHECK_REQUIRED',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });
});

describe('theatreService.updateStatus closure gates', () => {
  function currentSchedule(status = 'in_progress') {
    return { id: 42, status };
  }

  function closureSchedule(overrides = {}) {
    return {
      surgeon: SURGEON_UID,
      consent_obtained: true,
      pre_op_checklist: {},
      ...overrides,
    };
  }

  function finalizedAnesthesia() {
    return {
      status: 'finalized',
      finalized_by: ANESTHETIST_UID,
      finalized_at: new Date('2026-05-15T10:00:00.000Z'),
    };
  }

  function finalizedIntraop(overrides = {}) {
    return {
      status: 'finalized',
      finalized_by: SURGEON_UID,
      finalized_at: new Date('2026-05-15T10:05:00.000Z'),
      sponge_count_correct: true,
      sharp_count_correct: true,
      instrument_count_correct: true,
      ...overrides,
    };
  }

  it('rejects post-op closure until surgical consent is documented', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([currentSchedule()])
      .mockResolvedValueOnce([closureSchedule({ consent_obtained: false })])
      .mockResolvedValueOnce([]);

    await expect(theatreService.updateStatus(42, 'post_op', ADMIN_UID)).rejects.toMatchObject({
      statusCode: 400,
      code: 'SURGICAL_CONSENT_REQUIRED',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
  });

  it('accepts consent documented on the legacy theatre checklist', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([currentSchedule()]) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce([closureSchedule({   // _assertReadyForClosure: schedule
        consent_obtained: false,
        pre_op_checklist: { consent_signed: true },
      })])
      .mockResolvedValueOnce([]) // preop_checklist (no structured consent row)
      .mockResolvedValueOnce([finalizedAnesthesia()])
      .mockResolvedValueOnce([finalizedIntraop()])
      .mockResolvedValueOnce([{ status: 'complete' }]) // WHO sign_out (fix #4)
      .mockResolvedValueOnce([{ id: 42, status: 'post_op' }]); // UPDATE ... AND status=$current

    const result = await theatreService.updateStatus(42, 'post_op', ADMIN_UID);

    expect(result.status).toBe('post_op');
  });

  it('rejects closure when the WHO sign-out is not complete', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([currentSchedule()])
      .mockResolvedValueOnce([closureSchedule()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([finalizedAnesthesia()])
      .mockResolvedValueOnce([finalizedIntraop()])
      .mockResolvedValueOnce([]); // no sign_out row

    await expect(theatreService.updateStatus(42, 'post_op', ADMIN_UID)).rejects.toMatchObject({
      statusCode: 400,
      code: 'WHO_SIGNOUT_REQUIRED',
    });
  });

  it('rejects closure when sponge, sharp, or instrument counts are not all correct', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([currentSchedule()])
      .mockResolvedValueOnce([closureSchedule()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([finalizedAnesthesia()])
      .mockResolvedValueOnce([finalizedIntraop({ instrument_count_correct: false })]);

    await expect(theatreService.updateStatus(42, 'post_op', ADMIN_UID)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INSTRUMENT_COUNTS_REQUIRED',
      details: expect.objectContaining({ instrument_count_correct: false }),
    });
  });

  it('rejects closure when a non-booked surgeon signs the intraop note', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([currentSchedule()])
      .mockResolvedValueOnce([closureSchedule()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([finalizedAnesthesia()])
      .mockResolvedValueOnce([finalizedIntraop({ finalized_by: OTHER_SURGEON_UID })]);

    await expect(theatreService.updateStatus(42, 'post_op', ADMIN_UID)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BOOKED_SURGEON_SIGNOFF_REQUIRED',
      details: expect.objectContaining({
        booked_surgeon: SURGEON_UID,
        finalized_by: OTHER_SURGEON_UID,
      }),
    });
  });
});
