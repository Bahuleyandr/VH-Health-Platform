// src/routes/emr/admissionRoutes.js
// ADT (Admission/Discharge/Transfer) routes — mounted at /api/v1/emr

import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import admissionService from '../../services/emr/admissionService.js';
import patientCommandBoardService from '../../services/emr/patientCommandBoardService.js';
import * as dischargeSummaryGenerator from '../../services/emr/dischargeSummaryGenerator.js';
import {
  generateAdmissionAiDraft,
  generateWardRoundBrief,
} from '../../services/ai/clinicalAiWorkflowService.js';
import {
  listTranslations,
  translateGeneration,
} from '../../services/ai/translationService.js';
import {
  getLatestRisk,
  scoreLongitudinalRisk,
} from '../../services/ai/longitudinalRiskService.js';
import {
  generateTeachBackSession,
  submitTeachBackAnswers,
} from '../../services/ai/patientTeachBackService.js';
import { generateNursingAmbientSession } from '../../services/ai/nursingAmbientDocumentationService.js';
import { generateFamilyUpdate } from '../../services/ai/familyUpdateGeneratorService.js';
import { success, error } from '../../utils/responseHelper.js';
import {
  canEditDischargeSummary,
  canSignDischargeSummary,
  canViewDischargeSummary,
} from '../../utils/roleHelpers.js';
import { adviseForAdmission } from '../../controllers/appointment/appointmentWorkflowController.js';
import prisma from '../../lib/prisma.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// GET /command-board — live inpatient command board foundation.
//
// Composes active admissions, bed location, patient identifiers,
// allergies, active CDS alerts, diagnoses, open tasks/orders, and
// discharge checklist state into one role-aware board response. Exposed
// through both:
//   GET /api/v1/emr/command-board
//   GET /api/v1/admissions/command-board
// ---------------------------------------------------------------------------
router.get(
  '/command-board',
  wrapAsync(async (req, res) => {
    const board = await patientCommandBoardService.getPatientCommandBoard(
      {
        ward: req.query?.ward,
        status: req.query?.status,
        mine: req.query?.mine,
        limit: req.query?.limit,
      },
      {
        uid: req.user?.uid,
        id: req.user?.id,
        role: req.user?.role,
        tenantId: req.tenantId,
      },
    );
    success(res, board, 'Patient command board retrieved');
  }),
);

// ---------------------------------------------------------------------------
// GET /clinical-ai/config - Clinical AI provider status
// ---------------------------------------------------------------------------
router.get(
  '/clinical-ai/config',
  wrapAsync(async (_req, res) => {
    success(res, dischargeSummaryGenerator.getDischargeSummaryAiConfig(), 'Clinical AI config retrieved');
  })
);

// ---------------------------------------------------------------------------
// GET /lookup — Admission-counter patient lookup by phone.
//
// Exposed through /api/v1/admissions/lookup for reception counters. It
// returns the matched patient, hospital number, derived prior IP numbers, and
// a visible new-patient state when no row exists yet.
// ---------------------------------------------------------------------------
router.get(
  '/lookup',
  wrapAsync(async (req, res) => {
    const phone = req.query?.phone || req.query?.patient_phone || req.query?.q;
    const lookup = await admissionService.lookupAdmissionPatientByPhone({
      phone,
      tenantId: req.tenantId,
    });
    success(res, lookup, 'Admission patient lookup retrieved');
  })
);

// ---------------------------------------------------------------------------
// GET /ward-options — Admission-counter ward/floor dropdown.
//
// Kept under the admissions surface so reception/admission desk roles can load
// it without broadening the bed-management RBAC gate.
// ---------------------------------------------------------------------------
router.get(
  '/ward-options',
  wrapAsync(async (_req, res) => {
    const wards = await admissionService.listAdmissionWardOptions();
    success(res, { wards, count: wards.length }, 'Admission ward options retrieved');
  })
);

// ---------------------------------------------------------------------------
// GET /bed-options — Admission-counter available beds for a chosen ward.
// ---------------------------------------------------------------------------
router.get(
  '/bed-options',
  wrapAsync(async (req, res) => {
    const beds = await admissionService.listAdmissionBedOptions({
      wardId: req.query?.ward_id,
      wardLabel: req.query?.ward_label || req.query?.ward || req.query?.label,
    });
    success(res, { beds, count: beds.length }, 'Admission bed options retrieved');
  })
);

