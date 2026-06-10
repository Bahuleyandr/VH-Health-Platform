// src/routes/clinical/bcmaRoutes.js
//
// Roadmap B1 — BCMA support surfaces. Mounted at /api/v1/bcma behind the
// clinical-staff gate + PHI logger (app.js).
//
//   GET /wristband/:patientUid            — wristband payload (JSON)
//   GET /wristband/:patientUid?format=html — printable wristband with a
//       Code 39 rendering of the patient UID (the exact value
//       mar_scan_screen.dart expects from the wristband scan).

import express from 'express';
import logger from '../../logging/logger.js';
import prisma from '../../lib/prisma.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { code39Svg } from '../../utils/barcode/code39.js';
import { getUnifiedActiveAllergies } from '../../services/clinical/allergySourceService.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

router.get('/wristband/:patientUid', async (req, res) => {
  try {
    const { patientUid } = req.params;
    if (!UUID_RE.test(patientUid)) {
      return error(res, 'patientUid must be a UUID', HTTP_STATUS.BAD_REQUEST);
    }
    const rows = await prisma.$queryRawUnsafe(
      `SELECT u.id, u.uid, u.name, u.gender, u.blood_group,
              TO_CHAR(u.birthday, 'YYYY-MM-DD') AS birthday,
              CASE WHEN u.birthday IS NOT NULL THEN DATE_PART('year', AGE(NOW()::date, u.birthday))::int ELSE NULL END AS age_years,
              (SELECT pi.identifier_value FROM patient_identifiers pi
                WHERE pi.patient_uid = u.uid AND pi.identifier_type IN ('mrn', 'uhid')
                ORDER BY CASE pi.identifier_type WHEN 'mrn' THEN 0 ELSE 1 END
                LIMIT 1) AS mrn,
              (SELECT a.ward FROM admissions a
                WHERE a.patient_uid = u.uid AND a.status IN ('admitted', 'active')
                ORDER BY a.created_at DESC LIMIT 1) AS ward,
              (SELECT a.bed_number FROM admissions a
                WHERE a.patient_uid = u.uid AND a.status IN ('admitted', 'active')
                ORDER BY a.created_at DESC LIMIT 1) AS bed_number
         FROM users u
        WHERE u.uid = $1::uuid
        LIMIT 1`,
      patientUid,
    );
    if (!rows.length) return error(res, 'Patient not found', HTTP_STATUS.NOT_FOUND);
    const patient = rows[0];

    let allergies = [];
    try {
      allergies = await getUnifiedActiveAllergies(prisma, { patientUid });
    } catch (allergyErr) {
      logger.warn('Wristband allergy lookup failed (band prints without allergy strip)', {
        error: allergyErr.message,
      });
    }

    const payload = {
      patient: {
        uid: patient.uid,
        name: patient.name || null,
        gender: patient.gender || null,
        birthday: patient.birthday || null,
        age_years: patient.age_years ?? null,
        blood_group: patient.blood_group || null,
        mrn: patient.mrn || null,
        ward: patient.ward || null,
        bed_number: patient.bed_number || null,
      },
      barcode_payload: patient.uid,
      barcode_symbology: 'code39',
      allergies: allergies.map((a) => ({ allergen: a.allergen, severity: a.severity || null })),
      generated_at: new Date().toISOString(),
    };

    if (String(req.query.format || '').toLowerCase() === 'html') {
      const svg = code39Svg(patient.uid, { module: 2, height: 52 });
      const allergyStrip = payload.allergies.length
        ? `<div class="allergies">⚠ ALLERGIES: ${escapeHtml(payload.allergies.map((a) => a.allergen).join(', '))}</div>`
        : '<div class="allergies none">No known allergies recorded</div>';
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>Wristband ${escapeHtml(patient.name || patient.uid)}</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; margin: 16px; }
  .band { border: 1.5px solid #000; border-radius: 8px; padding: 10px 14px; max-width: 560px; }
  .row { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
  .name { font-size: 19px; font-weight: 700; }
  .meta { color: #222; }
  .allergies { margin-top: 6px; font-weight: 700; color: #a00; font-size: 13px; }
  .allergies.none { color: #555; font-weight: 400; }
  .code { margin-top: 8px; }
  @media print { body { margin: 0; } }
</style></head><body>
<div class="band">
  <div class="row"><span class="name">${escapeHtml(patient.name || 'Unknown patient')}</span>
    <span class="meta">${escapeHtml(patient.gender || '')} ${patient.age_years != null ? `${patient.age_years}y` : ''} ${escapeHtml(patient.blood_group || '')}</span></div>
  <div class="row meta"><span>DOB: ${escapeHtml(patient.birthday || '—')}</span>
    <span>MRN: ${escapeHtml(patient.mrn || '—')}</span>
    <span>${escapeHtml(patient.ward || '')} ${escapeHtml(patient.bed_number || '')}</span></div>
  ${allergyStrip}
  <div class="code">${svg}</div>
</div>
<script>window.addEventListener('load', () => { if (new URLSearchParams(location.search).get('autoprint') === '1') window.print(); });</script>
</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(html);
    }

    return success(res, payload, 'Wristband payload');
  } catch (err) {
    logger.error('Wristband generation failed:', err);
    return error(res, 'Failed to build wristband', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
