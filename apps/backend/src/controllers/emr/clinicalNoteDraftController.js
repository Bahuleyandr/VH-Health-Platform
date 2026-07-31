import prisma from '../../lib/prisma.js';
import * as clinicalNoteDraftService from '../../services/emr/clinicalNoteDraftService.js';
import { applyClinicalContinuityReplay } from '../../services/downtime/clinicalContinuityReplayReceiptService.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

export async function resolvePatientUidFromBody(body) {
  if (body.patient_uid) return body.patient_uid;

  const phone = normalizePhone(body.patient_phone || body.phone);
  if (!phone) return null;

  const last10 = phone.replace(/\D/g, '').slice(-10);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE role = 'PATIENT'
        AND (phone = $1 OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $2)
      ORDER BY CASE WHEN phone = $1 THEN 0 ELSE 1 END, registered_at DESC NULLS LAST
      LIMIT 1`,
    phone,
    `%${last10}`
  );
  return rows[0]?.uid ?? null;
}

export async function saveClinicalNoteDraft(req, res, next) {
  try {
    const patient_uid = await resolvePatientUidFromBody(req.body);
    const { note_type, appointment_id, content } = req.body;
    if (!patient_uid || !note_type) {
      return error(res, 'patient_uid (or patient phone) and note_type are required', 400);
    }
    if (req.clinicalContinuityReplay) {
      const result = await applyClinicalContinuityReplay(req.clinicalContinuityReplay);
      return success(res, result, 'Draft saved');
    }
    const draft = await clinicalNoteDraftService.upsertNoteDraft({
      tenantId: req.tenantId,
      authorUid: req.user.uid,
      patientUid: patient_uid,
      appointmentId: appointment_id ?? null,
      noteType: note_type,
      content: content ?? {}
    });
    return success(res, draft, 'Draft saved');
  } catch (err) {
    next(err);
  }
}