// ---------------------------------------------------------------------------
// POST /admit — Admit a patient
//
// Backwards-compat aliasing for the staff app admission sheet, which
// posts a `patient_query` (phone/UID/name) instead of `patient_uid`,
// `provisional_diagnosis` instead of `admitting_diagnosis`, and a
// free-text `bed` string instead of a `bed_id`. The canonical service
// signature still requires patient_uid + bed_id + admitting_doctor.
// Resolving here (rather than in admitPatient) keeps the service
// strict for callers that already speak the canonical contract.
// Finding 2026-05-11-tpa-insurance-claim-admission-617772d9.
// ---------------------------------------------------------------------------
router.post(
  '/admit',
  wrapAsync(async (req, res) => {
    const body = req.body || {};
    const resolved = { ...body };

    if (!resolved.patient_uid && body.patient_query) {
      const q = String(body.patient_query).trim();
      // UUID → use directly.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
        resolved.patient_uid = q;
      } else {
        const digits = q.replace(/\D/g, '');
        // Phone (>=8 digits) → search users.phone with both E.164 and
        // bare-national forms. Otherwise treat as name / hospital number.
        const rows = digits.length >= 8
          ? await admissionService.findPatientByPhoneOrName({ phone: digits, tenantId: req.tenantId })
          : await admissionService.findPatientByPhoneOrName({ name: q, tenantId: req.tenantId });
        if (rows && rows.length === 1) {
          resolved.patient_uid = rows[0].uid;
        } else if (rows && rows.length > 1) {
          return error(
            res,
            'patient_query matched multiple patients — pass patient_uid directly',
            HTTP_STATUS.BAD_REQUEST,
          );
        } else if (digits.length >= 8 && body.patient_name) {
          const patient = await admissionService.createCounterAdmissionPatient({
            phone: body.patient_phone || q,
            name: body.patient_name,
            tenantId: req.tenantId,
            createdBy: req.user?.uid,
          });
          resolved.patient_uid = patient.uid;
          resolved.patient_query = patient.hospital_number || patient.phone;
        }
      }
    }

    if (!resolved.admitting_diagnosis && body.provisional_diagnosis) {
      resolved.admitting_diagnosis = body.provisional_diagnosis;
    }

    // bed_id is needed by the service. If the staff form sent a free-text
    // `bed`, try to resolve it to a bed row (e.g. "ICU-12" / "Bed 12 /
    // Ward A"). Best-effort — if we can't resolve, leave bed_id missing
    // and the service will return its existing actionable 400 (which the
    // staff app can show as "use the bed picker").
    if (!resolved.bed_id && body.bed) {
      const bedLabel = String(body.bed).trim();
      const wardLabel = body.ward ? String(body.ward).trim() : null;
      const found = await admissionService.findBedByLabel(bedLabel, wardLabel);
      if (found?.id) resolved.bed_id = found.id;
    }

    // Doctor users invoking /admit themselves: default admitting_doctor
    // to the requesting doctor's uid. Other clinical staff still have to
    // pass it explicitly.
    if (!resolved.admitting_doctor && String(req.user?.role || '').toUpperCase() === 'DOCTOR') {
      resolved.admitting_doctor = req.user?.uid;
    }

    if (resolved.patient_uid && body.counter_consent_captured === true) {
      await admissionService.ensureCounterTreatmentConsent({
        patientUid: resolved.patient_uid,
        grantedBy: req.user?.uid,
      });
    }

    const data = {
      ...resolved,
      created_by: req.user?.uid,
      // E-4 — actor_role threaded so admitPatient can enforce the ICU
      // tier check. Without this, NURSING_STAFF (ward nurse) could
      // allocate ICU beds.
      actor_role: req.user?.role,
      // Thread tenant_id so admitPatient can auto-create the TPA preauth
      // draft in Phase 1.5 (claimsService.createPreauth requires it).
      tenant_id: req.tenantId,
    };

    const admission = await admissionService.admitPatient(data);
    success(res, { admission }, 'Patient admitted successfully', HTTP_STATUS.CREATED);
  })
);

