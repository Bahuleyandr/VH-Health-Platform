// src/services/discharge/dischargeService.js
//
// Sprint 11 — discharge summary builder. The doctor picks a template
// (or auto-pick by specialty), the system materialises a draft with
// every section row pre-populated from the template's `default_body`
// when set, then the doctor edits + signs. Status walk:
//   draft → ready_for_signoff → signed → delivered

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

// Section keys we recognise as "discharge medications" for the
// materialise-to-e_prescriptions handoff. Templates use slightly
// different naming conventions across specialties; match all of them
// case-insensitively. Anything matching here triggers a synthesised
// e_prescriptions row on sign so the patient app's Rx tab finds it.
const DISCHARGE_MED_SECTION_KEYS = new Set([
  'discharge_medications',
  'medications_on_discharge',
  'takeaway_medications',
  'take_home_medications',
  'discharge_meds',
]);

const DIAGNOSIS_SECTION_KEYS = new Set([
  'diagnosis',
  'discharge_diagnosis',
  'primary_diagnosis',
]);

const INACTIVE_ORDER_STATUS_RE =
  /cancelled|canceled|discontinued|stopped|\bheld\b|on[\s_-]?hold|suspended|completed/i;
const PARENTERAL_ROUTE_RE =
  /\b(iv|i\.v\.?|intravenous|infusion|drip|im|i\.m\.?|intramuscular|sc|s\.c\.?|subcut|subcutaneous|epidural|intrathecal)\b/i;

function textValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  return String(value).trim();
}

function firstText(...values) {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return '';
}

function parseOrderDetails(details) {
  if (!details) return {};
  if (typeof details === 'object' && !Array.isArray(details)) return details;
  if (typeof details === 'string') {
    try {
      const parsed = JSON.parse(details);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { text: details };
    } catch {
      return { text: details };
    }
  }
  return {};
}

function isParenteralMedication({ name, route }) {
  return PARENTERAL_ROUTE_RE.test(textValue(route))
    || PARENTERAL_ROUTE_RE.test(textValue(name));
}

function formatTakeHomeMedicationLines(rows) {
  const seen = new Set();
  const lines = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (INACTIVE_ORDER_STATUS_RE.test(textValue(row?.status))) continue;
    const details = parseOrderDetails(row?.details);
    const name = firstText(
      details.medication_name,
      details.drug_name,
      details.name,
      details.medication,
      details.text,
      row?.detail,
    );
    if (!name) continue;
    const route = firstText(details.route, details.route_name, row?.route);
    if (isParenteralMedication({ name, route })) continue;
    const dose = firstText(details.dose, details.dosage, details.strength);
    const frequency = firstText(details.frequency, details.freq, details.dose_interval);
    const duration = firstText(details.duration, details.days);
    const dedupeKey = [name, dose, route, frequency]
      .map((part) => textValue(part).toLowerCase())
      .join('|');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const body = [name, dose, route, frequency, duration].filter(Boolean).join(' ');
    lines.push(`- ${body}`);
  }
  return lines;
}

// ── Sign-completeness gate ──────────────────────────────────────────
//
// A discharge summary is a medico-legal patient-safety document. The
// historical sign() flipped status to 'signed' with no completeness
// check, so a summary whose required clinical sections were blank or
// still carried template placeholder text could be signed and handed
// to the patient as final instructions. For a low-literacy patient or
// a relative reading on the patient's behalf, a blank "Discharge
// Medications" or a placeholder "Eye Drop Schedule" is actively
// dangerous. Findings:
//   2026-05-22-surgical-day-care-discharge-ae484c86 (day-care eye:
//     procedure / eye_operated / intraop_summary / discharge_medications
//     null + follow_up/red_flags placeholder text were signable)
//   2026-05-21-inpatient-admission-patient-8db55849.
//
// The gate is *template-driven and minimal*: only the high-safety
// clinical sections below are required, and a section is only enforced
// when the summary actually has it (so a template without a `procedure`
// section is never forced to grow one). Optional prose sections
// (diet_advice, family_history, personal_history, …) are deliberately
// NOT required — we don't block a sign-off on a blank diet tip.
//
// "Blank" = null / empty / whitespace-only body. "Placeholder" = a body
// still containing the '[PLACEHOLDER' marker that the template seeds
// (migration 230 day-care template, buildAutoSectionBodies, and
// TRANSLATION_PLACEHOLDER all use it) — an unedited draft, not a final
// clinical instruction.
const REQUIRED_SIGN_SECTION_KEYS = new Set([
  // Diagnosis / procedure block — what was wrong + what was done.
  'diagnosis',
  'discharge_diagnosis',
  'primary_diagnosis',
  'procedure',
  'procedure_performed',
  'procedures_performed',
  // Take-home medication block (all naming variants).
  ...DISCHARGE_MED_SECTION_KEYS,
]);

// Case-insensitive marker the templates/auto-population use to flag a
// section body as an unreviewed draft.
const PLACEHOLDER_MARKER = '[placeholder';

function isBlankBody(body) {
  return body == null || String(body).trim().length === 0;
}

function isPlaceholderBody(body) {
  return String(body || '').toLowerCase().includes(PLACEHOLDER_MARKER);
}

/**
 * Throw AppError.conflict if any required clinical section that exists
 * on this summary is blank or still placeholder text. Returns silently
 * when every required-and-present section has real clinician content.
 *
 * `sections` is the discharge_summary_sections rows for the summary
 * (section_key + body). The check is intentionally tolerant of which
 * required sections a given template declares — it only blocks on the
 * ones actually present, so each specialty template gates on its own
 * required fields without a per-template config.
 */
