// src/services/emr/dischargeSummaryGenerator.js
//
// Auto-generates a discharge summary by aggregating all clinical data from
// an admission encounter: notes, vitals, orders, medications, investigations,
// diagnoses, and procedures.
//
// Architecture: The generator collects all data and builds a structured summary.
// It exposes a pluggable `summarizeWithAI` hook — currently returns the raw
// aggregated data, but can be replaced with a local LLM call (e.g., Ollama,
// llama.cpp, or any OpenAI-compatible API) for narrative summarization.
//
// The generated summary is ALWAYS a draft. It must be reviewed, edited, and
// signed by a doctor before it becomes the official discharge summary.

import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';

// ===================================================================
// AI Summarization Hook — PLUGGABLE
// Replace this function with your local LLM integration when ready.
// It receives structured clinical data and should return a narrative string.
// ===================================================================

/**
 * Default summarizer — formats collected data into a readable structured summary.
 * Replace with AI model call for narrative generation.
 *
 * To integrate a local LLM (e.g., Ollama):
 *   1. Set AI_SUMMARIZE_URL=http://localhost:11434/api/generate in .env
 *   2. Set AI_SUMMARIZE_MODEL=llama3 (or your model name)
 *   3. The function will POST the clinical context and return the AI narrative
 */
async function summarizeWithAI(clinicalData) {
  const aiUrl = process.env.AI_SUMMARIZE_URL;
  const aiModel = process.env.AI_SUMMARIZE_MODEL || 'llama3';

  if (aiUrl) {
    try {
      const prompt = buildAIPrompt(clinicalData);
      const response = await fetch(aiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: aiModel,
          prompt,
          stream: false,
          options: { temperature: 0.3, num_predict: 2000 },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const result = await response.json();
        const narrative = result.response || result.choices?.[0]?.text || '';
        if (narrative.trim()) {
          logger.info('Discharge summary generated via AI model');
          return narrative.trim();
        }
      }
      logger.warn('AI summarization returned empty — falling back to template');
    } catch (err) {
      logger.warn(`AI summarization failed (${err.message}) — falling back to template`);
    }
  }

  // Fallback: structured template summary
  return buildTemplateSummary(clinicalData);
}

// ===================================================================
// Build AI prompt from clinical data
// ===================================================================
function buildAIPrompt(data) {
  return `You are a medical professional writing a discharge summary for a hospital patient.
Based on the following clinical data, write a concise, professional discharge summary.
Include: hospital course, key findings, procedures performed, discharge diagnosis,
medications on discharge, follow-up instructions, and any warning signs the patient
should watch for. Use clear medical terminology.

PATIENT: ${data.patient.name || 'Unknown'}, ${data.patient.gender || 'Unknown'} gender
ADMISSION DATE: ${data.admission.admitted_at}
DISCHARGE DATE: ${new Date().toISOString().split('T')[0]}
ADMITTING DIAGNOSIS: ${data.admission.admitting_diagnosis || 'Not recorded'}
CHIEF COMPLAINT: ${data.admission.chief_complaint || 'Not recorded'}
LENGTH OF STAY: ${data.admission.actual_los_days || 'N/A'} days

DIAGNOSES:
${data.diagnoses.map(d => `- ${d.icd10_code || ''} ${d.description} (${d.status})`).join('\n') || 'None recorded'}

CLINICAL NOTES (chronological):
${data.notes.map(n => `[${n.note_type.toUpperCase()} - ${n.created_at}] ${JSON.stringify(n.content)}`).join('\n\n') || 'None'}

PROCEDURES:
${data.procedures.map(p => `- ${p.content?.procedure_name || 'Procedure'}: ${p.content?.findings || 'No findings noted'}`).join('\n') || 'None'}

VITALS (most recent):
${data.latestVitals ? `HR: ${data.latestVitals.heart_rate}, BP: ${data.latestVitals.systolic_bp}/${data.latestVitals.diastolic_bp}, Temp: ${data.latestVitals.temperature}, SpO2: ${data.latestVitals.spo2}, RR: ${data.latestVitals.respiratory_rate}` : 'Not recorded'}

INVESTIGATIONS:
${data.investigations.map(i => `- ${i.test_name || i.type}: ${i.status} ${i.result_summary || ''}`).join('\n') || 'None'}

MEDICATIONS GIVEN DURING STAY:
${data.medications.map(m => `- ${m.medication_name} ${m.dose} ${m.route} (${m.status})`).join('\n') || 'None'}

ACTIVE ORDERS AT DISCHARGE:
${data.activeOrders.map(o => `- [${o.order_type}] ${JSON.stringify(o.details)}`).join('\n') || 'None'}

Write the discharge summary now:`;
}

