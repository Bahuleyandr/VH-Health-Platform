import { jest } from '@jest/globals';

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  createDraft,
  markDelivered,
  markReadyForSignoff,
  sign,
  updateSection,
} = await import('../../services/discharge/dischargeService.js');

// Finding: 2026-05-09-inpatient-admission-discharge-summary-patient-fields-dropped
// POST /api/v1/discharge-summaries silently dropped patient_name_snapshot,
// age_years_snapshot, and sex_snapshot when callers used the snapshot-suffixed
// field names. The medico-legal document requires these fields; if neither
// the bare nor the snapshot-suffixed name is supplied, the INSERT must
// backfill from the users row.
describe('discharge createDraft — patient snapshot fields', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const patientUid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
    // pickTemplate -> templates SELECT
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { id: 1, sections: [] },
    ]);
    // INSERT discharge_summaries -> returning row
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { id: 99 },
    ]);
    // getOne -> discharge_summaries SELECT
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([
      { id: 99, patient_uid: patientUid },
    ]);
    // getOne -> sections SELECT
    mockPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
  });

  it('accepts snapshot-suffixed body fields and passes them through to the INSERT', async () => {
    await createDraft({
      tenantId,
      patient_uid: patientUid,
      patient_name_snapshot: 'Karuppasamy',
      age_years_snapshot: 55,
      sex_snapshot: 'M',
      template_code: 'GM-DEFAULT',
    });

    const insertCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (c) => /INSERT INTO discharge_summaries/i.test(c[0]),
    );
    expect(insertCall).toBeTruthy();
    // Param positions: $3=name, $4=age, $5=sex (see service)
    expect(insertCall[3]).toBe('Karuppasamy');
    expect(insertCall[4]).toBe(55);
    expect(insertCall[5]).toBe('M');
  });

  it('also accepts the bare field names (back-compat)', async () => {
    await createDraft({
      tenantId,
      patient_uid: patientUid,
      patient_name: 'Karuppasamy',
      age_years: 55,
      sex: 'M',
      template_code: 'GM-DEFAULT',
    });

    const insertCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (c) => /INSERT INTO discharge_summaries/i.test(c[0]),
    );
    expect(insertCall[3]).toBe('Karuppasamy');
    expect(insertCall[4]).toBe(55);
    expect(insertCall[5]).toBe('M');
  });

  it('uses COALESCE against users to backfill name/age/sex when omitted', async () => {
    await createDraft({
      tenantId,
      patient_uid: patientUid,
      template_code: 'GM-DEFAULT',
    });

    const insertCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (c) => /INSERT INTO discharge_summaries/i.test(c[0]),
    );
    const sql = insertCall[0];
    expect(sql).toMatch(/COALESCE\(\$3,\s*\(SELECT\s+u\.name\s+FROM\s+users\s+u/i);
    expect(sql).toMatch(/EXTRACT\(YEAR\s+FROM\s+AGE\(u\.birthday\)\)/i);
    expect(sql).toMatch(/COALESCE\(\$5,\s*\(SELECT\s+u\.gender\s+FROM\s+users\s+u/i);
    // Bound params are null so Postgres falls through to the SELECT.
    expect(insertCall[3]).toBeNull();
    expect(insertCall[4]).toBeNull();
    expect(insertCall[5]).toBeNull();
  });
});

describe('discharge summary audit trail', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const patientUid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const staffUid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
  });

  it('audits section edits with previous and new body text', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 99, status: 'draft' }])
      .mockResolvedValueOnce([{
        id: 7,
        section_key: 'course_in_hospital',
        section_title: 'Course in hospital',
        body: 'Initial course',
      }])
      .mockResolvedValueOnce([{ id: 99, patient_uid: patientUid }])
      .mockResolvedValueOnce([]);

    await updateSection({
      tenantId,
      id: 99,
      section_key: 'course_in_hospital',
      body: 'Revised course',
      edited_by: staffUid,
    });

    const auditCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
      (c) => /INSERT INTO audit_logs/i.test(c[0]),
    );
    expect(auditCall).toBeTruthy();
    expect(auditCall[2]).toBe('DISCHARGE_SUMMARY_SECTION_EDIT');
    expect(auditCall[3]).toBe('99');
    expect(JSON.parse(auditCall[4])).toMatchObject({
      section_key: 'course_in_hospital',
      previous_body: 'Initial course',
      new_body: 'Revised course',
    });
  });

  it('audits ready-for-signoff transitions', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValueOnce([{ id: 99, patient_uid: patientUid }])
      .mockResolvedValueOnce([]);

    await markReadyForSignoff({ tenantId, id: 99, marked_by: staffUid });

    const auditCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
      (c) => /INSERT INTO audit_logs/i.test(c[0]),
    );
    expect(auditCall[2]).toBe('DISCHARGE_SUMMARY_READY_FOR_SIGNOFF');
  });

  it('audits consultant signing', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{
        id: 99,
        admission_id: 18,
        patient_uid: patientUid,
        signed_at: new Date('2026-05-15T10:00:00.000Z'),
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 99, patient_uid: patientUid }])
      .mockResolvedValueOnce([]);

    await sign({
      tenantId,
      id: 99,
      signed_by: staffUid,
      signed_by_name: 'Dr Test',
      signed_by_reg: 'TNMC-1234',
    });

    const auditCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
      (c) => /INSERT INTO audit_logs/i.test(c[0]),
    );
    expect(auditCall[2]).toBe('DISCHARGE_SUMMARY_SIGNED');
    expect(JSON.parse(auditCall[4])).toMatchObject({
      admission_id: 18,
      patient_uid: patientUid,
      signed_by_name: 'Dr Test',
    });
  });

  it('audits delivery', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{
        id: 99,
        admission_id: 18,
        patient_uid: patientUid,
        primary_diagnosis: 'ACS',
      }])
      .mockResolvedValueOnce([{ id: 99, patient_uid: patientUid }])
      .mockResolvedValueOnce([]);

    await markDelivered({
      tenantId,
      id: 99,
      delivery_method: 'printed',
      delivered_by: staffUid,
    });

    const auditCall = mockPrisma.$executeRawUnsafe.mock.calls.find(
      (c) => /INSERT INTO audit_logs/i.test(c[0]),
    );
    expect(auditCall[2]).toBe('DISCHARGE_SUMMARY_DELIVERED');
    expect(JSON.parse(auditCall[4])).toMatchObject({ delivery_method: 'printed' });
  });
});
