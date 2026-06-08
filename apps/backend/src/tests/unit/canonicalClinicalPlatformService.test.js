import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const loggerWarnMock = jest.fn();
const validatePrescriptionSafetyMock = jest.fn();
const getLegacyPatientTimelineMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: loggerWarnMock,
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/clinical/prescriptionSafetyCheck.js', () => ({
  validatePrescriptionSafety: validatePrescriptionSafetyMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../services/emr/clinicalTimelineService.js', () => ({
  getPatientTimeline: getLegacyPatientTimelineMock,
}));

const {
  readCanonicalPatientTimeline,
  recordCanonicalClinicalEvent,
  transitionEncounter,
} = await import('../../services/clinical/canonicalClinicalPlatformService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENCOUNTER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  loggerWarnMock.mockReset();
  validatePrescriptionSafetyMock.mockReset().mockResolvedValue({ safe: true, warnings: [], blockers: [] });
  getLegacyPatientTimelineMock.mockReset().mockResolvedValue([]);
});

describe('canonical clinical platform service', () => {
  it('records a clinical write into timeline and clinical audit streams', async () => {
    const timelineRow = {
      id: '44444444-4444-4444-8444-444444444444',
      tenant_id: TENANT,
      patient_uid: PATIENT,
      encounter_id: ENCOUNTER,
      event_type: 'note.signed',
      source_table: 'clinical_notes',
      source_id: '7',
    };
    const auditRow = {
      id: '55555555-5555-4555-8555-555555555555',
      tenant_id: TENANT,
      patient_uid: PATIENT,
      encounter_id: ENCOUNTER,
      action: 'note.signed',
      resource_table: 'clinical_notes',
      resource_id: '7',
    };
    queryUnsafeMock
      .mockResolvedValueOnce([timelineRow])
      .mockResolvedValueOnce([auditRow]);

    const result = await recordCanonicalClinicalEvent({
      tenantId: TENANT,
      patientUid: PATIENT,
      encounterId: ENCOUNTER,
      eventType: 'note.signed',
      sourceTable: 'clinical_notes',
      sourceId: 7,
      resourceType: 'clinical_note',
      resourceId: 7,
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
      summary: 'OP note signed',
      payload: { note_type: 'op_consultation' },
      beforeState: { is_signed: false },
      afterState: { is_signed: true },
    });

    expect(result.timeline).toBe(timelineRow);
    expect(result.audit).toBe(auditRow);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[0][0]).toContain('clinical_timeline_events');
    expect(queryUnsafeMock.mock.calls[1][0]).toContain('clinical_audit_events');
  });

  it('reads the canonical patient timeline and merges legacy events for compatibility', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: '66666666-6666-4666-8666-666666666666',
      patient_uid: PATIENT,
      event_type: 'prescription.created',
      event_subtype: null,
      event_status: 'draft',
      source_table: 'e_prescriptions',
      source_id: '18',
      resource_type: 'prescription',
      resource_id: '18',
      encounter_id: ENCOUNTER,
      occurred_at: new Date('2026-06-07T09:00:00.000Z'),
      clinical_summary: 'Prescription created',
      actor_uid: ACTOR,
      actor_role: 'DOCTOR',
      visible_to_patient: false,
      payload: { title: 'E-prescription' },
      tags: ['op'],
    }]);
    getLegacyPatientTimelineMock.mockResolvedValueOnce([{
      id: 99,
      type: 'vitals',
      timestamp: '2026-06-07T08:30:00.000Z',
      title: 'Vitals recorded',
      summary: 'HR 82',
    }, {
      id: 100,
      event_type: 'clinical_note',
      timestamp: '2026-06-07T08:00:00.000Z',
      title: 'Progress note',
      summary: 'Review after rounds',
    }]);

    const timeline = await readCanonicalPatientTimeline(PATIENT, { limit: 20 });

    expect(timeline.patient_uid).toBe(PATIENT);
    expect(timeline.counts).toEqual({ canonical: 1, legacy: 2, returned: 3 });
    expect(timeline.events.map((event) => event.event_type)).toEqual([
      'prescription.created',
      'vitals.recorded',
      'clinical_note',
    ]);
  });

  it('rejects invalid encounter lifecycle transitions', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: ENCOUNTER,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      status: 'locked',
    }]);

    await expect(transitionEncounter(ENCOUNTER, 'active', {
      actorUid: ACTOR,
      actorRole: 'DOCTOR',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_ENCOUNTER_TRANSITION',
    });
  });
});
