import { jest } from '@jest/globals';

const queryMock = jest.fn();
const pointSummaryMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/gamification/pointService.js', () => ({
  getUserPointSummary: pointSummaryMock,
}));

const { getPatientCommandCenter } = await import(
  '../../services/portal/patientPortalService.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '4fd0f5a4-42da-4994-a85b-73ce79699147';

function installFixtureQuery(overrides = {}) {
  queryMock.mockImplementation(async (sql) => {
    const text = String(sql);
    if (text.includes('FROM users u')) {
      return overrides.profile ?? [{
        id: 97,
        uid: PATIENT_UID,
        name: 'Dev Patient',
        phone: '+911234567890',
        hospital_number: 'VH-000097',
      }];
    }
    if (text.includes('FROM appointments a')) {
      return overrides.appointments ?? [{
        id: 383,
        appointment_date: new Date(),
        appointment_time: '10:30',
        status: 'CONFIRMED',
        doctor_name: 'Test Doctor',
      }];
    }
    if (text.includes('FROM e_prescriptions ep')) {
      return overrides.prescriptions ?? [{
        id: 55,
        prescription_number: 'RX-55',
        doctor_name: 'Test Doctor',
        created_at: new Date(),
      }];
    }
    if (text.includes('FROM investigations i')) {
      return overrides.labOrders ?? [{
        id: 71,
        test_name: 'CBC',
        status: 'PENDING',
        fasting_required: false,
      }];
    }
    if (text.includes('FROM lab_results')) {
      return overrides.labResults ?? [{
        id: 72,
        test_name: 'HbA1c',
        abnormal_flag: 'H',
        signed_off_at: new Date(),
      }];
    }
    if (text.includes('billing_invoices') || text.includes('pharmacy_orders')) {
      return overrides.bills ?? [{
        id: 88,
        invoice_number: 'INV-88',
        status: 'pending',
        amount_due: 1200,
      }];
    }
    if (text.includes('FROM tpa_claims')) {
      return overrides.claims ?? [{
        id: 99,
        claim_number: 'TPA-99',
        status: 'submitted',
      }];
    }
    if (text.includes('FROM patient_message_threads')) {
      return overrides.threads ?? [{
        id: 7,
        subject: 'Please review my report',
        status: 'awaiting_patient',
        patient_unread_count: 2,
      }];
    }
    if (text.includes('FROM patient_records pr')) {
      return overrides.uploads ?? [{
        id: 44,
        title: 'Uploaded report',
        ai_extraction_status: 'needs_review',
        ai_reviewer_decision: 'pending',
      }];
    }
    if (text.includes('FROM appointment_documents')) {
      return [{ count: overrides.hospitalDocCount ?? 3 }];
    }
    if (text.includes('FROM clinical_notes')) {
      return overrides.clinicalNotes ?? [{ id: 1 }, { id: 2 }];
    }
    if (text.includes('FROM medication_reminders')) {
      return overrides.reminders ?? [{
        id: '1',
        medication_name: 'Metformin',
        reminder_times: ['08:00'],
      }];
    }
    return [];
  });
}

describe('patient portal command center', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pointSummaryMock.mockResolvedValue({
      totalPoints: 320,
      currentTier: { name: 'Bronze' },
      unclaimedCount: 1,
      recentActivity: [],
    });
  });

  it('aggregates patient-scoped services into prioritized Today cards', async () => {
    installFixtureQuery();

    const result = await getPatientCommandCenter({
      tenantId: TENANT,
      patient_uid: PATIENT_UID,
      patient_id: 97,
      acting: {
        actorUid: '8fe7d60a-f97f-4a52-9b01-657c9d32ad76',
        actorId: 12,
        actorRole: 'PATIENT',
      },
    });

    expect(result.profile).toEqual(expect.objectContaining({
      uid: PATIENT_UID,
      hospital_number: 'VH-000097',
      active_dependent: expect.objectContaining({
        acting_as_dependent: true,
        actor_uid: '8fe7d60a-f97f-4a52-9b01-657c9d32ad76',
      }),
    }));
    expect(result.counters).toEqual(expect.objectContaining({
      pending_uploads: 1,
      prescriptions: 1,
      lab_results: 1,
      bills_due: 1,
      unread_messages: 2,
      health_points: 320,
    }));
    expect(result.today.map((card) => card.type)).toEqual(
      expect.arrayContaining([
        'next_appointment',
        'unread_message',
        'bill_due',
        'lab_result_ready',
        'pending_lab_order',
        'prescription_ready',
        'claim_update',
        'upload_review',
      ]),
    );
    expect(result.services.next_appointment.id).toBe(383);
    expect(result.services.health_points.totalPoints).toBe(320);
  });

  it('returns useful fallback actions when no service rows exist', async () => {
    installFixtureQuery({
      appointments: [],
      prescriptions: [],
      labOrders: [],
      labResults: [],
      bills: [],
      claims: [],
      threads: [],
      uploads: [],
      clinicalNotes: [],
      reminders: [],
      hospitalDocCount: 0,
    });
    pointSummaryMock.mockResolvedValue({
      totalPoints: 0,
      currentTier: null,
      unclaimedCount: 0,
      recentActivity: [],
    });

    const result = await getPatientCommandCenter({
      tenantId: TENANT,
      patient_uid: PATIENT_UID,
      patient_id: 97,
    });

    expect(result.today.map((card) => card.type)).toEqual([
      'book_appointment',
      'upload_record',
      'departments',
      'contact_hospital',
    ]);
    expect(result.counters.timeline_count).toBe(0);
  });
});
