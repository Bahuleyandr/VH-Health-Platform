import { success } from '../../utils/responseHelper.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessPolicyRegistry.js';
import { authorizePatientAccessRequest } from '../../services/security/accessDecisionService.js';
import { parseClinicalContinuityPaperCommand } from '../../validators/clinicalContinuityPaperSchemas.js';
import {
  parseHeldMessageAttestation,
  parseHeldMessageBinding,
  parseHeldMessageRelease,
} from '../../validators/clinicalContinuityHeldReleaseSchemas.js';
import {
  attestClinicalContinuityHeldMessageRelease,
  bindClinicalContinuityHeldMessage,
  releaseClinicalContinuityHeldMessage,
} from '../../services/downtime/clinicalContinuityHeldReleaseService.js';
import {
  approveIncidentPacketContactSheet,
  createIncidentPacketContactSheet,
  getIncidentPacketArtifact,
  provisionIncidentPacket as provisionIncidentPacketService,
  recordIncidentPacketCustody,
  refreshIncidentPacket,
  revokeIncidentPacket,
} from '../../services/downtime/clinicalContinuityIncidentPacketProvisioningService.js';
import {
  appendClinicalContinuityIncidentAlias,
  applyClinicalContinuityPaperBackEntry,
  attestClinicalContinuityClosure,
  checkClinicalContinuityClosure,
  closeClinicalContinuityIncident,
  decideClinicalContinuityReconciliationItem,
  declareClinicalContinuityIncident,
  listClinicalContinuityWorkbench,
  recordClinicalContinuityDeviceOffset,
  recordClinicalContinuityInterfaceRequirement,
  recordClinicalContinuityRangeDisposition,
  registerClinicalContinuityPaperItem,
  transitionClinicalContinuityIncident,
} from '../../services/downtime/clinicalContinuityReconciliationService.js';
import {
  approveContinuityMerge,
  executeContinuityMerge,
  requestContinuityMerge,
} from '../../services/patient/patientMergeService.js';

function authority(req) {
  return {
    tenantId: req.tenantId,
    facilityId: req.continuityFacilityContext.facilityId,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    requestId: req.id,
  };
}

function createdStatus(result) {
  return result?.disposition === 'exact_duplicate' ? 200 : 201;
}

function authorizePaperPatient(req, actionId = null) {
  const policyCode = {
    'mar.administration.backfill': ACCESS_POLICY_CODES.PATIENT_CONTINUITY_MAR_BACK_ENTRY,
    'lab.specimen_collection.backfill': ACCESS_POLICY_CODES.PATIENT_CONTINUITY_SPECIMEN_BACK_ENTRY,
    'blood.transfusion_verification.backfill': ACCESS_POLICY_CODES.PATIENT_CONTINUITY_TRANSFUSION_BACK_ENTRY,
  }[actionId] || ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE;
  return ({ patientUid, patientId }) => authorizePatientAccessRequest(req, {
    policyCode,
    recordType: 'CLINICAL_CONTINUITY_PAPER_BACK_ENTRY',
    patient: { uid: patientUid, id: patientId },
    requireResolvedPatient: true,
    shadowMode: false,
  });
}

async function recordIncidentDeclaration(req, res, next, declarationSource) {
  try {
    const result = await declareClinicalContinuityIncident({
      ...authority(req),
      expectedVersion: req.body?.expected_version,
      packetId: req.body?.packet_id,
      reservedIncidentId: req.body?.reserved_incident_id,
      signedCanonicalHash: req.body?.signed_canonical_hash,
      signature: req.body?.signature,
      occurredAt: req.body?.occurred_at,
      declarationSource,
      sourceDeviceId: req.continuityFacilityContext.deviceId,
      sourceSessionId: req.continuityFacilityContext.contextId,
    });
    return success(res, result, 'Clinical continuity incident declaration recorded', createdStatus(result));
  } catch (error) {
    return next(error);
  }
}

export async function declareIncident(req, res, next) {
  return recordIncidentDeclaration(req, res, next, 'online');
}

export async function importIncident(req, res, next) {
  return recordIncidentDeclaration(req, res, next, 'offline_import');
}

