import { Router } from 'express';

import { success } from '../../utils/responseHelper.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import {
  createPerfusionDeviceLink,
  createPerfusionRecord,
  finalizePerfusionSignoff,
  listCtvsCaseOverlays,
  listPerfusionDeviceLinks,
  listPerfusionRecords,
  upsertCtvsCaseOverlay,
  upsertPerfusionSignoff,
} from '../../services/theatre/ctvsPerfusionService.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

router.put('/overlays/:otScheduleId', async (req, res, next) => {
  try {
    const body = req.body || {};
    const overlay = await upsertCtvsCaseOverlay({
      tenantId: tenantOf(req),
      otScheduleId: req.params.otScheduleId,
      procedureCategory: body.procedure_category,
      bypassExpected: body.bypass_expected,
      bloodProductReadiness: body.blood_product_readiness,
      implantDeviceReadiness: body.implant_device_readiness,
      evidenceOwnerUid: body.evidence_owner_uid,
      policySourceLabel: body.policy_source_label,
      policySourceVersion: body.policy_source_version,
      sourceDocumentRefs: body.source_document_refs,
      attachmentRefs: body.attachment_refs,
      metadata: body.metadata,
      actorUid: req.user?.uid || null,
    });
    return success(res, { overlay }, 'CTVS case overlay saved');
  } catch (err) { return next(err); }
});

router.get('/overlays', async (req, res, next) => {
  try {
    const result = await listCtvsCaseOverlays({
      tenantId: tenantOf(req),
      otScheduleId: req.query.ot_schedule_id,
      patientUid: req.query.patient_uid,
      limit: req.query.limit,
    });
    return success(res, result, 'CTVS case overlays retrieved');
  } catch (err) { return next(err); }
});

router.post('/perfusion-records', async (req, res, next) => {
  try {
    const body = req.body || {};
    const record = await createPerfusionRecord({
      tenantId: tenantOf(req),
      otScheduleId: body.ot_schedule_id,
      perfusionistUid: body.perfusionist_uid || req.user?.uid || null,
      bypassStartedAt: body.bypass_started_at,
      bypassEndedAt: body.bypass_ended_at,
      crossClampStartedAt: body.cross_clamp_started_at,
      crossClampEndedAt: body.cross_clamp_ended_at,
      actBaselineSeconds: body.act_baseline_seconds,
      actPeakSeconds: body.act_peak_seconds,
      actLastSeconds: body.act_last_seconds,
      temperatureMinC: body.temperature_min_c,
      temperatureMaxC: body.temperature_max_c,
      actSummary: body.act_summary,
      temperatureSummary: body.temperature_summary,
      fluidsProductsSummary: body.fluids_products_summary,
      complications: body.complications,
      status: body.status,
      evidenceOwnerUid: body.evidence_owner_uid,
      recordPolicySourceLabel: body.record_policy_source_label,
      recordPolicySourceVersion: body.record_policy_source_version,
      sourceDocumentRefs: body.source_document_refs,
      attachmentRefs: body.attachment_refs,
      metadata: body.metadata,
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, { record }, 'Perfusion record created', 201);
  } catch (err) { return next(err); }
});

router.get('/perfusion-records', async (req, res, next) => {
  try {
    const result = await listPerfusionRecords({
      tenantId: tenantOf(req),
      otScheduleId: req.query.ot_schedule_id,
      patientUid: req.query.patient_uid,
      limit: req.query.limit,
    });
    return success(res, result, 'Perfusion records retrieved');
  } catch (err) { return next(err); }
});

router.post('/perfusion-records/:id/signoff', async (req, res, next) => {
  try {
    const body = req.body || {};
    const signoff = await upsertPerfusionSignoff({
      tenantId: tenantOf(req),
      perfusionRecordId: req.params.id,
      perfusionistSignedBy: body.perfusionist_signed_by,
      perfusionistSignedAt: body.perfusionist_signed_at,
      surgeonReviewedBy: body.surgeon_reviewed_by,
      surgeonReviewedAt: body.surgeon_reviewed_at,
      anesthesiaReviewedBy: body.anesthesia_reviewed_by,
      anesthesiaReviewedAt: body.anesthesia_reviewed_at,
      evidenceOwnerUid: body.evidence_owner_uid,
      signoffPolicySourceLabel: body.signoff_policy_source_label,
      signoffPolicySourceVersion: body.signoff_policy_source_version,
      sourceDocumentRefs: body.source_document_refs,
      attachmentRefs: body.attachment_refs,
      metadata: body.metadata,
    });
    return success(res, { signoff }, 'Perfusion sign-off saved');
  } catch (err) { return next(err); }
});

router.post('/perfusion-signoffs/:id/finalize', async (req, res, next) => {
  try {
    const signoff = await finalizePerfusionSignoff({
      tenantId: tenantOf(req),
      id: req.params.id,
      finalizedBy: req.user?.uid || null,
      actorRole: req.user?.role || null,
    });
    return success(res, { signoff }, 'Perfusion sign-off finalized');
  } catch (err) { return next(err); }
});

router.post('/perfusion-records/:id/device-links', async (req, res, next) => {
  try {
    const body = req.body || {};
    const link = await createPerfusionDeviceLink({
      tenantId: tenantOf(req),
      perfusionRecordId: req.params.id,
      devicePatientAssociationId: body.device_patient_association_id,
      vendorDocumentRef: body.vendor_document_ref,
      vendorSourceLabel: body.vendor_source_label,
      vendorSourceVersion: body.vendor_source_version,
      summaryImportStatus: body.summary_import_status,
      importedSummary: body.imported_summary,
      attachmentRefs: body.attachment_refs,
      metadata: body.metadata,
      actorUid: req.user?.uid || null,
    });
    return success(res, { link }, 'Perfusion device link created', 201);
  } catch (err) { return next(err); }
});

router.get('/perfusion-records/:id/device-links', async (req, res, next) => {
  try {
    const result = await listPerfusionDeviceLinks({
      tenantId: tenantOf(req),
      perfusionRecordId: req.params.id,
      limit: req.query.limit,
    });
    return success(res, result, 'Perfusion device links retrieved');
  } catch (err) { return next(err); }
});

export default router;