function assertSignable(sections) {
  const rows = Array.isArray(sections) ? sections : [];
  const blank = [];
  const placeholder = [];
  for (const s of rows) {
    const key = String(s?.section_key || '').toLowerCase();
    if (!REQUIRED_SIGN_SECTION_KEYS.has(key)) continue;
    if (isBlankBody(s?.body)) {
      blank.push(s.section_key);
    } else if (isPlaceholderBody(s?.body)) {
      placeholder.push(s.section_key);
    }
  }
  if (blank.length === 0 && placeholder.length === 0) return;

  const parts = [];
  if (blank.length) parts.push(`blank: ${blank.join(', ')}`);
  if (placeholder.length) {
    parts.push(`unreviewed placeholder text: ${placeholder.join(', ')}`);
  }
  throw AppError.conflict(
    `Discharge summary cannot be signed — required clinical section(s) are incomplete (${parts.join('; ')}). `
    + 'Fill in the procedure/diagnosis and discharge medications and replace any placeholder text before sign-off.',
    'DISCHARGE_SUMMARY_INCOMPLETE',
    { blank_sections: blank, placeholder_sections: placeholder },
  );
}

// ── Section auto-population ─────────────────────────────────────────
//
// Clinical sections we can fill from structured visit data at draft
// time, so the discharge officer edits instead of typing from scratch.
// Sections that need clinician-authored prose (chief_complaint, hpi,
// follow_up, diet_advice, condition_at_discharge, …) are deliberately
// NOT in this set — they keep the template default and we never
// fabricate clinical narrative.
// Finding: 2026-05-09-tpa-insurance-claim-discharge-summary-sections-not-auto-populated
const AUTO_SECTION_KEYS = new Set([
  'course_in_hospital',
  'treatment_given',
  'investigations',
  'past_history',
  ...DIAGNOSIS_SECTION_KEYS,
]);

const AUTO_BANNER =
  '[Auto-populated from visit data — review and edit before sign-off]';

function isAutoPopulatableKey(key) {
  const k = String(key || '').toLowerCase();
  return AUTO_SECTION_KEYS.has(k) || DISCHARGE_MED_SECTION_KEYS.has(k);
}

