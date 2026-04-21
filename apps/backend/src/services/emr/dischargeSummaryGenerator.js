import crypto from 'node:crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { generateClinicalText, getClinicalAiConfig } from '../ai/localLlmClient.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { collectAdmissionClinicalContext } from './clinicalTimelineService.js';

const PROMPT_VERSION = 'clinical-discharge-v1';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

function formatDate(value) {
  if (!value) return 'not documented';
  return new Date(value).toISOString().slice(0, 10);
}

function makeSourceHash(context) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      patient: context.patient?.uid,
      admission: context.admission?.id,
      timeline: context.timeline.map((event) => ({
        type: event.event_type,
        id: event.id,
        timestamp: event.timestamp,
        summary: event.summary,
      })),
    }))
    .digest('hex');
}

function diagnosisText(event) {
  const payload = event.payload || {};
  return text(`${payload.icd10_code || ''} ${payload.description || payload.icd10_description || event.summary}`.trim());
}

function latestByType(events, predicate = () => true) {
  return [...events]
    .filter(predicate)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))[0] || null;
}

function buildCitations(context, limit = 80) {
  return context.citations.slice(0, limit);
}

function buildSafetyFlags(context, summary = {}) {
  const flags = [];
  const diagnoses = asArray(context.diagnoses);
  const meds = asArray(summary.medications_on_discharge);
  const investigations = asArray(context.investigations);
  const orders = asArray(context.orders);
  const allergies = asArray(context.allergies);

  if (!diagnoses.some((event) => /primary/i.test(text(event.payload?.diagnosis_type)))) {
    flags.push({
      severity: 'medium',
      code: 'NO_PRIMARY_DIAGNOSIS',
      message: 'No primary diagnosis is clearly documented.',
    });
  }

  const activeOrders = orders.filter((event) => !/completed|cancelled|discontinued/i.test(text(event.payload?.status)));
  if (activeOrders.length > 0) {
    flags.push({
      severity: 'medium',
      code: 'ACTIVE_ORDERS_AT_DISCHARGE',
      message: `${activeOrders.length} active order(s) still need review before discharge.`,
    });
  }

  const pendingInvestigations = investigations.filter((event) => /pending|requested|ordered/i.test(text(event.payload?.status)));
  if (pendingInvestigations.length > 0) {
    flags.push({
      severity: 'high',
      code: 'PENDING_INVESTIGATIONS',
      message: `${pendingInvestigations.length} investigation(s) appear pending.`,
    });
  }

  const latestVitals = latestByType(context.vitals);
  const vitalsPayload = latestVitals?.payload || {};
  if (Number(vitalsPayload.spo2) > 0 && Number(vitalsPayload.spo2) < 92) {
    flags.push({
      severity: 'high',
      code: 'LOW_SPO2',
      message: `Latest SpO2 is ${vitalsPayload.spo2}%. Confirm discharge safety.`,
    });
  }
  if (/high|medium/i.test(text(vitalsPayload.clinical_risk))) {
    flags.push({
      severity: /high/i.test(text(vitalsPayload.clinical_risk)) ? 'high' : 'medium',
      code: 'RECENT_NEWS2_RISK',
      message: `Recent NEWS2 risk is ${vitalsPayload.clinical_risk}.`,
    });
  }

  const allergyTerms = allergies
    .flatMap((row) => [row.allergen, row.name, row.allergy_name])
    .map((term) => text(term).toLowerCase())
    .filter(Boolean);
  const allergyHits = meds.filter((med) => {
    const name = text(med.name || med.medication_name).toLowerCase();
    return allergyTerms.some((term) => term.length >= 3 && name.includes(term));
  });
  if (allergyHits.length > 0) {
    flags.push({
      severity: 'critical',
      code: 'DISCHARGE_MED_ALLERGY_MATCH',
      message: `Possible allergy conflict in discharge medications: ${allergyHits.map((m) => m.name || m.medication_name).join(', ')}.`,
    });
  }

  if (!text(summary.follow_up_instructions)) {
    flags.push({
      severity: 'medium',
      code: 'MISSING_FOLLOW_UP',
      message: 'Follow-up instructions are empty.',
    });
  }

  return flags;
}

