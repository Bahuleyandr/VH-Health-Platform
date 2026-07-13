// src/routes/staff/

import express from 'express';
import multer from 'multer';
import attendanceRoutes from './attendanceRoutes.js';
import hrRoutes from './hrRoutes.js';
import pharmacyRoutes from './pharmacyRoutes.js';
import phoneRoutes from './phoneRoutes.js';
import rosterBoardRoutes from './rosterBoardRoutes.js';
import staffCarePlanRoutes from './staffCarePlanRoutes.js';
import staffAdminRoutes from './staffAdminRoutes.js';
import staffRoutes from './staffRoutes.js';
import * as replacementController from '../../controllers/staff/replacementController.js';
import * as workflowController from '../../controllers/appointment/appointmentWorkflowController.js';
import { OP_FLOW_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { validateFileContent } from '../../middleware/uploadMiddleware.js';
import * as orderService from '../../services/investigation/orderService.js';
import { createLegacyStaffConsultation } from '../../services/emr/legacyStaffMedicalService.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { isStaff } from '../../utils/roleHelpers.js';
import { deleteObject, uploadFileToR2 } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const walkInRoles = requireRole(...OP_FLOW_ROUTE_ROLES, 'PATIENT');
const guardPrescriptionAppointmentUpload = patientAccessGuardForResource('PRESCRIPTION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'appointment',
  idSelector: (req) => req.body?.appointment_id,
});
const guardStaffConsultationWrite = patientAccessGuard('MEDICAL_RECORD', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  requirePatientContext: true,
});
const guardStaffInvestigationWrite = patientAccessGuard('INVESTIGATION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  requirePatientContext: true,
});

function canUseStaffMedical(role) {
  const normalizedRole = String(role || '').toUpperCase();
  return normalizedRole === 'SUPER_ADMIN'
    || isStaff(normalizedRole)
    || ['NURSE', 'STAFF', 'GENERAL', 'HR', 'TECHNICIAN', 'LAB_TECHNICIAN'].includes(normalizedRole);
}

function requireStaffMedical(req, res, next) {
  if (!canUseStaffMedical(req.user?.role)) {
    return error(res, 'Staff access required', 403);
  }
  next();
}