async function appendDischargeAudit({
  tenantId,
  id,
  action,
  actorUid = null,
  metadata = {},
  db = prisma,
}) {
  await db.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (uid, action, resource, resource_id, metadata, ip_address)
     VALUES ($1::uuid, $2, 'discharge_summary', $3, $4::jsonb, NULL)`,
    actorUid ? String(actorUid) : null,
    action,
    String(id),
    JSON.stringify({ tenant_id: tenantId, ...metadata }),
  );
}

// Canonical clinical timeline invariant (docs/CANONICAL_CLINICAL_TIMELINE.md):
// a discharge summary is a medico-legal, patient-facing clinical artifact, so
// each lifecycle transition (ready_for_signoff / signed / delivered) must emit
// one clinical_timeline_events row + one clinical_audit_events row in the SAME
// transaction as the status flip — previously these wrote only the legacy
// audit_logs row, leaving the canonical patient timeline blind to the document.
// Runs on the transaction client (`db`) and is NOT swallowed: a failure aborts
// the transaction so the status change rolls back rather than leaving the
// timeline/audit layer out of sync. recordCanonicalClinicalEvent still tolerates
// a genuinely-absent canonical table (SQLSTATE 42P01) internally.
async function emitDischargeCanonicalEvent({
  db, tenantId, id, patientUid, admissionId = null,
  eventType, eventStatus, actorUid = null, summary, payload = {},
  previousStatus = null,
}) {
  if (!patientUid) return null;
  return recordCanonicalClinicalEvent({
    tenantId: tenantId || DEFAULT_TENANT_ID,
    patientUid,
    eventType,
    eventStatus,
    sourceTable: 'discharge_summaries',
    sourceId: String(id),
    resourceType: 'discharge_summary',
    resourceId: String(id),
    actorUid,
    actorRole: 'DISCHARGE',
    summary,
    payload: {
      discharge_summary_id: Number(id),
      admission_id: admissionId,
      status: eventStatus,
      previous_status: previousStatus,
      ...payload,
    },
    beforeState: previousStatus ? { status: previousStatus } : null,
    afterState: { status: eventStatus },
    tags: ['discharge_summary'],
    timelineIdempotencyKey: `discharge_summaries:${id}:${eventType}:${eventStatus}`,
    auditIdempotencyKey: `discharge_summaries:${id}:audit:${eventType}:${eventStatus}`,
  }, { db });
}

/**
 * Build bodies for the auto-populatable discharge-summary sections from
 * structured visit data — progress notes + clinical orders (scoped to
 * the admission encounter), lab results (patient + admission window),
 * and the patient's structured chronic-medication list. Returns a map
 * keyed by lower-cased section_key; only keys with real data appear, so
 * the caller falls back to the template default for everything else.
 *
 * Best-effort: any failure logs and yields an empty map — a discharge
 * draft must still be creatable when the EMR side has nothing yet.
 */
async function buildAutoSectionBodies({
  admission_id, patient_uid, admitted_at, discharged_at, neededKeys,
  primary_diagnosis, secondary_diagnoses,
}) {
  try {
    // clinical_notes / clinical_orders scope precisely by encounter_id
    // (uuid); lab_results + the chronic-med list scope by patient_uid
    // (labs additionally bounded by the admission window).
    let encounterId = null;
    let winStart = admitted_at || null;
    let winEnd = discharged_at || null;
    let diagnosisText = textValue(primary_diagnosis);
    if (admission_id) {
      const aRows = await prisma.$queryRawUnsafe(
        `SELECT encounter_id, admitted_at, discharged_at, admitting_diagnosis
           FROM admissions WHERE id = $1::int LIMIT 1`,
        Number(admission_id),
      );
      if (aRows.length) {
        encounterId = aRows[0].encounter_id || null;
        winStart = winStart || aRows[0].admitted_at;
        winEnd = winEnd || aRows[0].discharged_at;
        diagnosisText = diagnosisText || textValue(aRows[0].admitting_diagnosis);
      }
    }
    const windowEnd = winEnd || new Date().toISOString();

    const out = {};

    const diagnosisKey = [...neededKeys].find((k) => DIAGNOSIS_SECTION_KEYS.has(k));
    if (diagnosisKey) {
      const lines = [];
      if (diagnosisText) lines.push(`Primary diagnosis: ${diagnosisText}`);
      const secondary = Array.isArray(secondary_diagnoses) ? secondary_diagnoses : [];
      for (const dx of secondary.map((d) => textValue(d)).filter(Boolean)) {
        lines.push(`Secondary diagnosis: ${dx}`);
      }
      if (lines.length) {
        out[diagnosisKey] = `${AUTO_BANNER}\n\n${lines.join('\n')}`;
      }
    }

    // No encounter id and no lower window bound → nothing safe to scope
    // to beyond header-derived diagnosis. Leave all other sections on
    // their template default rather than pulling unbounded patient history.
    if (!encounterId && !winStart) return out;

    // course_in_hospital ← progress notes for the encounter.
    if (neededKeys.has('course_in_hospital') && encounterId) {
      const notes = await prisma.$queryRawUnsafe(
        `SELECT created_at,
                COALESCE(title, type, note_type) AS heading,
                COALESCE(notes, content->>'text', content->>'summary',
                         content->>'body') AS body_text
           FROM clinical_notes
          WHERE encounter_id = $1::uuid
            AND (LOWER(COALESCE(note_type, '')) LIKE '%progress%'
                 OR LOWER(COALESCE(type, '')) LIKE '%progress%')
          ORDER BY created_at ASC`,
        String(encounterId),
      );
      const usable = notes.filter((n) => n.body_text && String(n.body_text).trim());
      if (usable.length) {
        out.course_in_hospital = `${AUTO_BANNER}\n\n` + usable.map((n) => {
          const d = n.created_at
            ? new Date(n.created_at).toISOString().slice(0, 10) : '';
          return `${d} — ${n.heading || 'Progress note'}\n${String(n.body_text).trim()}`;
        }).join('\n\n');
      }
    }

    // treatment_given ← clinical orders raised during the encounter.
    if (neededKeys.has('treatment_given') && encounterId) {
      const orders = await prisma.$queryRawUnsafe(
        `SELECT order_type, status, created_at,
                COALESCE(notes, details->>'name', details->>'text',
                         details->>'summary') AS detail
           FROM clinical_orders
          WHERE encounter_id = $1::uuid
          ORDER BY created_at ASC`,
        String(encounterId),
      );
      if (orders.length) {
        out.treatment_given = `${AUTO_BANNER}\n\n` + orders.map((o) => {
          const bits = [o.order_type, o.detail, o.status ? `(${o.status})` : null]
            .filter(Boolean);
          return `- ${bits.join(' — ')}`;
        }).join('\n');
      }
    }

    // investigations ← lab results in the admission window.
    if (neededKeys.has('investigations') && patient_uid && winStart) {
      const labs = await prisma.$queryRawUnsafe(
        `SELECT test_name,
                COALESCE(value_text, value_numeric::text) AS value,
                unit, abnormal_flag, performed_at
           FROM lab_results
          WHERE patient_uid = $1::uuid
            AND COALESCE(performed_at, received_at, created_at)
                BETWEEN $2::timestamptz AND $3::timestamptz
          ORDER BY performed_at ASC NULLS LAST, id ASC`,
        String(patient_uid), winStart, windowEnd,
      );
      if (labs.length) {
        out.investigations = `${AUTO_BANNER}\n\n` + labs.map((l) => {
          const val = [l.value, l.unit].filter(Boolean).join(' ');
          const flag = l.abnormal_flag && l.abnormal_flag !== 'N'
            ? ` [${l.abnormal_flag}]` : '';
          return `- ${l.test_name}: ${val || '—'}${flag}`;
        }).join('\n');
      }
    }

    // discharge_medications ← active, non-parenteral medication orders
    // from the admission encounter. IV/IM/infusion rows are inpatient
    // administration, not take-home instructions, so they stay out of the
    // patient-facing section.
    const needsPastHx = neededKeys.has('past_history');
    const medKey = [...neededKeys].find((k) => DISCHARGE_MED_SECTION_KEYS.has(k));
    let activeTakeHomeLines = [];
    let chronicTakeHomeLines = [];
    if (medKey && encounterId) {
      const medicationOrders = await prisma.$queryRawUnsafe(
        `SELECT id, status, route, details,
                COALESCE(notes, details->>'medication_name', details->>'drug_name',
                         details->>'name', details->>'text') AS detail
           FROM clinical_orders
          WHERE encounter_id = $1::uuid
            AND LOWER(COALESCE(order_type, '')) = 'medication'
          ORDER BY created_at ASC, id ASC`,
        String(encounterId),
      );
      activeTakeHomeLines = formatTakeHomeMedicationLines(medicationOrders);
    }

    // past_history + chronic-medication part of discharge_medications ←
    // the patient's structured chronic-medication list.
    if ((needsPastHx || medKey) && patient_uid) {
      const uRows = await prisma.$queryRawUnsafe(
        `SELECT chronic_medications FROM users WHERE uid = $1::uuid LIMIT 1`,
        String(patient_uid),
      );
      const chronic = Array.isArray(uRows[0]?.chronic_medications)
        ? uRows[0].chronic_medications
        : [];
      if (needsPastHx && chronic.length) {
        const indications = [...new Set(
          chronic.map((m) => m && (m.indication || m.condition))
            .filter(Boolean).map((s) => String(s).trim()),
        )];
        if (indications.length) {
          out.past_history = `${AUTO_BANNER}\n\n`
            + 'Known conditions (from chronic medication list):\n'
            + indications.map((i) => `- ${i}`).join('\n')
            + '\n\n[PLACEHOLDER — clinician to add surgical / non-pharmacological history]';
        }
      }
      if (medKey && chronic.length) {
        const lines = chronic.map((m) => {
          if (!m) return null;
          const bits = [m.name, m.dose, m.frequency].filter(Boolean);
          return bits.length ? `- ${bits.join(' ')} (continue)` : null;
        }).filter(Boolean);
        if (lines.length) {
          chronicTakeHomeLines = lines;
        }
      }
    }
    if (medKey && (activeTakeHomeLines.length || chronicTakeHomeLines.length)) {
      const medSections = [];
      if (activeTakeHomeLines.length) {
        medSections.push(
          'Take-home medications from active orders:\n' + activeTakeHomeLines.join('\n'),
        );
      }
      if (chronicTakeHomeLines.length) {
        medSections.push(
          'Chronic medications to continue (reconcile against takeaway script):\n'
          + chronicTakeHomeLines.join('\n')
          + '\n\n[PLACEHOLDER — clinician to confirm takeaway medications, doses, and duration before sign-off]',
        );
      }
      out[medKey] = `${AUTO_BANNER}\n\n`
        + medSections.join('\n\n');
    }

    return out;
  } catch (e) {
    logger.warn(`buildAutoSectionBodies failed: ${e.message}`);
    return {};
  }
}

// ── Templates ───────────────────────────────────────────────────────

export async function listTemplates({ tenantId, specialty }) {
  const params = [tenantId];
  const where = [`tenant_id = $1::uuid`, `active = true`];
  if (specialty) {
    params.push(specialty);
    where.push(`(specialty = $${params.length} OR specialty IS NULL)`);
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, code, display_name, specialty, sections, active
       FROM discharge_summary_templates
      WHERE ${where.join(' AND ')}
      ORDER BY specialty NULLS LAST, display_name`,
    ...params,
  );
}