// ---------------------------------------------------------------------------
// POST /admissions/advise — Discoverable OPD→IPD bridge alias.
//
// The canonical handler lives on the appointments router
// (POST /api/v1/appointments/:id/advise-admission) but the swarm + real
// receptionists keep probing IPD-side paths. This shim accepts either
// an explicit `appointment_id` or a `patient_uid` (in which case it
// resolves the patient's most recent OPD appointment of today and
// advises on that). Delegates to the existing adviseForAdmission so
// the audit + RBAC + state-machine all stay in one canonical place.
//
// Body: { appointment_id?: int, patient_uid?: uuid, note?: string }
//
// Mounted reach:
//   POST /api/v1/emr/admissions/advise
//   POST /api/v1/admissions/advise   (via admissionAliasRouter rewrite)
//
// Finding: 2026-05-17-inpatient-admission-receptionist-30bd3752 (HIGH;
// duplicate of 2026-05-08-inpatient-admission-receptionist-no-advise-
// admission-workflow).
// ---------------------------------------------------------------------------
router.post(
  '/admissions/advise',
  wrapAsync(async (req, res) => {
    let appointmentId = Number.parseInt(req.body?.appointment_id, 10);
    if (!Number.isFinite(appointmentId) || appointmentId <= 0) {
      const patientUid = typeof req.body?.patient_uid === 'string'
        ? req.body.patient_uid.trim()
        : null;
      if (!patientUid) {
        return error(
          res,
          'appointment_id (int) or patient_uid (uuid) is required',
          HTTP_STATUS.BAD_REQUEST,
        );
      }
      // Resolve the patient's most recent appointment today. Prefer
      // CONFIRMED/SCHEDULED rows; skip CANCELLED/NO_SHOW.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT a.id
           FROM appointments a
           JOIN users u ON u.id = a.patient_id
          WHERE u.uid = $1::uuid
            AND DATE(a.appointment_date) = CURRENT_DATE
            AND a.status NOT IN ('CANCELLED', 'NO_SHOW')
          ORDER BY a.created_at DESC
          LIMIT 1`,
        patientUid,
      );
      if (!rows.length) {
        return error(
          res,
          'No active appointment today for that patient — pass appointment_id explicitly',
          HTTP_STATUS.NOT_FOUND,
          { code: 'NO_OPEN_APPOINTMENT_TODAY' },
        );
      }
      appointmentId = rows[0].id;
    }
    // Reshape req to match the canonical /:id/advise-admission call.
    req.params = { ...req.params, id: String(appointmentId) };
    return adviseForAdmission(req, res);
  }),
);

// ---------------------------------------------------------------------------
// POST /:id/assign-bed — Allocate a bed to a previously bedless admission
// (the emergency exception path). Migration 171.
// Finding: 2026-05-08-emergency-walk-in-doctor-admit-without-bed-allowed.
// ---------------------------------------------------------------------------
router.post(
  '/:id/assign-bed',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }
    const bedId = req.body?.bed_id !== undefined ? parseInt(req.body.bed_id, 10) : NaN;
    if (isNaN(bedId)) {
      return error(res, 'bed_id is required (integer)', HTTP_STATUS.BAD_REQUEST);
    }
    const assignedBy = req.user?.uid;
    const admission = await admissionService.assignBedToAdmission(admissionId, bedId, assignedBy);
    success(res, { admission }, 'Bed assigned to admission');
  })
);

// ---------------------------------------------------------------------------
// POST /:id/mark-for-discharge — Open the discharge cascade (D2).
// Architectural item D2. Stamps T0 = discharge_initiated_at, closes
// billing (soft), opens dietary + physiotherapy consults, generates
// the draft discharge summary, opens a placeholder TPA final claim
// if insurance applies. Idempotent — fails 409 if already marked.
// ---------------------------------------------------------------------------
router.post(
  '/:id/mark-for-discharge',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }
    const requestedBy = req.user?.uid;
    const result = await admissionService.markForDischarge(admissionId, requestedBy, req.user?.role);
    success(res, result, 'Admission marked for discharge — draft summary generated, consults opened', HTTP_STATUS.CREATED);
  })
);

// ---------------------------------------------------------------------------
// POST /:id/consults/:consultType/complete — Log a discharge consult
// completion (dietician, physio, etc.). T0→completed_at is the
// efficiency marker for that consult type. Architectural item D2.
// ---------------------------------------------------------------------------
router.post(
  '/:id/consults/:consultType/complete',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }
    const consultType = String(req.params.consultType || '').trim().toLowerCase();
    if (!consultType) {
      return error(res, 'consultType param is required', HTTP_STATUS.BAD_REQUEST);
    }
    const completedBy = req.user?.uid;
    const notes = req.body?.notes ?? null;
    const updated = await admissionService.completeDischargeConsult(
      admissionId,
      consultType,
      completedBy,
      notes,
      { role: req.user?.role }
    );
    success(res, { consult: updated }, `${consultType} consult logged as complete`);
  })
);

// ---------------------------------------------------------------------------
// POST /:id/mark-drugs-dispensed — Stamp T3 = discharge_drugs_dispensed_at.
// Called by the pharmacy module when discharge takeaway drugs are handed
// over. Architectural item D2.
// ---------------------------------------------------------------------------
router.post(
  '/:id/mark-drugs-dispensed',
  wrapAsync(async (req, res) => {
    if (!admissionService.canCompleteDischargeWorkItem('pharmacy', req.user?.role)) {
      return error(res, 'Only pharmacy can mark discharge drugs dispensed', HTTP_STATUS.FORBIDDEN);
    }

    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }
    const dispensedBy = req.user?.uid;
    const updated = await admissionService.markDischargeDrugsDispensed(admissionId, dispensedBy);
    success(res, { admission: updated }, 'Discharge drugs marked as dispensed');
  })
);

// ---------------------------------------------------------------------------
// GET /discharge-hub — Central discharge worklist for active cascades.
// ---------------------------------------------------------------------------
router.get(
  '/discharge-hub',
  wrapAsync(async (req, res) => {
    const hub = await admissionService.listDischargeHubAdmissions({
      uid: req.user?.uid,
      role: req.user?.role,
    });
    success(res, hub, 'Discharge hub worklist retrieved');
  })
);

// ---------------------------------------------------------------------------
// GET /:id/discharge-hub — Role-owned discharge workflow state
// ---------------------------------------------------------------------------
router.get(
  '/:id/discharge-hub',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }
    const hub = await admissionService.getDischargeHub(admissionId, {
      uid: req.user?.uid,
      role: req.user?.role,
    });
    success(res, hub, 'Discharge hub retrieved');
  })
);

// ---------------------------------------------------------------------------
// POST /:id/discharge — Discharge a patient
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const dischargedBy = req.user?.uid;
    const dischargeData = req.body;

    const admission = await admissionService.dischargePatient(admissionId, dischargeData, dischargedBy);
    success(res, { admission }, 'Patient discharged successfully');
  })
);

// ---------------------------------------------------------------------------
// POST /:id/transfer — Transfer a patient
// ---------------------------------------------------------------------------
router.post(
  '/:id/transfer',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const { to_ward_id, to_bed_id, reason } = req.body;
    const transferredBy = req.user?.uid;

    if (!to_bed_id) {
      return error(res, 'to_bed_id is required', HTTP_STATUS.BAD_REQUEST);
    }

    const admission = await admissionService.transferPatient(
      admissionId,
      to_ward_id || null,
      parseInt(to_bed_id, 10),
      reason || null,
      transferredBy
    );
    success(res, { admission }, 'Patient transferred successfully');
  })
);

// ---------------------------------------------------------------------------
// GET /admissions — List active admissions (with filters)
// ---------------------------------------------------------------------------
router.get(
  '/admissions',
  wrapAsync(async (req, res) => {
    const { ward, doctor, department, status, review_due, page, limit } = req.query;
    const result = await admissionService.getActiveAdmissions({
      ward, doctor, department, status, review_due,
      page: page || 1,
      limit: limit || 20,
      tenantId: req.tenantId,
    }, {
      uid: req.user?.uid,
      id: req.user?.id,
      role: req.user?.role,
      tenantId: req.tenantId,
    });
    success(res, result.admissions, 'Active admissions retrieved', HTTP_STATUS.OK, {
      pagination: result.pagination,
      scope: result.scope,
    });
  })
);

// ---------------------------------------------------------------------------
// GET /admissions/stats — Admission statistics
// ---------------------------------------------------------------------------
router.get(
  '/admissions/stats',
  wrapAsync(async (req, res) => {
    const { date_from, date_to } = req.query;
    const stats = await admissionService.getAdmissionStats(date_from || null, date_to || null);
    success(res, stats, 'Admission statistics retrieved');
  })
);

// ---------------------------------------------------------------------------
// GET /admissions/patient/:uid — Patient admission history
// ---------------------------------------------------------------------------
router.get(
  '/admissions/patient/:uid',
  wrapAsync(async (req, res) => {
    const { uid } = req.params;
    const history = await admissionService.getPatientAdmissionHistory(uid);
    success(res, { admissions: history, count: history.length }, 'Patient admission history retrieved');
  })
);

// ---------------------------------------------------------------------------
// GET /admission/:id — Admission detail
// ---------------------------------------------------------------------------
router.get(
  '/admission/:id',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const admission = await admissionService.getAdmissionDetail(admissionId, {
      userId: req.user?.uid,
      actorId: req.user?.id,
      userRole: req.user?.role,
      tenantId: req.tenantId,
      ip: req.ip,
      requestId: req.id,
    });
    success(res, { admission }, 'Admission detail retrieved');
  })
);

// ---------------------------------------------------------------------------
// PUT /:id/code-status — Update code status (DNR, etc.)
// ---------------------------------------------------------------------------
router.put(
  '/:id/code-status',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const { code_status } = req.body;
    if (!code_status) {
      return error(res, 'code_status is required', HTTP_STATUS.BAD_REQUEST);
    }

    const updatedBy = req.user?.uid;
    const admission = await admissionService.updateCodeStatus(admissionId, code_status, updatedBy);
    success(res, { admission }, 'Code status updated');
  })
);

// ---------------------------------------------------------------------------
// PUT /:id/attending-doctor — Change attending physician
// ---------------------------------------------------------------------------
router.put(
  '/:id/attending-doctor',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const { doctor_uid } = req.body;
    if (!doctor_uid) {
      return error(res, 'doctor_uid is required', HTTP_STATUS.BAD_REQUEST);
    }

    const updatedBy = req.user?.uid;
    const admission = await admissionService.updateAttendingDoctor(admissionId, doctor_uid, updatedBy);
    success(res, { admission }, 'Attending doctor updated');
  })
);

// ---------------------------------------------------------------------------
// PUT /:id/next-review — Set or clear the next ward-round review time.
// The inpatient-admission journey asks the consultant to "set
// review-after" once orders are in. Body: { next_review_at: ISO | null }.
// ---------------------------------------------------------------------------
router.put(
  '/:id/next-review',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const updatedBy = req.user?.uid;
    const admission = await admissionService.updateNextReviewAt(
      admissionId,
      req.body?.next_review_at ?? null,
      updatedBy,
    );
    success(res, { admission }, 'Next review time updated');
  })
);

// ---------------------------------------------------------------------------
// GET /:id/case-sheet — Admission baseline history and examination.
// ---------------------------------------------------------------------------
router.get(
  '/:id/case-sheet',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await admissionService.getAdmissionCaseSheet(admissionId, {
      uid: req.user?.uid,
      role: req.user?.role,
    });
    success(res, result, 'Admission case sheet retrieved');
  })
);

// ---------------------------------------------------------------------------
// PUT /:id/case-sheet — Save/update admission baseline. Chief complaints and
// provisional diagnosis are denormalized to the admission for Bed Board.
// ---------------------------------------------------------------------------
router.put(
  '/:id/case-sheet',
  wrapAsync(async (req, res) => {
    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await admissionService.saveAdmissionCaseSheet(
      admissionId,
      req.body?.case_sheet || req.body || {},
      req.user?.uid,
      req.user?.role,
    );
    success(res, result, `Admission case sheet ${result.action}`);
  })
);

// ---------------------------------------------------------------------------
// POST /:id/discharge-summary/generate — Auto-generate discharge summary
// Roles: DOCTOR, MEDICAL_RECORDS, ADMIN (not PHARMACY, HR, GENERAL)
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge-summary/generate',
  wrapAsync(async (req, res) => {
    const role = req.user?.role?.toUpperCase();
    if (!canEditDischargeSummary(role) && role !== 'SUPER_ADMIN') {
      return error(res, 'You do not have permission to generate discharge summaries', HTTP_STATUS.FORBIDDEN);
    }

    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const summary = await dischargeSummaryGenerator.generateDischargeSummary(
      admissionId,
      req.user?.uid,
      req
    );

    success(res, { discharge_summary: summary, is_draft: true },
      'Discharge summary generated (draft — requires doctor review and signature)');
  })
);

// ---------------------------------------------------------------------------
// GET /:id/discharge-summary — Load latest saved/generated summary
// ---------------------------------------------------------------------------
router.get(
  '/:id/discharge-summary',
  wrapAsync(async (req, res) => {
    const role = req.user?.role?.toUpperCase();
    if (!canViewDischargeSummary(role) && role !== 'SUPER_ADMIN') {
      return error(res, 'You do not have permission to view discharge summaries', HTTP_STATUS.FORBIDDEN);
    }

    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const summary = await dischargeSummaryGenerator.getLatestDischargeSummary(admissionId);
    success(res, { discharge_summary: summary }, summary ? 'Discharge summary retrieved' : 'No discharge summary found');
  })
);

// ---------------------------------------------------------------------------
// PUT /:id/discharge-summary — Save/edit discharge summary draft
// Roles: DOCTOR, MEDICAL_RECORDS, ADMIN (not PHARMACY, HR, NURSING, GENERAL)
// ---------------------------------------------------------------------------
router.put(
  '/:id/discharge-summary',
  wrapAsync(async (req, res) => {
    const role = req.user?.role?.toUpperCase();
    if (!canEditDischargeSummary(role) && role !== 'SUPER_ADMIN') {
      return error(res, 'You do not have permission to edit discharge summaries', HTTP_STATUS.FORBIDDEN);
    }

    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const { discharge_summary } = req.body;
    if (!discharge_summary) {
      return error(res, 'discharge_summary is required', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await dischargeSummaryGenerator.saveDischargeSummary(
      admissionId,
      discharge_summary,
      req.user?.uid,
      role
    );

    success(res, result, `Discharge summary ${result.action} (still a draft — requires doctor signature)`);
  })
);

// ---------------------------------------------------------------------------
// POST /:id/discharge-summary/sign — Doctor signs the discharge summary
// Roles: DOCTOR only (SUPER_ADMIN can override)
// Medical Records can generate/edit but NOT sign — only doctors sign.
// ---------------------------------------------------------------------------
router.post(
  '/:id/discharge-summary/sign',
  wrapAsync(async (req, res) => {
    const role = req.user?.role?.toUpperCase();
    if (!canSignDischargeSummary(role) && role !== 'SUPER_ADMIN') {
      return error(res, 'Only doctors can sign discharge summaries', HTTP_STATUS.FORBIDDEN);
    }

    const admissionId = parseInt(req.params.id, 10);
    if (isNaN(admissionId)) {
      return error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    }

    const doctorUid = req.user?.uid;
    const result = await dischargeSummaryGenerator.signDischargeSummary(admissionId, doctorUid);

    success(res, result, 'Discharge summary signed — now official and immutable');
  })
);

// ---------------------------------------------------------------------------
// Modular Clinical AI draft routes (admission-scoped).
// The top-level /api/v1/emr gate already restricts access to CLINICAL_STAFF_ROLES.
// Each module enforces enablement + reviewRoles inside the workflow service.
// ---------------------------------------------------------------------------
function parseAdmissionId(req, res) {
  const admissionId = parseInt(req.params.id, 10);
  if (Number.isNaN(admissionId)) {
    error(res, 'Invalid admission ID', HTTP_STATUS.BAD_REQUEST);
    return null;
  }
  return admissionId;
}

async function respondWithAdmissionAiDraft(req, res, moduleKey, message) {
  const admissionId = parseAdmissionId(req, res);
  if (admissionId === null) return;

  const draft = await generateAdmissionAiDraft(admissionId, moduleKey, req.user?.uid || null, req);
  success(res, draft, message);
}

function dischargeReadinessAiDisabled(err) {
  return err?.statusCode === 403
    && /Clinical AI module is disabled/i.test(String(err?.message || ''));
}

function safetyFlagsFromReadiness(readiness) {
  return (readiness.blockers || []).map((blocker) => ({
    severity: blocker.type === 'INVALID_STATE_TRANSITION' ? 'high' : 'medium',
    code: blocker.type,
    message: blocker.message,
  }));
}

function buildDischargeReadinessRulesResponse(readiness, fallbackReason) {
  return {
    draft: {
      ready: readiness.ready,
      blockers: readiness.blockers,
      checklist: readiness.checklist,
      forecast: readiness.ready
        ? 'Authoritative readiness rules found no discharge blockers.'
        : 'Final discharge is blocked by the authoritative readiness checklist.',
      rules_readiness: readiness,
    },
    module_key: 'discharge_readiness',
    prompt_version: 'rules-v1',
    source_citations: [{
      source_type: 'admission_readiness_rules',
      source_id: String(readiness.admission_id),
      summary: 'Deterministic discharge cascade, billing, investigations, radiology, and follow-up readiness checks.',
    }],
    safety_flags: safetyFlagsFromReadiness(readiness),
    ai_metadata: {
      provider: 'rules',
      model: null,
      used_ai: false,
      fallback_reason: fallbackReason,
      usage: {},
      safety_review: null,
    },
    review_status: 'not_required',
    review_id: null,
    generation_id: null,
    draft_generation_id: null,
    requires_signoff: false,
    rules_authoritative: true,
    rules_readiness: readiness,
  };
}

function attachRulesReadinessToDraft(aiDraft, readiness) {
  return {
    ...aiDraft,
    draft: {
      ...(aiDraft?.draft || {}),
      ready: readiness.ready,
      blockers: readiness.blockers,
      checklist: {
        ...(aiDraft?.draft?.checklist || {}),
        ...readiness.checklist,
      },
      rules_readiness: readiness,
      forecast: readiness.ready
        ? (aiDraft?.draft?.forecast || 'Authoritative readiness rules found no discharge blockers.')
        : 'Final discharge is blocked by the authoritative readiness checklist.',
    },
    safety_flags: [
      ...(Array.isArray(aiDraft?.safety_flags) ? aiDraft.safety_flags : []),
      ...safetyFlagsFromReadiness(readiness),
    ],
    rules_authoritative: true,
    rules_readiness: readiness,
  };
}

async function respondWithDischargeReadiness(req, res) {
  const admissionId = parseAdmissionId(req, res);
  if (admissionId === null) return;

  const readiness = await admissionService.getDischargeReadiness(admissionId, {
    discharge_type: req.query?.discharge_type || req.query?.dischargeType || 'home',
  });

  try {
    const draft = await generateAdmissionAiDraft(
      admissionId,
      'discharge_readiness',
      req.user?.uid || null,
      req,
    );
    success(res, attachRulesReadinessToDraft(draft, readiness), 'Discharge readiness draft generated');
  } catch (err) {
    if (!dischargeReadinessAiDisabled(err)) throw err;

    success(
      res,
      buildDischargeReadinessRulesResponse(readiness, 'clinical_ai_module_disabled'),
      'Discharge readiness checklist generated'
    );
  }
}

router.post(
  '/:id/ai/patient-record-summary',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'patient_record_summary', 'Patient record summary draft generated')
  )
);

router.post(
  '/:id/aftercare-instructions',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'patient_aftercare_instructions', 'Aftercare instructions draft generated')
  )
);

router.post(
  '/:id/medication-reconciliation',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'medication_reconciliation', 'Medication reconciliation draft generated')
  )
);

router.get(
  '/:id/discharge-readiness',
  wrapAsync((req, res) => respondWithDischargeReadiness(req, res))
);

router.post(
  '/:id/referral-letter',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'referral_letter', 'Referral letter draft generated')
  )
);

router.post(
  '/:id/abnormal-result-triage',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'abnormal_result_triage', 'Abnormal result triage draft generated')
  )
);

router.post(
  '/:id/clinical-coding-assist',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'clinical_coding_assist', 'Clinical coding assist draft generated')
  )
);

router.post(
  '/:id/quality-case-review',
  wrapAsync((req, res) =>
    respondWithAdmissionAiDraft(req, res, 'quality_case_review', 'Quality case review draft generated')
  )
);

// POST /:id/ai/teach-back — generate a patient teach-back session for an admission.
router.post(
  '/:id/ai/teach-back',
  wrapAsync(async (req, res) => {
    const admissionId = parseAdmissionId(req, res);
    if (admissionId === null) return;
    const result = await generateTeachBackSession({
      req,
      admissionId,
      patientUid: req.body?.patient_uid || null,
      sourceGenerationId: req.body?.source_generation_id || null,
      language: req.body?.language || 'en',
    });
    success(res, result, 'Patient teach-back session generated', HTTP_STATUS.CREATED);
  })
);

// POST /:id/ai/family-update — draft a consent-scoped family/caregiver update.
router.post(
  '/:id/ai/family-update',
  wrapAsync(async (req, res) => {
    const admissionId = parseAdmissionId(req, res);
    if (admissionId === null) return;
    if (!req.body?.patient_uid) {
      return error(res, 'patient_uid is required', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await generateFamilyUpdate({
      req,
      admissionId,
      patientUid: req.body.patient_uid,
      caregiverIdentifier: req.body?.caregiver_identifier || null,
      caregiverRelationship: req.body?.caregiver_relationship || 'other',
      language: req.body?.language || 'en',
      sourceGenerationId: req.body?.source_generation_id || null,
      consentReference: req.body?.consent_reference || null,
    });
    success(res, result, 'Family update drafted', HTTP_STATUS.CREATED);
  })
);

// POST /:id/ai/nursing-ambient — generate a nursing ambient documentation session.
router.post(
  '/:id/ai/nursing-ambient',
  wrapAsync(async (req, res) => {
    const admissionId = parseAdmissionId(req, res);
    if (admissionId === null) return;
    if (!req.body?.patient_uid) {
      return error(res, 'patient_uid is required', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await generateNursingAmbientSession({
      req,
      admissionId,
      patientUid: req.body.patient_uid,
      nurseUid: req.body?.nurse_uid || req.user?.uid || null,
      shift: req.body?.shift || 'day',
      recordingStartedAt: req.body?.recording_started_at || null,
      recordingEndedAt: req.body?.recording_ended_at || null,
      durationSeconds: req.body?.duration_seconds || null,
      consentReference: req.body?.consent_reference || null,
      audioStorageKey: req.body?.audio_storage_key || null,
      audioMime: req.body?.audio_mime || null,
      sttProvider: req.body?.stt_provider || 'none',
      sttModel: req.body?.stt_model || null,
      sttLanguage: req.body?.stt_language || null,
      diarizationProvider: req.body?.diarization_provider || null,
      transcriptSegments: req.body?.transcript_segments || [],
    });
    success(res, result, 'Nursing ambient session generated', HTTP_STATUS.CREATED);
  })
);

// POST /teach-back/:sessionId/answers — submit patient answers to an existing session.
router.post(
  '/teach-back/:sessionId/answers',
  wrapAsync(async (req, res) => {
    const result = await submitTeachBackAnswers({
      req,
      sessionId: req.params.sessionId,
      answers: req.body?.answers || [],
    });
    success(res, result, 'Patient teach-back answers recorded');
  })
);

// POST /ward-round-brief — aggregate draft across admitted patients.
router.post(
  '/ward-round-brief',
  wrapAsync(async (req, res) => {
    const draft = await generateWardRoundBrief({
      ward: req.body?.ward || req.query?.ward || null,
      limit: req.body?.limit || req.query?.limit,
      requestedBy: req.user?.uid || null,
      req,
    });
    success(res, draft, 'Daily ward round brief draft generated');
  })
);

// Translate an accepted generation into the patient's preferred language.
// Only reviewer-accepted generations are translated — enforced in the
// service. Multilingual rendering of unreviewed drafts is prohibited.
router.post(
  '/generations/:generationId/translate',
  wrapAsync(async (req, res) => {
    const result = await translateGeneration({
      generationId: req.params.generationId,
      targetLanguage: req.body?.target_language || req.query?.target_language,
      requestedBy: req.user?.uid || null,
      req,
    });
    success(res, result, 'Translation ready');
  })
);

// List translations (tenant-scoped). Optional ?language=hi.
router.get(
  '/translations',
  wrapAsync(async (req, res) => {
    const result = await listTranslations({
      tenantId: req.tenantId,
      targetLanguage: req.query?.language || null,
      limit: req.query?.limit,
    });
    success(res, result, 'Translations retrieved');
  })
);

// M5 — ABDM longitudinal risk score for an admission. Decision support,
// never auto-actions; clinicians read the card and decide.
router.post(
  '/:id/longitudinal-risk',
  wrapAsync(async (req, res) => {
    const admissionId = parseAdmissionId(req, res);
    if (admissionId === null) return;
    const result = await scoreLongitudinalRisk({ admissionId, req });
    success(res, result, 'Longitudinal risk score computed');
  })
);

router.get(
  '/:id/longitudinal-risk',
  wrapAsync(async (req, res) => {
    const admissionId = parseAdmissionId(req, res);
    if (admissionId === null) return;
    const latest = await getLatestRisk({ admissionId, tenantId: req.tenantId });
    if (!latest) return error(res, 'No risk snapshot yet for this admission', HTTP_STATUS.NOT_FOUND);
    success(res, latest, 'Latest longitudinal risk snapshot retrieved');
  })
);

export default router;