// ===================================================================
// Template-based summary (no AI — structured format)
// ===================================================================
function buildTemplateSummary(data) {
  const sections = [];

  // Hospital course
  const los = data.admission.actual_los_days || Math.max(1, Math.ceil(
    (new Date() - new Date(data.admission.admitted_at)) / (1000 * 60 * 60 * 24)
  ));
  sections.push(`Patient was admitted on ${new Date(data.admission.admitted_at).toLocaleDateString()} ` +
    `with chief complaint of "${data.admission.chief_complaint || 'not recorded'}". ` +
    `Length of stay: ${los} day(s).`);

  // Diagnoses
  if (data.diagnoses.length > 0) {
    const primary = data.diagnoses.find(d => d.diagnosis_type === 'primary');
    const secondary = data.diagnoses.filter(d => d.diagnosis_type !== 'primary');
    if (primary) sections.push(`Primary Diagnosis: ${primary.icd10_code || ''} ${primary.description}`);
    if (secondary.length) {
      sections.push('Secondary Diagnoses: ' + secondary.map(d =>
        `${d.icd10_code || ''} ${d.description}`
      ).join('; '));
    }
  }

  // Key clinical notes
  if (data.notes.length > 0) {
    const soapNotes = data.notes.filter(n => n.note_type === 'soap');
    if (soapNotes.length > 0) {
      const lastSoap = soapNotes[soapNotes.length - 1];
      sections.push(`Most recent assessment: ${lastSoap.content?.assessment || 'See clinical notes'}`);
      sections.push(`Plan at discharge: ${lastSoap.content?.plan || 'See clinical notes'}`);
    }
  }

  // Procedures
  if (data.procedures.length > 0) {
    sections.push('Procedures performed: ' + data.procedures.map(p =>
      p.content?.procedure_name || 'Procedure'
    ).join(', '));
  }

  // Latest vitals
  if (data.latestVitals) {
    const v = data.latestVitals;
    sections.push(`Vitals at discharge: HR ${v.heart_rate || '-'}, ` +
      `BP ${v.systolic_bp || '-'}/${v.diastolic_bp || '-'}, ` +
      `Temp ${v.temperature || '-'}°F, SpO2 ${v.spo2 || '-'}%`);
  }

  // Investigations summary
  if (data.investigations.length > 0) {
    sections.push('Key investigations: ' + data.investigations.map(i =>
      `${i.test_name || i.type} (${i.status})`
    ).join(', '));
  }

  return sections.join('\n\n');
}

