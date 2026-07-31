import { jest } from '@jest/globals';

const appendReference = jest.fn();
const supersedeReference = jest.fn();
const completeRegisteredCondition = jest.fn();
const completeRegisteredEvidence = jest.fn();
const executePathwayCommand = jest.fn();
const startCarePathwayInstance = jest.fn();
const resolvePathwayModeTx = jest.fn();

jest.unstable_mockModule(
  '../../services/pathways/carePathwayResourceReferenceService.js',
  () => ({
    appendPathwayResourceReferenceTx: appendReference,
    supersedePathwayResourceReferenceTx: supersedeReference,
  }),
);
jest.unstable_mockModule('../../services/pathways/pathwayExecutorService.js', () => ({
  completePathwayTaskAndExecuteFromRegisteredCondition: completeRegisteredCondition,
  completePathwayTaskAndExecuteFromRegisteredEvidence: completeRegisteredEvidence,
  executePathwayCommand,
  startCarePathwayInstance,
}));
jest.unstable_mockModule('../../services/pathways/pathwayRuntimePersistence.js', () => ({
  resolvePathwayModeTx,
}));

const {
  classifyDischargeSummarySignedEvent,
  projectInpatientPathwayEvent,
} = await import('../../services/pathways/inpatientPathwayProjector.js');
const {
  pathwayProjectorRegistryV4,
} = await import('../../services/events/pathwayProjectorRegistry.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '30000000-0000-4000-8000-000000000001';
const ROOT_REFERENCE_ID = '40000000-0000-4000-8000-000000000001';
const EVENT_ID = '91';

function legacySummaryEvent() {
  return {
    id: EVENT_ID,
    event_type: 'clinical_document.discharge_summary.signed',
    aggregate_type: 'clinical_note',
    aggregate_id: '27',
    patient_uid: PATIENT_UID,
    payload: {},
    occurred_at: new Date('2026-07-23T08:00:00.000Z'),
  };
}

describe('inpatient pathway projector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolvePathwayModeTx.mockResolvedValue('shadow');
    executePathwayCommand.mockResolvedValue({
      replayed: false,
      instance: { clinical_status: 'active' },
    });
  });

  it('classifies the structured and current legacy signed-summary identities exactly', () => {
    expect(classifyDischargeSummarySignedEvent({
      event_type: 'clinical_document.discharge_summary.signed',
      aggregate_type: 'discharge_summary',
      aggregate_id: '44',
      payload: { discharge_summary_id: 44 },
    })).toEqual({
      kind: 'structured_discharge_summary',
      dischargeSummaryId: 44,
    });
    expect(classifyDischargeSummarySignedEvent(legacySummaryEvent())).toEqual({
      kind: 'legacy_clinical_note',
      clinicalNoteId: 27,
    });
    expect(() => classifyDischargeSummarySignedEvent({
      event_type: 'clinical_document.discharge_summary.signed',
      aggregate_type: 'clinical_note',
      aggregate_id: '27',
      payload: { discharge_summary_id: 44 },
    })).toThrow('Signed discharge summary projector identity is inconsistent');
  });

  it('turns the real legacy clinical-note event into a bounded Gen4 observation', async () => {
    const tx = { $queryRawUnsafe: jest.fn() };
    const handler = pathwayProjectorRegistryV4.resolve(
      'clinical_document.discharge_summary.signed',
    );

    await expect(handler({
      tx,
      consumerKey: 'care_pathway_projector',
      generation: 4,
      tenantId: TENANT_ID,
      event: legacySummaryEvent(),
    })).resolves.toEqual({
      consumer_key: 'care_pathway_projector',
      generation: 4,
      event_type: 'clinical_document.discharge_summary.signed',
      pathway_key: 'inpatient_admission_to_recovery',
      pathway_mode: 'shadow',
      admission_id: null,
      admission_status: null,
      effects_suppressed: true,
      legacy_summary_ignored: true,
      reconciliation_code: 'INPATIENT_STRUCTURED_SUMMARY_IDENTITY_REQUIRED',
      legacy_shadow_observed: true,
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(appendReference).not.toHaveBeenCalled();
    expect(executePathwayCommand).not.toHaveBeenCalled();
  });

  it('reloads an exact admission-linked diagnostic row before appending its child reference', async () => {
    const event = {
      id: EVENT_ID,
      event_type: 'admission.diagnostic_resource_linked',
      aggregate_type: 'admission',
      aggregate_id: '17',
      patient_uid: PATIENT_UID,
      payload: {
        admission_id: 17,
        patient_uid: PATIENT_UID,
        resource_type: 'lab_result',
        resource_id: '73',
        canonical_timeline_event_id: null,
        canonical_audit_event_id: null,
        occurred_at: '2026-07-23T08:10:00.000Z',
        admission_lineage_version: 1,
      },
      occurred_at: new Date('2026-07-23T08:10:00.000Z'),
    };
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{
          id: 17,
          patient_uid: PATIENT_UID,
          encounter_id: null,
          status: 'admitted',
          source_appointment_id: null,
          source_pathway_instance_id: null,
          source_handoff_id: null,
          prior_admission_id: null,
          primary_assignment_id: null,
          primary_physician_uid: null,
        }])
        .mockResolvedValueOnce([{ id: 801 }])
        .mockResolvedValueOnce([{ id: PATHWAY_ID, clinical_status: 'active' }])
        .mockResolvedValueOnce([{ id: ROOT_REFERENCE_ID }])
        .mockResolvedValueOnce([{ resource_id: '73' }]),
    };

    await expect(projectInpatientPathwayEvent({
      tx,
      consumerKey: 'care_pathway_projector',
      generation: 4,
      tenantId: TENANT_ID,
      event,
    })).resolves.toMatchObject({
      pathway_instance_id: PATHWAY_ID,
      command_replayed: false,
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(5);
    expect(tx.$queryRawUnsafe.mock.calls[4][0]).toContain('FROM lab_results AS resource');
    expect(tx.$queryRawUnsafe.mock.calls[4].slice(1)).toEqual([
      TENANT_ID,
      '73',
      PATIENT_UID,
      17,
    ]);
    expect(appendReference).toHaveBeenCalledWith(tx, expect.objectContaining({
      tenantId: TENANT_ID,
      pathwayInstanceId: PATHWAY_ID,
      patientUid: PATIENT_UID,
      resourceType: 'lab_result',
      resourceId: '73',
      relationshipKind: 'child_action',
      evidenceState: 'open',
      sourceOutboxEventId: EVENT_ID,
      occurredAt: '2026-07-23T08:10:00.000Z',
      idempotencyKey: 'inpatient:17:diagnostic:lab_result:73:reference',
      metadata: {
        admission_id: 17,
        admission_lineage_version: 1,
        linkage_basis: 'explicit_admission_resource_link_v1',
      },
    }));
    expect(startCarePathwayInstance).not.toHaveBeenCalled();
    expect(executePathwayCommand).toHaveBeenCalledTimes(1);
  });
});
