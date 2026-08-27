// src/services/publicHealth/publicHealthService.js — G1 (reaudit 2026-08-25)
//
// Statutory public-health notifiable-disease register + submission-format
// export FILES. The register (migration 739) is the case-level source of
// truth; the exports are read-projections into the shapes the statutory
// programmes accept for manual upload:
//   * Nikshay (TB)   — case-level CSV for the NTEP TB notification portal.
//   * IDSP / IHIP     — weekly S (syndromic) + P (presumptive/lab) line-list.
//   * HMIS            — monthly aggregate return (counts by disease).
// Live portal APIs are out of scope (portals accept manual upload).
//
// Dark-gate: env PUBLIC_HEALTH_REGISTERS_ENABLED AND per-tenant
// settings.publicHealthRegisters.enabled, ANDed, fail-closed, default OFF.
// env off → 503 PUBLIC_HEALTH_REGISTERS_NOT_ENABLED; tenant off → 403
// PUBLIC_HEALTH_REGISTERS_DISABLED.
//
// Canonical clinical timeline invariant: createNotification persists the
// detail row PLUS one clinical_timeline_events + one clinical_audit_events row
// in the same transaction (recordCanonicalClinicalEvent, strict).

import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { escapeCsvField } from '../../utils/csv.js';
import { requireTenantId } from '../tenant/tenantService.js';

function tenantOr(t) { return requireTenantId(t); }
function unwrap(rows) { return Array.isArray(rows) ? rows[0] : rows; }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Controlled disease vocabulary — must stay in lockstep with the CHECK in
// migration 739. Each entry maps to its default programme + ICD-10.
export const NOTIFIABLE_DISEASES = Object.freeze({
  tuberculosis:                { name: 'Tuberculosis', program: 'nikshay', icd10: 'A15' },
  malaria:                     { name: 'Malaria', program: 'idsp', icd10: 'B54' },
  dengue:                      { name: 'Dengue', program: 'idsp', icd10: 'A90' },
  chikungunya:                 { name: 'Chikungunya', program: 'idsp', icd10: 'A92.0' },
  cholera:                     { name: 'Cholera', program: 'idsp', icd10: 'A00' },
  acute_diarrheal_disease:     { name: 'Acute Diarrheal Disease', program: 'idsp', icd10: 'A09' },
  typhoid:                     { name: 'Typhoid', program: 'idsp', icd10: 'A01.0' },
  viral_hepatitis:             { name: 'Viral Hepatitis', program: 'idsp', icd10: 'B17' },
  measles:                     { name: 'Measles', program: 'idsp', icd10: 'B05' },
  diphtheria:                  { name: 'Diphtheria', program: 'idsp', icd10: 'A36' },
  pertussis:                   { name: 'Pertussis', program: 'idsp', icd10: 'A37' },
  tetanus:                     { name: 'Tetanus', program: 'idsp', icd10: 'A35' },
  meningitis:                  { name: 'Meningitis', program: 'idsp', icd10: 'G03' },
  leptospirosis:               { name: 'Leptospirosis', program: 'idsp', icd10: 'A27' },
  japanese_encephalitis:       { name: 'Japanese Encephalitis', program: 'idsp', icd10: 'A83.0' },
  acute_encephalitis_syndrome: { name: 'Acute Encephalitis Syndrome', program: 'idsp', icd10: 'G04' },
  rabies:                      { name: 'Rabies', program: 'idsp', icd10: 'A82' },
  covid19:                     { name: 'COVID-19', program: 'idsp', icd10: 'U07.1' },
  influenza_h1n1:              { name: 'Influenza A H1N1', program: 'idsp', icd10: 'J09' },
  chickenpox:                  { name: 'Chickenpox', program: 'idsp', icd10: 'B01' },
  mumps:                       { name: 'Mumps', program: 'idsp', icd10: 'B26' },
  leprosy:                     { name: 'Leprosy', program: 'idsp', icd10: 'A30' },
  kala_azar:                   { name: 'Kala-azar', program: 'idsp', icd10: 'B55.0' },
  filariasis:                  { name: 'Filariasis', program: 'idsp', icd10: 'B74' },
  plague:                      { name: 'Plague', program: 'idsp', icd10: 'A20' },
  anthrax:                     { name: 'Anthrax', program: 'idsp', icd10: 'A22' },
  other:                       { name: 'Other Notifiable Condition', program: 'idsp', icd10: null },
});