function buildTemplateHospitalCourse(context) {
  const admission = context.admission || {};
  const patient = context.patient || {};
  const diagnoses = context.diagnoses.map(diagnosisText).filter(Boolean);
  const noteHighlights = context.notes
    .slice(-5)
    .map((event) => event.summary)
    .filter(Boolean);
  const procedureNames = context.notes
    .filter((event) => /procedure/i.test(text(event.sub_type)))
    .map((event) => event.payload?.content?.procedure_name || event.summary)
    .filter(Boolean);
  const investigationHighlights = context.investigations
    .slice(-8)
    .map((event) => event.summary)
    .filter(Boolean);

  const sections = [
    `${patient.name || 'The patient'} was admitted on ${formatDate(admission.admitted_at)} with ${admission.chief_complaint || admission.admitting_diagnosis || 'the documented presenting complaint not specified'}.`,
  ];

  if (diagnoses.length > 0) {
    sections.push(`Documented diagnoses include: ${diagnoses.join('; ')}.`);
  } else if (admission.admitting_diagnosis) {
    sections.push(`Admitting diagnosis: ${admission.admitting_diagnosis}.`);
  }

  if (noteHighlights.length > 0) {
    sections.push(`Clinical course highlights: ${noteHighlights.join(' ')}`);
  }

  if (procedureNames.length > 0) {
    sections.push(`Procedures performed: ${procedureNames.join('; ')}.`);
  }

  if (investigationHighlights.length > 0) {
    sections.push(`Investigations: ${investigationHighlights.join('; ')}.`);
  }

  return sections.join('\n\n');
}

function buildDischargeMedications(context) {
  const activeMedicationOrders = context.orders
    .filter((event) => event.payload?.order_type === 'medication')
    .filter((event) => !/cancelled|discontinued/i.test(text(event.payload?.status)));

  return activeMedicationOrders.map((event) => {
    const details = event.payload?.details || {};
    return {
      name: details.medication_name || details.name || 'Medication not named',
      dose: details.dose || details.dosage || '',
      route: details.route || '',
      frequency: details.frequency || '',
      duration: details.duration || '',
      source_order_id: event.id,
    };
  });
}

function buildStructuredSummary(context, hospitalCourse, aiResult) {
  const admission = context.admission || {};
  const diagnoses = context.diagnoses.map(diagnosisText).filter(Boolean);
  const latestVitals = latestByType(context.vitals);
  const vitals = latestVitals?.payload || {};
  const procedures = context.notes
    .filter((event) => /procedure/i.test(text(event.sub_type)))
    .map((event) => event.payload?.content?.procedure_name || event.summary)
    .filter(Boolean);
  const investigations = context.investigations.slice(-12).map((event) => ({
    test: event.payload?.test_name || event.payload?.test_type || event.payload?.investigation_type || 'Investigation',
    status: event.payload?.status || 'unknown',
    result: event.payload?.result_summary || event.payload?.conclusion || event.payload?.interpretation || 'See source record',
    source_id: event.id,
  }));

  const summary = {
    hospital_course: hospitalCourse || buildTemplateHospitalCourse(context),
    discharge_diagnosis: diagnoses.join('; ') || admission.admitting_diagnosis || 'Not documented',
    discharge_condition: latestVitals
      ? `Latest documented vitals: HR ${vitals.heart_rate ?? '-'}, BP ${vitals.systolic_bp ?? '-'}/${vitals.diastolic_bp ?? '-'}, SpO2 ${vitals.spo2 ?? '-'}%.`
      : 'Final discharge condition must be documented by the signing doctor.',
    medications_on_discharge: buildDischargeMedications(context),
    follow_up_instructions: 'Review with treating physician as advised. Return urgently for worsening symptoms, fever, breathlessness, chest pain, bleeding, confusion, or any new concerning symptom.',
    activity_restrictions: '',
    diet_instructions: '',
    warning_signs: 'Seek emergency care for chest pain, breathing difficulty, fainting, high fever, severe pain, worsening weakness, bleeding, or reduced consciousness.',
    procedures_performed: procedures,
    investigations_summary: investigations,
    generated_at: new Date().toISOString(),
    generated_by: null,
    is_draft: true,
    is_signed: false,
    signed_by: null,
    signed_at: null,
    ai_metadata: {
      provider: aiResult.provider,
      model: aiResult.model,
      used_ai: aiResult.usedAi,
      prompt_version: PROMPT_VERSION,
      fallback_reason: aiResult.reason || null,
    },
    source_citations: buildCitations(context),
  };

  summary.safety_flags = buildSafetyFlags(context, summary);
  return summary;
}

