// src/controllers/prescription/ePrescriptionController.js
// E-Prescription system — structured prescription entry, PDF generation, auto-pharmacy order

import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import { dispatch } from '../../utils/notifications/notificationDispatcher.js';
import { uploadFileToR2, getSignedFileUrl } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';

// ─── Frequency label map ─────────────────────────────────────────────────────
const FREQ_LABELS = {
  OD: 'Once daily',
  BD: 'Twice daily',
  TDS: 'Three times daily',
  QID: 'Four times daily',
  SOS: 'As needed (SOS)',
  HS: 'At bedtime',
  STAT: 'Immediately',
};

function parseJsonField(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseIntegerField(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : NaN;
}

// ─── PDF Generation ──────────────────────────────────────────────────────────
async function generatePrescriptionPDF(prescription, patient, doctor) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margins: { top: 40, bottom: 40, left: 40, right: 40 },
      size: 'A4',
    });
    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const leftX = 40;
    const pageWidth = 515;

    // ─── Header ──────────────────────────────────────────────────────────
    doc.rect(leftX, 30, pageWidth, 55).fill('#007A64');
    doc.fillColor('white').fontSize(18).font('Helvetica-Bold')
      .text('VENKATAESWARA HOSPITALS', leftX + 10, 38, { align: 'center', width: pageWidth });
    doc.fontSize(8).font('Helvetica')
      .text('Nandanam, Chennai – 600 035 | Tel: 044-24334455', leftX + 10, 58, { align: 'center', width: pageWidth });

    // ─── Rx Title ────────────────────────────────────────────────────────
    doc.fillColor('#007A64').fontSize(22).font('Helvetica-Bold')
      .text('℞', leftX, 100);
    doc.fillColor('#333').fontSize(12).font('Helvetica-Bold')
      .text('PRESCRIPTION', leftX + 30, 104);
    doc.fontSize(10).font('Helvetica')
      .text(prescription.prescription_number, leftX + 140, 104);

    const prescDate = new Date(prescription.created_at).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric'
    });
    doc.text(`Date: ${prescDate}`, leftX + pageWidth - 150, 104, { width: 150, align: 'right' });

    // ─── Divider ─────────────────────────────────────────────────────────
    doc.moveTo(leftX, 125).lineTo(leftX + pageWidth, 125).stroke('#007A64');

    // ─── Patient Info ────────────────────────────────────────────────────
    let y = 135;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#333');
    doc.text('Patient:', leftX, y);
    doc.font('Helvetica').text(patient.name || 'N/A', leftX + 55, y);

    doc.font('Helvetica-Bold').text('Age/Gender:', leftX + 250, y);
    const age = patient.birthday ? Math.floor((Date.now() - new Date(patient.birthday).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : '-';
    const gender = patient.gender ? patient.gender.charAt(0).toUpperCase() : '-';
    doc.font('Helvetica').text(`${age} / ${gender}`, leftX + 320, y);

    y += 16;
    doc.font('Helvetica-Bold').text('Phone:', leftX, y);
    doc.font('Helvetica').text(patient.phone || '-', leftX + 55, y);

    // ─── Doctor Info ─────────────────────────────────────────────────────
    y += 16;
    doc.font('Helvetica-Bold').text('Doctor:', leftX, y);
    doc.font('Helvetica').text(doctor.name || 'N/A', leftX + 55, y);
    if (doctor.specialization) {
      doc.font('Helvetica-Bold').text('Specialization:', leftX + 250, y);
      doc.font('Helvetica').text(doctor.specialization, leftX + 340, y);
    }

    if (doctor.qualification) {
      y += 16;
      doc.font('Helvetica-Bold').text('Qualification:', leftX, y);
      doc.font('Helvetica').text(doctor.qualification, leftX + 80, y);
    }

    // ─── Divider ─────────────────────────────────────────────────────────
    y += 20;
    doc.moveTo(leftX, y).lineTo(leftX + pageWidth, y).stroke('#ddd');

    // ─── Diagnosis ───────────────────────────────────────────────────────
    if (prescription.diagnosis) {
      y += 10;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Diagnosis:', leftX, y);
      y += 14;
      doc.fontSize(9).font('Helvetica').fillColor('#333').text(prescription.diagnosis, leftX, y, { width: pageWidth });
      y += doc.heightOfString(prescription.diagnosis, { width: pageWidth }) + 8;
    }

    // ─── Vitals ──────────────────────────────────────────────────────────
    const vitals = prescription.vitals;
    if (vitals && Object.keys(vitals).length > 0) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Vitals:', leftX, y);
      y += 14;
      const vitalParts = [];
      if (vitals.bp_systolic && vitals.bp_diastolic) vitalParts.push(`BP: ${vitals.bp_systolic}/${vitals.bp_diastolic} mmHg`);
      if (vitals.pulse) vitalParts.push(`Pulse: ${vitals.pulse} bpm`);
      if (vitals.temperature) vitalParts.push(`Temp: ${vitals.temperature}°F`);
      if (vitals.spo2) vitalParts.push(`SpO2: ${vitals.spo2}%`);
      if (vitals.weight) vitalParts.push(`Weight: ${vitals.weight} kg`);
      if (vitals.blood_sugar) vitalParts.push(`Blood Sugar: ${vitals.blood_sugar} mg/dL`);
      doc.fontSize(9).font('Helvetica').fillColor('#333').text(vitalParts.join('  |  '), leftX, y, { width: pageWidth });
      y += 18;
    }

    // ─── Medications Table ───────────────────────────────────────────────
    y += 5;
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Medications:', leftX, y);
    y += 16;

    const medications = prescription.medications || [];
    if (medications.length > 0) {
      // Table header
      const colWidths = [25, 140, 55, 70, 60, 50, 115];
      const headers = ['#', 'Medicine', 'Dosage', 'Frequency', 'Duration', 'Route', 'Instructions'];

      doc.rect(leftX, y, pageWidth, 16).fill('#007A64');
      doc.fillColor('white').fontSize(7).font('Helvetica-Bold');
      let cx = leftX + 3;
      headers.forEach((h, i) => {
        doc.text(h, cx, y + 4, { width: colWidths[i] });
        cx += colWidths[i];
      });
      y += 16;

      // Table rows
      medications.forEach((med, idx) => {
        // Check if we need a new page
        if (y > 720) {
          doc.addPage();
          y = 40;
        }

        const bgColor = idx % 2 === 0 ? '#f8f8f8' : '#ffffff';
        const rowHeight = 18;
        doc.rect(leftX, y, pageWidth, rowHeight).fill(bgColor);

        doc.fillColor('#333').fontSize(7).font('Helvetica');
        cx = leftX + 3;
        const rowData = [
          `${idx + 1}`,
          `${med.name}${med.generic_name ? ` (${med.generic_name})` : ''}`,
          med.dosage || '-',
          FREQ_LABELS[med.frequency] || med.frequency || '-',
          med.duration || '-',
          med.route || 'Oral',
          med.instructions || '-',
        ];
        rowData.forEach((val, i) => {
          doc.text(val, cx, y + 5, { width: colWidths[i], lineBreak: false });
          cx += colWidths[i];
        });
        y += rowHeight;
      });

      // Bottom border
      doc.moveTo(leftX, y).lineTo(leftX + pageWidth, y).stroke('#ddd');
    }

    // ─── Follow-up ───────────────────────────────────────────────────────
    if (prescription.follow_up_date) {
      y += 15;
      const fuDate = new Date(prescription.follow_up_date).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Follow-up:', leftX, y);
      doc.fontSize(9).font('Helvetica').fillColor('#333').text(fuDate, leftX + 65, y);
      if (prescription.follow_up_notes) {
        y += 14;
        doc.text(prescription.follow_up_notes, leftX, y, { width: pageWidth });
        y += doc.heightOfString(prescription.follow_up_notes, { width: pageWidth });
      }
    }

    // ─── Clinical Notes ──────────────────────────────────────────────────
    if (prescription.clinical_notes) {
      y += 15;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#007A64').text('Clinical Notes:', leftX, y);
      y += 14;
      doc.fontSize(9).font('Helvetica').fillColor('#333').text(prescription.clinical_notes, leftX, y, { width: pageWidth });
      y += doc.heightOfString(prescription.clinical_notes, { width: pageWidth });
    }

    // ─── Footer / Signature ──────────────────────────────────────────────
    y = Math.max(y + 40, 680);
    if (y > 750) {
      doc.addPage();
      y = 40;
    }
    doc.moveTo(leftX + pageWidth - 200, y).lineTo(leftX + pageWidth, y).stroke('#333');
    y += 5;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#333')
      .text(`Dr. ${doctor.name || 'N/A'}`, leftX + pageWidth - 200, y, { width: 200, align: 'center' });
    y += 12;
    if (doctor.specialization) {
      doc.fontSize(8).font('Helvetica')
        .text(doctor.specialization, leftX + pageWidth - 200, y, { width: 200, align: 'center' });
    }

    // ─── Disclaimer ──────────────────────────────────────────────────────
    doc.fontSize(7).font('Helvetica').fillColor('#999')
      .text('This is a computer-generated prescription. Valid only with doctor\'s signature.', leftX, 790, { width: pageWidth, align: 'center' });

    doc.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /prescriptions/create — staff enters structured prescription
// ═══════════════════════════════════════════════════════════════════════════════
export const createPrescription = async (req, res) => {
  try {
    const {
      appointment_id,
      patient_id,
      doctor_id,
      diagnosis,
      clinical_notes,
      medications: rawMedications,
      follow_up_date,
      follow_up_notes,
      vitals: rawVitals,
    } = req.body;

    const patientId = parseIntegerField(patient_id);
    const doctorId = parseIntegerField(doctor_id);
    const appointmentId = parseIntegerField(appointment_id);
    const medications = parseJsonField(rawMedications, []);
    const vitals = parseJsonField(rawVitals, null);
    const override = parseJsonField(req.body.override, null); // { reason, approvedBy? }

    if (!Number.isInteger(patientId) || !Number.isInteger(doctorId)) {
      return error(res, 'patient_id and doctor_id are required', HTTP_STATUS.BAD_REQUEST);
    }
    if (appointment_id && !Number.isInteger(appointmentId)) {
      return error(res, 'appointment_id must be a valid integer', HTTP_STATUS.BAD_REQUEST);
    }
    if (!medications || !Array.isArray(medications) || medications.length === 0) {
      return error(res, 'At least one medication is required', HTTP_STATUS.BAD_REQUEST);
    }

    // ── Clinical Decision Support hard-block ──
    // Run safety check; if blockers[] non-empty, require an explicit override payload.
    // Override requires a non-empty reason; we log it to prescription_safety_overrides
    // after the prescription is inserted so there's always a prescription_id to link.
    const safety = await validatePrescriptionSafety(patientId, medications);
    if (!safety.safe) {
      if (!override || typeof override.reason !== 'string' || override.reason.trim().length < 5) {
        return error(
          res,
          'Prescription blocked by clinical safety check',
          HTTP_STATUS.CONFLICT,
          { blockers: safety.blockers, warnings: safety.warnings, requiresOverride: true },
        );
      }
      logger.warn(
        `CDS override used by user=${req.user?.id} patient=${patientId} blockers=${safety.blockers.length}`,
      );
    }

    // Validate appointment if provided
    if (appointmentId) {
      const apptCheck = await prisma.$queryRawUnsafe('SELECT id FROM appointments WHERE id=$1', appointmentId);
      if (apptCheck.length === 0) {
        return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
      }
    }

    // Upload handwritten photo if present (multer file)
    let handwritten_photo_key = null;
    if (req.file) {
      const key = `prescriptions/handwritten/${Date.now()}-${req.file.originalname || 'photo.jpg'}`;
      await uploadFileToR2(req.file.buffer, key, req.file.mimetype);
      handwritten_photo_key = key;
    }

    // Get creator (staff user) from auth context
    const created_by = req.user?.id || req.user?.userId || null;

    // Resolve patient_uid + doctor_uid for the dedicated UUID columns
    // (added in migration 176). The patient app's Rx-list filter and
    // pharmacy lookups join by uid, not the int id — leaving these null
    // made every walk-in's prescriptions invisible in the patient app.
    // See finding 2026-05-08-walk-in-opd-doctor-prescription-uid-fields-null.
    //
    // Pre-flight existence check: discharge-takeaway rx is created from
    // the discharge desk with patient/doctor ids that may not exist
    // (e.g. doctor id passed from the doctors table rather than users).
    // Surface that as a clean 404 — without this, the downstream INSERT
    // still succeeded with null uids but the patient app could never
    // see the prescription, and any clinical-context probe (PDF, follow-
    // up notification) silently degraded. Finding:
    //   2026-05-10-surgical-day-care-discharge-prescription-create-500.
    const [patientRow, doctorRow] = await Promise.all([
      prisma.$queryRawUnsafe('SELECT uid FROM users WHERE id=$1', patientId),
      prisma.$queryRawUnsafe('SELECT uid FROM users WHERE id=$1', doctorId),
    ]);
    if (!patientRow?.length) {
      return error(res, `Patient ${patientId} not found`, HTTP_STATUS.NOT_FOUND);
    }
    if (!doctorRow?.length) {
      return error(res, `Doctor ${doctorId} not found`, HTTP_STATUS.NOT_FOUND);
    }
    const patientUid = patientRow[0].uid ?? null;
    const doctorUid = doctorRow[0].uid ?? null;

    // Insert prescription.
    // The table has `clinical_notes` (not `notes`); patient_uid + doctor_uid
    // are populated explicitly so downstream uid-based lookups work.
    const insertResult = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
        (appointment_id, patient_id, doctor_id, patient_uid, doctor_uid,
         diagnosis, clinical_notes, medications,
         follow_up_date, follow_up_notes, vitals, handwritten_photo_key, created_by)
       VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8::jsonb, $9::date, $10, $11::jsonb, $12, $13)
       RETURNING id, appointment_id, patient_id, doctor_id, patient_uid, doctor_uid,
                 medications, status, created_at,
                 prescription_number, diagnosis, clinical_notes, vitals,
                 follow_up_date, follow_up_notes, pdf_key, handwritten_photo_key`,
      appointmentId || null,
      patientId,
      doctorId,
      patientUid,
      doctorUid,
      diagnosis || null,
      clinical_notes || null,
      JSON.stringify(medications),
      follow_up_date || null,
      follow_up_notes || null,
      vitals ? JSON.stringify(vitals) : null,
      handwritten_photo_key,
      created_by,
    );

    const prescription = insertResult[0];

    // If CDS blockers were overridden, persist the audit row linked to the new Rx.
    if (!safety.safe && override) {
      try {
        await prisma.$queryRawUnsafe(
          `INSERT INTO prescription_safety_overrides
             (prescription_id, patient_id, doctor_id, blockers, reason, approved_by, created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          prescription.id,
          patientId,
          doctorId,
          JSON.stringify(safety.blockers),
          override.reason.trim(),
          override.approvedBy || null,
          created_by,
        );
      } catch (auditErr) {
        logger.error('Failed to persist CDS override audit row:', auditErr.message);
      }
    }

    // Fetch patient and doctor info for PDF
    const [patientRes, doctorRes] = await Promise.all([
      prisma.$queryRawUnsafe('SELECT id, name, phone, gender, birthday FROM users WHERE id=$1', patientId),
      prisma.$queryRawUnsafe(`SELECT u.id, u.name, u.phone, d.specialty AS specialization, NULL::text AS qualification
                FROM users u LEFT JOIN doctors d ON d.user_id = u.id
                WHERE u.id=$1`, doctorId),
    ]);
    const patient = patientRes[0] || {};
    const doctor = doctorRes[0] || {};

    // Generate PDF
    try {
      const pdfBuffer = await generatePrescriptionPDF(prescription, patient, doctor);
      const pdfKey = `prescriptions/pdf/${prescription.prescription_number}.pdf`;
      await uploadFileToR2(pdfBuffer, pdfKey, 'application/pdf');
      await prisma.$queryRawUnsafe('UPDATE e_prescriptions SET pdf_key=$1 WHERE id=$2', pdfKey, prescription.id);
      prescription.pdf_key = pdfKey;
    } catch (pdfErr) {
      logger.error('Failed to generate prescription PDF:', pdfErr);
      // Non-blocking — prescription still created
    }

    // Fire-and-forget notification to patient
    dispatch({
      userId: patient.phone || String(patient_id),
      title: '📋 Prescription Ready',
      body: `Your prescription ${prescription.prescription_number} is ready. Open the app to view and order medicines.`,
      channels: ['push', 'inapp'],
      data: { type: 'prescription', prescriptionId: String(prescription.id) },
      type: 'prescription',
    }).catch(err => logger.error('Prescription notification failed:', err));

    // Phase 1.5 — best-effort follow-up appointment auto-booking. The
    // doctor's Rx form has a `follow_up_date` field that was previously
    // captured only as a printed instruction on the prescription PDF.
    // The receptionist had to remember to manually book the follow-up
    // — and frequently didn't, so the 28-week ANC return / 14-day
    // post-op review / chronic-care visit never materialised. Finding:
    //   2026-05-09-walk-in-opd-patient-follow-up-appt-not-booked.
    //
    // Idempotency: skip if an appointment for the same
    // (patient_id, doctor_id, appointment_date) already exists in a
    // non-terminal state. The matcher uses DATE() to ignore time
    // components — patients typically don't care which slot of the
    // recommended day they get, only that one is reserved.
    if (follow_up_date && /^\d{4}-\d{2}-\d{2}$/.test(String(follow_up_date))) {
      try {
        const existing = await prisma.$queryRawUnsafe(
          `SELECT id FROM appointments
            WHERE patient_id = $1::int
              AND doctor_id  = $2::int
              AND DATE(appointment_date) = $3::date
              AND status NOT IN ('CANCELLED', 'NO_SHOW')
            LIMIT 1`,
          patientId, doctorId, follow_up_date,
        );
        if (!existing.length) {
          await prisma.$queryRawUnsafe(
            `INSERT INTO appointments
               (patient_id, doctor_id, appointment_date, appointment_time, phone, reason, notes,
                status, visit_type, parent_appointment_id, created_by, updated_at)
             VALUES ($1::int, $2::int, $3::date, $4, $5, $6, $7,
                     'SCHEDULED', 'FOLLOW_UP', $8, $9::uuid, NOW())`,
            patientId, doctorId, follow_up_date,
            // appointment_time is VARCHAR(10) NOT NULL. The Rx didn't
            // capture a slot time — the receptionist will assign one
            // when the day comes. Use the 'Follow-up' literal as a
            // placeholder that the appointment dashboard recognises.
            'Follow-up',
            patient.phone || '',
            `Follow-up for prescription ${prescription.prescription_number}`,
            follow_up_notes || null,
            appointmentId || null,
            req.user?.uid || null,
          );
        }
      } catch (followUpErr) {
        // Non-blocking — the prescription is already saved.
        logger.warn('Follow-up appointment auto-booking failed:', {
          prescription_id: prescription.id,
          err: followUpErr?.message,
        });
      }
    }

    success(res, prescription, `Prescription ${prescription.prescription_number} created`, HTTP_STATUS.CREATED);
  } catch (err) {
    // Log enough context to actually diagnose the next swarm 500. The
    // previous catch logged the bare Error and surfaced a generic
    // "Failed to create prescription" — every subsequent tick filed
    // an opaque finding (see 2026-05-10-surgical-day-care-discharge-
    // prescription-create-500). Now: log err.code, err.meta (Prisma's
    // FK/unique-constraint diagnostics), and err.stack so the
    // operations log carries the actual fault.
    logger.error('Create e-prescription error', {
      message: err?.message,
      code: err?.code,
      meta: err?.meta,
      stack: err?.stack,
    });
    error(res, 'Failed to create prescription', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /prescriptions/safety-check — preview CDS result before save (no insert).
// Clients call this to drive the hard-block UX without committing anything.
// Body: { patient_id, medications: [{ name | medication_name, ... }] }
// ═══════════════════════════════════════════════════════════════════════════════
export const previewSafetyCheck = async (req, res) => {
  try {
    const { patient_id, medications } = req.body;
    if (!patient_id || !Array.isArray(medications) || medications.length === 0) {
      return error(res, 'patient_id and medications are required', HTTP_STATUS.BAD_REQUEST);
    }
    const safety = await validatePrescriptionSafety(patient_id, medications);
    success(res, safety, safety.safe ? 'Safe to prescribe' : 'Blockers detected');
  } catch (err) {
    logger.error('Preview safety check error:', err);
    error(res, 'Failed to run safety check', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/:id/safety — patient-facing safety context for the Rx detail
// sheet. Returns allergy warnings the patient should see + any override reason
// so they know when a clinician consciously prescribed through a caution.
// ═══════════════════════════════════════════════════════════════════════════════
export const getPrescriptionSafety = async (req, res) => {
  try {
    const { id } = req.params;
    const rx = await prisma.$queryRawUnsafe(
      'SELECT patient_id, medications, diagnosis FROM e_prescriptions WHERE id = $1',
      id,
    );
    if (rx.length === 0) return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);

    // Patient role may only view their own prescription's safety context.
    if (req.user?.role === 'PATIENT' && String(rx[0].patient_id) !== String(req.user.id)) {
      return error(res, 'Forbidden', HTTP_STATUS.FORBIDDEN);
    }

    const meds = Array.isArray(rx[0].medications)
      ? rx[0].medications
      : (typeof rx[0].medications === 'string' ? JSON.parse(rx[0].medications) : []);
    const safety = await validatePrescriptionSafety(rx[0].patient_id, meds);

    const overrides = await prisma.$queryRawUnsafe(
      `SELECT reason, created_at FROM prescription_safety_overrides
       WHERE prescription_id = $1 ORDER BY created_at DESC`,
      id,
    );

    success(res, {
      warnings: safety.warnings,
      blockers: safety.blockers,
      overrides: overrides.map(o => ({
        reason: o.reason,
        at: o.created_at,
      })),
      indication: rx[0].diagnosis || null,
    }, 'Prescription safety context');
  } catch (err) {
    logger.error('Get prescription safety error:', err);
    error(res, 'Failed to fetch safety context', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/:id — get prescription detail
// ═══════════════════════════════════════════════════════════════════════════════
export const getPrescription = async (req, res) => {
  try {
    // `e_prescriptions.id` is an `integer` column. node-postgres types the
    // raw `req.params.id` string as `text` and Postgres rejects the
    // comparison with the int column → swallowed 500. Coerce here.
    // See finding 2026-05-08-walk-in-opd-doctor-prescription-get-by-id-fails.
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await prisma.$queryRawUnsafe(
      `SELECT ep.*,
              p.name AS patient_name, p.phone AS patient_phone, p.gender AS patient_gender, p.birthday AS patient_birthday,
              d.name AS doctor_name, doc.specialty AS doctor_specialization, NULL::text AS doctor_qualification
       FROM e_prescriptions ep
       JOIN users p ON p.id = ep.patient_id
       JOIN users d ON d.id = ep.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = ep.doctor_id
       WHERE ep.id = $1`,
      id
    );
    if (result.length === 0) {
      return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);
    }

    const rx = result[0];

    // B-2 IDOR check. Patient-role callers may only read their own
    // prescriptions; staff (DOCTOR / NURSING / PHARMACY / ADMIN) read
    // any. The role helpers normalise across the role enum so a single
    // isStaff()-or-isAdmin() gate suffices. Scoped here rather than in
    // routing because the route-level RBAC already allows PATIENT (and
    // we need PATIENT to reach /:id for their OWN script).
    const role = String(req.user?.role || '').toUpperCase();
    const isPrivileged = ['ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF',
      'PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'BILLING_STAFF'].includes(role);
    if (!isPrivileged) {
      const callerId = req.user?.id ?? req.user?.userId;
      if (!callerId || String(rx.patient_id) !== String(callerId)) {
        return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);
      }
    }

    // Sign URLs
    if (rx.pdf_key) {
      try { rx.pdf_url = await getSignedFileUrl(rx.pdf_key); } catch (e) { logger.warn('Signed URL generation failed for PDF:', e.message); }
    }
    if (rx.handwritten_photo_key) {
      try { rx.handwritten_photo_url = await getSignedFileUrl(rx.handwritten_photo_key); } catch (e) { logger.warn('Signed URL generation failed for handwritten photo:', e.message); }
    }

    success(res, rx, 'Prescription detail');
  } catch (err) {
    logger.error('Get prescription error:', err);
    error(res, 'Failed to fetch prescription', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/appointment/:appointmentId
// ═══════════════════════════════════════════════════════════════════════════════
export const getPrescriptionByAppointment = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const result = await prisma.$queryRawUnsafe(
      `SELECT ep.*,
              p.name AS patient_name, p.phone AS patient_phone,
              d.name AS doctor_name, doc.specialty AS doctor_specialization
       FROM e_prescriptions ep
       JOIN users p ON p.id = ep.patient_id
       JOIN users d ON d.id = ep.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = ep.doctor_id
       WHERE ep.appointment_id = $1
       ORDER BY ep.created_at DESC LIMIT 1`,
      appointmentId
    );
    if (result.length === 0) {
      return error(res, 'No prescription found for this appointment', HTTP_STATUS.NOT_FOUND);
    }

    const rx = result[0];
    if (rx.pdf_key) {
      try { rx.pdf_url = await getSignedFileUrl(rx.pdf_key); } catch (e) { logger.warn('Signed URL generation failed for PDF:', e.message); }
    }

    success(res, rx, 'Prescription for appointment');
  } catch (err) {
    logger.error('Get prescription by appointment error:', err);
    error(res, 'Failed to fetch prescription', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/patient/my — patient's own prescriptions
// ═══════════════════════════════════════════════════════════════════════════════
export const getMyPrescriptions = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    if (!userId) {
      return error(res, 'Authentication required', HTTP_STATUS.UNAUTHORIZED);
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT ep.*,
              d.name AS doctor_name, doc.specialty AS doctor_specialization
       FROM e_prescriptions ep
       JOIN users d ON d.id = ep.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = ep.doctor_id
       WHERE ep.patient_id = $1
       ORDER BY ep.created_at DESC`,
      userId
    );

    // Sign PDF URLs
    for (const rx of result) {
      if (rx.pdf_key) {
        try { rx.pdf_url = await getSignedFileUrl(rx.pdf_key); } catch (e) { logger.warn('Signed URL generation failed for PDF:', e.message); }
      }
    }

    success(res, result, 'My prescriptions');
  } catch (err) {
    logger.error('Get my prescriptions error:', err);
    error(res, 'Failed to fetch prescriptions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/all — admin list all prescriptions
// ═══════════════════════════════════════════════════════════════════════════════
export const getAllPrescriptions = async (req, res) => {
  try {
    const { doctor_id, phone, from_date, to_date, status, page = 1, limit = 50 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (doctor_id) {
      params.push(doctor_id);
      where += ` AND ep.doctor_id = $${params.length}`;
    }
    // Phone filter — scope to one patient via the joined users row.
    // Without this branch the param was silently ignored and the query
    // returned every patient's prescriptions (PHI leak; finding
    // 2026-05-08-walk-in-opd-pharmacy-prescription-phone-filter-leaks-all-patients).
    if (phone) {
      params.push(phone);
      where += ` AND p.phone = $${params.length}`;
    }
    if (from_date) {
      params.push(from_date);
      where += ` AND ep.created_at >= $${params.length}::date`;
    }
    if (to_date) {
      params.push(to_date);
      where += ` AND ep.created_at < ($${params.length}::date + interval '1 day')`;
    }
    if (status) {
      params.push(status);
      where += ` AND ep.status = $${params.length}`;
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit));
    params.push(offset);

    const result = await prisma.$queryRawUnsafe(
      `SELECT ep.*,
              p.name AS patient_name, p.phone AS patient_phone,
              d.name AS doctor_name, doc.specialty AS doctor_specialization
       FROM e_prescriptions ep
       JOIN users p ON p.id = ep.patient_id
       JOIN users d ON d.id = ep.doctor_id
       LEFT JOIN doctors doc ON doc.user_id = ep.doctor_id
       ${where}
       ORDER BY ep.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params
    );

    success(res, result, 'All prescriptions');
  } catch (err) {
    logger.error('Get all prescriptions error:', err);
    error(res, 'Failed to fetch prescriptions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /prescriptions/:id/order-pharmacy — patient opts to get medicines
// ═══════════════════════════════════════════════════════════════════════════════
export const orderPharmacyFromPrescription = async (req, res) => {
  try {
    // Same string→int coercion as getPrescription. See finding
    // 2026-05-08-walk-in-opd-doctor-prescription-get-by-id-fails.
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }
    const { delivery_type = 'delivery', delivery_address, delivery_phone } = req.body;

    // Fetch prescription
    const rxResult = await prisma.$queryRawUnsafe(
      `SELECT ep.*, p.name AS patient_name, p.phone AS patient_phone
       FROM e_prescriptions ep
       JOIN users p ON p.id = ep.patient_id
       WHERE ep.id = $1`,
      id
    );
    if (rxResult.length === 0) {
      return error(res, 'Prescription not found', HTTP_STATUS.NOT_FOUND);
    }
    const rx = rxResult[0];

    if (rx.pharmacy_opted) {
      return error(res, 'Pharmacy order already placed for this prescription', HTTP_STATUS.BAD_REQUEST);
    }

    // Build items list from medications + catalog prices.
    //
    // The e_prescriptions.medications JSONB carries clinician-entered shape
    // — `medication_name` is the canonical field, with `name` accepted as
    // alias for older Rx payloads. Pull every dispensing-relevant field
    // (dose, frequency, route, duration, instructions) into the order's
    // items_list so the counter pharmacist + label endpoint have what they
    // need without re-reading the prescription. Resolve catalog_id when we
    // can — this is what markCounterDispensed/markDelivered use to decrement
    // stock; otherwise stock movement silently drops to zero.
    //
    // Findings:
    //   2026-05-09-walk-in-opd-pharmacy-order-items-missing-medication-details
    //   2026-05-09-inpatient-admission-pharmacy-order-pharmacy-items-zero-price-no-stock
    //   2026-05-09-walk-in-opd-pharmacy-stock-not-decremented
    const medications = rx.medications || [];
    const itemsList = [];
    let totalCost = 0;

    const toPositiveInt = (val, fallback = 1) => {
      const n = Number.parseInt(val, 10);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };

    for (const med of medications) {
      const medName = med.name || med.medication_name || med.drug_name || '';
      let price = 0;
      let catalogId = med.catalog_id ? Number(med.catalog_id) : null;
      if (Number.isFinite(catalogId)) {
        const catRes = await prisma.$queryRawUnsafe(
          'SELECT id, unit_price FROM pharmacy_catalog WHERE id=$1',
          catalogId,
        );
        if (catRes.length > 0) {
          price = parseFloat(catRes[0].unit_price) || 0;
        } else {
          catalogId = null;
        }
      }
      if (!catalogId && medName) {
        const catRes = await prisma.$queryRawUnsafe(
          'SELECT id, unit_price FROM pharmacy_catalog WHERE name ILIKE $1 LIMIT 1',
          medName,
        );
        if (catRes.length > 0) {
          catalogId = catRes[0].id;
          price = parseFloat(catRes[0].unit_price) || 0;
        }
      }
      const qty = toPositiveInt(med.quantity ?? med.qty, 1);
      const lineTotal = Number((price * qty).toFixed(2));
      totalCost += lineTotal;
      itemsList.push({
        catalog_id: catalogId,
        name: medName,
        medication_name: medName,
        strength: med.strength || med.dosage || null,
        dose: med.dose || med.dosage || null,
        route: med.route || null,
        frequency: med.frequency || null,
        duration: med.duration || null,
        instructions: med.instructions || med.notes || null,
        qty,
        price,
        line_total: lineTotal,
      });
    }
    totalCost = Number(totalCost.toFixed(2));

    // Create pharmacy order.
    // Three drift fixes per finding 2026-05-08-pediatric-opd-pharmacy-order-from-rx-500:
    //   1. `updated_at` is NOT NULL with no default — insert NOW().
    //   2. `order_number` has a DB default in main schema but absent in the
    //      under-migrated swarm tenant DB. Generate it explicitly so the
    //      INSERT succeeds either way (RETURNING then surfaces it).
    //   3. Status default + downstream state machine are UPPERCASE
    //      (`PENDING`); lowercase `pending` was rejected by transitions in
    //      pharmacyOrderController and broke confirm/dispatch flows.
    const phone = delivery_phone || rx.patient_phone;
    const orderNumber = `PO-${randomUUID().replace(/-/g, '')}`;
    const orderResult = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders
        (phone, patient_id, patient_name, order_note, delivery_type, delivery_address, delivery_phone,
         items_list, total_amount, status, order_number, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'PENDING', $10, NOW())
       RETURNING id, uid, patient_id, patient_name, status, order_note, total_amount, created_at, updated_at, order_number, delivery_type`,
      phone,
      rx.patient_id,
      rx.patient_name,
      `Auto-order from prescription ${rx.prescription_number}`,
      delivery_type,
      delivery_address || null,
      delivery_phone || phone,
      JSON.stringify(itemsList),
      totalCost,
      orderNumber,
    );
    const pharmacyOrder = orderResult[0];

    // Link back to prescription
    await prisma.$queryRawUnsafe(
      `UPDATE e_prescriptions
       SET pharmacy_order_id = $1, pharmacy_opted = TRUE, pharmacy_opt_type = $2,
           status = 'pharmacy_linked', updated_at = NOW()
       WHERE id = $3`,
      pharmacyOrder.id, delivery_type, id
    );

    // Notify pharmacy staff
    dispatch({
      userId: 'pharmacy', // will fail gracefully — intended for in-app
      title: '🛒 New Rx Pharmacy Order',
      body: `Order ${pharmacyOrder.order_number} from prescription ${rx.prescription_number}`,
      channels: ['inapp'],
      type: 'pharmacy_order',
    }).catch(e => logger.warn('Pharmacy staff notification failed:', e.message));

    success(res, pharmacyOrder, `Pharmacy order ${pharmacyOrder.order_number} created from prescription`);
  } catch (err) {
    logger.error('Order pharmacy from prescription error:', err);
    error(res, 'Failed to create pharmacy order', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /prescriptions/pdf/:id — download prescription PDF (signed URL redirect)
// ═══════════════════════════════════════════════════════════════════════════════
export const downloadPrescriptionPDF = async (req, res) => {
  try {
    // Same string→int coercion as getPrescription. See finding
    // 2026-05-08-walk-in-opd-doctor-prescription-get-by-id-fails.
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return error(res, 'Invalid prescription id', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await prisma.$queryRawUnsafe('SELECT pdf_key FROM e_prescriptions WHERE id=$1', id);
    if (result.length === 0 || !result[0].pdf_key) {
      return error(res, 'PDF not found', HTTP_STATUS.NOT_FOUND);
    }

    const url = await getSignedFileUrl(result[0].pdf_key);
    success(res, { url }, 'PDF URL');
  } catch (err) {
    logger.error('Download prescription PDF error:', err);
    error(res, 'Failed to get PDF', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
