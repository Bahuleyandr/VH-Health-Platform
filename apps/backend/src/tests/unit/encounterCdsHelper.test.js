/**
 * Phase D2 — encounterCdsHelper unit tests.
 *
 * Covers the encounter-start + encounter-discharge alert assemblers.
 * Mocks prisma.$queryRawUnsafe + cdsEngine helpers so we can drive
 * each branch independently.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const getActiveAlertsMock = jest.fn();
const getProtocolRemindersMock = jest.fn();
const getUnifiedActiveAllergiesMock = jest.fn(async () => []);

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  // B7/B8: the helper now reaches problemListService → terminologyService,
  // which named-imports prismaReadOnly; route reads through the same mock.
  prismaReadOnly: { $queryRawUnsafe: queryUnsafeMock },
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));
jest.unstable_mockModule('../../services/emr/cdsEngine.js', () => ({
  getActiveAlerts: getActiveAlertsMock,
  getProtocolReminders: getProtocolRemindersMock,
  // Only these two are imported; the others stay unmocked for other tests.
}));
// getUnifiedActiveAllergies queries 4 stores internally (patient resolution +
// patient_allergies + legacy allergies + admission intake). Mock it at the
// SERVICE level so this test asserts the helper's alert logic without tracking
// the allergy service's internal $queryRawUnsafe call count — that count changed
// in the audit-2026-06-18 fail-open-UNION fix (a leading `SELECT … FROM users`
// resolution query was added), which silently desynced the old positional
// $queryRawUnsafe sequence mock and dropped the downstream alerts.
jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: getUnifiedActiveAllergiesMock,
  mergeAllergyRows: (rows) => rows,
  rankSeverity: () => 0,
  SEVERE_BLOCK_RANK: 4,
  default: { getUnifiedActiveAllergies: getUnifiedActiveAllergiesMock },
}));

const {
  buildEncounterDischargeAlerts,
  buildEncounterStartAlerts,
} = await import('../../services/cds/encounterCdsHelper.js');

const PATIENT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getActiveAlertsMock.mockReset();
  getProtocolRemindersMock.mockReset();
  getUnifiedActiveAllergiesMock.mockReset();
  getUnifiedActiveAllergiesMock.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// encounter-start
// ---------------------------------------------------------------------------

describe('buildEncounterStartAlerts', () => {
  it('returns empty array when patientUid missing', async () => {
    const alerts = await buildEncounterStartAlerts({ patientUid: null });
    expect(alerts).toEqual([]);
  });

  it('combines active alerts + protocol reminders + allergies + follow-ups + tasks', async () => {
    getActiveAlertsMock.mockResolvedValueOnce([
      { alert_type: 'sepsis_risk', severity: 'critical', title: 'Sepsis risk',
        description: 'NEWS2 = 7', acknowledged: false, source_data: { news2: 7 } },
    ]);
    getProtocolRemindersMock.mockResolvedValueOnce([
      { type: 'protocol_reminder', severity: 'warning', title: 'VTE prophylaxis due', description: 'NICE NG89' },
    ]);
    getUnifiedActiveAllergiesMock.mockResolvedValueOnce([
      { allergen: 'penicillin', severity: 'severe', sources: ['patient_allergies'] },
      { allergen: 'sulfa', severity: 'mild', sources: ['patient_allergies'] },
    ]); // allergies (service-level)
    queryUnsafeMock.mockResolvedValueOnce([]); // active problems (B7)
    queryUnsafeMock.mockResolvedValueOnce([
      {
        id: 5,
        origin_kind: 'discharge',
        due_at: new Date(Date.now() - 86400000).toISOString(),
        // The query selects an epoch twin beside due_at: a timestamptz read back
        // through the driver is shifted by the database session timezone, so the
        // overdue comparison reads the epoch instead.
        due_at_epoch_ms: BigInt(Date.now() - 86400000),
        reason: '6w post-op',
      },
    ]); // follow-ups (overdue)
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 7, title: 'Review labs', priority: 'critical', due_at: null, due_at_epoch_ms: null, task_kind: 'review' },
    ]); // tasks

    const alerts = await buildEncounterStartAlerts({ patientUid: PATIENT, encounterId: 42 });

    const types = alerts.map((a) => a.type);
    expect(types).toContain('sepsis_risk');
    expect(types).toContain('protocol_reminder');
    expect(types).toContain('allergies_on_file');
    expect(types).toContain('follow_up_plan_due');
    expect(types).toContain('open_task_high_priority');

    // Overdue follow-up should be warning, not info
    const fu = alerts.find((a) => a.type === 'follow_up_plan_due');
    expect(fu.severity).toBe('warning');

    // Critical task -> critical severity
    const task = alerts.find((a) => a.type === 'open_task_high_priority');
    expect(task.severity).toBe('critical');
  });

  it('survives schema-missing on optional tables', async () => {
    getActiveAlertsMock.mockResolvedValueOnce([]);
    getProtocolRemindersMock.mockResolvedValueOnce([]);
    // allergies degrade to [] via the service-level mock (default in beforeEach);
    // the remaining optional tables still throw schema-missing and are swallowed.
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "patient_problems" does not exist'));
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "follow_up_plans" does not exist'));
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "tasks" does not exist'));
    const alerts = await buildEncounterStartAlerts({ patientUid: PATIENT });
    expect(alerts).toEqual([]);
  });

  it('survives cdsEngine errors gracefully (logs, not throws)', async () => {
    getActiveAlertsMock.mockRejectedValueOnce(new Error('db down'));
    getProtocolRemindersMock.mockRejectedValueOnce(new Error('db down'));
    queryUnsafeMock.mockResolvedValueOnce([]);  // active problems (B7)
    queryUnsafeMock.mockResolvedValueOnce([]);  // follow-ups
    queryUnsafeMock.mockResolvedValueOnce([]);  // tasks
    const alerts = await buildEncounterStartAlerts({ patientUid: PATIENT });
    expect(alerts).toEqual([]);
  });

  it('produces info severity for due-but-not-overdue follow-up', async () => {
    getActiveAlertsMock.mockResolvedValueOnce([]);
    getProtocolRemindersMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]); // active problems (B7)
    const futureMs = Date.now() + 7 * 86400000;
    const future = new Date(futureMs).toISOString();
    queryUnsafeMock.mockResolvedValueOnce([
      // Twin supplied so 'info' is proven for a genuinely-future instant —
      // without it the overdue check reads null and this assertion would stay
      // green even if the window logic broke.
      { id: 5, origin_kind: 'consultation', due_at: future, due_at_epoch_ms: BigInt(futureMs), reason: 'follow-up' },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]); // tasks
    const alerts = await buildEncounterStartAlerts({ patientUid: PATIENT });
    const fu = alerts.find((a) => a.type === 'follow_up_plan_due');
    expect(fu.severity).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// encounter-discharge
// ---------------------------------------------------------------------------

describe('buildEncounterDischargeAlerts', () => {
  it('returns empty array when patientUid missing', async () => {
    expect(await buildEncounterDischargeAlerts({ patientUid: null })).toEqual([]);
  });

  it('flags unsigned orders + unscheduled follow-ups + outstanding goals + unack critical alerts + missing discharge summary', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, status: 'pending_signature', order_type: 'medication' },
      { id: 2, status: 'draft', order_type: 'investigation' },
    ]); // unsigned orders
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 3, origin_kind: 'discharge', reason: 'wound check' },
    ]); // unscheduled follow-ups
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 10, description: 'HbA1c < 7', priority: 'high' },
    ]); // unachieved goals
    getActiveAlertsMock.mockResolvedValueOnce([
      { alert_type: 'critical_lab', severity: 'critical', title: 'Hb 6.2', description: 'critical low', acknowledged: false, source_data: {} },
      { alert_type: 'critical_lab', severity: 'critical', title: 'K+ 6.5', description: 'critical high', acknowledged: true, source_data: {} },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]); // discharge summary lookup -> missing

    const alerts = await buildEncounterDischargeAlerts({ patientUid: PATIENT, encounterId: 42 });
    const types = alerts.map((a) => a.type);
    expect(types).toContain('unsigned_orders');
    expect(types).toContain('follow_up_unscheduled');
    expect(types).toContain('unachieved_care_goals');
    expect(types).toContain('missing_discharge_summary');
    // Only the unacknowledged critical alert should pass through.
    const critical = alerts.filter((a) => String(a.title).startsWith('Unacknowledged critical:'));
    expect(critical).toHaveLength(1);
    expect(critical[0].title).toContain('Hb 6.2');
  });

  it('skips missing-discharge-summary check when encounterId not provided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // unsigned
    queryUnsafeMock.mockResolvedValueOnce([]); // follow-ups
    queryUnsafeMock.mockResolvedValueOnce([]); // goals
    getActiveAlertsMock.mockResolvedValueOnce([]);
    const alerts = await buildEncounterDischargeAlerts({ patientUid: PATIENT });
    expect(alerts.find((a) => a.type === 'missing_discharge_summary')).toBeUndefined();
  });

  it('does NOT flag missing-discharge-summary when one is signed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    getActiveAlertsMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 99, decision: 'accepted' }]);
    const alerts = await buildEncounterDischargeAlerts({ patientUid: PATIENT, encounterId: 42 });
    expect(alerts.find((a) => a.type === 'missing_discharge_summary')).toBeUndefined();
  });

  it('survives schema-missing on every optional table', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "clinical_orders" does not exist'));
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "follow_up_plans" does not exist'));
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "care_plan_goals" does not exist'));
    getActiveAlertsMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "clinical_ai_reviews" does not exist'));
    const alerts = await buildEncounterDischargeAlerts({ patientUid: PATIENT, encounterId: 42 });
    expect(alerts).toEqual([]);
  });
});
