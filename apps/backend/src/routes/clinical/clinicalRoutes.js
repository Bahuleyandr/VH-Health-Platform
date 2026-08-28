// src/routes/clinical/clinicalRoutes.js
import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import multer from 'multer';
import * as handoverService from '../../services/clinical/handoverService.js';
import * as marService from '../../services/clinical/marService.js';
import * as marFiveRightsService from '../../services/clinical/marFiveRightsService.js';
import * as marSupplyService from '../../services/clinical/marSupplyService.js';
import * as drugChartService from '../../services/clinical/drugChartService.js';
import * as news2Service from '../../services/clinical/news2Service.js';
import * as voiceSoapService from '../../services/ai/voiceSoapService.js';
import { describeSttConfig } from '../../services/ai/sttService.js';
import { reviewPolypharmacy } from '../../services/ai/polypharmacyAiService.js';
import { scoreDeterioration } from '../../services/ai/deteriorationEarlyWarningService.js';
import { createAmbientEncounter, listAmbientEncounters } from '../../services/ai/ambientDocumentationService.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { enforceStaffClinicalWriteDevicePosture } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { ADMIN_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { success, error } from '../../utils/responseHelper.js';
import { getAuthenticatedActorRoles, isDoctor } from '../../utils/roleHelpers.js';
import {
  requiredUUID, requiredString, optionalString, paramId,
  marScheduleValidator, marAdministerValidator, handoverValidator,
} from '../../validators/sharedValidators.js';
import {
  marAdministerIdempotencyBody,
  marAdministerWithScanIdempotencyBody,
    marExceptionClaimIdempotencyBody,
    marExceptionDispositionIdempotencyBody,
    marExceptionHandoffIdempotencyBody,
  marSupplyReconciliationIdempotencyBody,
  marTransitionIdempotencyBody,
} from './marIdempotencyProjection.js';

// Dedicated audio uploader — memory-backed, 20MB cap, audio-mime allowlist.
// Kept separate from the hospital-wide file uploader so voice-note-specific
// limits don't leak into the patient/radiology/pharmacy upload paths.
const AUDIO_MIMES = new Set([
  'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/mpeg', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'audio/ogg', 'audio/webm', 'audio/aac',
]);
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const type = String(file.mimetype || '').toLowerCase();
    if (!AUDIO_MIMES.has(type)) {
      return cb(new Error(`Unsupported audio type: ${type}`));
    }
    cb(null, true);
  },
});

const router = express.Router();
const POSTGRES_INTEGER_MAX = 2147483647n;
const POSTGRES_BIGINT_MAX = 9223372036854775807n;
const canonicalPositivePostgresInteger = (value) => {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]{0,9}$/.test(text) || BigInt(text) > POSTGRES_INTEGER_MAX) {
    throw new Error('must be a canonical positive PostgreSQL INTEGER');
  }
  return true;
};
const canonicalMedicationAdministrationIdParam = (name = 'id') => param(name)
  .custom(canonicalPositivePostgresInteger)
  .withMessage(`${name} must be a canonical positive PostgreSQL INTEGER`)
  .toInt();
const canonicalMedicationAdministrationIdBody = (name = 'ma_id') => body(name)
  .custom(canonicalPositivePostgresInteger)
  .withMessage(`${name} must be a canonical positive PostgreSQL INTEGER`)
  .toInt();
const canonicalPositiveSignedBigIntWireValue = (value) => {
  if (typeof value !== 'string'
      || !/^[1-9][0-9]{0,18}$/.test(value)
      || BigInt(value) > POSTGRES_BIGINT_MAX) {
    throw new Error('must be a canonical positive signed-64 decimal string');
  }
  return true;
};
const canonicalMarExceptionCaseId = (value) => {
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > POSTGRES_BIGINT_MAX) {
    throw new Error('must be a canonical positive signed-64 integer');
  }
  return true;
};

const guardClinicalPatientView = patientAccessGuard('CLINICAL_WORKFLOW', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});
const guardClinicalPatientWrite = patientAccessGuard('CLINICAL_WORKFLOW', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
});
const guardClinicalAppointmentWrite = patientAccessGuardForResource('CLINICAL_WORKFLOW', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'appointment',
  idSelector: (req) => req.body?.appointment_id || req.body?.appointmentId || null,
  allowNoPatientResource: true,
});
const guardClinicalAdmissionView = patientAccessGuardForResource('CLINICAL_WORKFLOW', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  resourceType: 'admission',
});
const guardMarResourceView = patientAccessGuardForResource('MAR', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
  resourceType: 'mar',
  idSelector: (req) => req.params?.id || req.body?.ma_id || null,
});
const guardMarResourceWrite = patientAccessGuardForResource('MAR', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'mar',
});
const guardMarSupplyReconciliationWrite = patientAccessGuardForResource('MAR', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_MAR_SUPPLY_RECONCILIATION_WRITE,
  resourceType: 'mar',
});
const guardHandoverResourceWrite = patientAccessGuardForResource('NURSE_HANDOVER', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'handover',
});