async function pickTemplate({ tenantId, template_code, specialty }) {
  if (template_code) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM discharge_summary_templates
        WHERE tenant_id = $1::uuid AND code = $2 AND active = true`,
      tenantId, template_code,
    );
    if (rows.length) return rows[0];
  }
  if (specialty) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM discharge_summary_templates
        WHERE tenant_id = $1::uuid AND specialty = $2 AND active = true
        ORDER BY id LIMIT 1`,
      tenantId, specialty,
    );
    if (rows.length) return rows[0];
  }
  // Fallback to general medicine.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM discharge_summary_templates
      WHERE tenant_id = $1::uuid AND specialty = 'general_medicine' AND active = true
      ORDER BY id LIMIT 1`,
    tenantId,
  );
  if (!rows.length) {
    throw AppError.badRequest(
      'No discharge summary template available. Configure one in admin first.',
    );
  }
  return rows[0];
}

// ── Discharge summary CRUD ──────────────────────────────────────────

export async function createDraft({
  tenantId, admission_id, patient_uid,
  patient_name, age_years, sex,
  patient_name_snapshot, age_years_snapshot, sex_snapshot,
  hospital_number, admitted_at, discharged_at, ward_at_discharge,
  primary_diagnosis, secondary_diagnoses, icd10_codes, procedures_performed,
  template_code, specialty, created_by,
}) {
  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  const template = await pickTemplate({ tenantId, template_code, specialty });

  // Accept both naming styles: callers may send the bare field
  // (`patient_name`) or the explicit snapshot column name
  // (`patient_name_snapshot`). Whichever is present wins; if neither
  // is supplied, the INSERT's COALESCE backfills from the users row.
  // A discharge summary is a medico-legal document — patient name,
  // age, and sex are mandatory header fields and must never be NULL.
  // Finding:
  //   2026-05-09-inpatient-admission-discharge-summary-patient-fields-dropped
  const headerRows = await prisma.$queryRawUnsafe(
    `INSERT INTO discharge_summaries
       (admission_id, patient_uid, patient_name_snapshot, age_years_snapshot,
        sex_snapshot, hospital_number, admitted_at, discharged_at,
        ward_at_discharge, primary_diagnosis, secondary_diagnoses,
        icd10_codes, procedures_performed, status, created_by, tenant_id)
     VALUES ($1::int, $2::uuid,
             COALESCE($3, (SELECT u.name FROM users u WHERE u.uid = $2::uuid LIMIT 1)),
             COALESCE($4::int,
               (SELECT (EXTRACT(YEAR FROM AGE(u.birthday)))::int
                  FROM users u WHERE u.uid = $2::uuid AND u.birthday IS NOT NULL LIMIT 1)),
             COALESCE($5, (SELECT u.gender FROM users u WHERE u.uid = $2::uuid LIMIT 1)),
             $6, $7::timestamptz,
             $8::timestamptz, $9, $10, $11::text[], $12::text[], $13::text[],
             'draft', $14::uuid, $15::uuid)
     RETURNING *`,
    admission_id ? Number(admission_id) : null,
    String(patient_uid),
    patient_name_snapshot ?? patient_name ?? null,
    (age_years_snapshot ?? age_years) != null
      ? Number(age_years_snapshot ?? age_years)
      : null,
    sex_snapshot ?? sex ?? null,
    hospital_number || null,
    admitted_at || null,
    discharged_at || null,
    ward_at_discharge || null,
    primary_diagnosis || null,
    secondary_diagnoses || null,
    icd10_codes || null,
    procedures_performed || null,
    created_by ? String(created_by) : null,
    tenantId,
  );
  const summary = headerRows[0];

  // Materialise sections from the template, auto-filling the clinical
  // sections that have structured visit data behind them. Sections that
  // need clinician-authored prose keep the template default — we never
  // fabricate clinical narrative. Auto-population only runs when the
  // template actually declares an auto-populatable section, so a
  // section-less template stays a zero-extra-query path.
  // Finding: 2026-05-09-tpa-insurance-claim-discharge-summary-sections-not-auto-populated
  const sections = Array.isArray(template.sections) ? template.sections : [];
  const neededKeys = new Set(
    sections
      .map((s) => String(s?.section_key || '').toLowerCase())
      .filter((k) => isAutoPopulatableKey(k)),
  );
  let autoBodies = {};
  if (neededKeys.size > 0) {
    autoBodies = await buildAutoSectionBodies({
      admission_id, patient_uid, admitted_at, discharged_at, neededKeys,
      primary_diagnosis, secondary_diagnoses,
    });
  }
  for (const s of sections) {
    if (!s?.section_key || !s?.section_title) continue;
    const autoBody = autoBodies[String(s.section_key).toLowerCase()];
    const body = autoBody != null
      ? autoBody
      : (s.default_body ? String(s.default_body) : null);
    await prisma.$executeRawUnsafe(
      `INSERT INTO discharge_summary_sections
         (discharge_summary_id, section_key, section_title, display_order, body)
       VALUES ($1::int, $2, $3, $4::int, $5)`,
      summary.id,
      String(s.section_key),
      String(s.section_title),
      Number(s.display_order ?? 0),
      body,
    );
  }

  return getOne({ tenantId, id: summary.id });
}

export async function getOne({ tenantId, id }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM discharge_summaries WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Discharge summary not found');
  const sections = await prisma.$queryRawUnsafe(
    `SELECT id, section_key, section_title, display_order, body,
            body_translations, edited_by, edited_at
       FROM discharge_summary_sections
      WHERE discharge_summary_id = $1::int
      ORDER BY display_order, id`,
    rows[0].id,
  );
  return { ...rows[0], sections };
}

export async function updateSection({
  tenantId, id, section_key, body, edited_by,
}) {
  // Verify ownership before edit (prevents cross-tenant tampering).
  const owner = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM discharge_summaries
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!owner.length) throw AppError.notFound('Discharge summary not found');
  if (owner[0].status === 'signed' || owner[0].status === 'delivered') {
    throw AppError.badRequest(
      `Discharge summary is ${owner[0].status} — sections cannot be edited.`,
    );
  }
  const sectionRows = await prisma.$queryRawUnsafe(
    `SELECT id, section_key, section_title, body, edited_by, edited_at
       FROM discharge_summary_sections
      WHERE discharge_summary_id = $1::int AND section_key = $2
      LIMIT 1`,
    Number(id), String(section_key),
  );
  if (!sectionRows.length) {
    throw AppError.notFound(`Section ${section_key} not found on this summary`);
  }
  const before = sectionRows[0];
  await prisma.$executeRawUnsafe(
    `UPDATE discharge_summary_sections
        SET body = $1, edited_by = $2::uuid, edited_at = NOW()
      WHERE discharge_summary_id = $3::int AND section_key = $4`,
    body || null,
    edited_by ? String(edited_by) : null,
    Number(id), String(section_key),
  );
  // Bump parent updated_at to track edit recency.
  await prisma.$executeRawUnsafe(
    `UPDATE discharge_summaries SET updated_at = NOW() WHERE id = $1::int`,
    Number(id),
  );
  await appendDischargeAudit({
    tenantId,
    id,
    action: 'DISCHARGE_SUMMARY_SECTION_EDIT',
    actorUid: edited_by,
    metadata: {
      section_key: String(section_key),
      section_title: before.section_title || null,
      previous_body: before.body || null,
      new_body: body || null,
    },
  });
  return getOne({ tenantId, id });
}

// ── Language-tagged discharge summary (translation mechanism) ────────
//
// The discharge summary is authored in English. For a Tamil-speaking
// (often illiterate) patient an English printout is functionally no
// discharge instruction at all. This builds the *mechanism*, not the
// translation: `discharge_summaries.summary_language` tags the
// authored language, and `discharge_summary_sections.body_translations`
// holds per-language bodies keyed by ISO code, e.g. {"ta": "..."}.
//
// It deliberately does NOT machine-translate — clinical text (drug
// schedules, red flags, follow-up dates) must be reviewed by a human
// translator. Calling setSectionTranslation without a `body` stores the
// review placeholder so the section lands in a translator's queue
// instead of silently staying English. Finding
// 2026-05-09-inpatient-admission-discharge-no-tamil-summary-no-sms-followup.
export const TRANSLATION_PLACEHOLDER = '[PLACEHOLDER — translation review required]';

export async function setSectionTranslation({
  tenantId, id, section_key, language, body, edited_by,
}) {
  const lang = String(language || '').trim().toLowerCase();
  if (!/^[a-z]{2,5}$/.test(lang)) {
    throw AppError.badRequest('language must be a 2-5 char ISO code (e.g. "ta" for Tamil)');
  }
  if (lang === 'en') {
    throw AppError.badRequest('English is the authored language — edit the section body directly, not as a translation');
  }
  // Verify ownership before edit (prevents cross-tenant tampering).
  const owner = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM discharge_summaries
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!owner.length) throw AppError.notFound('Discharge summary not found');

  // No human translation supplied → store the review placeholder so the
  // section is discoverable as "needs translation" rather than missing.
  const translatedBody = body && String(body).trim()
    ? String(body)
    : TRANSLATION_PLACEHOLDER;

  const result = await prisma.$executeRawUnsafe(
    `UPDATE discharge_summary_sections
        SET body_translations = body_translations || jsonb_build_object($1::text, $2::text),
            edited_by = $3::uuid, edited_at = NOW()
      WHERE discharge_summary_id = $4::int AND section_key = $5`,
    lang, translatedBody,
    edited_by ? String(edited_by) : null,
    Number(id), String(section_key),
  );
  if (Number(result) === 0) {
    throw AppError.notFound(`Section ${section_key} not found on this summary`);
  }
  await prisma.$executeRawUnsafe(
    `UPDATE discharge_summaries SET updated_at = NOW() WHERE id = $1::int`,
    Number(id),
  );
  return getOne({ tenantId, id });
}

export async function markReadyForSignoff({ tenantId, id, marked_by = null }) {
  // Same completeness gate as sign() — surface incomplete required
  // sections at "mark ready" so the doctor sees the blocker before the
  // sign-off step rather than only at the final sign. Ownership-scoped
  // read prevents a cross-tenant id probing section content. Finding:
  // 2026-05-22-surgical-day-care-discharge-ae484c86.
  const ownerRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM discharge_summaries
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!ownerRows.length) throw AppError.notFound('Discharge summary not found');
  const gateSections = await prisma.$queryRawUnsafe(
    `SELECT section_key, body
       FROM discharge_summary_sections
      WHERE discharge_summary_id = $1::int`,
    Number(id),
  );
  assertSignable(gateSections);

  // Atomic: status flip + legacy audit + canonical timeline/audit events commit
  // together (canonical timeline invariant). setTenantTx also scopes the writes
  // under the discharge_summaries RLS policy (migration 304).
  await setTenantTx(tenantId || DEFAULT_TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE discharge_summaries
          SET status = 'ready_for_signoff', updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid AND status = 'draft'
        RETURNING id, admission_id, patient_uid`,
      Number(id), tenantId,
    );
    if (!rows.length) {
      throw AppError.badRequest(
        'Discharge summary not in draft state (cannot mark ready)',
      );
    }
    const summary = rows[0];
    await appendDischargeAudit({
      tenantId, id, db: tx,
      action: 'DISCHARGE_SUMMARY_READY_FOR_SIGNOFF',
      actorUid: marked_by,
      metadata: { status: 'ready_for_signoff' },
    });
    await emitDischargeCanonicalEvent({
      db: tx, tenantId, id, patientUid: summary.patient_uid,
      admissionId: summary.admission_id,
      eventType: 'discharge_summary.ready', eventStatus: 'ready_for_signoff',
      previousStatus: 'draft', actorUid: marked_by,
      summary: 'Discharge summary marked ready for sign-off',
    });
  });
  return getOne({ tenantId, id });
}