// ===================================================================
// Collect all clinical data for an admission encounter
// ===================================================================
async function collectClinicalData(admissionId) {
  // Get admission details
  const { rows: admRows } = await db.query(
    `SELECT a.*, u.name as patient_name, u.gender, u.phone, u.birthday, u.allergies as patient_allergies
     FROM admissions a
     LEFT JOIN users u ON a.patient_uid = u.uid
     WHERE a.id = $1`,
    [admissionId]
  );
  if (!admRows.length) throw AppError.notFound('Admission not found');
  const admission = admRows[0];

  // Get all clinical notes for this encounter
  const { rows: notes } = await db.query(
    `SELECT id, note_type, content, author_uid, is_signed, created_at
     FROM clinical_notes
     WHERE encounter_id = $1
     ORDER BY created_at ASC`,
    [admission.encounter_id]
  );

  // Get procedure notes specifically
  const procedures = notes.filter(n => n.note_type === 'procedure');

  // Get diagnoses
  const { rows: diagnoses } = await db.query(
    `SELECT icd10_code, description, diagnosis_type, status, severity, onset_date
     FROM diagnoses
     WHERE encounter_id = $1
     ORDER BY diagnosis_type ASC`,
    [admission.encounter_id]
  );

  // Get latest vitals
  const { rows: vitalsRows } = await db.query(
    `SELECT heart_rate, systolic_bp, diastolic_bp, temperature, spo2,
            respiratory_rate, blood_glucose, pain_score, gcs_score, consciousness
     FROM vitals_chart
     WHERE encounter_id = $1
     ORDER BY recorded_at DESC LIMIT 1`,
    [admission.encounter_id]
  );

  // Get medication administrations
  const { rows: medications } = await db.query(
    `SELECT medication_name, dose, route, status, administered_at
     FROM medication_administrations
     WHERE patient_uid = $1 AND created_at >= $2
     ORDER BY created_at DESC`,
    [admission.patient_uid, admission.admitted_at]
  );

  // Get investigations
  const { rows: investigations } = await db.query(
    `SELECT type, test_name, status, result_summary, created_at
     FROM investigations
     WHERE patient_uid = $1 AND created_at >= $2
     ORDER BY created_at DESC`,
    [admission.patient_uid, admission.admitted_at]
  );

  // Get active orders
  const { rows: activeOrders } = await db.query(
    `SELECT order_type, details, status, priority
     FROM clinical_orders
     WHERE encounter_id = $1 AND status NOT IN ('completed', 'cancelled', 'discontinued')
     ORDER BY created_at DESC`,
    [admission.encounter_id]
  );

  return {
    admission: {
      id: admission.id,
      encounter_id: admission.encounter_id,
      chief_complaint: admission.chief_complaint,
      admitting_diagnosis: admission.admitting_diagnosis,
      admitted_at: admission.admitted_at,
      department: admission.department,
      ward: admission.ward,
      code_status: admission.code_status,
      allergies: admission.allergies,
      actual_los_days: admission.actual_los_days,
    },
    patient: {
      uid: admission.patient_uid,
      name: admission.patient_name,
      gender: admission.gender,
      phone: admission.phone,
      birthday: admission.birthday,
      allergies: admission.patient_allergies,
    },
    notes,
    procedures,
    diagnoses,
    latestVitals: vitalsRows[0] || null,
    medications,
    investigations,
    activeOrders,
  };
}

// ===================================================================
// Generate discharge summary — returns editable draft
// ===================================================================
async function generateDischargeSummary(admissionId, requestedBy, req) {
  logger.info(`Generating discharge summary for admission ${admissionId}`);

  // Collect all clinical data
  const clinicalData = await collectClinicalData(admissionId);

  // Log PHI access
  logPhiAccess({
    userId: requestedBy,
    patientId: clinicalData.patient.uid,
    recordType: 'discharge_summary_generation',
    action: 'GENERATE',
    ip: req?.ip,
    requestId: req?.id,
  });

  // Generate summary text (template or AI)
  const hospitalCourse = await summarizeWithAI(clinicalData);

  // Build structured discharge summary
  const dischargeSummary = {
    hospital_course: hospitalCourse,
    discharge_diagnosis: clinicalData.diagnoses
      .filter(d => d.status === 'active' || d.diagnosis_type === 'primary')
      .map(d => `${d.icd10_code || ''} ${d.description}`.trim())
      .join('; ') || clinicalData.admission.admitting_diagnosis || 'See clinical notes',
    discharge_condition: clinicalData.latestVitals
      ? `Vitals stable: HR ${clinicalData.latestVitals.heart_rate}, BP ${clinicalData.latestVitals.systolic_bp}/${clinicalData.latestVitals.diastolic_bp}, SpO2 ${clinicalData.latestVitals.spo2}%`
      : 'See final vitals chart',
    medications_on_discharge: clinicalData.activeOrders
      .filter(o => o.order_type === 'medication')
      .map(o => ({
        name: o.details?.medication_name || 'Unknown',
        dose: o.details?.dose || '',
        route: o.details?.route || '',
        frequency: o.details?.frequency || '',
        duration: o.details?.duration || '',
      })),
    follow_up_instructions: 'Review with treating physician within 1 week. Report to emergency if symptoms worsen.',
    activity_restrictions: '',
    diet_instructions: '',
    warning_signs: 'Return immediately if: high fever, difficulty breathing, chest pain, severe pain, or any new concerning symptoms.',
    procedures_performed: clinicalData.procedures.map(p => p.content?.procedure_name || 'Procedure'),
    investigations_summary: clinicalData.investigations.map(i => ({
      test: i.test_name || i.type,
      status: i.status,
      result: i.result_summary || 'Pending',
    })),
    generated_at: new Date().toISOString(),
    generated_by: requestedBy,
    is_draft: true,
    is_signed: false,
    signed_by: null,
    signed_at: null,
  };

  return dischargeSummary;
}

