/**
 * Admin routes for ABDM HIP/HIU (Phase D1).
 * Mounted at /api/v1/admin/abdm.
 */

import express from 'express';

import { success } from '../../utils/responseHelper.js';
import {
  createConsentRequest,
  createDataTransfer,
  expireConsentArtifacts,
  getAbhaProfileByAbhaId,
  linkCareContext,
  listAbhaProfiles,
  listCareContexts,
  listConsentArtifacts,
  listDataTransfers,
  listFacilityMappings,
  listPractitionerMappings,
  listWebhookEvents,
  markWebhookProcessed,
  recordConsentArtifact,
  recordWebhookEvent,
  revokeConsentArtifact,
  transitionConsentRequest,
  transitionDataTransfer,
  unlinkCareContext,
  upsertAbhaProfile,
  upsertFacilityMapping,
  upsertPractitionerMapping,
} from '../../services/abdmFull/abdmHipHiuService.js';

const router = express.Router();

// ABHA profiles
router.put('/abha-profiles', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertAbhaProfile({
      tenantId: req.tenantId,
      patientUid: b.patient_uid, abhaId: b.abha_id, abhaAddress: b.abha_address,
      fullName: b.full_name, dateOfBirth: b.date_of_birth, gender: b.gender,
      stateCode: b.state_code, districtCode: b.district_code, pincode: b.pincode,
      kycVerified: b.kyc_verified, kycMethod: b.kyc_method,
      status: b.status, metadata: b.metadata,
    });
    return success(res, row, 'ABHA profile saved');
  } catch (err) { return next(err); }
});

router.get('/abha-profiles', async (req, res, next) => {
  try {
    const result = await listAbhaProfiles({
      tenantId: req.tenantId,
      status: req.query.status || null,
      kycVerified: req.query.kyc_verified != null ? req.query.kyc_verified === 'true' : null,
      limit: req.query.limit,
    });
    return success(res, result, 'ABHA profiles retrieved');
  } catch (err) { return next(err); }
});

router.get('/abha-profiles/by-id/:abhaId', async (req, res, next) => {
  try {
    const row = await getAbhaProfileByAbhaId({
      tenantId: req.tenantId, abhaId: req.params.abhaId,
    });
    return success(res, row, 'ABHA profile retrieved');
  } catch (err) { return next(err); }
});

// Facility mappings (HFR)
router.put('/facility-mappings', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertFacilityMapping({
      tenantId: req.tenantId,
      facilityId: b.facility_id,
      hfrId: b.hfr_id, facilityName: b.facility_name,
      ownershipKind: b.ownership_kind, facilityKind: b.facility_kind,
      registrationStatus: b.registration_status,
      stateCode: b.state_code, districtCode: b.district_code, pincode: b.pincode,
      metadata: b.metadata, createdBy: req.user?.uid || null,
    });
    return success(res, row, 'Facility mapping saved');
  } catch (err) { return next(err); }
});

router.get('/facility-mappings', async (req, res, next) => {
  try {
    const result = await listFacilityMappings({
      tenantId: req.tenantId,
      registrationStatus: req.query.registration_status || null,
    });
    return success(res, result, 'Facility mappings retrieved');
  } catch (err) { return next(err); }
});

// Practitioner mappings (HPR)
router.put('/practitioner-mappings', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await upsertPractitionerMapping({
      tenantId: req.tenantId, staffUid: b.staff_uid,
      hprId: b.hpr_id, fullName: b.full_name,
      specialty: b.specialty, councilName: b.council_name,
      registrationNumber: b.registration_number, registrationYear: b.registration_year,
      qualification: b.qualification, status: b.status, metadata: b.metadata,
    });
    return success(res, row, 'Practitioner mapping saved');
  } catch (err) { return next(err); }
});

router.get('/practitioner-mappings', async (req, res, next) => {
  try {
    const result = await listPractitionerMappings({
      tenantId: req.tenantId, status: req.query.status || null,
    });
    return success(res, result, 'Practitioner mappings retrieved');
  } catch (err) { return next(err); }
});

// Care contexts
router.post('/care-contexts', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await linkCareContext({
      tenantId: req.tenantId,
      abhaProfileId: b.abha_profile_id, patientUid: b.patient_uid,
      facilityMappingId: b.facility_mapping_id,
      referenceId: b.reference_id, display: b.display, hiType: b.hi_type,
      sourceResourceType: b.source_resource_type, sourceResourceId: b.source_resource_id,
      metadata: b.metadata,
    });
    return success(res, row, 'Care context linked', 201);
  } catch (err) { return next(err); }
});

router.patch('/care-contexts/:id/unlink', async (req, res, next) => {
  try {
    const row = await unlinkCareContext({ tenantId: req.tenantId, id: req.params.id });
    return success(res, row, 'Care context unlinked');
  } catch (err) { return next(err); }
});

router.get('/care-contexts', async (req, res, next) => {
  try {
    const result = await listCareContexts({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      hiType: req.query.hi_type || null,
      status: req.query.status || null,
    });
    return success(res, result, 'Care contexts retrieved');
  } catch (err) { return next(err); }
});

