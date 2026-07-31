import { jest } from '@jest/globals';

jest.unstable_mockModule('../config/downtimeConfig.js', () => ({
  clinicalContinuityReplayReceiptsEnabled: () => true
}));

const { runClinicalContinuityReplayConformance } =
  await import('./helpers/clinicalContinuityReplayConformance.js');

runClinicalContinuityReplayConformance({
  actionId: 'emr.nursing_note.draft.store',
  actorRole: 'NURSING_INCHARGE',
  bodyFactory: ({ patientUid }) => ({
    content: { free_text: 'bounded nursing draft' },
    note_type: 'nursing_assessment',
    patient_uid: patientUid
  }),
  expectedEffectContract: 'private_draft_storage_only'
});

runClinicalContinuityReplayConformance({
  actionId: 'emr.op_note.draft.store',
  actorRole: 'DOCTOR',
  bodyFactory: ({ fixture, patientUid }) => ({
    appointment_id: fixture.appointmentIds[patientUid],
    content: { summary: 'bounded OP draft' },
    note_type: 'op_consultation',
    patient_uid: patientUid
  }),
  expectedEffectContract: 'private_draft_storage_only'
});
