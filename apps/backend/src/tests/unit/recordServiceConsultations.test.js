import { jest } from '@jest/globals';

const prismaMock = {
  medical_records: { findMany: jest.fn() },
  clinical_notes: { findMany: jest.fn() },
  users: { findMany: jest.fn() },
  doctors: { findMany: jest.fn() },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/security/phiColumnEncryption.js', () => ({
  encryptColumn: jest.fn((value) => `enc:${value}`),
}));

const { getConsultationsByUid } = await import('../../services/record/recordService.js');

describe('recordService.getConsultationsByUid', () => {
  const patientUid = '4fd0f5a4-42da-4994-a85b-73ce79699147';
  const doctorRelation = 'users_medical_records_doctor_idTousers';

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.medical_records.findMany.mockResolvedValue([]);
    prismaMock.clinical_notes.findMany.mockResolvedValue([]);
    prismaMock.users.findMany.mockResolvedValue([]);
    prismaMock.doctors.findMany.mockResolvedValue([]);
  });

  it('returns staff-created medical consultation records for the patient UID', async () => {
    const createdAt = new Date('2026-06-07T05:46:06.107Z');
    prismaMock.medical_records.findMany.mockResolvedValue([
      {
        id: 42,
        patient_id: patientUid,
        doctor_id: 5,
        record_type: 'CONSULTATION',
        title: 'Follow-up',
        description: 'Review after prescription',
        diagnosis: 'Test diagnosis',
        treatment: null,
        medications: null,
        lab_results: null,
        attachments: { consultationDate: '2026-06-07' },
        privacy_level: 'RESTRICTED',
        created_at: createdAt,
        updated_at: null,
        [doctorRelation]: {
          id: 5,
          name: 'Dr Test',
          phone: '+919999999999',
          email: 'doctor@example.test',
        },
      },
    ]);
    prismaMock.users.findMany.mockResolvedValue([
      {
        uid: patientUid,
        id: 97,
        name: 'test',
        phone: '+911234567890',
        email: null,
        birthday: null,
        gender: null,
        address: null,
      },
    ]);
    prismaMock.doctors.findMany.mockResolvedValue([
      { user_id: 5, specialty: 'General Medicine', department: 'OPD' },
    ]);

    const rows = await getConsultationsByUid(patientUid, { limit: 5, offset: 0 });

    expect(prismaMock.medical_records.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          patient_id: patientUid,
          record_type: 'CONSULTATION',
          is_active: true,
        },
        take: 5,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: 42,
        patient_id: patientUid,
        patient_uid: patientUid,
        doctor_name: 'Dr Test',
        doctor_specialization: 'General Medicine',
        diagnosis: 'Test diagnosis',
        notes: 'Review after prescription',
        consultation_date: '2026-06-07',
      }),
    );
  });

  it('returns signed OP consultation notes created by the staff app', async () => {
    const createdAt = new Date('2026-06-07T05:37:43.420Z');
    prismaMock.clinical_notes.findMany.mockResolvedValue([
      {
        id: 103,
        patient_uid: patientUid,
        author_uid: '930cc1d5-0bd2-4739-86ad-844f59ea439d',
        note_type: 'op_consultation',
        title: 'OP consultation - test',
        content: {
          chief_complaint: 'new test',
          history: 'new test history',
          examination: 'vitals stable',
          diagnosis: 'test diagnosis',
          plan: 'CAG',
        },
        notes: null,
        is_signed: true,
        signed_at: createdAt,
        created_at: createdAt,
        updated_at: createdAt,
        appointment_id: 383,
        appointments: {
          id: 383,
          doctor_id: 5,
          appointment_date: new Date('2026-06-07T00:00:00.000Z'),
          reason: 'new test',
          users_appointments_doctor_idTousers: {
            id: 5,
            name: 'Dr Test',
            phone: '+919999999999',
            email: 'doctor@example.test',
          },
        },
      },
    ]);
    prismaMock.users.findMany.mockResolvedValue([
      {
        uid: '930cc1d5-0bd2-4739-86ad-844f59ea439d',
        id: 5,
        name: 'Dr Test',
        phone: '+919999999999',
        email: 'doctor@example.test',
      },
    ]);
    prismaMock.doctors.findMany.mockResolvedValue([
      { user_id: 5, specialty: 'General Medicine', department: 'OPD' },
    ]);

    const rows = await getConsultationsByUid(patientUid, { limit: 5, offset: 0 });

    expect(prismaMock.clinical_notes.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          patient_uid: patientUid,
          note_type: { in: ['op_consultation', 'consultation_note', 'soap'] },
          is_signed: true,
          status: { not: 'deleted' },
        },
        take: 5,
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: 103,
        source: 'clinical_notes',
        patient_id: patientUid,
        patient_uid: patientUid,
        doctor_name: 'Dr Test',
        doctor_specialization: 'General Medicine',
        diagnosis: 'test diagnosis',
        appointment_id: 383,
        appointment_reason: 'new test',
        is_signed: true,
      }),
    );
    expect(rows[0].notes).toContain('Chief complaint: new test');
    expect(rows[0].notes).toContain('Plan: CAG');
  });
});
