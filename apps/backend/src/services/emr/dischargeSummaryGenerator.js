import crypto from 'node:crypto';

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { generateClinicalText, getClinicalAiConfig } from '../ai/localLlmClient.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { collectAdmissionClinicalContext } from './clinicalTimelineService.js';

const PROMPT_VERSION = 'clinical-discharge-v1';

// Fallback tenant when the request doesn't carry one. clinical_ai_generations.tenant_id
// is NOT NULL in the schema, so we always need a value. Matches the historical
// raw-SQL fallback ('00000000-0000-4000-8000-000000000001').
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

// Common Prisma `select` shapes — keep these in one place so every read returns
// the same projection the pre-ORM raw SQL did.
const ADMISSION_LOOKUP_SELECT = {
  encounter_id: true,
  patient_uid: true,
  status: true,
};

const ADMISSION_FOR_SIGN_SELECT = {
  encounter_id: true,
  patient_uid: true,
};

const DISCHARGE_NOTE_SELECT = {
  id: true,
  is_signed: true,
};

const DISCHARGE_NOTE_FOR_SIGN_SELECT = {
  id: true,
  is_signed: true,
  ai_generation_id: true,
  content: true,
};

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
  const radiologyOrders = asArray(context.radiology_orders);
  const chronicMeds = asArray(context.chronic_medications);

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

  // Wave-4B-1 — pending radiology orders are a discharge-readiness blocker
  // (the prior gate only looked at `investigations`, missing ultrasound /
  // CT / MRI / X-ray orders). Finding:
  //   2026-05-10-inpatient-admission-discharge-pending-radiology-not-in-readiness
  const pendingRadiology = radiologyOrders.filter((row) => {
    const status = String(row.status || '').toLowerCase();
    return status && !['completed', 'cancelled', 'reported', 'signed_off'].includes(status);
  });
  if (pendingRadiology.length > 0) {
    flags.push({
      severity: 'high',
      code: 'PENDING_RADIOLOGY',
      message: `${pendingRadiology.length} pending radiology order(s): ${pendingRadiology
        .map((r) => `${r.modality || 'radiology'} ${r.body_part || ''} [${r.status}]`.trim())
        .slice(0, 3)
        .join('; ')}${pendingRadiology.length > 3 ? '; …' : ''}.`,
    });
  }

  // Wave-4B-1 — chronic medication reconciliation. Any chronic med the
  // patient was on pre-admission that isn't present in the discharge med
  // list AND isn't explicitly reconciled (continue / stop / hold / restart)
  // is a polypharmacy safety risk. Finding:
  //   2026-05-10-inpatient-admission-discharge-drug-reconciliation-drops-chronic-meds
  if (chronicMeds.length > 0) {
    const dischargeMedNames = new Set(
      meds.map((m) => text(m.name || m.medication_name).toLowerCase()).filter(Boolean),
    );
    const unreconciled = chronicMeds.filter((cm) => {
      const cmName = text(cm.name || cm.medication_name).toLowerCase();
      if (!cmName) return false;
      // Explicit reconciliation marker (set when the doctor reviewed it).
      if (cm.reconciled_at_discharge || cm.reconciliation_status) return false;
      // Fuzzy match against discharge meds — chronic Atorvastatin is OK
      // if discharge meds include "Atorvastatin 10mg".
      return !Array.from(dischargeMedNames).some((dn) => dn.includes(cmName) || cmName.includes(dn));
    });
    if (unreconciled.length > 0) {
      flags.push({
        severity: 'high',
        code: 'CHRONIC_MED_NOT_RECONCILED',
        message: `${unreconciled.length} chronic medication(s) not reconciled: ${unreconciled
          .map((m) => m.name || m.medication_name)
          .slice(0, 5)
          .join(', ')}${unreconciled.length > 5 ? ', …' : ''}. Mark continue / stop / hold / restart before discharge.`,
        chronic_unreconciled: unreconciled,
      });
    }
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

// Order statuses that mean the medication is no longer active and must
// not be carried onto the take-home list. `discontinued`/`cancelled`
// are the orderEntryService lifecycle terminals; `stopped`/`held`/
// `on_hold`/`suspended` cover the free-text VARCHAR status values older
// rows / step-down notes use (a stopped IV must not reappear as a
// take-home drug); `completed` is a finished inpatient course, not a
// take-home med. Finding 2026-05-22-inpatient-admission-discharge-edb7c8ff.
const INACTIVE_ORDER_STATUS_RE =
  /cancelled|canceled|discontinued|stopped|\bheld\b|on[\s_-]?hold|suspended|completed/i;

// Parenteral / inpatient-only administration routes. An IV fluid, IV
// push, infusion, or IM/SC injection is administered on the ward — it
// is never a "continue at home" tablet. We still surface these for the
// doctor's reconciliation, but as `pending_review` (NOT `continue`) so
// the patient/relative is never told to keep taking IV saline. Finding
// 2026-05-22-inpatient-admission-discharge-edb7c8ff.
const PARENTERAL_ROUTE_RE =
  /\b(iv|i\.v\.?|intravenous|infusion|drip|im|i\.m\.?|intramuscular|sc|s\.c\.?|subcut|subcutaneous|epidural|intrathecal)\b/i;

function isParenteralMed({ route, name }) {
  if (PARENTERAL_ROUTE_RE.test(text(route))) return true;
  // Route is often blank on free-text orders — fall back to the name,
  // which commonly carries the form ("Normal Saline IV", "... infusion").
  return PARENTERAL_ROUTE_RE.test(text(name));
}

function buildDischargeMedications(context) {
  const activeMedicationOrders = context.orders
    .filter((event) => event.payload?.order_type === 'medication')
    .filter((event) => !INACTIVE_ORDER_STATUS_RE.test(text(event.payload?.status)));

  // De-duplicate the same drug ordered more than once during the stay
  // (e.g. ORS re-ordered on two days) so the take-home list doesn't list
  // it twice. Key on normalised name+route+dose. Finding
  // 2026-05-22-inpatient-admission-discharge-edb7c8ff (duplicate ORS from
  // source_order_id 59 and 60).
  const seenInpatient = new Set();
  const inpatientMeds = activeMedicationOrders.reduce((acc, event) => {
    const details = event.payload?.details || {};
    const name = details.medication_name || details.name || 'Medication not named';
    const dose = details.dose || details.dosage || '';
    const route = details.route || '';
    const dedupeKey = [name, route, dose]
      .map((v) => text(v).toLowerCase())
      .join('|');
    if (seenInpatient.has(dedupeKey)) return acc;
    seenInpatient.add(dedupeKey);

    // Parenteral inpatient drugs are not take-home meds — surface for
    // review but never auto-mark `continue`.
    const parenteral = isParenteralMed({ route, name });
    acc.push({
      name,
      dose,
      route,
      frequency: details.frequency || '',
      duration: details.duration || '',
      source_order_id: event.id,
      source: 'inpatient',
      reconciliation_status: parenteral ? 'pending_review' : 'continue',
      ...(parenteral
        ? { requires_review_reason: 'parenteral_inpatient_route_not_take_home' }
        : {}),
    });
    return acc;
  }, []);

  // Wave-4B-1 — merge in pre-admission chronic medications so the discharge
  // medication draft surfaces them for explicit continue / stop / hold /
  // restart review by the signing doctor. Chronic entries that the doctor
  // already reconciled (`reconciled_at_discharge: true` or a non-null
  // `reconciliation_status`) carry the status forward; un-reconciled ones
  // get `reconciliation_status: 'pending_review'` so the buildSafetyFlags
  // pass can emit CHRONIC_MED_NOT_RECONCILED. Finding:
  //   2026-05-10-inpatient-admission-discharge-drug-reconciliation-drops-chronic-meds
  const chronicMeds = asArray(context.chronic_medications);
  const inpatientNames = new Set(
    inpatientMeds.map((m) => text(m.name).toLowerCase()).filter(Boolean),
  );
  const chronicAsDischargeMeds = chronicMeds.map((cm) => {
    const cmName = cm.name || cm.medication_name || '';
    const alreadyOnList = Array.from(inpatientNames).some(
      (nm) => nm.includes(cmName.toLowerCase()) || cmName.toLowerCase().includes(nm),
    );
    return {
      name: cmName || 'Chronic medication (unnamed)',
      dose: cm.dose || cm.dosage || '',
      route: cm.route || '',
      frequency: cm.frequency || '',
      duration: cm.duration || 'chronic',
      indication: cm.indication || '',
      started_at: cm.started_at || null,
      source: 'pre_admission_chronic',
      reconciliation_status: cm.reconciliation_status
        || (cm.reconciled_at_discharge ? 'continue' : alreadyOnList ? 'continue' : 'pending_review'),
    };
  });

  return [...inpatientMeds, ...chronicAsDischargeMeds];
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
      module_key: aiResult.moduleKey,
      used_ai: aiResult.usedAi,
      prompt_tokens: aiResult.usage?.prompt_tokens || 0,
      completion_tokens: aiResult.usage?.completion_tokens || 0,
      total_tokens: aiResult.usage?.total_tokens || 0,
      estimated_cost_minor: aiResult.estimatedCostMinor || null,
      latency_ms: aiResult.usage?.latency_ms || null,
      provider_request_id: aiResult.usage?.provider_request_id || null,
      finish_reason: aiResult.usage?.finish_reason || null,
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

async function saveAiGeneration(context, summary, requestedBy, sourceHash, tenantId = null) {
  const metadata = {
    fallback_reason: summary.ai_metadata.fallback_reason,
    usage: {
      prompt_tokens: summary.ai_metadata.prompt_tokens || 0,
      completion_tokens: summary.ai_metadata.completion_tokens || 0,
      total_tokens: summary.ai_metadata.total_tokens || 0,
    },
  };

  return prisma.clinical_ai_generations.create({
    data: {
      tenant_id: tenantId || DEFAULT_TENANT_ID,
      patient_uid: context.admission.patient_uid,
      admission_id: context.admission.id,
      task_type: 'discharge_summary',
      module_key: summary.ai_metadata.module_key || 'discharge_summary',
      provider: summary.ai_metadata.provider,
      model: summary.ai_metadata.model,
      prompt_version: PROMPT_VERSION,
      source_hash: sourceHash,
      status: 'draft',
      used_ai: summary.ai_metadata.used_ai,
      safety_flags: summary.safety_flags || [],
      citations: summary.source_citations || [],
      draft: summary,
      generated_by: requestedBy || null,
      prompt_tokens: summary.ai_metadata.prompt_tokens || 0,
      completion_tokens: summary.ai_metadata.completion_tokens || 0,
      total_tokens: summary.ai_metadata.total_tokens || 0,
      estimated_cost_minor: summary.ai_metadata.estimated_cost_minor || null,
      latency_ms: summary.ai_metadata.latency_ms || null,
      provider_request_id: summary.ai_metadata.provider_request_id || null,
      finish_reason: summary.ai_metadata.finish_reason || null,
      metadata,
    },
    select: {
      id: true,
      provider: true,
      model: true,
      used_ai: true,
      status: true,
      created_at: true,
    },
  });
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
  const generation = await saveAiGeneration(context, summary, requestedBy, sourceHash, req?.tenantId || null);
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

export async function saveDischargeSummary(admissionId, summary, savedBy, savedByRole) {
  if (!savedBy) throw AppError.badRequest('savedBy is required');
  if (!savedByRole) throw AppError.badRequest('savedByRole is required');
  if (!summary || typeof summary !== 'object') throw AppError.badRequest('summary is required');

  const admission = await prisma.admissions.findUnique({
    where: { id: admissionId },
    select: ADMISSION_LOOKUP_SELECT,
  });
  if (!admission) throw AppError.notFound('Admission not found');

  const content = {
    ...summary,
    is_draft: true,
    is_signed: false,
    reviewed_by: savedBy,
    reviewed_at: new Date().toISOString(),
  };

  // Match the pre-ORM ORDER BY version DESC, id DESC LIMIT 1.
  const existing = await prisma.clinical_notes.findFirst({
    where: {
      encounter_id: admission.encounter_id,
      note_type: 'discharge',
      is_addendum: false,
    },
    select: DISCHARGE_NOTE_SELECT,
    orderBy: [{ version: 'desc' }, { id: 'desc' }],
  });

  let result;
  if (existing) {
    if (existing.is_signed) {
      throw AppError.badRequest('Signed discharge summary cannot be modified. Add an addendum instead.');
    }

    const updated = await prisma.clinical_notes.update({
      where: { id: existing.id },
      data: {
        content,
        version: { increment: 1 },
        ai_generation_id: content.draft_generation_id || null,
        updated_at: new Date(),
      },
      select: { id: true },
    });
    result = { noteId: updated.id, action: 'updated' };
  } else {
    const created = await prisma.clinical_notes.create({
      data: {
        encounter_id: admission.encounter_id,
        patient_uid: admission.patient_uid,
        author_uid: savedBy,
        author_role: savedByRole,
        note_type: 'discharge',
        title: 'Draft discharge summary',
        content,
        version: 1,
        is_addendum: false,
        is_signed: false,
        ai_generation_id: content.draft_generation_id || null,
      },
      select: { id: true },
    });
    result = { noteId: created.id, action: 'created' };
  }

  if (content.draft_generation_id) {
    await prisma.clinical_ai_generations.update({
      where: { id: content.draft_generation_id },
      data: {
        draft: content,
        reviewed_by: savedBy,
        status: 'reviewed',
        updated_at: new Date(),
      },
    });
  }

  // Denormalize first-edit timestamp on the admission (T1) — only stamp
  // if not already set. Lets efficiency dashboards compute T1−T0 without
  // joining clinical_notes. Migration 173. Best-effort.
  try {
    await prisma.admissions.updateMany({
      where: { id: admissionId, summary_first_edit_at: null },
      data: { summary_first_edit_at: new Date(), updated_at: new Date() },
    });
  } catch (e) {
    logger.warn(`saveDischargeSummary: failed to denormalize summary_first_edit_at on admission ${admissionId}: ${e.message}`);
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

  const admission = await prisma.admissions.findUnique({
    where: { id: admissionId },
    select: ADMISSION_FOR_SIGN_SELECT,
  });
  if (!admission) throw AppError.notFound('Admission not found');

  // The read of `note` (for the jsonb_set replacement) and the write that
  // flips `is_signed` happen in one transaction. The write itself is
  // conditioned on `is_signed: false` via updateMany — if a concurrent
  // signer flipped the flag between our SELECT and UPDATE, count comes
  // back 0 and we surface a 400 instead of silently double-signing.
  // Single shared timestamp so the column value matches the JSON value
  // the original `to_jsonb(NOW())` produced.
  const signedAt = new Date();

  const txnResult = await prisma.$transaction(async (tx) => {
    const note = await tx.clinical_notes.findFirst({
      where: {
        encounter_id: admission.encounter_id,
        note_type: 'discharge',
        is_addendum: false,
      },
      select: DISCHARGE_NOTE_FOR_SIGN_SELECT,
      orderBy: [{ version: 'desc' }, { id: 'desc' }],
    });
    if (!note) throw AppError.notFound('No discharge summary found. Generate one first.');
    if (note.is_signed) throw AppError.badRequest('Discharge summary is already signed');

    // content may be null on pathological rows; default to {} so we don't NPE.
    const baseContent = (note.content && typeof note.content === 'object' && !Array.isArray(note.content))
      ? note.content
      : {};
    const updatedContent = {
      ...baseContent,
      is_signed: true,
      signed_at: signedAt.toISOString(),
    };

    const flip = await tx.clinical_notes.updateMany({
      where: { id: note.id, is_signed: false },
      data: {
        is_signed: true,
        signed_at: signedAt,
        signed_by: doctorUid,
        updated_at: signedAt,
        content: updatedContent,
      },
    });
    if (flip.count === 0) {
      // Lost the race — another signer flipped is_signed between our
      // SELECT and UPDATE. Reject with a 400 (the signed copy stands).
      throw AppError.badRequest('Discharge summary is already signed');
    }

    if (note.ai_generation_id) {
      await tx.clinical_ai_generations.update({
        where: { id: note.ai_generation_id },
        data: {
          status: 'signed',
          reviewed_by: doctorUid,
          signed_note_id: note.id,
          updated_at: signedAt,
        },
      });
    }

    // Denormalize the sign timestamp onto the admission row so
    // discharge-cascade readiness checks (D2) and efficiency dashboards
    // (T0→T2) can read it without a clinical_notes join. Migration 173.
    // Best-effort — admission row may not exist in legacy/test data.
    try {
      await tx.admissions.update({
        where: { id: admissionId },
        data: { summary_signed_at: signedAt, updated_at: signedAt },
      });
    } catch (e) {
      logger.warn(`signDischargeSummary: failed to denormalize summary_signed_at on admission ${admissionId}: ${e.message}`);
    }

    await tx.audit_logs.create({
      data: {
        uid: doctorUid,
        action: 'SIGN_DISCHARGE_SUMMARY',
        resource: 'clinical_notes',
        resource_id: String(note.id),
        metadata: {
          admission_id: admissionId,
          patient_uid: admission.patient_uid,
          ai_generation_id: note.ai_generation_id || null,
        },
      },
    });

    return { noteId: note.id, aiGenerationId: note.ai_generation_id || null };
  });

  await publishEvent({
    eventType: 'clinical_document.discharge_summary.signed',
    aggregateType: 'clinical_note',
    aggregateId: txnResult.noteId,
    patientUid: admission.patient_uid,
    payload: {
      admission_id: admissionId,
      signed_by: doctorUid,
      signed_at: signedAt,
      ai_generation_id: txnResult.aiGenerationId,
    },
  });

  // Materialise take-home medicines from the signed discharge note into
  // e_prescriptions so the patient app's Rx tab surfaces them. The
  // clinical_notes path stores the discharge summary as a structured
  // JSON object on `content` — medications_on_discharge is an array of
  // { name, dose, frequency, duration, instructions, ... } entries (see
  // buildDischargeMedications). The sibling Sprint-11 dischargeService
  // path does the same materialisation against discharge_summary_sections
  // free-text bodies. Best-effort: signing must not fail if no
  // medications are present.
  // Finding 2026-05-10-inpatient-admission-patient-takeaway-meds-missing.
  await materialiseDischargeMedsFromClinicalNote({
    note_id: txnResult.noteId,
    admission_id: admissionId,
    patient_uid: admission.patient_uid,
    doctor_uid: doctorUid,
  });

  return {
    noteId: txnResult.noteId,
    signed: true,
    signedAt: signedAt,
  };
}

async function materialiseDischargeMedsFromClinicalNote({
  note_id, admission_id, patient_uid, doctor_uid,
}) {
  if (!patient_uid) return;
  try {
    const noteRows = await prisma.clinical_notes.findUnique({
      where: { id: Number(note_id) },
      select: { content: true },
    });
    const content = noteRows?.content;
    const meds = (content && typeof content === 'object' && !Array.isArray(content))
      ? asArray(content.medications_on_discharge)
      : [];
    if (!meds.length) return;

    // Idempotency probe — re-signing or backfilling should not create
    // duplicate Rx rows. Stamp a discharge marker in clinical_notes so
    // we can detect a prior insert via LIKE.
    const marker = `[discharge_clinical_note_id=${note_id}]`;
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM e_prescriptions
        WHERE patient_uid = $1::uuid
          AND clinical_notes LIKE $2
        LIMIT 1`,
      String(patient_uid), `%${marker}%`,
    );
    if (existing.length) return;

    // Resolve int ids for the FK columns. The patient must exist; the
    // doctor may not (legacy / name-only signers).
    const [patientRow, doctorRow] = await Promise.all([
      prisma.users.findUnique({
        where: { uid: String(patient_uid) },
        select: { id: true },
      }),
      doctor_uid
        ? prisma.users.findUnique({
            where: { uid: String(doctor_uid) },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    const patientId = patientRow?.id ?? null;
    const doctorId = doctorRow?.id ?? null;
    if (!patientId) {
      logger.warn(
        `materialiseDischargeMedsFromClinicalNote: no users row for patient_uid=${patient_uid}`,
      );
      return;
    }

    // Each entry is a structured medication record. Surface the array
    // verbatim into e_prescriptions.medications so the Rx tab card
    // renders the same fields the discharge note carried.
    const medications = meds.map((m) => {
      if (typeof m !== 'object' || m === null) {
        return { name: String(m), source: 'discharge_summary' };
      }
      return { ...m, source: 'discharge_summary' };
    });

    const clinicalNotesText =
      `Take-home medicines from discharge summary. ${marker}\n\n` +
      medications.map((m) => {
        const parts = [
          m.name,
          m.dose ? `(${m.dose})` : null,
          m.frequency || null,
          m.duration ? `× ${m.duration}` : null,
          m.instructions || null,
        ].filter(Boolean);
        return `• ${parts.join(' ')}`.trim();
      }).join('\n');

    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions
         (appointment_id, patient_id, doctor_id, patient_uid, doctor_uid,
          diagnosis, clinical_notes, medications, status)
       VALUES (NULL, $1::int, $2, $3::uuid, $4,
               NULL, $5, $6::jsonb, 'active')`,
      patientId,
      doctorId,
      String(patient_uid),
      doctor_uid ? String(doctor_uid) : null,
      clinicalNotesText,
      JSON.stringify(medications),
    );
  } catch (e) {
    logger.warn(
      `materialiseDischargeMedsFromClinicalNote failed for admission ${admission_id} note ${note_id}: ${e.message}`,
    );
  }
}

export function getDischargeSummaryAiConfig() {
  return getClinicalAiConfig();
}

// Implementation detail exposed only for unit tests — asserts the
// take-home medication reconciliation excludes inactive/parenteral
// inpatient drugs and de-duplicates repeat orders. Not part of the
// public API. Finding 2026-05-22-inpatient-admission-discharge-edb7c8ff.
export const __testing__ = {
  buildDischargeMedications,
  isParenteralMed,
  INACTIVE_ORDER_STATUS_RE,
  PARENTERAL_ROUTE_RE,
};

export default {
  generateDischargeSummary,
  saveDischargeSummary,
  signDischargeSummary,
  collectClinicalData,
  getDischargeSummaryAiConfig,
};
