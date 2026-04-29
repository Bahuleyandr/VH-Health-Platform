// src/routes/staff/

import express from 'express';
import multer from 'multer';
import attendanceRoutes from './attendanceRoutes.js';
import hrRoutes from './hrRoutes.js';
import pharmacyRoutes from './pharmacyRoutes.js';
import staffAdminRoutes from './staffAdminRoutes.js';
import staffRoutes from './staffRoutes.js';
import * as replacementController from '../../controllers/staff/replacementController.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as orderService from '../../services/investigation/orderService.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { isStaff } from '../../utils/roleHelpers.js';
import { uploadFileToR2 } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
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

// Mount sub-routers
router.use('/', staffRoutes);           // Staff management
router.use('/attendance', attendanceRoutes);  // Attendance operations
router.use('/hr', hrRoutes);            // HR management
router.use('/pharmacy', pharmacyRoutes); // Pharmacy order updates
router.use('/admin', staffAdminRoutes);  // Staff admin operations

// ─── /staff/replacements/* aliases ────────────────────────────────────────
// The admin /dashboard/my-replacements page calls /api/v1/staff/replacements/my
// (GET) and /api/v1/staff/replacements (POST). The canonical controllers live
// under /staff/hr/replacement/* (see hrRoutes.js); these aliases keep that
// canonical mount untouched while supporting the admin page's API config
// (apps/admin/src/lib/api-config.ts → myWork.replacements.*).
router.get('/replacements/my', replacementController.getPendingReplacements);
router.post('/replacements', replacementController.requestReplacement);

// Staff app compatibility: clinical uploads previously posted to
// /staff/medical/*, while canonical records/investigation modules live under
// /records and /investigations. Keep the staff URLs as thin adapters.
router.post('/medical/consultations', requireStaffMedical, async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const consultationType = req.body?.consultationType || req.body?.consultation_type || 'Consultation';
    const notes = req.body?.notes || null;

    if (!phone) {
      return error(res, 'Phone is required', 400);
    }

    const patient = await prisma.users.findFirst({
      where: { phone },
      select: { id: true, uid: true, name: true },
    });
    if (!patient) {
      return error(res, 'Patient not found', 404);
    }

    const currentUserId = Number(req.user?.id);
    const doctorId = Number.isInteger(currentUserId) && currentUserId > 0 ? currentUserId : null;
    const record = await prisma.medical_records.create({
      data: {
        patient_id: patient.uid,
        doctor_id: doctorId,
        record_type: 'CONSULTATION',
        title: String(consultationType),
        description: notes,
        attachments: {
          source: 'staff_app_legacy',
          patientName: req.body?.patientName || null,
          consultationDate: req.body?.date || null,
          additionalData: req.body?.additionalData || null,
        },
        privacy_level: 'RESTRICTED',
        created_by: req.user?.uid || null,
      },
      select: {
        id: true,
        patient_id: true,
        doctor_id: true,
        record_type: true,
        title: true,
        description: true,
        created_by: true,
        created_at: true,
      },
    });

    return success(res, { record, patient }, 'Consultation uploaded successfully', 201);
  } catch (err) {
    logger.error('Staff medical consultation upload failed:', err);
    return error(res, 'Failed to upload consultation', 500);
  }
});

router.post('/medical/investigations', requireStaffMedical, upload.single('file'), async (req, res) => {
  try {
    const phone = normalizePhone(req.body?.phone);
    const testName = req.body?.test_name || req.body?.testType || req.body?.test_type;
    if (!phone || !testName) {
      return error(res, 'Phone and test type are required', 400);
    }

    let fileKey = req.body?.file_key || req.body?.fileUrl || null;
    if (req.file) {
      const fileName = storageSafeName(req.file.originalname || req.body?.fileName || 'result');
      fileKey = `investigations/staff/${phone.replace(/^\+/, '')}/${Date.now()}-${fileName}`;
      await uploadFileToR2(req.file.buffer, fileKey, req.file.mimetype);
    }

    let investigation = await orderService.createLegacyInvestigation({
      phone,
      test_name: String(testName),
      file_key: fileKey,
      createdBy: req.user?.uid || null,
    });

    const patch = {};
    if (req.body?.result) {
      patch.result_summary = String(req.body.result);
      patch.results = { result: String(req.body.result) };
      patch.status = 'COMPLETED';
      patch.completed_at = new Date();
      patch.result_uploaded_at = new Date();
    } else if (fileKey) {
      patch.status = 'COMPLETED';
      patch.completed_at = new Date();
      patch.result_uploaded_at = new Date();
    }
    if (req.body?.notes) {
      patch.notes = String(req.body.notes);
    }

    if (Object.keys(patch).length > 0) {
      investigation = await prisma.investigations.update({
        where: { id: investigation.id },
        data: patch,
        select: {
          id: true,
          phone: true,
          test_name: true,
          file_key: true,
          status: true,
          result_summary: true,
          notes: true,
          requested_by: true,
          requested_at: true,
          completed_at: true,
        },
      });
    }

    return success(res, {
      investigation,
      requestedBy: req.user?.uid || null,
    }, 'Investigation uploaded successfully', 201);
  } catch (err) {
    logger.error('Staff medical investigation upload failed:', err);
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
