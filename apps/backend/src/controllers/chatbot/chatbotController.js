// src/controllers/chatbot/chatbotController.js
//
// Thin controller over triageService. Pulls the authenticated patient's
// clinical context (allergies, age, conditions) so the model has the minimum
// it needs without the patient having to restate it.

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { triageSymptoms } from '../../services/chatbot/triageService.js';
import { success, error } from '../../utils/responseHelper.js';

async function _buildPatientContext(userId) {
  if (!userId) return null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT u.id, u.gender, u.birthday,
              COALESCE(
                (SELECT json_agg(json_build_object('name', allergy_name, 'severity', severity))
                   FROM patient_allergies WHERE patient_id = u.id AND is_active = true),
                '[]'::json
              ) AS allergies
         FROM users u WHERE u.id = $1`,
      userId,
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    const ageYears = r.birthday
      ? Math.floor((Date.now() - new Date(r.birthday).getTime()) / (365.25 * 24 * 3600 * 1000))
      : null;
    return {
      age: ageYears,
      sex: r.gender || null,
      allergies: r.allergies || [],
    };
  } catch (err) {
    logger.warn('Failed to build patient context for triage:', err.message);
    return null;
  }
}

export async function triage(req, res) {
  try {
    const { symptoms, history } = req.body;
    const patientContext = await _buildPatientContext(req.user?.id);
    const result = await triageSymptoms({
      symptoms,
      history,
      patientContext,
      // Thread the tenant's data-residency region so the egress guard can
      // actually match the allowlist (previously never passed, making the
      // region guard all-or-nothing), plus tenant/patient identity for the
      // governed-framework generation + review rows.
      tenantRegion: req.tenant?.region || null,
      tenantId: req.tenantId || null,
      patientUid: req.user?.uid || null,
    });
    return success(res, result, 'Triage complete');
  } catch (err) {
    const status = err.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
    logger.error('Triage controller error:', err.message);
    return error(res, status === 503 ? 'Symptom checker is currently unavailable' : 'Failed to run triage', status);
  }
}
