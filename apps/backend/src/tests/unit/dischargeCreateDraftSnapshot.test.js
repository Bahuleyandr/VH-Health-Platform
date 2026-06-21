import { jest } from '@jest/globals';

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));
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
      // assertSignable pre-flight: ownership probe + gate sections
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValueOnce([
        { section_key: 'diagnosis', body: 'Acute gastroenteritis, resolved' },
        { section_key: 'discharge_medications', body: 'Tab ORS, Tab Pantoprazole 40mg OD x 5d' },
      ])
      // markReadyForSignoff UPDATE ... RETURNING
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
      // assertSignable pre-flight: ownership probe + gate sections
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValueOnce([
        { section_key: 'diagnosis', body: 'Acute coronary syndrome' },
        { section_key: 'discharge_medications', body: 'Tab Aspirin 75mg OD, Tab Atorvastatin 40mg HS' },
      ])
      // sign UPDATE ... RETURNING
      .mockResolvedValueOnce([{
        id: 99,
        admission_id: 18,
        patient_uid: patientUid,
        signed_at: new Date('2026-05-15T10:00:00.000Z'),
      }])
      // canonical timeline + audit event INSERTs (now emitted inside the sign tx)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
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
      // canonical timeline + audit event INSERTs (now emitted inside the deliver tx)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
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

// Finding: 2026-05-22-surgical-day-care-discharge-ae484c86
//   A day-care discharge summary reached status=signed with procedure /
//   eye_operated / intraop_summary / discharge_medications bodies null and
//   follow_up/red_flags still carrying template placeholder text. Signing
//   (and marking ready) must block until the required clinical sections
//   present on the summary have real, non-placeholder content.
describe('discharge sign-completeness gate', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001';
  const patientUid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const staffUid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

  // Sections matching the DAYCARE_OPHTHALMOLOGY_V1 template shape.
  const blankRequiredSections = [
    { section_key: 'procedure', body: null },
    { section_key: 'eye_operated', body: null },
    { section_key: 'intraop_summary', body: '   ' },
    { section_key: 'condition_at_discharge', body: 'Comfortable, eye shield in place.' },
    { section_key: 'discharge_medications', body: null },
    { section_key: 'follow_up', body: '[PLACEHOLDER — ophthalmology clinical review required] POD-1 review.' },
  ];
  const completeSections = [
    { section_key: 'procedure', body: 'Phacoemulsification with IOL implantation' },
    { section_key: 'eye_operated', body: 'Right eye (RE)' },
    { section_key: 'intraop_summary', body: 'Uneventful; PCIOL in the bag.' },
    { section_key: 'condition_at_discharge', body: 'Comfortable, eye shield in place.' },
    { section_key: 'discharge_medications', body: 'Moxifloxacin 0.5% eye drops QID x 1 week' },
    { section_key: 'follow_up', body: 'POD-1 review tomorrow at 9am.' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$executeRawUnsafe.mockResolvedValue(1);
  });

  it('rejects sign() when a required clinical section is blank', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 10 }])           // ownership probe
      .mockResolvedValueOnce(blankRequiredSections); // gate sections

    await expect(
      sign({ tenantId, id: 10, signed_by: staffUid, signed_by_name: 'Dr Eye' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DISCHARGE_SUMMARY_INCOMPLETE',
    });

    // The summary UPDATE must never have run.
    const updateCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (c) => /UPDATE discharge_summaries\s+SET status = 'signed'/i.test(c[0]),
    );
    expect(updateCall).toBeUndefined();
  });

  it('reports the blank required sections in the error details', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce(blankRequiredSections);

    let caught;
    try {
      await sign({ tenantId, id: 10, signed_by: staffUid, signed_by_name: 'Dr Eye' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // The gate enforces the universal high-safety set (procedure /
    // diagnosis + discharge medications), not every specialty-specific
    // section — so a blank procedure + discharge_medications block, while
    // optional/specialty prose (eye_operated, intraop_summary, follow_up)
    // does not.
    expect(caught.details.blank_sections).toEqual(
      expect.arrayContaining(['procedure', 'discharge_medications']),
    );
    expect(caught.details.blank_sections).not.toContain('eye_operated');
    expect(caught.details.placeholder_sections).not.toContain('follow_up');
  });

  it('blocks a required section that still carries placeholder text', async () => {
    // discharge_medications present but unedited (placeholder) — must block.
    const placeholderMeds = [
      { section_key: 'procedure', body: 'Phacoemulsification with IOL' },
      { section_key: 'discharge_medications', body: '[PLACEHOLDER — clinician to confirm takeaway medications]' },
    ];
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce(placeholderMeds);

    await expect(
      sign({ tenantId, id: 10, signed_by: staffUid, signed_by_name: 'Dr Eye' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DISCHARGE_SUMMARY_INCOMPLETE',
      details: { placeholder_sections: ['discharge_medications'] },
    });
  });

  it('allows sign() when every required section has real content', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 11 }])        // ownership probe
      .mockResolvedValueOnce(completeSections)    // gate sections
      .mockResolvedValueOnce([{                   // UPDATE ... RETURNING
        id: 11, admission_id: 30, patient_uid: patientUid,
        signed_at: new Date('2026-05-22T09:00:00.000Z'),
      }])
      .mockResolvedValueOnce([])                  // canonical timeline INSERT (in-tx)
      .mockResolvedValueOnce([])                  // canonical audit INSERT (in-tx)
      .mockResolvedValueOnce([])                  // materialise meds: sections
      .mockResolvedValueOnce([{ id: 11, patient_uid: patientUid }]) // getOne header
      .mockResolvedValueOnce([]);                 // getOne sections

    const result = await sign({
      tenantId, id: 11, signed_by: staffUid, signed_by_name: 'Dr Eye', signed_by_reg: 'TNMC-9',
    });
    expect(result).toBeTruthy();
    const updateCall = mockPrisma.$queryRawUnsafe.mock.calls.find(
      (c) => /UPDATE discharge_summaries\s+SET status = 'signed'/i.test(c[0]),
    );
    expect(updateCall).toBeTruthy();
  });

  it('does not block on a blank OPTIONAL section (only required ones gate)', async () => {
    // diet_advice / family_history are optional — a blank body must not
    // block signing when the required clinical sections are complete.
    const sectionsWithBlankOptional = [
      ...completeSections,
      { section_key: 'diet_advice', body: null },
      { section_key: 'family_history', body: '   ' },
    ];
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 12 }])
      .mockResolvedValueOnce(sectionsWithBlankOptional)
      .mockResolvedValueOnce([{
        id: 12, admission_id: 31, patient_uid: patientUid,
        signed_at: new Date('2026-05-22T10:00:00.000Z'),
      }])
      .mockResolvedValueOnce([])                  // canonical timeline INSERT (in-tx)
      .mockResolvedValueOnce([])                  // canonical audit INSERT (in-tx)
      .mockResolvedValueOnce([])                  // materialise meds: sections
      .mockResolvedValueOnce([{ id: 12, patient_uid: patientUid }])
      .mockResolvedValueOnce([]);

    await expect(
      sign({ tenantId, id: 12, signed_by: staffUid, signed_by_name: 'Dr Eye' }),
    ).resolves.toBeTruthy();
  });

  it('blocks markReadyForSignoff() on incomplete required sections', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([{ id: 10 }])
      .mockResolvedValueOnce(blankRequiredSections);

    await expect(
      markReadyForSignoff({ tenantId, id: 10, marked_by: staffUid }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DISCHARGE_SUMMARY_INCOMPLETE',
    });
  });
});