function buildPrompt(context) {
  const patient = context.patient || {};
  const admission = context.admission || {};
  const compactTimeline = context.timeline.map((event) => ({
    type: event.event_type,
    sub_type: event.sub_type,
    id: event.id,
    timestamp: event.timestamp,
    summary: event.summary,
  }));

  const systemPrompt = [
    'You are a clinical documentation assistant inside a hospital EMR.',
    'Use only the provided source data.',
    'Never invent diagnoses, procedures, medications, dates, or follow-up plans.',
    'If something is not documented, say "not documented".',
    'Return concise professional hospital-course prose only, not JSON.',
    'The output is a draft for doctor review and must not claim to be signed.',
  ].join('\n');

  const userPrompt = JSON.stringify({
    task: 'Draft hospital course for a discharge summary',
    patient: {
      uid: patient.uid,
      name: patient.name,
      gender: patient.gender,
      birthday: patient.birthday,
    },
    admission: {
      id: admission.id,
      admitted_at: admission.admitted_at,
      discharged_at: admission.discharged_at,
      ward: admission.ward,
      chief_complaint: admission.chief_complaint,
      admitting_diagnosis: admission.admitting_diagnosis,
      code_status: admission.code_status,
    },
    allergies: context.allergies,
    timeline: compactTimeline,
  });

  return { systemPrompt, userPrompt };
}

async function saveAiGeneration(context, summary, requestedBy, sourceHash) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (patient_uid, admission_id, task_type, provider, model, prompt_version,
        source_hash, status, used_ai, safety_flags, citations, draft, generated_by,
        created_at, updated_at)
     VALUES ($1::uuid, $2, 'discharge_summary', $3, $4, $5, $6, 'draft',
             $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::uuid, NOW(), NOW())
     RETURNING id, provider, model, used_ai, status, created_at`,
    context.admission.patient_uid,
    context.admission.id,
    summary.ai_metadata.provider,
    summary.ai_metadata.model,
    PROMPT_VERSION,
    sourceHash,
    summary.ai_metadata.used_ai,
    JSON.stringify(summary.safety_flags || []),
    JSON.stringify(summary.source_citations || []),
    JSON.stringify(summary),
    requestedBy || null
  );

  return rows[0];
}

export async function collectClinicalData(admissionId) {
  return collectAdmissionClinicalContext(admissionId);
}

export async function generateDischargeSummary(admissionId, requestedBy, req) {
  if (!requestedBy) throw AppError.badRequest('requestedBy is required');

  const context = await collectAdmissionClinicalContext(admissionId);
  const prompt = buildPrompt(context);
  const aiResult = await generateClinicalText({
    ...prompt,
    taskType: 'discharge_summary',
  });
  const hospitalCourse = aiResult.usedAi ? aiResult.text : buildTemplateHospitalCourse(context);
  const summary = buildStructuredSummary(context, hospitalCourse, aiResult);
  summary.generated_by = requestedBy;

  const sourceHash = makeSourceHash(context);
  const generation = await saveAiGeneration(context, summary, requestedBy, sourceHash);
  summary.draft_generation_id = generation.id;

  logPhiAccess({
    userId: requestedBy,
    userRole: req?.user?.role,
    patientId: context.patient?.uid || context.admission.patient_uid,
    recordType: 'discharge_summary_generation',
    action: 'GENERATE',
    ip: req?.ip,
    requestId: req?.id,
  });

  await publishEvent({
    eventType: 'clinical_ai.discharge_summary.generated',
    aggregateType: 'admission',
    aggregateId: admissionId,
    patientUid: context.admission.patient_uid,
    payload: {
      generation_id: generation.id,
      used_ai: generation.used_ai,
      provider: generation.provider,
      safety_flag_count: summary.safety_flags.length,
    },
  });

  logger.info('Discharge summary draft generated', {
    admissionId,
    patientUid: context.admission.patient_uid,
    provider: generation.provider,
    usedAi: generation.used_ai,
  });

  return summary;
}

export async function saveDischargeSummary(admissionId, summary, savedBy) {
  if (!savedBy) throw AppError.badRequest('savedBy is required');
  if (!summary || typeof summary !== 'object') throw AppError.badRequest('summary is required');

  const admRows = await prisma.$queryRawUnsafe(
    `SELECT encounter_id, patient_uid, status FROM admissions WHERE id = $1`,
    admissionId
  );
  if (!admRows.length) throw AppError.notFound('Admission not found');
  const admission = admRows[0];

  const content = {
    ...summary,
    is_draft: true,
    is_signed: false,
    reviewed_by: savedBy,
    reviewed_at: new Date().toISOString(),
  };

  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, is_signed
     FROM clinical_notes
     WHERE encounter_id = $1::uuid AND note_type = 'discharge' AND is_addendum = false
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    admission.encounter_id
  );

  let result;
  if (existing.length) {
    if (existing[0].is_signed) {
      throw AppError.badRequest('Signed discharge summary cannot be modified. Add an addendum instead.');
    }

    const rows = await prisma.$queryRawUnsafe(
      `UPDATE clinical_notes
       SET content = $1::jsonb,
           version = version + 1,
           ai_generation_id = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id`,
      JSON.stringify(content),
      content.draft_generation_id || null,
      existing[0].id
    );
    result = { noteId: rows[0].id, action: 'updated' };
  } else {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_notes
         (encounter_id, patient_uid, author_uid, author_role, note_type, title,
          content, version, is_addendum, is_signed, ai_generation_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'DOCTOR', 'discharge', 'Draft discharge summary',
               $4::jsonb, 1, false, false, $5, NOW(), NOW())
       RETURNING id`,
      admission.encounter_id,
      admission.patient_uid,
      savedBy,
      JSON.stringify(content),
      content.draft_generation_id || null
    );
    result = { noteId: rows[0].id, action: 'created' };
  }

  if (content.draft_generation_id) {
    await prisma.$queryRawUnsafe(
      `UPDATE clinical_ai_generations
       SET draft = $1::jsonb, reviewed_by = $2::uuid, status = 'reviewed', updated_at = NOW()
       WHERE id = $3`,
      JSON.stringify(content),
      savedBy,
      content.draft_generation_id
    );
  }

  await publishEvent({
    eventType: 'clinical_document.discharge_summary.saved',
    aggregateType: 'clinical_note',
    aggregateId: result.noteId,
    patientUid: admission.patient_uid,
    payload: {
      admission_id: admissionId,
      action: result.action,
      generation_id: content.draft_generation_id || null,
    },
  });

  return result;
}

