/**
 * Phase E1 — breachService unit tests covering the GDPR Art. 33/34
 * notification flows added in 2026-04-30.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  getBreaches,
  getBreachTimeline,
  notifyDataSubjects,
  notifyRegulator,
  reportBreach,
} = await import('../../services/compliance/breachService.js');

const USER = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe('breach listing queries', () => {
  it('selects schema-backed notification fields when listing breaches', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ total: '1' }])
      .mockResolvedValueOnce([{ breach_id: 'B-001' }]);

    await getBreaches();

    const selectSql = queryUnsafeMock.mock.calls[1][0];
    expect(selectSql).not.toMatch(/notification_sent_at/);
    expect(selectSql).toMatch(/data_subjects_notified_at/);
    expect(selectSql).toMatch(/regulator_notified_at/);
  });

  it('selects schema-backed notification fields for breach timelines', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ breach_id: 'B-001' }])
      .mockResolvedValueOnce([]);

    await getBreachTimeline('B-001');

    const selectSql = queryUnsafeMock.mock.calls[0][0];
    expect(selectSql).not.toMatch(/notification_sent_at/);
    expect(selectSql).toMatch(/data_subjects_notified_at/);
    expect(selectSql).toMatch(/regulator_notified_at/);
  });

  it('does not write the removed notification_sent_at column for admin alerts', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        breach_id: 'B-001',
        severity: 'critical',
        affected_records: 12,
      }])
      .mockResolvedValueOnce([{ uid: USER, name: 'Admin' }])
      .mockResolvedValueOnce([]);

    await reportBreach({
      severity: 'critical',
      description: 'Test breach',
      affectedRecords: 12,
      affectedPatientUids: [],
      reportedBy: USER,
    });

    const sql = queryUnsafeMock.mock.calls.map((call) => call[0]).join('\n');
    expect(sql).toMatch(/notification_outbox/);
    expect(sql).not.toMatch(/notification_sent_at/);
  });
});

describe('notifyRegulator', () => {
  it('rejects missing required fields', async () => {
    await expect(notifyRegulator({ breachId: 'B-001' }))
      .rejects.toThrow(/required/);
  });

  it('rejects when regulator already notified', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, breach_id: 'B-001', status: 'contained', regulator_notified_at: '2026-04-29' },
    ]);
    await expect(notifyRegulator({
      breachId: 'B-001', regulatorReference: 'CERT-IN/9000', jurisdiction: 'IN',
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('throws 404 when breach not found', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(notifyRegulator({
      breachId: 'B-001', regulatorReference: 'X', jurisdiction: 'IN',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('records the regulator notification with risk_assessment + dpa_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, breach_id: 'B-001', status: 'contained', regulator_notified_at: null },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, breach_id: 'B-001',
      regulator_notified_at: '2026-04-30', regulator_reference: 'CERT-IN/42',
      regulator_jurisdiction: 'IN', cross_border_impact: false, dpa_id: 7,
    }]);
    const row = await notifyRegulator({
      breachId: 'B-001',
      regulatorReference: 'CERT-IN/42',
      jurisdiction: 'IN',
      riskAssessment: { likelihood: 'medium', severity: 'high' },
      dpaId: 7,
      crossBorderImpact: false,
      notifiedBy: USER,
    });
    expect(row.regulator_reference).toBe('CERT-IN/42');
    expect(row.dpa_id).toBe(7);
    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/UPDATE data_breaches/);
    expect(updateSql).toMatch(/regulator_notified_at = NOW\(\)/);
  });
});

describe('notifyDataSubjects', () => {
  it('rejects negative notificationCount', async () => {
    await expect(notifyDataSubjects({ breachId: 'B-001', notificationCount: -3 }))
      .rejects.toThrow(/non-negative integer/);
  });

  it('throws 404 when breach not found', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(notifyDataSubjects({ breachId: 'B-001', notificationCount: 5 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('records notification timestamp + count', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, breach_id: 'B-001', status: 'contained' }]);
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, breach_id: 'B-001', data_subjects_notified_at: '2026-04-30',
      data_subject_notification_count: 142,
    }]);
    const row = await notifyDataSubjects({ breachId: 'B-001', notificationCount: 142, notifiedBy: USER });
    expect(row.data_subject_notification_count).toBe(142);
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/data_subjects_notified_at = NOW\(\)/);
  });
});