const MEDICATION_ADMINISTRATION_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'CNO',
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ICU_STAFF',
]);
const MAR_SUPPLY_RECONCILIATION_ROLES = new Set([
  'ADMIN',
  'SUPER_ADMIN',
  'PHARMACY_INCHARGE',
  'NURSING_INCHARGE',
  'IP_INCHARGE',
]);
const MAR_DUE_LIST_ROLES = new Set([
  'NURSING_STAFF',
  'NURSING_INCHARGE',
  'IP_STAFF_NURSE',
  'IP_INCHARGE',
  'CNO',
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ICU_STAFF',
]);

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

function requireMedicationAdministrationRole(req, res, next) {
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!MEDICATION_ADMINISTRATION_ROLES.has(role)) {
    return error(res, 'Only nursing roles can record inpatient medication administration', 403);
  }
  return next();
}

function requireMarSupplyReconciliationRole(req, res, next) {
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!MAR_SUPPLY_RECONCILIATION_ROLES.has(role)) {
    return error(res, 'Only pharmacy, nursing, or administrative in-charge roles can reconcile MAR supply evidence', 403);
  }
  return next();
}

function requirePrescriberRole(req, res, next) {
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!isDoctor(role)) {
    return error(res, 'Only an active prescriber may review a medication exception', 403);
  }
  return next();
}

function requireMarDueListRole(req, res, next) {
  const role = String(req.user?.role || '').trim().toUpperCase();
  if (!MAR_DUE_LIST_ROLES.has(role)) {
    return error(res, 'Only inpatient nursing roles can enumerate due medications', 403);
  }
  return next();
}

// ===================================================================
// NEWS2 Scoring Routes
// ===================================================================

/**
 * POST /clinical/news2/record
 * Record a NEWS2 assessment for a patient.
 */