// Consent requests
router.post('/consent-requests', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createConsentRequest({
      tenantId: req.tenantId,
      requestId: b.request_id, flowKind: b.flow_kind,
      abhaId: b.abha_id, abhaProfileId: b.abha_profile_id,
      patientUid: b.patient_uid, requesterUid: b.requester_uid || req.user?.uid || null,
      hiTypes: b.hi_types, permissionKind: b.permission_kind,
      dataFrom: b.data_from, dataTo: b.data_to, expiryAt: b.expiry_at,
      purposeCode: b.purpose_code, environment: b.environment, metadata: b.metadata,
    });
    return success(res, row, 'Consent request created', 201);
  } catch (err) { return next(err); }
});

router.patch('/consent-requests/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionConsentRequest({
      tenantId: req.tenantId, id: req.params.id,
      nextStatus: req.body?.next_status,
      notificationFailure: req.body?.notification_failure,
    });
    return success(res, row, 'Consent request transitioned');
  } catch (err) { return next(err); }
});

// Consent artifacts
router.post('/consent-artifacts', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await recordConsentArtifact({
      tenantId: req.tenantId,
      consentRequestId: b.consent_request_id, artifactId: b.artifact_id,
      abhaId: b.abha_id, patientUid: b.patient_uid,
      hiTypes: b.hi_types, permissionKind: b.permission_kind,
      dataFrom: b.data_from, dataTo: b.data_to, expiryAt: b.expiry_at,
      signedPayload: b.signed_payload, signatureKid: b.signature_kid,
      signatureAlgorithm: b.signature_algorithm,
      environment: b.environment, metadata: b.metadata,
    });
    return success(res, row, 'Consent artifact recorded', 201);
  } catch (err) { return next(err); }
});

router.patch('/consent-artifacts/:id/revoke', async (req, res, next) => {
  try {
    const row = await revokeConsentArtifact({ tenantId: req.tenantId, id: req.params.id });
    return success(res, row, 'Consent artifact revoked');
  } catch (err) { return next(err); }
});

router.post('/consent-artifacts/expire-now', async (req, res, next) => {
  try {
    const result = await expireConsentArtifacts({ tenantId: req.tenantId });
    return success(res, result, 'Expired-artifact sweep complete');
  } catch (err) { return next(err); }
});

router.get('/consent-artifacts', async (req, res, next) => {
  try {
    const result = await listConsentArtifacts({
      tenantId: req.tenantId,
      status: req.query.status || null,
      abhaId: req.query.abha_id || null,
      environment: req.query.environment || null,
    });
    return success(res, result, 'Consent artifacts retrieved');
  } catch (err) { return next(err); }
});

// Data transfers
router.post('/data-transfers', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await createDataTransfer({
      tenantId: req.tenantId,
      consentArtifactId: b.consent_artifact_id, transactionId: b.transaction_id,
      patientUid: b.patient_uid, abhaId: b.abha_id,
      direction: b.direction, bundleKind: b.bundle_kind,
      payloadSizeBytes: b.payload_size_bytes,
      encryptionKind: b.encryption_kind, destinationUrl: b.destination_url,
      hiTypes: b.hi_types, environment: b.environment, metadata: b.metadata,
    });
    return success(res, row, 'Data transfer created', 201);
  } catch (err) { return next(err); }
});

router.patch('/data-transfers/:id/transition', async (req, res, next) => {
  try {
    const row = await transitionDataTransfer({
      tenantId: req.tenantId, id: req.params.id,
      nextStatus: req.body?.next_status,
      failureReason: req.body?.failure_reason,
      attemptIncrement: req.body?.attempt_increment,
    });
    return success(res, row, 'Data transfer transitioned');
  } catch (err) { return next(err); }
});

router.get('/data-transfers', async (req, res, next) => {
  try {
    const result = await listDataTransfers({
      tenantId: req.tenantId,
      status: req.query.status || null,
      direction: req.query.direction || null,
      environment: req.query.environment || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Data transfers retrieved');
  } catch (err) { return next(err); }
});

// Webhook events
router.post('/webhook-events', async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await recordWebhookEvent({
      tenantId: req.tenantId,
      externalEventId: b.external_event_id, eventType: b.event_type,
      source: b.source, signatureVerified: b.signature_verified,
      signatureKid: b.signature_kid, payload: b.payload,
      environment: b.environment, metadata: b.metadata,
    });
    return success(res, result, result.duplicate ? 'Webhook event already recorded (idempotent)' : 'Webhook event recorded', result.duplicate ? 200 : 201);
  } catch (err) { return next(err); }
});

router.patch('/webhook-events/:id/process', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await markWebhookProcessed({
      tenantId: req.tenantId, id: req.params.id,
      status: b.status, failureReason: b.failure_reason,
      relatedRequestId: b.related_request_id,
      relatedArtifactId: b.related_artifact_id,
      relatedTransferId: b.related_transfer_id,
    });
    return success(res, row, 'Webhook event processed');
  } catch (err) { return next(err); }
});

router.get('/webhook-events', async (req, res, next) => {
  try {
    const result = await listWebhookEvents({
      tenantId: req.tenantId,
      status: req.query.status || null,
      eventType: req.query.event_type || null,
      environment: req.query.environment || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Webhook events retrieved');
  } catch (err) { return next(err); }
});

export default router;
