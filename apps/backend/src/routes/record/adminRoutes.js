// src/routes/record/adminRoutes.js
import express from 'express';
import * as adminController from '../../controllers/record/adminRecordController.js';
import logger from '../../logging/logger.js';
import * as exportService from '../../services/record/exportService.js';
import { resolveDoctorFilterId } from '../../services/doctor/doctorRefService.js';
import prisma from '../../lib/prisma.js';
import { formatDateForDisplay } from '../../utils/record/recordHelpers.js';
import { error } from '../../utils/responseHelper.js';
import { 
  recordIdValidator, 
  deleteReasonValidator 
} from '../../validators/record/recordValidators.js';

const router = express.Router();

// Get analytics
router.get('/admin/analytics', adminController.getRecordAnalytics);

// Get HIPAA audit
router.get('/admin/hipaa-audit', adminController.getHipaaAudit);

// Export records to PDF
router.get('/export/pdf', async (req, res) => {
  try {
    const filters = {
      patient_id: req.query.patient_id,
      // Roadmap A9: canonicalize to users.id whichever id space the caller used.
      doctor_id: await resolveDoctorFilterId(prisma, req.query.doctor_id, {
        tenantId: req.tenantId || null,
      }),
      record_type: req.query.type,
      date_from: req.query.date_from,
      date_to: req.query.date_to
    };
    
    const pdfBuffer = await exportService.exportRecordsToPDF(filters, req.user?.role);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=medical-records-${formatDateForDisplay(new Date())}.pdf`);
    res.send(pdfBuffer);
  } catch (err) {
    logger.error(`[ExportPDF] ${err.message}`);
    error(res, 'Failed to export records to PDF');
  }
});

// Export records to Excel
router.get('/export/excel', async (req, res) => {
  try {
    const filters = {
      patient_id: req.query.patient_id,
      // Roadmap A9: canonicalize to users.id whichever id space the caller used.
      doctor_id: await resolveDoctorFilterId(prisma, req.query.doctor_id, {
        tenantId: req.tenantId || null,
      }),
      record_type: req.query.type,
      date_from: req.query.date_from,
      date_to: req.query.date_to
    };
    
    const excelBuffer = await exportService.exportRecordsToExcel(filters, req.user?.role);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=medical-records-${formatDateForDisplay(new Date())}.xlsx`);
    res.send(excelBuffer);
  } catch (err) {
    logger.error(`[ExportExcel] ${err.message}`);
    error(res, 'Failed to export records to Excel');
  }
});

// Delete record
router.delete('/:id', 
  [...recordIdValidator, ...deleteReasonValidator], 
  adminController.deleteMedicalRecord
);

export default router;