export async function createIncidentContactSheet(req, res, next) {
  try {
    const result = await createIncidentPacketContactSheet({
      ...authority(req),
      content: req.body?.content,
    });
    return success(res, result, 'Incident-packet contact sheet created', 201);
  } catch (error) {
    return next(error);
  }
}

export async function approveIncidentContactSheet(req, res, next) {
  try {
    const result = await approveIncidentPacketContactSheet({
      ...authority(req),
      contactSheetId: req.params.contactSheetId,
    });
    return success(res, result, 'Incident-packet contact sheet approved', 201);
  } catch (error) {
    return next(error);
  }
}

export async function provisionIncidentPacket(req, res, next) {
  try {
    const result = await provisionIncidentPacketService({
      ...authority(req),
      contactSheetId: req.body?.contact_sheet_id,
      requestId: req.body?.request_id,
      signer: req.app?.locals?.clinicalContinuitySigner,
    });
    return success(
      res,
      result,
      result.disposition === 'exact_duplicate'
        ? 'Prior incident packet returned'
        : 'Incident packet provisioned',
      result.disposition === 'exact_duplicate' ? 200 : 201,
    );
  } catch (error) {
    return next(error);
  }
}

export async function refreshProvisionedIncidentPacket(req, res, next) {
  try {
    const result = await refreshIncidentPacket({
      ...authority(req),
      packetId: req.params.packetId,
      contactSheetId: req.body?.contact_sheet_id,
      requestId: req.body?.request_id,
      signer: req.app?.locals?.clinicalContinuitySigner,
    });
    return success(res, result, 'Replacement incident packet provisioned', 201);
  } catch (error) {
    return next(error);
  }
}

export async function getProvisionedIncidentPacketArtifact(req, res, next) {
  try {
    const result = await getIncidentPacketArtifact({
      ...authority(req),
      packetId: req.params.packetId,
    });
    res.set('Cache-Control', 'no-store, max-age=0');
    return success(res, result, 'Incident-packet artifact');
  } catch (error) {
    return next(error);
  }
}

export async function recordProvisionedIncidentPacketCustody(req, res, next) {
  try {
    const result = await recordIncidentPacketCustody({
      ...authority(req),
      packetId: req.params.packetId,
      eventType: req.body?.event_type,
      copyNumber: req.body?.copy_number,
      evidenceHash: req.body?.evidence_hash,
      notes: req.body?.notes,
      occurredAt: req.body?.occurred_at,
    });
    return success(res, result, 'Incident-packet custody evidence recorded', 201);
  } catch (error) {
    return next(error);
  }
}

export async function revokeProvisionedIncidentPacket(req, res, next) {
  try {
    const result = await revokeIncidentPacket({
      ...authority(req),
      packetId: req.params.packetId,
      reason: req.body?.reason,
    });
    return success(res, result, 'Incident packet revoked');
  } catch (error) {
    return next(error);
  }
}

export async function transitionIncident(req, res, next) {
  try {
    const result = await transitionClinicalContinuityIncident({
      ...authority(req),
      incidentId: req.params.incidentId,
      expectedVersion: req.body?.expected_version,
      nextState: req.body?.next_state,
    });
    return success(res, result, 'Clinical continuity incident updated');
  } catch (error) {
    return next(error);
  }
}

export async function recordRangeDisposition(req, res, next) {
  try {
    const result = await recordClinicalContinuityRangeDisposition({
      ...authority(req),
      incidentId: req.params.incidentId,
      expectedVersion: req.body?.expected_version,
      disposition: req.body?.disposition,
      reasonCode: req.body?.reason_code,
      lastAccountedNumber: req.body?.last_accounted_number,
    });
    return success(res, result, 'Paper range disposition recorded');
  } catch (error) {
    return next(error);
  }
}

export async function appendIncidentAlias(req, res, next) {
  try {
    const result = await appendClinicalContinuityIncidentAlias({
      ...authority(req),
      observedIncidentId: req.body?.observed_incident_id,
      canonicalIncidentId: req.body?.canonical_incident_id,
      expectedVersion: req.body?.expected_version,
      reasonCode: req.body?.reason_code,
      supersedesAliasId: req.body?.supersedes_alias_id,
    });
    return success(res, result, 'Incident alias decision appended', 201);
  } catch (error) {
    return next(error);
  }
}