router.post('/news2/record', requiredUUID('patient_uid'), validate, requireIdempotencyKey({ required: false, scope: 'news2_record' }), guardClinicalPatientWrite, async (req, res, next) => {
  try {
    const { patient_uid, vitals } = req.body;

    if (!patient_uid || !vitals) {
      return error(res, 'patient_uid and vitals are required', 400);
    }

    const requiredVitals = ['respiration_rate', 'spo2', 'temperature', 'systolic_bp', 'heart_rate', 'consciousness'];
    const missing = requiredVitals.filter((v) => vitals[v] === undefined && vitals[v] !== 0);
    if (missing.length > 0) {
      return error(res, `Missing required vital signs: ${missing.join(', ')}`, 400);
    }

    const record = await news2Service.recordNEWS2(patient_uid, vitals, req.user.uid);
    return success(res, record, 'NEWS2 assessment recorded', 201);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/news2/patient/:patientUid
 * Get NEWS2 history for a patient.
 */
router.get('/news2/patient/:patientUid',
  param('patientUid').isUUID().withMessage('patientUid must be a valid UUID'),
  validate,
  guardClinicalPatientView,
  async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const limit = parseInt(req.query.limit, 10) || 50;

    const result = await news2Service.getPatientNEWS2History(patientUid, limit);
    return success(res, result, 'NEWS2 history retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// Medication Administration Record (MAR) Routes
// ===================================================================

/**
 * GET /clinical/drug-chart/admission/:id
 * Unified inpatient drug chart for the current admission. Doctors prescribe
 * via /emr/orders; nurses administer via MAR; pharmacy receives ward indents.
 */
router.get('/drug-chart/admission/:id', paramId(), validate, guardClinicalAdmissionView, async (req, res, next) => {
  try {
    const chart = await drugChartService.getAdmissionDrugChart({
      admissionId: parseInt(req.params.id, 10),
      tenantId: req.tenantId || null,
      user: req.user,
    });
    return success(res, chart, 'Inpatient drug chart retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/schedule
 * Schedule medications for a patient.
 */
// E-10 — discoverability alias for the existing POST /api/v1/emr/notes
// path. Doctors searching for "where do I file a progress note?" hit
// /consultations, /visits, /progress-notes — none of which existed.
// This alias delegates to clinicalNotesService.createNote so the path
// people expect actually works. Finding:
// 2026-05-08-follow-up-opd-doctor-no-progress-note-api.
//
// Normalise note_type aliases (consultant_round, ward_round, daily_note,
// round → progress) and wrap plain-text bodies into the structured
// content shape the validator expects. Without this, a doctor calling
// the discoverability alias with the natural "consultant_round" type
// and a plain text body got a 400 even though the same content posts
// fine via /api/v1/emr/notes. Findings:
// 2026-05-10-inpatient-admission-doctor-progress-note-alias-rejects-normal-note.
const PROGRESS_NOTE_ALIASES = new Map([
  ['consultant_round', 'progress'],
  ['ward_round', 'progress'],
  ['daily_note', 'progress'],
  ['round', 'progress'],
  ['note', 'progress'],
]);

function normaliseProgressNoteType(raw) {
  if (!raw) return 'progress';
  const key = String(raw).trim().toLowerCase();
  return PROGRESS_NOTE_ALIASES.get(key) || key;
}

function buildProgressNoteContent(rawContent, summaryHint) {
  // Already structured object — pass through (validator catches missing
  // required fields). Same shape /api/v1/emr/notes accepts.
  if (rawContent && typeof rawContent === 'object' && !Array.isArray(rawContent)) {
    return rawContent;
  }
  const text = String(rawContent ?? '').trim();
  if (!text) return rawContent ?? null;
  // Plain text → fill the three required progress-note fields with the
  // same body so the validator passes. Doctors writing a brief consultant
  // round note shouldn't need to memorise the SOAP-adjacent schema.
  return {
    summary: summaryHint ? String(summaryHint).slice(0, 200) : text.slice(0, 200),
    current_status: text,
    plan: text,
    text,
  };
}

router.post('/progress-notes', requireIdempotencyKey({ required: false, scope: 'progress_note' }), guardClinicalAppointmentWrite, async (req, res, next) => {
  try {
    const { default: clinicalNotesService } = await import('../../services/emr/clinicalNotesService.js');
    const rawType = req.body.note_type || req.body.type;
    const noteType = normaliseProgressNoteType(rawType);
    const rawContent = req.body.content ?? req.body.note ?? req.body.body ?? req.body.text;
    const content = noteType === 'progress'
      ? buildProgressNoteContent(rawContent, req.body.summary)
      : rawContent;
    // encounter_id (UUID, IPD/ER) and appointment_id (int, OPD) are
    // DISTINCT keys — pass them through separately. Folding appointment_id
    // into encounter_id sent an integer to the UUID encounter lookup
    // (prisma.admissions.findFirst({ where: { encounter_id } })), which
    // threw a type error → 500 on every OPD note save. createNote already
    // binds OPD notes via appointment_id (migration 240).
    // Finding: /clinical/progress-notes 500s on OPD note save.
    const note = await clinicalNotesService.createNote({
      tenant_id: req.tenantId,
      encounter_id: req.body.encounter_id || null,
      appointment_id: req.body.appointment_id || null,
      patient_uid: req.body.patient_uid,
      author_uid: req.user?.uid,
      author_role: req.body.author_role || req.user?.role,
      note_type: noteType,
      content,
      // Trusted caller identity for the assigned-doctor ownership guard (H2).
      acting_user: { id: req.user?.id, uid: req.user?.uid, role: req.user?.role },
    });
    return success(res, note, 'Progress note filed', 201);
  } catch (err) {
    next(err);
  }
});

router.post('/mar/schedule', ...marScheduleValidator, validate, guardClinicalPatientWrite, async (req, res, next) => {
  try {
    const { patient_uid, prescription_id, medications } = req.body;

    if (!patient_uid) {
      return error(res, 'patient_uid is required', 400);
    }

    // E-4 — MAR can be pre-staged on admission with no medications yet,
    // so the nurse has a frame to chart against once the doctor's first
    // prescription lands. Empty medications[] returns an empty MAR list
    // (the chart frame already exists conceptually — the API just confirms
    // there are no scheduled doses yet). Finding:
    // 2026-05-08-inpatient-admission-nurse-mar-chicken-and-egg.
    const meds = Array.isArray(medications) ? medications : [];
    if (meds.length === 0) {
      return success(res, [], 'MAR ready (no medications scheduled yet)', 201);
    }

    return error(
      res,
      'Medication doses must be scheduled by the governed clinical-order workflow',
      409,
      {
        code: 'MAR_SCHEDULE_REQUIRES_CLINICAL_ORDER_WORKFLOW',
        order_endpoint: '/api/v1/emr/orders',
        patient_uid,
        prescription_id: prescription_id || null,
      },
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/:id/administer
 * Record medication administration.
 */
router.post('/mar/:id/administer', canonicalMedicationAdministrationIdParam(), ...marAdministerValidator.slice(1), validate, requireMedicationAdministrationRole, guardMarResourceWrite, requireIdempotencyKey({
  required: true,
  scope: 'mar_administer',
  requestBodyForIdempotency: marAdministerIdempotencyBody,
}), async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      notes,
      witness_uid,
      override_reason,
      supply_override_reason,
      supply_quantity,
    } = req.body;

    // B1 — scan-first policy: this non-scan path needs override_reason
    // (≥5 chars) while MAR_REQUIRE_BARCODE_SCAN is on; the service 409s
    // with MAR_SCAN_REQUIRED otherwise.
    const record = await marService.recordAdministration(
      parseInt(id, 10),
      req.user.uid,
      notes || null,
      witness_uid || null,
      {
        overrideReason: override_reason && override_reason.trim().length >= 5
          ? override_reason.trim()
          : null,
        supplyOverrideReason: supply_override_reason?.trim() || null,
        supplyQuantity: supply_quantity ?? null,
        commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
        requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
        httpIdempotencyClaimId: req.idempotencyClaim?.id || null,
        requestId: req.id || null,
        tenantId: req.tenantId,
      }
    );
    return success(res, record, 'Medication administration recorded');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/verify
 * Dry-run 5-rights check for a scheduled medication_administrations row.
 * Body: { ma_id, scanned_patient_uid, scanned_barcode }.
 * Returns { rights, allPassed, ma, context }. Does not write.
 */
router.post('/mar/verify',
  canonicalMedicationAdministrationIdBody(),
  requiredUUID('scanned_patient_uid'),
  requiredString('scanned_barcode', 100),
  validate,
  guardMarResourceView,
  async (req, res, next) => {
    try {
      const { ma_id, scanned_patient_uid, scanned_barcode } = req.body;
      const result = await marFiveRightsService.evaluate5Rights({
        ma_id: parseInt(ma_id, 10),
        scanned_patient_uid,
        scanned_barcode,
        tenantId: req.tenantId,
      });
      return success(res, result, result.allPassed ? 'All 5 rights passed' : '5-rights check failed');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /clinical/mar/:id/administer-with-scan
 * Commit a medication administration after a wristband + drug-barcode scan.
 * Body: { scanned_patient_uid, scanned_barcode, override_reason? }.
 * If any right fails and override_reason is absent, returns 409 with the
 * failing rights so the client can drive the override modal.
 */
router.post('/mar/:id/administer-with-scan',
  canonicalMedicationAdministrationIdParam(),
  requiredUUID('scanned_patient_uid'),
  requiredString('scanned_barcode', 100),
  body('witness_uid').optional({ nullable: true }).isUUID().withMessage('witness_uid must be a UUID'),
  optionalString('override_reason', 500),
  optionalString('supply_override_reason', 500),
  body('supply_quantity').optional({ nullable: true }).isFloat({ gt: 0 }).toFloat(),
  body('administered_at')
    .custom((value) => value == null || value === '')
    .withMessage('administered_at is accepted only by the governed paper reconciliation workflow'),
  validate,
  requireMedicationAdministrationRole,
  guardMarResourceWrite,
  requireIdempotencyKey({
    required: true,
    scope: 'mar_administer_scan',
    requestBodyForIdempotency: marAdministerWithScanIdempotencyBody,
  }),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const {
        scanned_patient_uid,
        scanned_barcode,
        witness_uid,
        override_reason,
        supply_override_reason,
        supply_quantity,
      } = req.body;
      const record = await marFiveRightsService.administerWithScan({
        ma_id: parseInt(id, 10),
        scanned_patient_uid,
        scanned_barcode,
        administeredBy: req.user.uid,
        witnessUid: witness_uid || null,
        overrideReason: override_reason && override_reason.trim().length >= 5 ? override_reason.trim() : null,
        supplyOverrideReason: supply_override_reason?.trim() || null,
        supplyQuantity: supply_quantity ?? null,
        commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
        requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
        httpIdempotencyClaimId: req.idempotencyClaim?.id || null,
        requestId: req.id || null,
        tenantId: req.tenantId,
      });
      return success(res, record, 'Medication administration recorded');
    } catch (err) {
      next(err);
    }
  },
);

router.get('/mar/:id/supply', canonicalMedicationAdministrationIdParam(), validate, guardMarResourceView, async (req, res, next) => {
  try {
    const state = await marSupplyService.getMarSupplyState(parseInt(req.params.id, 10), {
      tenantId: req.tenantId,
    });
    return success(res, state, 'MAR supply state retrieved');
  } catch (err) {
    next(err);
  }
});

router.post(
  '/mar/:id/supply-overrides/:consumptionId/reconcile',
  enforceStaffClinicalWriteDevicePosture,
  canonicalMedicationAdministrationIdParam('id'),
  param('consumptionId')
    .custom(canonicalPositiveSignedBigIntWireValue)
    .withMessage('consumptionId must be a canonical positive signed-64 decimal string'),
  body('allocations').isArray({ min: 1 }).withMessage('allocations must be a non-empty array'),
  body('allocations.*.inventory_allocation_id')
    .custom(canonicalPositiveSignedBigIntWireValue)
    .withMessage('inventory_allocation_id must be a canonical positive signed-64 decimal string'),
  body('allocations.*.quantity').isFloat({ gt: 0 }).toFloat(),
  validate,
  requireMarSupplyReconciliationRole,
  guardMarSupplyReconciliationWrite,
  requireIdempotencyKey({
    required: true,
    scope: 'mar_supply_reconcile',
    requestBodyForIdempotency: marSupplyReconciliationIdempotencyBody,
  }),
  async (req, res, next) => {
    try {
      const result = await marSupplyService.reconcileMarSupplyOverride(
        req.params.consumptionId,
        req.body.allocations,
        {
          tenantId: req.tenantId,
          reconciledBy: req.user.uid,
          commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
          expectedMedicationAdministrationId: req.params.id,
        },
      );
      return success(res, result, 'MAR supply reconciliation recorded');
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /clinical/mar/:id/miss
 * Record a missed medication dose.
 */
router.post('/mar/:id/miss', canonicalMedicationAdministrationIdParam(), requiredString('reason', 500), validate, requireMedicationAdministrationRole, guardMarResourceWrite, requireIdempotencyKey({
  required: true,
  scope: 'mar_miss',
  requestBodyForIdempotency: marTransitionIdempotencyBody,
}), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return error(res, 'Reason is required for missed medication', 400);
    }

    const record = await marService.recordMissed(
      parseInt(id, 10),
      reason,
      req.user.uid,
      {
        commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
        requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
        httpIdempotencyClaimId: req.idempotencyClaim?.id || null,
        requestId: req.id || null,
        tenantId: req.tenantId,
      },
    );
    return success(res, record, 'Missed medication recorded');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/:id/hold
 * Hold a medication with reason.
 */
router.post('/mar/:id/hold', canonicalMedicationAdministrationIdParam(), requiredString('reason', 500), validate, requireMedicationAdministrationRole, guardMarResourceWrite, requireIdempotencyKey({
  required: true,
  scope: 'mar_hold',
  requestBodyForIdempotency: marTransitionIdempotencyBody,
}), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return error(res, 'Reason is required to hold medication', 400);
    }

    const record = await marService.holdMedication(
      parseInt(id, 10),
      reason,
      req.user.uid,
      {
        commandKey: req.idempotencyClaim?.requestKey || req.get('idempotency-key'),
        requestFingerprint: req.idempotencyClaim?.requestBodyHash || null,
        httpIdempotencyClaimId: req.idempotencyClaim?.id || null,
        requestId: req.id || null,
        tenantId: req.tenantId,
      },
    );
    return success(res, record, 'Medication held');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/mar/:id/release-hold
 * A held dose remains non-administrable until an active prescriber records a
 * release reason. Original hold attribution remains on the MAR record.
 */
router.post(
  '/mar/:id/release-hold',
  enforceStaffClinicalWriteDevicePosture,
  canonicalMedicationAdministrationIdParam(),
  requiredString('reason', 500),
  validate,
  requirePrescriberRole,
  requireIdempotencyKey({
    required: true,
    scope: 'mar_release_hold',
    requestBodyForIdempotency: marTransitionIdempotencyBody,
  }),
  async (req, res, next) => {
    try {
      const record = await marService.releaseHeldMedication(
        parseInt(req.params.id, 10),
        req.body.reason,
        req.user.uid,
        {
          tenantId: req.tenantId,
          commandKey: req.idempotencyClaim?.requestKey,
          requestFingerprint: req.idempotencyClaim?.requestBodyHash,
          httpIdempotencyClaimId: req.idempotencyClaim?.id,
          requestId: req.id,
        },
      );
      return success(res, record, 'Medication hold released by prescriber');
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  '/mar/exceptions',
  query('case_id')
    .optional()
    .custom(canonicalMarExceptionCaseId)
    .withMessage('case_id must be a canonical positive signed-64 integer'),
  validate,
  requirePrescriberRole,
  async (req, res, next) => {
    try {
      const records = await marService.getAssignedMedicationExceptions({
        tenantId: req.tenantId,
        actorUid: req.user.uid,
        caseId: req.query.case_id || null,
      });
      return success(res, records, 'Assigned medication exceptions retrieved');
    } catch (err) {
      return next(err);
    }
  },
);

router.post(
  '/mar/exceptions/:caseId/claim',
  enforceStaffClinicalWriteDevicePosture,
  param('caseId')
    .custom(canonicalMarExceptionCaseId)
    .withMessage('caseId must be a canonical positive signed-64 integer'),
  body().custom((_value, { req }) => {
    if (Object.keys(req.body || {}).length !== 0) {
      throw new Error('Medication exception claim body must be empty');
    }
    return true;
  }),
  validate,
  requirePrescriberRole,
  requireIdempotencyKey({
    required: true,
    scope: 'mar_exception_claim',
    requestBodyForIdempotency: marExceptionClaimIdempotencyBody,
  }),
  async (req, res, next) => {
    try {
      const result = await marService.claimMedicationException({
        exceptionCaseId: req.params.caseId,
        actorUid: req.user.uid,
        actorRoles: getAuthenticatedActorRoles(req.user),
        actorPrimaryRole: req.user.role,
        actorRawRole: req.user.rawRole || req.user.role,
        tenantId: req.tenantId,
        commandKey: req.idempotencyClaim?.requestKey,
        requestFingerprint: req.idempotencyClaim?.requestBodyHash,
        httpIdempotencyClaimId: req.idempotencyClaim?.id,
        requestId: req.id,
      });
      return success(
        res,
        result,
        result.replayed
          ? 'Medication exception claim replayed'
          : 'Medication exception claimed',
      );
    } catch (err) {
      return next(err);
    }
  },
);

router.post(
  '/mar/exceptions/:caseId/handoff',
  enforceStaffClinicalWriteDevicePosture,
  param('caseId')
    .custom(canonicalMarExceptionCaseId)
    .withMessage('caseId must be a canonical positive signed-64 integer'),
  body('expected_prescriber_uid')
    .isUUID()
    .withMessage('expected_prescriber_uid must be a UUID'),
  body('target_prescriber_uid')
    .isUUID()
    .withMessage('target_prescriber_uid must be a UUID'),
  body('reason')
    .isString()
    .trim()
    .isLength({ min: 5, max: 500 })
    .withMessage('reason must be between 5 and 500 characters'),
  body().custom((_value, { req }) => {
    const allowed = new Set([
      'expected_prescriber_uid',
      'target_prescriber_uid',
      'reason',
    ]);
    if (Object.keys(req.body || {}).some((field) => !allowed.has(field))) {
      throw new Error('Medication exception handoff body contains unsupported fields');
    }
    return true;
  }),
  validate,
  requireRole(...ADMIN_ROUTE_ROLES),
  requireIdempotencyKey({
    required: true,
    scope: 'mar_exception_handoff',
    requestBodyForIdempotency: marExceptionHandoffIdempotencyBody,
  }),
  async (req, res, next) => {
    try {
      const result = await marService.handoffMedicationException({
        exceptionCaseId: req.params.caseId,
        expectedPrescriberUid: req.body.expected_prescriber_uid,
        targetPrescriberUid: req.body.target_prescriber_uid,
        reason: req.body.reason,
        actorUid: req.user.uid,
        tenantId: req.tenantId,
        commandKey: req.idempotencyClaim?.requestKey,
        requestFingerprint: req.idempotencyClaim?.requestBodyHash,
        httpIdempotencyClaimId: req.idempotencyClaim?.id,
        requestId: req.id,
      });
      return success(
        res,
        result,
        result.replayed
          ? 'Medication exception handoff replayed'
          : 'Medication exception reassigned to prescriber',
      );
    } catch (err) {
      return next(err);
    }
  },
);

router.post(
  '/mar/exceptions/:caseId/disposition',
  enforceStaffClinicalWriteDevicePosture,
  param('caseId')
    .custom(canonicalMarExceptionCaseId)
    .withMessage('caseId must be a canonical positive signed-64 integer'),
  body('disposition')
    .isIn(['reviewed_no_replacement', 'replacement_ordered', 'order_stopped'])
    .withMessage('disposition must be a governed medication-exception disposition'),
  body('reason')
    .isString()
    .trim()
    .isLength({ min: 5, max: 500 })
    .withMessage('reason must be between 5 and 500 characters'),
  body('replacement_clinical_order_id')
    .optional({ nullable: true })
    .isInt({ min: 1 })
    .withMessage('replacement_clinical_order_id must be a positive integer')
    .toInt(),
  validate,
  requirePrescriberRole,
  requireIdempotencyKey({
    required: true,
    scope: 'mar_exception_disposition',
    requestBodyForIdempotency: marExceptionDispositionIdempotencyBody,
  }),
  async (req, res, next) => {
    try {
      const result = await marService.recordMedicationExceptionDisposition({
        exceptionCaseId: req.params.caseId,
        disposition: req.body.disposition,
        reason: req.body.reason,
        replacementClinicalOrderId: req.body.replacement_clinical_order_id ?? null,
        actorUid: req.user.uid,
        tenantId: req.tenantId,
        commandKey: req.idempotencyClaim?.requestKey,
        requestFingerprint: req.idempotencyClaim?.requestBodyHash,
        httpIdempotencyClaimId: req.idempotencyClaim?.id,
        requestId: req.id,
      });
      return success(res, result, 'Medication exception disposition recorded');
    } catch (err) {
      return next(err);
    }
  },
);

/**
 * GET /clinical/mar/patient/:patientUid
 * Get patient's MAR for a specific date.
 */
router.get('/mar/patient/:patientUid',
  param('patientUid').isUUID().withMessage('patientUid must be a valid UUID'),
  validate,
  guardClinicalPatientView,
  async (req, res, next) => {
  try {
    const { patientUid } = req.params;
    const { date } = req.query;

    const records = await marService.getPatientMAR(patientUid, date || null);
    return success(res, records, 'Patient MAR retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/mar/overdue
 * Get overdue medications, optionally filtered by ward.
 */
router.get('/mar/overdue', requireMarDueListRole, async (req, res, next) => {
  try {
    const { ward_id } = req.query;
    const wardId = ward_id ? parseInt(ward_id, 10) : null;

    const records = await marService.getOverdueMedications(
      Number.isFinite(wardId) ? wardId : null,
      { tenantId: req.tenantId },
    );
    return success(res, records, 'Overdue medications retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/mar/due
 * Nurse "due meds" list — scheduled/held medications within a rolling
 * window around now. Joins patient name + bed/ward for a single-fetch list.
 * Query params: ward_id?, past_minutes? (default 120), future_minutes? (default 60).
 * Window bounds clamped to the 0..1440-minute (24h) range.
 */
router.get('/mar/due', requireMarDueListRole, async (req, res, next) => {
  try {
    const wardIdRaw = req.query.ward_id ? parseInt(req.query.ward_id, 10) : null;
    const pastRaw = req.query.past_minutes ? parseInt(req.query.past_minutes, 10) : 120;
    const futureRaw = req.query.future_minutes ? parseInt(req.query.future_minutes, 10) : 60;

    const wardId = Number.isFinite(wardIdRaw) ? wardIdRaw : null;
    const pastMinutes = Math.max(0, Math.min(Number.isFinite(pastRaw) ? pastRaw : 120, 1440));
    const futureMinutes = Math.max(0, Math.min(Number.isFinite(futureRaw) ? futureRaw : 60, 1440));

    const records = await marService.getDueMedications({
      tenantId: req.tenantId,
      wardId,
      pastMinutes,
      futureMinutes,
    });
    return success(res, records, 'Due medications retrieved');
  } catch (err) {
    next(err);
  }
});

// ===================================================================
// Nurse Handover Routes
// ===================================================================

/**
 * POST /clinical/handover/generate
 * Generate a draft handover summary from the patient timeline.
 */
router.post('/handover/generate', requiredUUID('patient_uid'), validate, guardClinicalPatientView, async (req, res, next) => {
  try {
    const draft = await handoverService.generateHandoverDraft(req.body.patient_uid, req.user.uid, req.tenantId);
    return success(res, draft, 'Handover draft generated');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/handover
 * Create a nurse handover note.
 */
router.post('/handover', ...handoverValidator, validate, guardClinicalPatientWrite, async (req, res, next) => {
  try {
    const data = {
      ...req.body,
      tenant_id: req.tenantId,
      patient_summary: req.body.patient_summary || req.body.summary,
      outgoing_nurse: req.body.outgoing_nurse || req.user.uid,
    };

    const record = await handoverService.createHandover(data);
    return success(res, record, 'Handover created', 201);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /clinical/handover/:id/acknowledge
 * Acknowledge a handover as the incoming nurse.
 */
router.post('/handover/:id/acknowledge', paramId(), validate, guardHandoverResourceWrite, async (req, res, next) => {
  try {
    const { id } = req.params;

    const record = await handoverService.acknowledgeHandover(parseInt(id, 10), req.user.uid);
    return success(res, record, 'Handover acknowledged');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/handover/pending
 * Get pending (unacknowledged) handovers for the current nurse.
 */
router.get('/handover/pending', async (req, res, next) => {
  try {
    const records = await handoverService.getActiveHandovers(req.user.uid);
    return success(res, records, 'Pending handovers retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /clinical/handover/patient/:patientUid
 * Get handover history for a patient.
 */
router.get(
  '/handover/patient/:patientUid',
  param('patientUid').isUUID().withMessage('patientUid must be a valid UUID'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100').toInt(),
  validate,
  guardClinicalPatientView,
  async (req, res, next) => {
    try {
      const { patientUid } = req.params;
      const limit = parseInt(req.query.limit, 10) || 50;

      const records = await handoverService.getPatientHandoverHistory(patientUid, limit);
      return success(res, records, 'Patient handover history retrieved');
    } catch (err) {
      next(err);
    }
  },
);

// ===================================================================
// Voice-to-SOAP routes (M3)
// ===================================================================

/**
 * GET /clinical/voice-note/config
 * Returns the configured STT provider so clients can show the right UI
 * (e.g. disable recording if no provider is reachable).
 */
router.get('/voice-note/config', async (req, res, next) => {
  try {
    const stt = describeSttConfig({ tenantRegion: req.tenant?.region || null });
    const voiceNote = await voiceSoapService.getVoiceCapturePolicy({ req });
    return success(res, { ...stt, voice_note: voiceNote }, 'STT configuration retrieved');
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /clinical/voice-note/transcribe (multipart)
 * Field: audio (file). Optional query/body: patient_uid, admission_id, language.
 */
router.post('/voice-note/transcribe', audioUpload.single('audio'), guardClinicalPatientWrite, async (req, res, next) => {
  try {
    if (!req.file) return error(res, 'audio file required', 400);

    const saved = await voiceSoapService.createAndTranscribeVoiceNote({
      req,
      audioBuffer: req.file.buffer,
      mimeType: req.file.mimetype,
      patientUid: req.body?.patient_uid || req.query?.patient_uid || null,
      admissionId: req.body?.admission_id ? Number.parseInt(req.body.admission_id, 10) : null,
      durationSeconds: req.body?.duration_seconds ? Number(req.body.duration_seconds) : null,
      language: req.body?.language || null,
    });
    return success(res, saved, 'Voice note stored', 201);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /clinical/voice-note/:id/generate-soap
 * Convert a completed transcript into a SOAP draft. Enters the review queue.
 */
router.post('/voice-note/:id/generate-soap', async (req, res, next) => {
  try {
    const draft = await voiceSoapService.generateSoapDraftFromVoiceNote({
      req,
      voiceNoteId: req.params.id,
    });
    return success(res, draft, 'SOAP draft generated');
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /clinical/voice-note/my
 * List this clinician's recent voice notes (tenant-scoped).
 */
router.get('/voice-note/my', async (req, res, next) => {
  try {
    const result = await voiceSoapService.listVoiceNotes({
      tenantId: req.tenantId,
      recordedBy: req.user?.uid || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Voice notes retrieved');
  } catch (err) {
    return next(err);
  }
});

// ===================================================================
// Clinical safety AI — deterioration + polypharmacy (Batch 3)
// ===================================================================

/**
 * POST /clinical/safety/deterioration/:patientUid
 * Score an admitted patient's deterioration risk from the last 4h of
 * vitals + recent labs. Returns the NEWS2-like composite with band.
 */
router.post('/safety/deterioration/:patientUid',
  param('patientUid').isUUID().withMessage('patientUid must be a valid UUID'),
  validate,
  guardClinicalPatientView,
  async (req, res, next) => {
  try {
    const result = await scoreDeterioration({
      patientUid: req.params.patientUid,
      admissionId: req.body?.admission_id || null,
      tenantId: req.tenantId,
    });
    return success(res, result, 'Deterioration score computed');
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /clinical/safety/polypharmacy
 * Body: { patient_id?, patient_uid, medications: [{name,dose,route,frequency}],
 *         admission_id? }
 * Runs rules + AI drug-interaction review. Returns combined_severity with
 * rule + AI findings. Persists row for reviewer decisioning.
 */
router.post('/safety/polypharmacy', guardClinicalPatientView, async (req, res, next) => {
  try {
    if (!Array.isArray(req.body?.medications) || req.body.medications.length === 0) {
      return error(res, 'medications array is required', 400);
    }
    const result = await reviewPolypharmacy({
      patientId: req.body?.patient_id || null,
      patientUid: req.body?.patient_uid || null,
      medications: req.body.medications,
      admissionId: req.body?.admission_id || null,
      req,
    });
    return success(res, result, 'Polypharmacy review complete');
  } catch (err) {
    return next(err);
  }
});

// ===================================================================
// Ambient clinical documentation (full-encounter multi-speaker note)
// ===================================================================

/**
 * POST /clinical/ambient/encounters
 * Body:
 *   patient_uid, admission_id?, clinician_uid?, recording_started_at,
 *   recording_ended_at?, duration_seconds?, audio_storage_key?, audio_mime?,
 *   stt_provider?, stt_model?, stt_language?, diarization_provider?,
 *   raw_transcript?, diarization_payload?,
 *   transcript_segments: [{ speaker:'doctor'|'patient'|'caregiver'|'other',
 *                           text, start_seconds, end_seconds }],
 *   consent_reference
 *
 * Returns the generated structured visit note with citations back to
 * transcript segments. Enters the review queue.
 */
router.post('/ambient/encounters', guardClinicalPatientWrite, async (req, res, next) => {
  try {
    const result = await createAmbientEncounter({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      clinicianUid: req.body?.clinician_uid || req.user?.uid || null,
      recordedBy: req.user?.uid || null,
      recordingStartedAt: req.body?.recording_started_at,
      recordingEndedAt: req.body?.recording_ended_at || null,
      durationSeconds: req.body?.duration_seconds || null,
      audioStorageKey: req.body?.audio_storage_key || null,
      audioMime: req.body?.audio_mime || null,
      sttProvider: req.body?.stt_provider || 'none',
      sttModel: req.body?.stt_model || null,
      sttLanguage: req.body?.stt_language || null,
      diarizationProvider: req.body?.diarization_provider || null,
      diarizationPayload: req.body?.diarization_payload || null,
      rawTranscript: req.body?.raw_transcript || null,
      transcriptSegments: req.body?.transcript_segments || [],
      consentReference: req.body?.consent_reference || null,
    });
    return success(res, result, 'Ambient visit note draft generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/ambient/encounters', guardClinicalPatientView, async (req, res, next) => {
  try {
    const result = await listAmbientEncounters({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Ambient encounters retrieved');
  } catch (err) {
    return next(err);
  }
});

export default router;