// ===================================================================
// Save edited discharge summary as clinical note (draft or final)
// ===================================================================
async function saveDischargeSummary(admissionId, summary, savedBy) {
  const { rows: admRows } = await db.query(
    `SELECT encounter_id, patient_uid, status FROM admissions WHERE id = $1`,
    [admissionId]
  );
  if (!admRows.length) throw AppError.notFound('Admission not found');

  const admission = admRows[0];

  // Check if a discharge note already exists for this encounter
  const { rows: existing } = await db.query(
    `SELECT id FROM clinical_notes
     WHERE encounter_id = $1 AND note_type = 'discharge'
     ORDER BY version DESC LIMIT 1`,
    [admission.encounter_id]
  );

  if (existing.length) {
    // Update existing draft (only if not signed)
    const { rows: note } = await db.query(
      `SELECT is_signed FROM clinical_notes WHERE id = $1`,
      [existing[0].id]
    );
    if (note[0]?.is_signed) {
      throw AppError.badRequest('Signed discharge summary cannot be modified. Add an addendum instead.');
    }

    await db.query(
      `UPDATE clinical_notes
       SET content = $1, version = version + 1, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(summary), existing[0].id]
    );

    return { noteId: existing[0].id, action: 'updated' };
  }

  // Create new discharge note
  const { rows: created } = await db.query(
    `INSERT INTO clinical_notes
     (encounter_id, patient_uid, author_uid, author_role, note_type, content, version, is_signed)
     VALUES ($1, $2, $3, 'DOCTOR', 'discharge', $4, 1, false)
     RETURNING id`,
    [admission.encounter_id, admission.patient_uid, savedBy, JSON.stringify(summary)]
  );

  return { noteId: created[0].id, action: 'created' };
}

// ===================================================================
// Sign discharge summary — makes it official and immutable
// ===================================================================
async function signDischargeSummary(admissionId, doctorUid) {
  const { rows: admRows } = await db.query(
    `SELECT encounter_id, patient_uid FROM admissions WHERE id = $1`,
    [admissionId]
  );
  if (!admRows.length) throw AppError.notFound('Admission not found');

  // Verify the signer is a doctor
  const { rows: userRows } = await db.query(
    `SELECT role FROM users WHERE uid = $1`,
    [doctorUid]
  );
  const role = userRows[0]?.role?.toUpperCase() || '';
  if (!['DOCTOR', 'SENIOR_DOCTOR', 'RESIDENT_DOCTOR', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
    throw AppError.forbidden('Only doctors can sign discharge summaries');
  }

  // Find the discharge note
  const { rows: noteRows } = await db.query(
    `SELECT id, is_signed FROM clinical_notes
     WHERE encounter_id = $1 AND note_type = 'discharge'
     ORDER BY version DESC LIMIT 1`,
    [admRows[0].encounter_id]
  );
  if (!noteRows.length) throw AppError.notFound('No discharge summary found. Generate one first.');
  if (noteRows[0].is_signed) throw AppError.badRequest('Discharge summary is already signed');

  // Sign the note — this makes it immutable
  await db.query(
    `UPDATE clinical_notes
     SET is_signed = true, signed_at = NOW(), signed_by = $1
     WHERE id = $2`,
    [doctorUid, noteRows[0].id]
  );

  // Audit log
  await db.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, created_at)
     VALUES ($1, 'SIGN_DISCHARGE_SUMMARY', 'clinical_notes', $2, $3, NOW())`,
    [doctorUid, String(noteRows[0].id), JSON.stringify({
      admission_id: admissionId,
      patient_uid: admRows[0].patient_uid,
    })]
  );

  logger.info(`Discharge summary signed for admission ${admissionId} by doctor ${doctorUid}`);
  return { noteId: noteRows[0].id, signed: true, signedAt: new Date().toISOString() };
}

export default {
  generateDischargeSummary,
  saveDischargeSummary,
  signDischargeSummary,
  collectClinicalData,
};
