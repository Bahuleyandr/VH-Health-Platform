import { jest } from '@jest/globals';

const controls = {
  staffError: null,
  shiftsError: null,
  ptoError: null,
  generationError: null,
  burnoutReviewError: null,
  clinicalReviewError: null,
  listError: null,
  ptoRows: [],
};

const queryRawUnsafeMock = jest.fn(async (sql) => {
  const query = String(sql);
  if (query.includes('FROM users u') && query.includes('LEFT JOIN staff s')) {
    if (controls.staffError) throw controls.staffError;
    return [{
      staff_uid: '00000000-0000-4000-8000-0000000000b1',
      name: 'Nurse One',
      role: 'NURSING_STAFF',
      department: 'ICU',
    }];
  }
  if (query.includes('FROM staff_attendance')) {
    if (controls.shiftsError) throw controls.shiftsError;
    return [];
  }
  if (query.includes('SELECT id') && query.includes('FROM users')) return [{ id: 1 }];
  if (query.includes('FROM leave_requests')) {
    const err = new Error('relation "leave_requests" does not exist');
    err.code = '42P01';
    throw err;
  }
  if (query.includes('FROM leave_applications')) {
    if (controls.ptoError) throw controls.ptoError;
    return controls.ptoRows;
  }
  if (query.includes('FROM clinical_ai_prompts')) return [];
  if (query.includes('INSERT INTO clinical_ai_generations')) {
    if (controls.generationError) throw controls.generationError;
    return [{ id: 10, status: 'draft' }];
  }
  if (query.includes('INSERT INTO clinical_ai_staff_burnout_reviews')) {
    if (controls.burnoutReviewError) throw controls.burnoutReviewError;
    return [{ id: 20, reviewer_decision: 'pending' }];
  }
  if (query.includes('INSERT INTO clinical_ai_reviews')) {
    if (controls.clinicalReviewError) throw controls.clinicalReviewError;
    return [{ id: 30, decision: 'pending' }];
  }
  if (query.includes('FROM clinical_ai_staff_burnout_reviews r')) {
    if (controls.listError) throw controls.listError;
    return [];
  }
  throw new Error(`Unexpected SQL in staff burnout honesty test: ${query.slice(0, 80)}`);
});

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
jest.unstable_mockModule('../../services/ai/clinicalAiModuleService.js', () => ({
  getClinicalAiModule: jest.fn(async () => ({
    enabled: true,
    display_name: 'Staff burnout workload risk',
    settings: { requiresClinicianSignoff: true },
  })),
}));
jest.unstable_mockModule('../../services/ai/localLlmClient.js', () => ({
  generateClinicalText: jest.fn(async () => {
    throw new Error('model unavailable');
  }),
}));
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: jest.fn(async () => ({ id: 1 })),
}));

const {
  evaluateStaffBurnout,
  listStaffBurnoutReviews,
} = await import('../../services/ai/staffBurnoutRiskService.js');

const req = {
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  user: { uid: '00000000-0000-4000-8000-0000000000c1' },
};
const staffUid = '00000000-0000-4000-8000-0000000000b1';

describe('staff burnout evidence and persistence failures', () => {
  beforeEach(() => {
    Object.keys(controls).forEach((key) => { controls[key] = key === 'ptoRows' ? [] : null; });
    queryRawUnsafeMock.mockClear();
  });

  test.each([
    ['shift evidence', 'shiftsError'],
    ['PTO evidence', 'ptoError'],
    ['generation persistence', 'generationError'],
    ['burnout-review persistence', 'burnoutReviewError'],
    ['clinical-review persistence', 'clinicalReviewError'],
  ])('%s fault rejects instead of returning a low or untracked result', async (_label, control) => {
    controls[control] = new Error(`${control} unavailable`);

    await expect(evaluateStaffBurnout({ req, staffUid }))
      .rejects.toThrow(`${control} unavailable`);
  });

  test('review-list fault rejects instead of returning an empty authoritative list', async () => {
    controls.listError = new Error('review list unavailable');

    await expect(listStaffBurnoutReviews({ tenantId: req.tenantId }))
      .rejects.toThrow('review list unavailable');
  });

  test('loads tenant-scoped PTO evidence from canonical leave applications', async () => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setUTCDate(today.getUTCDate() - 1);
    controls.ptoRows = [{
      start_date: yesterday.toISOString().slice(0, 10),
      end_date: today.toISOString().slice(0, 10),
      status: 'approved',
    }];

    const result = await evaluateStaffBurnout({ req, staffUid });

    const identityCall = queryRawUnsafeMock.mock.calls.find(([sql]) => (
      String(sql).includes('SELECT id') && String(sql).includes('FROM users')
    ));
    expect(String(identityCall?.[0])).toContain('tenant_id = $1::uuid');
    expect(identityCall?.slice(1)).toEqual([req.tenantId, staffUid]);

    const leaveCall = queryRawUnsafeMock.mock.calls.find(([sql]) => String(sql).includes('FROM leave_applications'));
    expect(String(leaveCall?.[0])).toContain('tenant_id = $1::uuid');
    expect(leaveCall?.slice(1, 3)).toEqual([req.tenantId, 1]);
    expect(queryRawUnsafeMock.mock.calls.some(([sql]) => String(sql).includes('FROM leave_requests'))).toBe(false);
    expect(result.source_citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_type: 'leave_applications' }),
    ]));
  });
});