function storageSafeName(name = 'upload') {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'upload';
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function tenantIdOf(req) {
  return req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;
}

function normalizeAppointmentDocument(row) {
  return {
    id: Number(row.id),
    appointment_id: Number(row.appointment_id),
    patient_name: row.patient_name || 'Unknown patient',
    type: row.type || row.document_type || 'OTHER',
    file_name: row.file_name || 'Document',
    file_size: row.file_size == null ? null : Number(row.file_size),
    uploaded_at: row.uploaded_at || row.created_at,
  };
}

// Compatibility alias for clients documented against /api/v1/staff/walk-in.
// The canonical implementation remains /api/v1/appointments/walk-in.
router.post('/walk-in', walkInRoles, workflowController.registerWalkIn);

// Mount sub-routers
router.use('/', phoneRoutes);           // Staff phone home + query workflow
router.use('/', staffRoutes);           // Staff management
router.use('/attendance', attendanceRoutes);  // Attendance operations
router.use('/hr', hrRoutes);            // HR management
router.use('/pharmacy', pharmacyRoutes); // Pharmacy order updates
router.use('/roster-board', rosterBoardRoutes); // Central shift roster board
router.use('/', staffCarePlanRoutes); // Staff-scoped care-plan patient surface
router.use('/admin', staffAdminRoutes);  // Staff admin operations

// ─── /staff/replacements/* aliases ────────────────────────────────────────
// The admin /dashboard/my-replacements page calls /api/v1/staff/replacements/my
// (GET) and /api/v1/staff/replacements (POST). The canonical controllers live
// under /staff/hr/replacement/* (see hrRoutes.js); these aliases keep that
// canonical mount untouched while supporting the admin page's API config
// (apps/admin/src/lib/api-config.ts → myWork.replacements.*).
router.get('/replacements/my', replacementController.getPendingReplacements);
router.post('/replacements', replacementController.requestReplacement);

// Admin upload-prescription page compatibility. The documents are stored in
// appointment_documents, but the page owns a staff-scoped URL contract.
router.get('/prescriptions/my', requireStaffMedical, async (req, res) => {
  try {
    const tenantId = tenantIdOf(req);
    const uploadedById = parsePositiveInt(req.user?.id);
    const role = String(req.user?.role || '').toUpperCase();
    const canViewAll = role === 'ADMIN' || role === 'SUPER_ADMIN';
    const limit = Math.min(Math.max(parsePositiveInt(req.query?.limit) || 25, 1), 100);

    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        ad.id,
        ad.appointment_id,
        COALESCE(NULLIF(p.name, ''), NULLIF(a.patient_name, ''), a.phone, 'Unknown patient') AS patient_name,
        COALESCE(ad.document_type, 'OTHER') AS type,
        ad.file_name,
        ad.file_size,
        ad.created_at AS uploaded_at
      FROM appointment_documents ad
      JOIN appointments a ON a.id = ad.appointment_id AND a.tenant_id = $4::uuid
      LEFT JOIN users p ON p.id = ad.patient_id AND p.tenant_id = $4::uuid
      WHERE ad.tenant_id = $4::uuid
        AND ($2::boolean = TRUE OR ad.uploaded_by = $1::int)
      ORDER BY ad.created_at DESC
      LIMIT $3::int
    `, uploadedById, canViewAll, limit, tenantId);

    return success(res, rows.map(normalizeAppointmentDocument), 'Prescription uploads retrieved');
  } catch (err) {
    logger.error('Staff prescription uploads list failed:', err);
    return error(res, 'Failed to retrieve prescription uploads', 500);
  }
});

router.post('/prescriptions/upload', requireStaffMedical, upload.single('file'), validateFileContent, guardPrescriptionAppointmentUpload, async (req, res) => {
  try {
    const tenantId = tenantIdOf(req);
    const appointmentId = parsePositiveInt(req.body?.appointment_id);
    if (!appointmentId || !req.file) {
      return error(res, 'appointment_id and file are required', 400);
    }

    const appointments = await prisma.$queryRawUnsafe(
      'SELECT id, patient_id, doctor_id, tenant_id FROM appointments WHERE id=$1::int AND tenant_id=$2::uuid',
      appointmentId,
      tenantId,
    );
    const appointment = appointments[0];
    if (!appointment) {
      return error(res, 'Appointment not found', 404);
    }
    if (!appointment.patient_id) {
      return error(res, 'Appointment has no linked patient', 409);
    }

    const uploadedById = parsePositiveInt(req.user?.id);
    const uploadRole = String(req.user?.role || 'staff').toUpperCase();
    const documentType = req.body?.document_type || req.body?.type || 'PRESCRIPTION';
    const fileName = storageSafeName(req.file.originalname || 'document');
    const fileKey = `records/appointments/${appointmentId}/${Date.now()}-${fileName}`;
    const fileUrl = await uploadFileToR2(req.file.buffer, fileKey, req.file.mimetype);

    const rows = await prisma.$queryRawUnsafe(`
      INSERT INTO appointment_documents
        (appointment_id, patient_id, doctor_id, uploaded_by, upload_role,
         document_type, file_key, file_url, file_name, file_size, file_mime, notes, tenant_id)
      VALUES ($1::int, $2::int, $3::int, $4::int, $5, $6, $7, $8, $9, $10::bigint, $11, $12, $13::uuid)
      RETURNING id, appointment_id, patient_id, doctor_id, uploaded_by, upload_role, document_type,
        file_key, file_url, file_name, file_size, file_mime, notes, created_at AS uploaded_at
    `,
      appointmentId,
      appointment.patient_id,
      appointment.doctor_id || null,
      uploadedById,
      uploadRole,
      String(documentType),
      fileKey,
      fileUrl,
      req.file.originalname || fileName,
      req.file.size,
      req.file.mimetype,
      req.body?.notes || null,
      tenantId,
    );

    return success(res, normalizeAppointmentDocument(rows[0]), 'Document uploaded successfully', 201);
  } catch (err) {
    logger.error('Staff prescription upload failed:', err);
    return error(res, 'Failed to upload prescription document', 500);
  }
});

// Staff app compatibility: clinical uploads previously posted to
// /staff/medical/*, while canonical records/investigation modules live under
// /records and /investigations. Keep the staff URLs as thin adapters.
router.post('/medical/consultations', requireStaffMedical, guardStaffConsultationWrite, async (req, res) => {
  try {
    const tenantId = tenantIdOf(req);
    const phone = normalizePhone(req.body?.phone);
    const consultationType = req.body?.consultationType || req.body?.consultation_type || 'Consultation';
    const notes = req.body?.notes || null;

    if (!phone) {
      return error(res, 'Phone is required', 400);
    }

    const patient = await prisma.users.findFirst({
      where: { phone, tenant_id: tenantId, role: 'PATIENT' },
      select: { id: true, uid: true, name: true },
    });
    if (!patient) {
      return error(res, 'Patient not found', 404);
    }

    const currentUserId = Number(req.user?.id);
    const doctorId = Number.isInteger(currentUserId) && currentUserId > 0 ? currentUserId : null;
    const record = await createLegacyStaffConsultation({
      tenantId,
      patientUid: patient.uid,
      doctorId,
      consultationType,
      notes,
      attachments: {
        patientName: req.body?.patientName || null,
        consultationDate: req.body?.date || null,
        additionalData: req.body?.additionalData || null,
      },
      actorUid: req.user?.uid || null,
      actorRole: req.user?.role || null,
      requestId: req.id,
    });

    return success(res, { record, patient }, 'Consultation uploaded successfully', 201);
  } catch (err) {
    logger.error('Staff medical consultation upload failed:', err);
    return error(res, 'Failed to upload consultation', 500);
  }
});

router.post('/medical/investigations', requireStaffMedical, upload.single('file'), validateFileContent, guardStaffInvestigationWrite, async (req, res) => {
  try {
    const tenantId = tenantIdOf(req);
    const phone = normalizePhone(req.body?.phone);
    const testName = req.body?.test_name || req.body?.testType || req.body?.test_type;
    if (!phone || !testName) {
      return error(res, 'Phone and test type are required', 400);
    }

    let fileKey = req.body?.file_key || req.body?.fileUrl || null;
    let uploadedFileKey = null;
    if (req.file) {
      const fileName = storageSafeName(req.file.originalname || req.body?.fileName || 'result');
      fileKey = `investigations/staff/${phone.replace(/^\+/, '')}/${Date.now()}-${fileName}`;
      await uploadFileToR2(req.file.buffer, fileKey, req.file.mimetype);
      uploadedFileKey = fileKey;
    }

    let investigation;
    try {
      investigation = await orderService.createLegacyInvestigation({
        phone,
        test_name: String(testName),
        file_key: fileKey,
        createdBy: req.user?.uid || null,
        actorRole: req.user?.role || null,
        tenantId,
        result_summary: req.body?.result ? String(req.body.result) : null,
        results: req.body?.result ? { result: String(req.body.result) } : null,
        notes: req.body?.notes ? String(req.body.notes) : null,
        completed: Boolean(req.body?.result || fileKey),
      });
    } catch (writeError) {
      if (uploadedFileKey) {
        await deleteObject(uploadedFileKey).catch((cleanupError) => {
          logger.warn(`Failed to clean up uncommitted staff investigation file ${uploadedFileKey}: ${cleanupError.message}`);
        });
      }
      throw writeError;
    }

    return success(res, {
      investigation,
      requestedBy: req.user?.uid || null,
    }, 'Investigation uploaded successfully', 201);
  } catch (err) {
    logger.error('Staff medical investigation upload failed:', err);
    if (err?.code === 'PATIENT_NOT_FOUND') {
      return error(res, 'Patient not found', 404);
    }
    return error(res, 'Failed to upload investigation', 500);
  }
});

// Legacy compatibility routes
router.get('/attendance', (req, res) => {
  res.json({
    success: true,
    message: 'Attendance system operational',
    features: ['check_in', 'check_out', 'location_tracking', 'hours_calculation'],
    endpoints: {
      mark_attendance: 'POST /staff/attendance',
      view_attendance: 'GET /staff/:id/attendance',
      attendance_summary: 'GET /staff/stats/summary'
    }
  });
});

router.get('/roll-call', (req, res) => {
  res.json({
    success: true,
    message: 'Roll-call system operational',
    features: ['shift_based_attendance', 'department_roll_call', 'real_time_status'],
    endpoints: {
      by_shift: 'GET /staff/shift/:shift',
      by_department: 'GET /staff/department/:department',
      dashboard: 'GET /staff/hr/dashboard'
    }
  });
});

export default router;