export async function registerPaperItem(req, res, next) {
  try {
    const result = await registerClinicalContinuityPaperItem({
      ...authority(req),
      incidentId: req.params.incidentId,
      paperItemId: req.params.paperItemId,
      expectedVersion: req.body?.expected_version,
      itemKind: req.body?.item_kind,
      actionId: req.body?.action_id,
      originalActorUid: req.body?.original_actor_uid,
      originalActorRole: req.body?.original_actor_role,
      occurredAt: req.body?.occurred_at,
      patientUid: req.body?.patient_uid,
      temporaryIdentityId: req.body?.temporary_identity_id,
      encounterId: req.body?.encounter_id,
      evidenceHash: req.body?.evidence_hash,
      patientAuthorizer: authorizePaperPatient(req, req.body?.action_id),
    });
    return success(res, result, 'Paper item registered', createdStatus(result));
  } catch (error) {
    return next(error);
  }
}

function paperCommand(actionId) {
  return async (req, res, next) => {
    try {
      const parsed = parseClinicalContinuityPaperCommand({
        actionId,
        body: req.body,
        incidentId: req.params.incidentId,
        paperItemId: req.params.paperItemId,
      });
      const result = await applyClinicalContinuityPaperBackEntry({
        ...authority(req),
        facilityContext: req.continuityFacilityContext,
        appVersion: req.get('x-vh-client-app-version'),
        devicePosture: req.user?.deviceType,
        idempotencyKey: req.get('idempotency-key'),
        parsed,
        patientAuthorizer: authorizePaperPatient(req, actionId),
      });
      return success(
        res,
        result,
        result.disposition === 'needs_review'
          ? 'Paper fact requires reconciliation'
          : 'Retrospective paper fact recorded',
        result.replayed ? 200 : result.disposition === 'needs_review' ? 409 : 201,
      );
    } catch (error) {
      return next(error);
    }
  };
}

export const backfillMedicationAdministration = paperCommand('mar.administration.backfill');
export const backfillSpecimenCollection = paperCommand('lab.specimen_collection.backfill');
export const backfillTransfusionVerification = paperCommand('blood.transfusion_verification.backfill');

export async function listWorkbench(req, res, next) {
  try {
    const result = await listClinicalContinuityWorkbench({
      tenantId: req.tenantId,
      facilityId: req.continuityFacilityContext.facilityId,
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      incidentId: req.query.incident_id,
      queueType: req.query.queue_type,
      interfaceItemKind: req.query.interface_item_kind,
    });
    return success(res, result, 'Clinical continuity reconciliation workbench');
  } catch (error) {
    return next(error);
  }
}

export async function bindHeldMessage(req, res, next) {
  try {
    const result = await bindClinicalContinuityHeldMessage({
      ...authority(req),
      incidentId: req.params.incidentId,
      parsed: parseHeldMessageBinding(req.body),
    });
    return success(
      res,
      result,
      'Held message bound to continuity reconciliation',
      result.exact_duplicate ? 200 : 201,
    );
  } catch (error) {
    return next(error);
  }
}

export async function attestHeldMessageRelease(req, res, next) {
  try {
    const result = await attestClinicalContinuityHeldMessageRelease({
      ...authority(req),
      itemId: req.params.itemId,
      parsed: parseHeldMessageAttestation(req.body),
    });
    return success(res, result, 'Held-message release attestation recorded', 201);
  } catch (error) {
    return next(error);
  }
}

export async function releaseHeldMessage(req, res, next) {
  try {
    const result = await releaseClinicalContinuityHeldMessage({
      ...authority(req),
      itemId: req.params.itemId,
      parsed: parseHeldMessageRelease(req.body),
      facilityContext: req.continuityFacilityContext,
      appVersion: req.get('x-vh-client-app-version'),
      devicePosture: req.user?.deviceType,
      idempotencyKey: req.get('idempotency-key'),
    });
    return success(
      res,
      result,
      result.disposition === 'exact_duplicate'
        ? 'Prior held-message release outcome returned'
        : 'Held-message send authority released',
      result.disposition === 'exact_duplicate' ? 200 : 201,
    );
  } catch (error) {
    return next(error);
  }
}

