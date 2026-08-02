import { HTTP_STATUS, RESPONSE_MESSAGES } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as orderService from '../../services/investigation/orderService.js';
import { logAudit } from '../../utils/logAudit.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';
import { resolveStaffPushRecipients } from '../../services/notification/staffPushRecipientService.js';
import { recordStaffPushFanoutFailure } from '../../observability/staffPushFanoutMetrics.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

// Roles alerted for an URGENT/STAT investigation order.
const URGENT_ALERT_ROLES = [
  'NURSE', 'NURSING_STAFF', 'TECHNICIAN', 'LAB_STAFF',
  'LAB_TECHNICIAN', 'LAB', 'RECEPTIONIST', 'RADIOLOGIST',
];

// Fire-and-forget urgent alert to lab-adjacent staff.
//
// Scoped to the investigation's OWN tenant by an explicit predicate inside
// resolveStaffPushRecipients. The push body carries the patient's name AND the
// ordered test name, so the previous unscoped lookup (which also had no LIMIT at
// all) could deliver one tenant's PHI to every other tenant's staff devices.
async function sendUrgentAlert(investigation, patientName, tenantId) {
  try {
    if (!tenantId) {
      // Fail loudly rather than falling back to an unscoped fan-out.
      throw new Error('sendUrgentAlert requires a tenantId');
    }

    const { tokens } = await resolveStaffPushRecipients(prisma, {
      tenantId,
      roles: URGENT_ALERT_ROLES,
      alert: 'urgent_investigation',
    });

    if (tokens.length === 0) return;

    await sendPushNotification({
      tokens,
      title: '⚠️ URGENT Investigation',
      body: `⚠️ URGENT: ${investigation.test_name} for ${patientName} — immediate processing required`,
      data: { type: 'urgent_investigation', investigation_id: String(investigation.id) }
    });

    await prisma.$queryRawUnsafe(
      `UPDATE investigations SET urgent_alert_sent = TRUE
        WHERE id = $1 AND tenant_id = $2::uuid`,
      investigation.id,
      tenantId,
    );

    logger.info(`⚠️ Urgent alert sent for investigation ${investigation.id} to ${tokens.length} staff`);
  } catch (err) {
    recordStaffPushFanoutFailure('urgent_investigation');
    logger.error(`Failed to send urgent alert for investigation ${investigation?.id}: ${err.message}`);
  }
}

// Order new investigation
export const orderInvestigation = async (req, res) => {
  try {
    const userRole = req.user?.role?.toUpperCase();
    const requestedBy = req.user?.uid;
    
    if (!orderService.canOrderInvestigations(userRole)) {
      return error(res, 'Access denied: Doctor privileges required to order investigations', 403);
    }
    
    // Accept the alias field names the admin UI + several callers use:
    // investigation_name → test_name, investigation_type → type,
    // clinical_notes → notes. Lowercase priority so STAT/URGENT/ROUTINE all
    // hit the validator. See finding
    // 2026-05-08-obstetric-anc-doctor-investigations-all-500.
    const body = req.body || {};
    const orderData = {
      ...body,
      test_name: body.test_name ?? body.investigation_name ?? body.testName,
      type: body.type ?? body.investigation_type ?? body.investigationType,
      notes: body.notes ?? body.clinical_notes ?? body.clinicalNotes,
      // Migration 203: patient-actionable collection instructions. Accept
      // common alias keys (camelCase / collectionDeadline) so admin and
      // doctor UIs converge on the same intake without churn.
      collection_location: body.collection_location ?? body.collectionLocation,
      collection_deadline_at:
        body.collection_deadline_at ?? body.collectionDeadlineAt ?? body.collection_deadline,
      fasting_required: body.fasting_required ?? body.fastingRequired,
      fasting_instructions: body.fasting_instructions ?? body.fastingInstructions,
      admission_id: body.admission_id ?? body.admissionId,
      priority: body.priority ? String(body.priority).toUpperCase() : body.priority,
      orderedBy: requestedBy,
      actorRole: req.user?.role || null,
      tenantId: req.tenantId,
    };

    const result = await orderService.createInvestigationOrder(orderData);

    if (!result) {
      return error(res, 'Failed to create investigation order', 400);
    }

    await logAudit(req, 'investigation-ordered', { 
      investigation_id: result.investigation.id,
      patient_id: result.investigation.patient_id,
      appointment_id: result.investigation.appointment_id || null,
      test_name: result.investigation.test_name,
      type: result.investigation.type
    });

    // Fire-and-forget urgent alert for URGENT/STAT investigations
    const priority = result.investigation?.priority?.toUpperCase();
    if (priority === 'URGENT' || priority === 'STAT') {
      sendUrgentAlert(
        result.investigation,
        result.patient_name,
        result.investigation?.tenant_id || req.tenantId,
      ).catch(e => logger.warn('Urgent investigation alert failed:', e.message));
    }

    success(res, {
      ...result,
      orderedBy: requestedBy
    }, 'Investigation ordered successfully');

  } catch (err) {
    logger.error('Order Investigation Error:', err);
    
    if (err.message === 'PATIENT_NOT_FOUND') {
      return error(res, 'Patient not found', 404);
    } else if (err.message === 'DOCTOR_NOT_FOUND') {
      return error(res, 'Doctor not found', 404);
    } else if (err.message === 'INVALID_TYPE') {
      return error(res, 'Invalid investigation type', 400);
    } else if (err.message === 'INVALID_PRIORITY') {
      return error(res, 'Invalid priority level', 400);
    } else if (err.message === 'MISSING_REQUIRED_FIELDS') {
      return error(
        res,
        'Required fields missing — patient_id (or patient_phone), test_name, and type are mandatory.',
        400,
        { code: 'MISSING_REQUIRED_FIELDS' },
      );
    } else if (err.message === 'INVALID_APPOINTMENT_ID') {
      return error(res, 'appointment_id must be a valid appointment id', 400, {
        code: 'INVALID_APPOINTMENT_ID',
      });
    } else if (err.message === 'APPOINTMENT_NOT_FOUND') {
      return error(res, 'Appointment not found', 404, {
        code: 'APPOINTMENT_NOT_FOUND',
      });
    } else if (err.message === 'APPOINTMENT_PATIENT_MISMATCH') {
      return error(res, 'Appointment does not belong to this patient', 400, {
        code: 'APPOINTMENT_PATIENT_MISMATCH',
      });
    }

    error(res, 'Failed to order investigation', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Legacy phone-based investigation request
export const legacyInvestigationRequest = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone || req.body.phoneNumber);
    const { test_name, file_key } = req.body;
    const requestedBy = req.user?.uid;

    if (!phone || !test_name) {
      return error(res, 'Phone and test name are required.', HTTP_STATUS.BAD_REQUEST);
    }

    const result = await orderService.createLegacyInvestigation({
      phone,
      test_name,
      file_key,
      createdBy: requestedBy,
      actorRole: req.user?.role || null,
      tenantId: req.tenantId,
      admission_id: req.body.admission_id ?? req.body.admissionId ?? null,
    });

    await logAudit(req, 'legacy-investigation-requested', { phone, test_name });

    success(res, {
      investigation: result,
      requestedBy
    }, RESPONSE_MESSAGES.INVESTIGATION_REQUESTED);

  } catch (err) {
    logger.error('Legacy Investigation Request Error:', err);
    error(res, RESPONSE_MESSAGES.DATABASE_ERROR, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