export async function sign({
  tenantId, id, signed_by, signed_by_name, signed_by_reg,
}) {
  if (!signed_by_name) {
    throw AppError.badRequest('signed_by_name is required');
  }

  // Completeness gate (pre-flight, outside any txn). A signed discharge
  // summary is final patient-facing instruction — block the sign if the
  // required clinical sections present on this summary are blank or
  // still carry template placeholder text. Verify ownership in the same
  // read so a cross-tenant id can't probe section content. Finding:
  // 2026-05-22-surgical-day-care-discharge-ae484c86.
  const ownerRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM discharge_summaries
      WHERE id = $1::int AND tenant_id = $2::uuid`,
    Number(id), tenantId,
  );
  if (!ownerRows.length) throw AppError.notFound('Discharge summary not found');
  const gateSections = await prisma.$queryRawUnsafe(
    `SELECT section_key, body
       FROM discharge_summary_sections
      WHERE discharge_summary_id = $1::int`,
    Number(id),
  );
  assertSignable(gateSections);

  // Atomic sign (canonical timeline invariant + audit 2026-06-18 §4): the status
  // flip, the legacy audit row, the canonical timeline/audit events, AND the
  // admission summary_signed_at stamp all commit together (previously the flip,
  // the stamp, and the med materialisation ran as separate non-transactional
  // statements). setTenantTx scopes the writes under the discharge_summaries +
  // admissions RLS policies. The e_prescriptions med materialisation stays
  // POST-COMMIT best-effort (idempotent, patient-app convenience) — an
  // e_prescriptions hiccup must not roll back a legally-signed discharge.
  const signed = await setTenantTx(tenantId || DEFAULT_TENANT_ID, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE discharge_summaries
          SET status = 'signed', signed_by = $1::uuid,
              signed_by_name = $2, signed_by_reg = $3, signed_at = NOW(),
              updated_at = NOW()
        WHERE id = $4::int AND tenant_id = $5::uuid
          AND status IN ('draft', 'ready_for_signoff')
        RETURNING id, admission_id, patient_uid, signed_at, status`,
      signed_by ? String(signed_by) : null,
      String(signed_by_name),
      signed_by_reg || null,
      Number(id), tenantId,
    );
    if (!rows.length) {
      throw AppError.badRequest(
        'Discharge summary already signed or in an invalid state for signing',
      );
    }
    const row = rows[0];
    await appendDischargeAudit({
      tenantId, id, db: tx,
      action: 'DISCHARGE_SUMMARY_SIGNED',
      actorUid: signed_by,
      metadata: {
        admission_id: row.admission_id || null,
        patient_uid: row.patient_uid || null,
        signed_by_name: signed_by_name || null,
        signed_by_reg: signed_by_reg || null,
        signed_at: row.signed_at || null,
      },
    });
    await emitDischargeCanonicalEvent({
      db: tx, tenantId, id, patientUid: row.patient_uid,
      admissionId: row.admission_id,
      eventType: 'discharge_summary.signed', eventStatus: 'signed',
      actorUid: signed_by,
      summary: `Discharge summary signed by ${signed_by_name}`,
      payload: { signed_by_name: signed_by_name || null, signed_by_reg: signed_by_reg || null },
    });

    // Denormalise summary_signed_at onto the admission row so the patient-side
    // discharge-PDF gate (clinicalPdfGenerator.getOrGenerateDischargePdfUrl)
    // and the cascade-readiness check can both read it without re-joining
    // discharge_summaries. Now in-tx with the sign (was best-effort + outside).
    // Finding: 2026-05-09-tpa-insurance-claim-patient-discharge-pdf-blocked.
    if (row.admission_id) {
      await tx.$executeRawUnsafe(
        `UPDATE admissions
            SET summary_signed_at = $1, updated_at = NOW()
          WHERE id = $2::int`,
        row.signed_at, Number(row.admission_id),
      );
    }
    return row;
  });

  // Materialise discharge medications as an e_prescriptions row so the
  // patient app's Rx tab surfaces them. Best-effort: signing must not
  // fail if no medication section is configured or the section body is
  // empty. Finding 2026-05-09-surgical-day-care-patient-discharge-meds-
  // not-in-e_prescriptions.
  await materialiseDischargeMedsAsPrescription({
    discharge_summary_id: Number(id),
    patient_uid: signed.patient_uid,
    doctor_uid: signed_by || null,
  });

  return getOne({ tenantId, id });
}