const STATUS_TRANSITIONS = {
  draft:        ['notified', 'cancelled'],
  notified:     ['acknowledged', 'closed'],
  acknowledged: ['closed'],
  closed:       [],
  cancelled:    [],
};

const VALID_PROGRAMS = ['idsp', 'nikshay', 'hmis', 'other'];
const VALID_CLASSIFICATIONS = ['suspected', 'probable', 'confirmed', 'discarded'];

/* ─── Dark-ship gate ─────────────────────────────────────────────────────── */

export function isPublicHealthRegistersEnvEnabled() {
  return process.env.PUBLIC_HEALTH_REGISTERS_ENABLED === 'true';
}

async function getPublicHealthRegistersSettingsLazy(tenantId) {
  const mod = await import('../tenant/tenantSettingsService.js');
  return mod.getPublicHealthRegistersSettings(tenantId);
}

export async function requirePublicHealthRegistersEnabled(tenantId) {
  if (!isPublicHealthRegistersEnvEnabled()) {
    throw new AppError('Public-health registers are not enabled', 503, 'PUBLIC_HEALTH_REGISTERS_NOT_ENABLED');
  }
  const settings = await getPublicHealthRegistersSettingsLazy(tenantId);
  if (!settings.enabled) {
    throw AppError.forbidden(
      'Public-health registers are not enabled for this tenant',
      'PUBLIC_HEALTH_REGISTERS_DISABLED',
    );
  }
  return settings;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function cleanText(value, max = null) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

// CSV cell escape — the shared helper both RFC-4180-quotes AND neutralizes
// spreadsheet formula injection (leading = + - @ tab/CR), since these files
// are built for manual opening in Excel (Nikshay/IDSP/HMIS uploads).
const ce = escapeCsvField;

function normalizeLimit(value, fallback = 100, max = 1000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/* ─── Create ─────────────────────────────────────────────────────────────── */

export async function createNotification({ tenantId, ...body }) {
  await requirePublicHealthRegistersEnabled(tenantId);
  const tid = tenantOr(tenantId);

  if (!body.patient_uid) throw AppError.badRequest('patient_uid required');
  if (!UUID_RE.test(String(body.patient_uid))) {
    throw AppError.badRequest('patient_uid must be a UUID', 'PUBLIC_HEALTH_PATIENT_UID_INVALID');
  }
  if (!body.date_of_diagnosis) throw AppError.badRequest('date_of_diagnosis required');
  const diseaseCode = cleanText(body.disease_code);
  const disease = NOTIFIABLE_DISEASES[diseaseCode];
  if (!disease) {
    throw AppError.badRequest(`disease_code must be one of: ${Object.keys(NOTIFIABLE_DISEASES).join(', ')}`);
  }
  const program = cleanText(body.program) || disease.program;
  if (!VALID_PROGRAMS.includes(program)) {
    throw AppError.badRequest(`program must be one of: ${VALID_PROGRAMS.join(', ')}`);
  }
  const classification = cleanText(body.case_classification) || 'suspected';
  if (!VALID_CLASSIFICATIONS.includes(classification)) {
    throw AppError.badRequest(`case_classification must be one of: ${VALID_CLASSIFICATIONS.join(', ')}`);
  }

  return setTenantTx(tid, async (tx) => {
    // Tenant-scoped patient resolution (inventoryV2Service precedent): a
    // statutory register row must reference a real patient of THIS tenant —
    // never a dangling or cross-tenant UUID.
    const patients = await tx.$queryRawUnsafe(
      `SELECT uid
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
          AND role = 'PATIENT'
        LIMIT 1`,
      tid, String(body.patient_uid));
    if (!patients[0]) {
      throw AppError.notFound(
        'Notification patient was not found in this tenant',
        'PUBLIC_HEALTH_PATIENT_NOT_FOUND',
      );
    }

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO notifiable_disease_notifications
         (tenant_id, patient_uid, admission_id, patient_name, patient_age_years,
          patient_sex, patient_phone, patient_address, patient_district, patient_state,
          disease_code, disease_name, icd10_code, program, case_classification,
          lab_confirmed, specimen_type, lab_test, lab_result,
          date_of_onset, date_of_diagnosis, program_details, outcome,
          status, reported_by, reported_by_name, notes, created_by)
       VALUES ($1::uuid, $2::uuid, $3::int, $4, $5::int,
               $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15,
               $16::boolean, $17, $18, $19,
               $20::date, $21::date, $22::jsonb, $23,
               'draft', $24::uuid, $25, $26, $27::uuid)
       RETURNING *`,
      tid, body.patient_uid,
      body.admission_id ? Number.parseInt(body.admission_id, 10) : null,
      cleanText(body.patient_name, 160), body.patient_age_years ?? null,
      cleanText(body.patient_sex, 12), cleanText(body.patient_phone, 20),
      cleanText(body.patient_address), cleanText(body.patient_district, 120),
      cleanText(body.patient_state, 80),
      diseaseCode, disease.name, cleanText(body.icd10_code, 10) || disease.icd10,
      program, classification,
      Boolean(body.lab_confirmed), cleanText(body.specimen_type, 60),
      cleanText(body.lab_test, 120), cleanText(body.lab_result, 120),
      body.date_of_onset || null, body.date_of_diagnosis,
      JSON.stringify(body.program_details && typeof body.program_details === 'object' ? body.program_details : {}),
      cleanText(body.outcome, 24),
      cleanText(body.reported_by) || null, cleanText(body.reported_by_name, 160),
      cleanText(body.notes), cleanText(body.created_by) || null);
    const record = unwrap(rows);

    const { recordCanonicalClinicalEvent } = await import('../clinical/canonicalClinicalPlatformService.js');
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: body.patient_uid,
      eventType: 'notifiable_disease.recorded',
      eventStatus: 'draft',
      action: 'NOTIFIABLE_DISEASE_RECORDED',
      resourceTable: 'notifiable_disease_notifications',
      resourceId: String(record.id),
      actorUid: cleanText(body.created_by) || null,
      actorRole: cleanText(body.actor_role) || null,
      summary: `Notifiable disease recorded: ${disease.name} (${classification})`,
      metadata: { disease_code: diseaseCode, program, case_classification: classification },
    }, { db: tx, strict: true });

    return record;
  });
}

/* ─── Reads ──────────────────────────────────────────────────────────────── */

export async function listNotifications({ tenantId, program, status, disease_code, from, to, limit = 100 }) {
  await requirePublicHealthRegistersEnabled(tenantId);
  const conds = ['tenant_id = $1::uuid'];
  const args = [tenantOr(tenantId)];
  if (program) { args.push(program); conds.push(`program = $${args.length}`); }
  if (status) { args.push(status); conds.push(`status = $${args.length}`); }
  if (disease_code) { args.push(disease_code); conds.push(`disease_code = $${args.length}`); }
  if (from) { args.push(from); conds.push(`date_of_diagnosis >= $${args.length}::date`); }
  if (to) { args.push(to); conds.push(`date_of_diagnosis <= $${args.length}::date`); }
  const lim = normalizeLimit(limit);
  return prisma.$queryRawUnsafe(
    `SELECT * FROM notifiable_disease_notifications
      WHERE ${conds.join(' AND ')}
      ORDER BY date_of_diagnosis DESC, id DESC
      LIMIT ${lim}`,
    ...args);
}

export async function getNotification({ tenantId, id }) {
  await requirePublicHealthRegistersEnabled(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM notifiable_disease_notifications WHERE id = $1::bigint AND tenant_id = $2::uuid`,
    Number.parseInt(id, 10), tenantOr(tenantId));
  const rec = unwrap(rows);
  if (!rec) throw AppError.notFound('Notification not found');
  return rec;
}

export async function transition({ tenantId, id, to_status, external_ref, outcome, actor_uid, actor_role }) {
  await requirePublicHealthRegistersEnabled(tenantId);
  const tid = tenantOr(tenantId);
  const recordId = Number.parseInt(id, 10);

  return setTenantTx(tid, async (tx) => {
    const recRows = await tx.$queryRawUnsafe(
      `SELECT * FROM notifiable_disease_notifications WHERE id = $1::bigint AND tenant_id = $2::uuid FOR UPDATE`,
      recordId, tid);
    const rec = unwrap(recRows);
    if (!rec) throw AppError.notFound('Notification not found');

    const allowed = STATUS_TRANSITIONS[rec.status] || [];
    if (!allowed.includes(to_status)) {
      throw AppError.invalidTransition(rec.status, to_status, allowed);
    }

    const setNotifiedAt = to_status === 'notified' && !rec.notified_at;
    const rows = await tx.$queryRawUnsafe(
      `UPDATE notifiable_disease_notifications
          SET status = $1,
              notified_at = CASE WHEN $2::boolean THEN NOW() ELSE notified_at END,
              external_ref = COALESCE($3, external_ref),
              outcome = COALESCE($4, outcome),
              updated_at = NOW()
        WHERE id = $5::bigint AND tenant_id = $6::uuid
        RETURNING *`,
      to_status, setNotifiedAt, cleanText(external_ref, 80), cleanText(outcome, 24),
      recordId, tid);
    const updated = unwrap(rows);

    const { recordCanonicalClinicalEvent } = await import('../clinical/canonicalClinicalPlatformService.js');
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: updated.patient_uid,
      eventType: `notifiable_disease.${to_status}`,
      eventStatus: to_status,
      action: `NOTIFIABLE_DISEASE_${to_status.toUpperCase()}`,
      resourceTable: 'notifiable_disease_notifications',
      resourceId: String(recordId),
      actorUid: cleanText(actor_uid) || null,
      actorRole: cleanText(actor_role) || null,
      summary: `Notifiable disease case ${to_status}`,
      metadata: { disease_code: updated.disease_code, program: updated.program, to_status },
    }, { db: tx, strict: true });

    return updated;
  });
}

/* ─── Export files ───────────────────────────────────────────────────────── */

async function loadForExport({ tenantId, program, from, to, diseaseCode = null }) {
  const conds = ['tenant_id = $1::uuid', "status <> 'cancelled'"];
  const args = [tenantOr(tenantId)];
  if (program) { args.push(program); conds.push(`program = $${args.length}`); }
  if (diseaseCode) { args.push(diseaseCode); conds.push(`disease_code = $${args.length}`); }
  if (from) { args.push(from); conds.push(`date_of_diagnosis >= $${args.length}::date`); }
  if (to) { args.push(to); conds.push(`date_of_diagnosis <= $${args.length}::date`); }
  return prisma.$queryRawUnsafe(
    `SELECT * FROM notifiable_disease_notifications
      WHERE ${conds.join(' AND ')}
      ORDER BY date_of_diagnosis ASC, id ASC`,
    ...args);
}

function csv(rows, columns) {
  const header = columns.map((c) => c.label).join(',');
  const body = rows.map((r) => columns.map((c) => ce(c.value(r))).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

// Nikshay (NTEP TB) case-level export — the fields the Nikshay bulk-upload
// template expects for a private-notification line-list.
export async function exportNikshayTb({ tenantId, from = null, to = null }) {
  await requirePublicHealthRegistersEnabled(tenantId);
  const rows = await loadForExport({ tenantId, program: 'nikshay', from, to, diseaseCode: 'tuberculosis' });
  const content = csv(rows, [
    { label: 'PatientName', value: (r) => r.patient_name },
    { label: 'Age', value: (r) => r.patient_age_years },
    { label: 'Gender', value: (r) => r.patient_sex },
    { label: 'MobileNumber', value: (r) => r.patient_phone },
    { label: 'Address', value: (r) => r.patient_address },
    { label: 'District', value: (r) => r.patient_district },
    { label: 'State', value: (r) => r.patient_state },
    { label: 'DiseaseClassification', value: (r) => r.case_classification },
    { label: 'BasisOfDiagnosis', value: (r) => (r.lab_confirmed ? 'microbiologically_confirmed' : 'clinically_diagnosed') },
    { label: 'TestType', value: (r) => r.lab_test },
    { label: 'TestResult', value: (r) => r.lab_result },
    { label: 'HIVStatus', value: (r) => r.program_details?.hiv_status || '' },
    { label: 'DateOfDiagnosis', value: (r) => r.date_of_diagnosis },
    { label: 'NikshayId', value: (r) => r.external_ref || '' },
    { label: 'TreatmentOutcome', value: (r) => r.outcome || '' },
  ]);
  return {
    format: 'nikshay_tb_csv',
    content_type: 'text/csv',
    filename: `nikshay-tb-${from || 'all'}-${to || 'all'}.csv`.replace(/[^a-zA-Z0-9._-]/g, '_'),
    case_count: rows.length,
    content,
  };
}

// IDSP / IHIP weekly line-list — the presumptive (P) form is lab-confirmed /
// probable cases; the syndromic (S) form is suspected cases. Both share the
// IHIP line-list shape; we split by case classification.
export async function exportIdspWeekly({ tenantId, from = null, to = null, form = 'P' }) {
  await requirePublicHealthRegistersEnabled(tenantId);
  const all = await loadForExport({ tenantId, program: 'idsp', from, to });
  const formCode = form === 'S' ? 'S' : 'P';
  const rows = formCode === 'S'
    ? all.filter((r) => r.case_classification === 'suspected')
    : all.filter((r) => r.case_classification !== 'suspected');
  // The IHIP line-list carries a 1-based serial column, so build directly.
  const header = 'Sr,PatientName,Age,Sex,Address,Village_Ward,Disease_Syndrome,ICD10,DateOfOnset,DateOfDiagnosis,LabConfirmed,Outcome';
  const lines = rows.map((r, i) => [
    i + 1, ce(r.patient_name), r.patient_age_years ?? '', ce(r.patient_sex),
    ce(r.patient_address), ce(r.patient_district), ce(r.disease_name), ce(r.icd10_code),
    r.date_of_onset || '', r.date_of_diagnosis, r.lab_confirmed ? 'Yes' : 'No', ce(r.outcome || ''),
  ].join(','));
  return {
    format: `idsp_ihip_weekly_${formCode.toLowerCase()}_csv`,
    content_type: 'text/csv',
    filename: `idsp-ihip-${formCode}-${from || 'all'}-${to || 'all'}.csv`.replace(/[^a-zA-Z0-9._-]/g, '_'),
    form: formCode,
    case_count: rows.length,
    content: `${header}\n${lines.join('\n')}\n`,
  };
}

// HMIS monthly return — aggregate counts by disease for a month, the shape the
// state HMIS monthly upload expects (no line-list, counts only).
export async function exportHmisMonthly({ tenantId, month, year }) {
  await requirePublicHealthRegistersEnabled(tenantId);
  const m = Number.parseInt(month, 10);
  const y = Number.parseInt(year, 10);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw AppError.badRequest('month must be 1-12');
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw AppError.badRequest('year must be a valid year');
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const toDate = new Date(Date.UTC(y, m, 0)); // last day of month
  const to = toDate.toISOString().slice(0, 10);

  const rows = await prisma.$queryRawUnsafe(
    `SELECT disease_code, disease_name,
            COUNT(*)::int AS total_cases,
            COUNT(*) FILTER (WHERE lab_confirmed)::int AS lab_confirmed,
            COUNT(*) FILTER (WHERE case_classification = 'confirmed')::int AS confirmed,
            COUNT(*) FILTER (WHERE outcome = 'died')::int AS deaths
       FROM notifiable_disease_notifications
      WHERE tenant_id = $1::uuid
        AND status <> 'cancelled'
        AND date_of_diagnosis >= $2::date
        AND date_of_diagnosis <= $3::date
      GROUP BY disease_code, disease_name
      ORDER BY disease_name ASC`,
    tenantOr(tenantId), from, to);

  const header = 'Disease,DiseaseCode,TotalCases,LabConfirmed,Confirmed,Deaths';
  const lines = rows.map((r) => [
    ce(r.disease_name), ce(r.disease_code), r.total_cases, r.lab_confirmed, r.confirmed, r.deaths,
  ].join(','));
  return {
    format: 'hmis_monthly_csv',
    content_type: 'text/csv',
    filename: `hmis-monthly-${y}-${String(m).padStart(2, '0')}.csv`,
    period: { month: m, year: y, from, to },
    disease_count: rows.length,
    content: `${header}\n${lines.join('\n')}\n`,
  };
}

export const _internal = { STATUS_TRANSITIONS, NOTIFIABLE_DISEASES, VALID_PROGRAMS, VALID_CLASSIFICATIONS };
