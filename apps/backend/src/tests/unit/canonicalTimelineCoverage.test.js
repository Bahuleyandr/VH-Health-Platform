import fs from 'node:fs';
import path from 'node:path';

const SOURCE_ROOT = path.join(process.cwd(), 'src');

function readSource(relativePath) {
  return fs.readFileSync(path.join(SOURCE_ROOT, relativePath), 'utf8');
}

describe('canonical timeline coverage guard', () => {
  const requiredCanonicalWriters = [
    ['services/emr/clinicalNotesService.js', ['recordCanonicalClinicalEvent', 'note.created', 'note.edited', 'note.signed']],
    ['controllers/prescription/ePrescriptionController.js', ['recordCanonicalClinicalEvent', 'prescription.created', 'prescription.edited', 'prescription.signed']],
    ['services/investigation/orderService.js', ['recordCanonicalClinicalEvent', 'investigation.ordered']],
    ['services/investigation/investigationService.js', ['recordCanonicalClinicalEvent', 'investigation.status_changed', 'investigation.result_recorded', 'investigation.result_critical']],
    ['services/diagnostics/diagnosticResultGenerationService.js', ['recordCanonicalClinicalEvent', 'diagnostic.result.generation_signed', 'diagnostic.result.generation_corrected']],
    ['services/referral/referralService.js', ['recordCanonicalClinicalEvent', 'referral.requested', 'referral.completed']],
    ['services/emr/vitalsChartService.js', ['recordCanonicalClinicalEvent', 'vitals.recorded']],
    ['services/emr/orderEntryService.js', ['recordCanonicalClinicalEvent', 'order.created']],
    ['services/emr/diagnosisService.js', ['recordCanonicalClinicalEvent', 'diagnosis.added', 'diagnosis.status_updated']],
    ['services/clinical/handoverService.js', ['recordCanonicalClinicalEvent', 'handover.created', 'handover.acknowledged']],
    ['services/emr/admissionService.js', ['recordCanonicalClinicalEvent', 'admission.created', 'bed.assigned', 'bed.transferred']],
    ['services/ai/virtualWardService.js', ['recordCanonicalClinicalEvent', 'virtual_ward.check_in_recorded', 'virtual_ward.escalation_raised']],
    ['services/clinical/canonicalOperationalBridgeService.js', [
      'recordCanonicalClinicalEvent',
      'startWorkflowSla',
      'completeWorkflowSla',
      'pharmacy.order_updated',
      'housekeeping.requested',
      'housekeeping.status_changed',
      'bed.ready',
      'discharge.workflow_opened',
      'discharge.work_item_completed',
      'discharge.drugs_dispensed',
      'discharge.completed',
      'critical_result.acknowledged',
      'cds.alert_acknowledged',
    ]],
  ];

  it.each(requiredCanonicalWriters)('%s emits canonical timeline/audit events', (relativePath, expectedTokens) => {
    const source = readSource(relativePath);
    for (const token of expectedTokens) {
      expect(source).toContain(token);
    }
  });

  it('keeps public timeline routes delegated to the canonical reader', () => {
    const directReaders = [
      'routes/patient/patientSearchRoutes.js',
      'routes/emr/clinicalTimelineRoutes.js',
      'services/emr/clinicalNotesService.js',
    ];

    for (const file of directReaders) {
      expect(readSource(file)).toContain('readCanonicalPatientTimeline');
    }

    expect(readSource('routes/emr/clinicalNotesRoutes.js')).toContain('clinicalNotesService.getPatientTimeline');
  });
});
