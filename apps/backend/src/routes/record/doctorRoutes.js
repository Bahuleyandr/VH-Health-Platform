// src/routes/record/doctorRoutes.js
import express from 'express';
import * as doctorController from '../../controllers/record/doctorRecordController.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import {
  recordCreateValidator,
  recordUpdateValidator,
  recordIdValidator
} from '../../validators/record/recordValidators.js';

const router = express.Router();

// This subrouter is mounted at '/' under the broad RECORD_ROUTE_ROLES parent via
// a (now removed) inert no-op wrapAutoRBAC, so it must gate its own writes.
// rbacConfig.doctorRoutes = [DOCTOR, ADMIN]: medical-record authoring is a doctor
// act (nurses document via the EMR nursing surfaces, not generic /records). The
// gate runs BEFORE the validators so a denied caller gets 403, not a 400. Note:
// PUT /:id has no patient context (record id), so the parent patientAccessGuard
// passes it through — without this gate any record-capable role could update any
// record by id (cross-patient tamper, parallel to the admin DELETE in HEAD-006).
const requireRecordAuthor = requireRole('DOCTOR', 'ADMIN'); // SUPER_ADMIN bypasses via rbac

// Create new medical record
router.post('/create', requireRecordAuthor, recordCreateValidator, doctorController.createMedicalRecord);

// Update medical record
router.put('/:id',
  requireRecordAuthor,
  [...recordIdValidator, ...recordUpdateValidator],
  doctorController.updateMedicalRecord
);

export default router;