export async function decideReconciliationItem(req, res, next) {
  try {
    const result = await decideClinicalContinuityReconciliationItem({
      ...authority(req),
      itemId: req.params.itemId,
      expectedVersion: req.body?.expected_version,
      decision: req.body?.decision,
      reasonCode: req.body?.reason_code,
    });
    return success(res, result, 'Reconciliation decision appended');
  } catch (error) {
    return next(error);
  }
}

export async function recordDeviceOffset(req, res, next) {
  try {
    const result = await recordClinicalContinuityDeviceOffset({
      ...authority(req),
      incidentId: req.params.incidentId,
      deviceId: req.params.deviceId,
      requiredHighWaterMark: req.body?.required_high_water_mark,
      observedHighWaterMark: req.body?.observed_high_water_mark,
      disposition: req.body?.disposition,
      expectedVersion: req.body?.expected_version,
    });
    return success(res, { device_offset: result }, 'Device journal evidence recorded');
  } catch (error) {
    return next(error);
  }
}

export async function recordInterfaceRequirement(req, res, next) {
  try {
    const result = await recordClinicalContinuityInterfaceRequirement({
      ...authority(req),
      incidentId: req.params.incidentId,
      offsetId: req.body?.offset_id,
      interfaceFamily: req.body?.interface_family,
      direction: req.body?.direction,
      sourcePartition: req.body?.source_partition,
      requiredGeneration: req.body?.required_generation,
      requiredHighWaterPosition: req.body?.required_high_water_position,
      requiredHighWaterToken: req.body?.required_high_water_token,
      disposition: req.body?.disposition,
      expectedVersion: req.body?.expected_version,
    });
    return success(res, { interface_requirement: result }, 'Interface reconciliation evidence recorded');
  } catch (error) {
    return next(error);
  }
}

export async function checkClosure(req, res, next) {
  try {
    const result = await checkClinicalContinuityClosure({
      ...authority(req),
      incidentId: req.params.incidentId,
    });
    return success(res, result, 'Incident closure predicate evaluated');
  } catch (error) {
    return next(error);
  }
}

export async function attestClosure(req, res, next) {
  try {
    const result = await attestClinicalContinuityClosure({
      ...authority(req),
      incidentId: req.params.incidentId,
      expectedVersion: req.body?.expected_version,
      attestationKind: req.body?.attestation_kind,
    });
    return success(res, result, 'Incident closure attestation appended', 201);
  } catch (error) {
    return next(error);
  }
}

export async function closeIncident(req, res, next) {
  try {
    const result = await closeClinicalContinuityIncident({
      ...authority(req),
      incidentId: req.params.incidentId,
      expectedVersion: req.body?.expected_version,
    });
    return success(res, result, 'Clinical continuity incident closed');
  } catch (error) {
    return next(error);
  }
}

export async function proposeIdentityMatch(req, res, next) {
  try {
    const result = await requestContinuityMerge({
      tenantId: req.tenantId,
      facilityId: req.continuityFacilityContext.facilityId,
      incidentId: req.params.incidentId,
      packetId: req.body?.packet_id,
      paperItemRowId: req.body?.paper_item_row_id,
      temporaryIdentityId: req.body?.temporary_identity_id,
      targetPatientUid: req.body?.target_patient_uid,
      requestedBy: req.user?.uid,
      requesterRole: req.user?.role,
      requesterNote: req.body?.note,
      requestId: req.id,
    });
    return success(res, result, 'Temporary identity match proposed', 201);
  } catch (error) {
    return next(error);
  }
}

export async function approveIdentityMatch(req, res, next) {
  try {
    const result = await approveContinuityMerge({
      tenantId: req.tenantId,
      facilityId: req.continuityFacilityContext.facilityId,
      id: req.params.mergeId,
      approvedBy: req.user?.uid,
      approverRole: req.user?.role,
      approverNote: req.body?.note,
      requestId: req.id,
    });
    return success(res, result, 'Temporary identity match approved');
  } catch (error) {
    return next(error);
  }
}

export async function executeIdentityMatch(req, res, next) {
  try {
    const result = await executeContinuityMerge({
      tenantId: req.tenantId,
      facilityId: req.continuityFacilityContext.facilityId,
      id: req.params.mergeId,
      executedBy: req.user?.uid,
      executorRole: req.user?.role,
      requestId: req.id,
    });
    return success(res, result, 'Temporary identity match executed');
  } catch (error) {
    return next(error);
  }
}
