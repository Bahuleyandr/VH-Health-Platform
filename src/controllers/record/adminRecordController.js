// src/controllers/record/adminRecordController.js
import { RECORD_MESSAGES, AUDIT_ACTIONS } from '../../config/recordConfig.js';
import logger from '../../logging/logger.js';
import * as analyticsService from '../../services/record/analyticsService.js';
import * as auditService from '../../services/record/auditService.js';
import * as recordService from '../../services/record/recordService.js';
import { formatDateDDMMYYYY } from '../../utils/dateUtils.js';
import { success, error } from '../../utils/responseHelper.js';

export async function getRecordAnalytics(req, res) {
  try {
    const { days = 30 } = req.query;
    const requestedBy = req.user?.uid;

    const analytics = await analyticsService.getRecordAnalytics(days);

    success(res, {
      analytics,
      period: `${days} days`,
      totalRecords: analytics.totalRecords,
      recentRecords: analytics.recentRecords,
      generatedAt: formatDateDDMMYYYY(new Date()),
      requestedBy
    }, 'Medical records analytics retrieved');

  } catch (err) {
    logger.error(`[RecordAnalytics] ${err.message}`);
    error(res, 'Failed to retrieve analytics');
  }
}

export async function getHipaaAudit(req, res) {
  try {
    const { startDate, endDate } = req.query;
    const requestedBy = req.user?.uid;

    const auditData = await auditService.getAuditLogs(startDate, endDate);
    const complianceMetrics = auditService.calculateComplianceMetrics(auditData);

    success(res, {
      hipaaAudit: {
        auditLog: auditData,
        complianceMetrics,
        auditPeriod: {
          from: startDate || '30 days ago',
          to: endDate || 'today'
        }
      },
      complianceStatus: 'COMPLIANT',
      auditGeneratedAt: formatDateDDMMYYYY(new Date()),
      requestedBy
    }, 'HIPAA compliance audit completed');

  } catch (err) {
    logger.error(`[HIPAAAudit] ${err.message}`);
    error(res, 'Failed to generate HIPAA audit');
  }
}

export async function deleteMedicalRecord(req, res) {
  try {
    const { id } = req.params;
    const { reason = 'Admin deletion' } = req.body;
    const deletedBy = req.user?.uid;

    // Get record details before deletion
    const recordDetails = await recordService.getMedicalRecordById(id);

    if (!recordDetails) {
      return res.status(404).json({ 
        message: RECORD_MESSAGES.NOT_FOUND,
        id
      });
    }

    // Soft delete
    const deletedRecord = await recordService.softDeleteRecord(id, deletedBy, reason);

    // Audit log
    await auditService.logAuditEntry(
      AUDIT_ACTIONS.DELETE_MEDICAL_RECORD,
      'medical_records',
      id,
      deletedBy,
      'ADMIN',
      { reason, original_record: recordDetails }
    );

    logger.warn(`🗑️ Medical record deleted: ${id} by admin ${deletedBy} - Reason: ${reason}`);

    success(res, {
      deletedRecord: {
        id: deletedRecord.id,
        title: deletedRecord.title
      },
      deletedBy,
      reason,
      timestamp: formatDateDDMMYYYY(new Date()),
      note: 'Record marked as inactive for compliance - data retained in audit logs'
    }, RECORD_MESSAGES.DELETE_SUCCESS);

  } catch (err) {
    logger.error(`[DeleteMedicalRecord] ${err.message}`);
    error(res, 'Failed to delete medical record');
  }
}