/**
 * Create an e_prescriptions row from the discharge summary's medication
 * section(s) so the patient app's Rx list surfaces discharge meds.
 *
 * Section bodies are free text — we don't try to parse them into
 * structured `medications` JSON (that would require NLP and may
 * misrepresent dosing for a clinical artifact). Instead we store the
 * full body as `clinical_notes` and one synthetic medication entry
 * pointing at the discharge summary, so the Rx tab card renders
 * something sensible and a deep-link can route the patient to the
 * actual discharge summary view (see Group A patient portal route).
 *
 * Idempotent — if a prescription was already created from this
 * discharge summary, we skip. Best-effort: any failure is logged and
 * swallowed.
 */
export async function materialiseDischargeMedsAsPrescription({
  discharge_summary_id, patient_uid, doctor_uid,
}) {
  if (!patient_uid) return;
  try {
    const sections = await prisma.$queryRawUnsafe(
      `SELECT section_key, section_title, body
         FROM discharge_summary_sections
        WHERE discharge_summary_id = $1::int
          AND body IS NOT NULL AND length(trim(body)) > 0`,
      Number(discharge_summary_id),
    );
    const medSection = sections.find((s) =>
      DISCHARGE_MED_SECTION_KEYS.has(String(s.section_key || '').toLowerCase()),
    );
    if (!medSection) return;

    // Idempotency probe: a prescription whose clinical_notes references
    // this discharge_summary_id means we've already materialised it.
    const marker = `[discharge_summary_id=${discharge_summary_id}]`;
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM e_prescriptions
        WHERE patient_uid = $1::uuid
          AND clinical_notes LIKE $2
        LIMIT 1`,
      String(patient_uid), `%${marker}%`,
    );
    if (existing.length) return;

    // Resolve int ids — getMyPrescriptions filters by patient_id (int).
    // doctor_id is best-effort: discharge can be signed by a name-only
    // user with no DB row.
    const [patientRow, doctorRow] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`,
        String(patient_uid),
      ),
      doctor_uid
        ? prisma.$queryRawUnsafe(
            `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`,
            String(doctor_uid),
          )
        : Promise.resolve([]),
    ]);
    const patientId = patientRow[0]?.id ?? null;
    const doctorId = doctorRow[0]?.id ?? null;
    if (!patientId) {
      logger.warn(
        `materialiseDischargeMedsAsPrescription: no users row for patient_uid=${patient_uid}`,
      );
      return;
    }

    // The section body is unstructured free text (one med per line in
    // typical templates). Earlier code surfaced each line verbatim with
    // a generic "See discharge summary for full schedule" instructions
    // string, so the patient app's Rx tab rendered every takeaway med
    // with the same useless boilerplate sentence and no dose/frequency.
    // D71 fix: split each line into a name + structured instructions
    // (dose / frequency / route / duration) so the Rx card actually
    // tells the patient WHAT to take. The split heuristic is conservative:
    //   * If the line matches `<name> <number...rest>` (a med name
    //     followed by a digit-led dose), use the name and use the
    //     remainder as instructions.
    //   * Otherwise (no digits, all letters/parens), the whole line is
    //     the name and instructions are left null — the patient app
    //     will fall back to showing just the name, which is still
    //     better than the generic boilerplate.
    // Findings 2026-05-22-discharge-..._a175476a and ..._c221cd96.
    const sectionBody = String(medSection.body || '').trim();
    const lines = sectionBody
      .split(/\r?\n/)
      .map((l) => l.replace(/^[\s•\-*]+/, '').trim())
      .filter((l) => l.length > 0);

    const splitMedLine = (line) => {
      // Find the start of a dose-formed tail: <number><unit-letters>
      // (e.g. 500mg, 60000 IU, 25 mg). The med name may itself contain
      // digits ("Vitamin D3", "B12") so a plain "first digit" rule
      // splits in the wrong place. The regex requires the dose number
      // to be followed (with at most one whitespace + dot/digit run) by
      // unit letters — "D3 " on its own (no unit) is NOT a dose, so
      // "Vitamin D3" stays in the name and the actual dose tail starts
      // at "60000 IU".
      const m = line.match(/^(.+?)\s+(\d+(?:[\s.,]\d+)*\s*[a-zA-Zµ]+\b[\s\S]*)$/);
      if (m && m[1].trim().length > 0) {
        return {
          name: m[1].trim().replace(/[:;,-]+$/, '').trim(),
          instructions: m[2].trim(),
        };
      }
      // Fallback: no dose pattern found (e.g. "Continue current home meds") —
      // surface the whole line as the name with no instructions so the
      // Rx card at least shows the line text rather than the generic
      // "See discharge summary" string.
      return { name: line, instructions: null };
    };

    const medications = lines.length
      ? lines.map((line) => {
          const { name, instructions } = splitMedLine(line);
          return {
            name,
            instructions,
            source: 'discharge_summary',
          };
        })
      : [{
          name: medSection.section_title || 'Discharge medications',
          instructions: sectionBody,
          source: 'discharge_summary',
        }];

    const clinicalNotesText =
      `Discharge medications from discharge summary. ${marker}\n\n${sectionBody}`;

    await prisma.$executeRawUnsafe(
      // $2/$4 carry explicit casts: doctor_id is int (nullable — a name-only
      // signer has no users row) and doctor_uid is a uuid column. Without
      // $4::uuid Postgres typed the bound string as text → 42804 ("column
      // doctor_uid is of type uuid but expression is of type text"), which the
      // best-effort catch swallowed — so discharge meds silently never
      // materialised to the patient's Rx tab. Finding surfaced during D3.
      `INSERT INTO e_prescriptions
         (appointment_id, patient_id, doctor_id, patient_uid, doctor_uid,
          diagnosis, clinical_notes, medications, status)
       VALUES (NULL, $1::int, $2::int, $3::uuid, $4::uuid,
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
      `materialiseDischargeMedsAsPrescription failed for discharge_summary_id=${discharge_summary_id}: ${e.message}`,
    );
  }
}

export async function markDelivered({
  tenantId, id, delivery_method, delivered_by = null,
}) {
  // `sms` added to the delivery channels so a feature-phone patient
  // (no smartphone, no email, no WhatsApp) gets a plain-text discharge
  // notification. discharge_summaries.delivery_method is a free
  // VARCHAR(20) — no DB enum change needed. Finding
  // 2026-05-09-inpatient-admission-discharge-no-tamil-summary-no-sms-followup.
  const allowed = ['printed', 'email', 'whatsapp', 'abdm', 'sms'];
  if (!allowed.includes(delivery_method)) {
    throw AppError.badRequest(
      `delivery_method must be one of: ${allowed.join(', ')}`,
    );
  }
  // Atomic: status flip + legacy audit + canonical timeline/audit events commit
  // together (canonical timeline invariant), scoped under the discharge_summaries
  // RLS policy. The SMS-intent queue stays POST-COMMIT best-effort below.
  const rows = await setTenantTx(tenantId || DEFAULT_TENANT_ID, async (tx) => {
    const updated = await tx.$queryRawUnsafe(
      `UPDATE discharge_summaries
          SET status = 'delivered', delivered_at = NOW(),
              delivery_method = $1, updated_at = NOW()
        WHERE id = $2::int AND tenant_id = $3::uuid AND status = 'signed'
        RETURNING id, admission_id, patient_uid, primary_diagnosis`,
      delivery_method, Number(id), tenantId,
    );
    if (!updated.length) {
      throw AppError.badRequest(
        'Discharge summary must be signed before it can be marked delivered',
      );
    }
    const summary = updated[0];
    await appendDischargeAudit({
      tenantId, id, db: tx,
      action: 'DISCHARGE_SUMMARY_DELIVERED',
      actorUid: delivered_by,
      metadata: {
        admission_id: summary.admission_id || null,
        patient_uid: summary.patient_uid || null,
        delivery_method,
      },
    });
    await emitDischargeCanonicalEvent({
      db: tx, tenantId, id, patientUid: summary.patient_uid,
      admissionId: summary.admission_id,
      eventType: 'discharge_summary.delivered', eventStatus: 'delivered',
      previousStatus: 'signed', actorUid: delivered_by,
      summary: `Discharge summary delivered (${delivery_method})`,
      payload: { delivery_method },
    });
    return updated;
  });

  // SMS delivery: persist the intent to the notification outbox. No SMS
  // gateway is wired yet (smsService is dry-run) — the outbox row IS
  // the delivery intent, drained by a future gateway integration.
  // fix-deferred: SMS gateway integration. Best-effort: a queue failure
  // must not un-deliver the summary.
  if (delivery_method === 'sms') {
    await queueDischargeSms(rows[0]).catch((e) =>
      logger.warn(
        `dischargeService.markDelivered: SMS queue failed for summary ${id}: ${e.message}`,
      ),
    );
  }

  return getOne({ tenantId, id });
}

// Queue a plain-SMS discharge notification through the notification
// outbox. The body is intentionally short, instruction-oriented, and
// language-neutral — the structured (and, where available, translated)
// summary is what the patient reads; this is just the "your summary is
// ready" nudge for a feature phone.
async function queueDischargeSms(summary) {
  const patientRows = await prisma.$queryRawUnsafe(
    `SELECT id, name, phone FROM users WHERE uid = $1::uuid LIMIT 1`,
    String(summary.patient_uid),
  );
  const patient = patientRows[0];
  if (!patient?.phone) {
    logger.warn(
      `dischargeService.queueDischargeSms: no phone on file for patient ${summary.patient_uid}`,
    );
    return;
  }
  const { default: outbox } = await import(
    '../../utils/notifications/notificationOutbox.js'
  );
  await outbox.queue({
    type: 'sms',
    recipientId: patient.id,
    recipientPhone: patient.phone,
    title: 'Discharge summary ready',
    body:
      'Your discharge summary from Venkataeswara Hospitals is ready. '
      + 'Please follow the printed instructions and attend your follow-up appointment.',
    data: { type: 'discharge_summary', discharge_summary_id: summary.id },
  });
}

export async function listForPatient({ tenantId, patient_uid, limit = 50 }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, admission_id, primary_diagnosis, status, signed_at,
            delivered_at, delivery_method, created_at
       FROM discharge_summaries
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY created_at DESC
      LIMIT $3::int`,
    tenantId, String(patient_uid), Number(limit),
  );
}

export async function listPending({ tenantId, limit = 100 }) {
  return prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, patient_name_snapshot, primary_diagnosis,
            admitted_at, discharged_at, status, created_at, updated_at
       FROM discharge_summaries
      WHERE tenant_id = $1::uuid AND status IN ('draft', 'ready_for_signoff')
      ORDER BY updated_at DESC
      LIMIT $2::int`,
    tenantId, Number(limit),
  );
}