export async function signDischargeSummary(admissionId, doctorUid) {
  if (!doctorUid) throw AppError.badRequest('doctorUid is required');

  const admRows = await prisma.$queryRawUnsafe(
    `SELECT encounter_id, patient_uid FROM admissions WHERE id = $1`,
    admissionId
  );
  if (!admRows.length) throw AppError.notFound('Admission not found');
  const admission = admRows[0];

  const noteRows = await prisma.$queryRawUnsafe(
    `SELECT id, is_signed, ai_generation_id
     FROM clinical_notes
     WHERE encounter_id = $1::uuid AND note_type = 'discharge' AND is_addendum = false
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    admission.encounter_id
  );
  if (!noteRows.length) throw AppError.notFound('No discharge summary found. Generate one first.');
  if (noteRows[0].is_signed) throw AppError.badRequest('Discharge summary is already signed');

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE clinical_notes
     SET is_signed = true, signed_at = NOW(), signed_by = $1::uuid, updated_at = NOW(),
         content = jsonb_set(
           jsonb_set(content, '{is_signed}', 'true'::jsonb, true),
           '{signed_at}', to_jsonb(NOW()), true
         )
     WHERE id = $2
     RETURNING id, signed_at`,
    doctorUid,
    noteRows[0].id
  );

  if (noteRows[0].ai_generation_id) {
    await prisma.$queryRawUnsafe(
      `UPDATE clinical_ai_generations
       SET status = 'signed', reviewed_by = $1::uuid, signed_note_id = $2, updated_at = NOW()
       WHERE id = $3`,
      doctorUid,
      noteRows[0].id,
      noteRows[0].ai_generation_id
    );
  }

  await prisma.$queryRawUnsafe(
    `INSERT INTO audit_logs (uid, action, resource, resource_id, metadata, created_at)
     VALUES ($1::uuid, 'SIGN_DISCHARGE_SUMMARY', 'clinical_notes', $2, $3::jsonb, NOW())`,
    doctorUid,
    String(noteRows[0].id),
    JSON.stringify({
      admission_id: admissionId,
      patient_uid: admission.patient_uid,
      ai_generation_id: noteRows[0].ai_generation_id || null,
    })
  );

  await publishEvent({
    eventType: 'clinical_document.discharge_summary.signed',
    aggregateType: 'clinical_note',
    aggregateId: noteRows[0].id,
    patientUid: admission.patient_uid,
    payload: {
      admission_id: admissionId,
      signed_by: doctorUid,
      signed_at: rows[0].signed_at,
      ai_generation_id: noteRows[0].ai_generation_id || null,
    },
  });

  return {
    noteId: noteRows[0].id,
    signed: true,
    signedAt: rows[0].signed_at,
  };
}

export function getDischargeSummaryAiConfig() {
  return getClinicalAiConfig();
}

export default {
  generateDischargeSummary,
  saveDischargeSummary,
  signDischargeSummary,
  collectClinicalData,
  getDischargeSummaryAiConfig,
};
