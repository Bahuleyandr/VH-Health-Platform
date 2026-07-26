import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function serviceSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('inpatient discharge serialization contract', () => {
  it('locks the admission, rechecks active evidence, and only then commits discharge', () => {
    const source = serviceSource('../../services/emr/admissionService.js');
    const dischargeStart = source.indexOf('async function dischargePatient');
    const phaseOne = source.slice(
      source.indexOf('const phase1 = await scopedTx', dischargeStart),
    );
    const admissionLock = phaseOne.indexOf('FROM admissions');
    const forUpdate = phaseOne.indexOf('FOR UPDATE', admissionLock);
    const activeEvidence = phaseOne.indexOf('getInpatientDischargeEvidenceTx');
    const dischargeWrite = phaseOne.indexOf('const updated = await tx.admissions.update');

    expect(admissionLock).toBeGreaterThanOrEqual(0);
    expect(forUpdate).toBeGreaterThan(admissionLock);
    expect(activeEvidence).toBeGreaterThan(forUpdate);
    expect(dischargeWrite).toBeGreaterThan(activeEvidence);
    expect(phaseOne.slice(forUpdate, dischargeWrite)).toContain(
      'READINESS_GATED_DISCHARGE_TYPES.has(discharge_type)',
    );
    expect(phaseOne.slice(forUpdate, dischargeWrite)).toContain(
      'activeDischargeBranchBlockers(',
    );
    expect(phaseOne.slice(forUpdate, dischargeWrite)).toContain(
      'lockedActiveBlockers',
    );
  });

  it('rechecks exact pathway, attending, assignment, and accepted-handoff convergence under the final lock', () => {
    const domainSource = serviceSource(
      '../../services/emr/inpatientPathwayDomainService.js',
    );
    const convergenceStart = domainSource.indexOf(
      'async function ownerAssignmentConvergenceTx',
    );
    const convergenceEnd = domainSource.indexOf(
      'async function assertAccountableEvidenceActorTx',
      convergenceStart,
    );
    const convergence = domainSource.slice(convergenceStart, convergenceEnd);
    const blockerStart = domainSource.indexOf('function activeEvidenceBlockers');
    const blockerEnd = domainSource.indexOf(
      'export async function getInpatientDischargeEvidenceTx',
      blockerStart,
    );
    const blockers = domainSource.slice(blockerStart, blockerEnd);

    expect(convergence).toContain('pathway.owning_clinician_uid');
    expect(convergence).toContain('admission.attending_doctor');
    expect(convergence).toContain('assignment.physician_uid');
    expect(convergence).toContain('assignmentVersion > 1');
    expect(convergence).toContain("assignment?.assignment_source === 'accepted_covering_handoff'");
    expect(convergence).toContain("handoff.handoff_type = 'covering_clinician_reassignment'");
    expect(convergence).toContain("handoff.status = 'accepted'");
    expect(convergence).toContain('handoff.sender_uid = previous_assignment.physician_uid');
    expect(convergence).toContain('handoff.intended_recipient_uid = $5::uuid');
    expect(convergence).toContain('handoff.accepted_by_uid = $5::uuid');
    expect(convergence).toContain('handoff.sending_pathway_instance_id = $7::uuid');
    expect(convergence).toContain("handoff.source_resource_type = 'care_pathway_instance'");
    expect(blockers).toContain("type: 'INPATIENT_OWNER_ASSIGNMENT_DIVERGED'");

    const admissionSource = serviceSource('../../services/emr/admissionService.js');
    const dischargeStart = admissionSource.indexOf('async function dischargePatient');
    const phaseOne = admissionSource.slice(
      admissionSource.indexOf('const phase1 = await scopedTx', dischargeStart),
    );
    const finalAdmissionLock = phaseOne.indexOf('FOR UPDATE');
    const finalEvidenceRead = phaseOne.indexOf('getInpatientDischargeEvidenceTx');
    const finalBlockerRead = phaseOne.indexOf('...activeReadiness.active_blockers');
    const dischargeWrite = phaseOne.indexOf('const updated = await tx.admissions.update');
    expect(finalEvidenceRead).toBeGreaterThan(finalAdmissionLock);
    expect(finalBlockerRead).toBeGreaterThan(finalEvidenceRead);
    expect(dischargeWrite).toBeGreaterThan(finalBlockerRead);
  });

  it('keeps external discharge transfer explicitly deferred only in active mode', () => {
    const source = serviceSource('../../services/emr/admissionService.js');
    const helperStart = source.indexOf('function activeDischargeBranchBlockers');
    const helperEnd = source.indexOf('function buildDischargeReadinessChecklist', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const readinessStart = source.indexOf('async function getDischargeReadiness');
    const readinessEnd = source.indexOf('async function getDischargeHub', readinessStart);
    const readiness = source.slice(readinessStart, readinessEnd);

    expect(helper).toContain('pathwayMode === PATHWAY_MODES.ACTIVE');
    expect(helper).toContain("dischargeType === 'transfer'");
    expect(helper).toContain('EXTERNAL_TRANSFER_BRANCH_DEFERRED');
    expect(readiness).toContain('activeDischargeBranchBlockers(');
    expect(readiness.indexOf('inpatientPathway.mode !== PATHWAY_MODES.ACTIVE')).toBeLessThan(
      readiness.lastIndexOf('activeDischargeBranchBlockers('),
    );
  });

  it('serializes every typed source event on the same admission lock and rejects late new links', () => {
    const source = serviceSource('../../services/emr/inpatientPathwayDomainService.js');
    const start = source.indexOf(
      'export async function publishInpatientDiagnosticResourceLinkedTx',
    );
    const end = source.indexOf('async function assertSameTenantPhysicianTx', start);
    const publisher = source.slice(start, end);

    expect(publisher).toContain('{ lock: true }');
    expect(publisher).toContain("type !== 'diagnostic_result_generation'");
    expect(publisher).toContain("['admitted', 'transferred'].includes");
    expect(publisher).toContain('INPATIENT_DIAGNOSTIC_ADMISSION_NOT_ACTIVE');
    expect(publisher.indexOf('{ lock: true }')).toBeLessThan(
      publisher.indexOf('INPATIENT_DIAGNOSTIC_ADMISSION_NOT_ACTIVE'),
    );
    expect(publisher.indexOf('INPATIENT_DIAGNOSTIC_ADMISSION_NOT_ACTIVE')).toBeLessThan(
      publisher.indexOf("eventType: 'admission.diagnostic_resource_linked'"),
    );
  });

  it('keeps all exact source producers on the transactional publisher', () => {
    const producers = [
      ['../../services/investigation/orderService.js', 'investigation', 2],
      ['../../services/lab/labPanelService.js', 'lab_result', 1],
      ['../../services/lab/labResultsService.js', 'lab_result', 2],
      ['../../services/lab/labClosedLoopService.js', 'lab_result', 1],
      ['../../services/radiology/radiologyService.js', 'radiology_order', 1],
      ['../../services/pathology/pathologyService.js', 'anatomical_pathology_case', 1],
      [
        '../../services/diagnostics/diagnosticResultGenerationService.js',
        'diagnostic_result_generation',
        2,
      ],
      [
        '../../services/diagnostics/structuredReportDiagnosticGenerationService.js',
        'diagnostic_result_generation',
        1,
      ],
    ];

    for (const [path, resourceType, minimumCalls] of producers) {
      const source = serviceSource(path);
      const calls = source.match(/publishInpatientDiagnosticResourceLinkedTx\(\{/g) || [];
      expect(calls.length).toBeGreaterThanOrEqual(minimumCalls);
      expect(source).toContain(`resourceType: '${resourceType}'`);
    }
  });

  it('locks and rejects a handoff that starts after discharge', () => {
    const source = serviceSource('../../services/emr/inpatientPathwayDomainService.js');
    const start = source.indexOf('export async function recordPendingResultHandoff');
    const end = source.indexOf('export async function recordPendingResultSummaryInclusion', start);
    const handoff = source.slice(start, end);

    expect(handoff).toContain('admissionContextTx(tx, tenantId, id, { lock: true })');
    expect(handoff).toContain('INPATIENT_PENDING_RESULT_ADMISSION_NOT_ACTIVE');
    expect(handoff.indexOf('{ lock: true }')).toBeLessThan(
      handoff.indexOf('INPATIENT_PENDING_RESULT_ADMISSION_NOT_ACTIVE'),
    );
    expect(handoff.indexOf('INPATIENT_PENDING_RESULT_ADMISSION_NOT_ACTIVE')).toBeLessThan(
      handoff.indexOf('INSERT INTO discharge_pending_result_handoffs'),
    );
  });

  it('returns an already-current attending doctor before duplicate writes or evidence', () => {
    const source = serviceSource('../../services/emr/admissionService.js');
    const start = source.indexOf('async function updateAttendingDoctor');
    const end = source.indexOf('async function updateNextReviewAt', start);
    const update = source.slice(start, end);
    const samePhysician = update.indexOf("String(previousDoctor || '').toLowerCase()");
    const admissionWrite = update.indexOf('const updated = await tx.admissions.update');
    const canonicalWrite = update.indexOf('await recordCanonicalAdmissionEvent');

    expect(samePhysician).toBeGreaterThanOrEqual(0);
    expect(update.slice(samePhysician, admissionWrite)).toContain(
      'recordPrimaryPhysicianChangeTx',
    );
    expect(update.slice(samePhysician, admissionWrite)).toContain(
      'return findAdmissionById',
    );
    expect(admissionWrite).toBeGreaterThan(samePhysician);
    expect(canonicalWrite).toBeGreaterThan(admissionWrite);
  });

  it('keeps shadow-mode bed assignment observational', () => {
    const source = serviceSource('../../services/emr/admissionService.js');
    const start = source.indexOf('async function assignBedToAdmission');
    const end = source.indexOf('async function', start + 20);
    const assignment = source.slice(start, end);

    expect(assignment).toContain(
      'if (pathwayMode === PATHWAY_MODES.ACTIVE)',
    );
    expect(assignment).not.toContain(
      'if (pathwayMode !== PATHWAY_MODES.OFF)',
    );
  });
});
