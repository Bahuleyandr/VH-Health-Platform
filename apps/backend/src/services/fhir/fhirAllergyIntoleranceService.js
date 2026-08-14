import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { rankSeverity } from '../clinical/allergySourceService.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SEVERITIES = new Set(['MILD', 'MODERATE', 'SEVERE']);

function requiredUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw AppError.badRequest(`${label} must be a UUID`, 'FHIR_ALLERGY_IDENTITY_INVALID');
  }
  return normalized;
}

function normalizeText(value, maxLength, { required = false } = {}) {
  const normalized = String(value || '').trim().replace(/\s+/gu, ' ');
  if ((required && !normalized) || normalized.length > maxLength) {
    throw AppError.badRequest('FHIR AllergyIntolerance content is invalid', 'FHIR_ALLERGY_CONTENT_INVALID');
  }
  return normalized || null;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function allergyIdentityFingerprint({ patientUid, allergen }) {
  return sha256(`${patientUid}\n${allergen.toLocaleLowerCase('en-US')}`);
}

function allergyPayloadFingerprint({ severity, reaction }) {
  return sha256(`${severity}\n${String(reaction || '').toLocaleLowerCase('en-US')}`);
}

function normalizeAllergyInput(input) {
  const tenantId = requiredUuid(input.tenantId, 'FHIR tenant id');
  const patientUid = requiredUuid(input.patientUid, 'FHIR patient id');
  const allergen = normalizeText(input.allergen, 255, { required: true });
  const severity = String(input.severity || 'MILD').trim().toUpperCase();
  if (!ALLOWED_SEVERITIES.has(severity)) {
    throw AppError.badRequest('FHIR AllergyIntolerance severity is invalid', 'FHIR_ALLERGY_SEVERITY_INVALID');
  }
  const reaction = normalizeText(input.reaction, 4000);
  const clinicalStatus = String(input.clinicalStatus || 'active').trim().toLowerCase();
  if (clinicalStatus !== 'active') {
    throw AppError.badRequest(
      'Only active AllergyIntolerance creates are supported',
      'FHIR_ALLERGY_LIFECYCLE_UNSUPPORTED',
    );
  }
  const resourceFingerprint = allergyIdentityFingerprint({ patientUid, allergen });
  const payloadSha256 = allergyPayloadFingerprint({ severity, reaction });
  return {
    tenantId,
    patientUid,
    allergen,
    severity,
    reaction,
    clinicalStatus,
    resourceFingerprint,
    payloadSha256,
  };
}

function publicAllergy(row) {
  if (!row) return null;
  return {
    ...row,
    id: row.fhir_id || `pa-${row.id}`,
    allergen: row.allergy_name,
    recorded_at: row.recorded_at || row.created_at,
  };
}

// Returns the patient this source row belongs to, or `null` when the row states
// no patient key at all.
//
// The two outcomes are deliberately different. A row that NAMES a patient we
// cannot honour (unknown uid, staff/inactive user, uid and id disagreeing) is a
// MIS-ATTRIBUTED row: it claims to be somebody's allergy and we cannot tell
// whose, so serving the rest of the list could omit a real allergy from the
// patient actually being read — that still refuses the whole read.
//
// A row with neither `patient_uid` nor `patient_id` (both columns are NULLABLE
// on `patient_allergies`, and legacy imports predate the uid key — see
// services/clinical/allergySourceService.js) makes no claim at all. It cannot
// belong to any patient, it can never be part of any patient's allergy list,
// and it is already invisible to every patient-scoped read because the patient
// filter drops it. Refusing on it took the whole tenant-wide read down — every
// patient's allergy list — over a row that belongs to nobody. Those are
// quarantined and reported instead, never served.
function readablePatientUid(row) {
  const resolveIdentity = ({ raw, match, role, isActive }) => {
    if (raw == null || String(raw).trim() === '') return null;
    const resolved = String(match || '').trim().toLowerCase() || null;
    if (!resolved || !UUID_RE.test(resolved)) {
      throw AppError.internal(
        'FHIR AllergyIntolerance source row has an unresolved patient identity',
        'FHIR_ALLERGY_PATIENT_UNRESOLVED',
      );
    }
    if (
      String(role || '').trim().toUpperCase() !== 'PATIENT'
      || isActive !== true
    ) {
      throw AppError.internal(
        'FHIR AllergyIntolerance source row does not belong to an active patient',
        'FHIR_ALLERGY_PATIENT_INVALID',
      );
    }
    return resolved;
  };
  const uidMatch = resolveIdentity({
    raw: row.patient_uid_raw,
    match: row.patient_uid_match,
    role: row.patient_uid_role,
    isActive: row.patient_uid_active,
  });
  const idMatch = resolveIdentity({
    raw: row.patient_id_raw,
    match: row.patient_id_match,
    role: row.patient_id_role,
    isActive: row.patient_id_active,
  });
  if (uidMatch && idMatch && uidMatch !== idMatch) {
    throw AppError.internal(
      'FHIR AllergyIntolerance source row has conflicting patient identities',
      'FHIR_ALLERGY_PATIENT_IDENTITY_CONFLICT',
    );
  }
  const resolved = uidMatch || idMatch;
  if (!resolved) return null;
  if (!UUID_RE.test(resolved)) {
    throw AppError.internal(
      'FHIR AllergyIntolerance source row has an unresolved patient identity',
      'FHIR_ALLERGY_PATIENT_UNRESOLVED',
    );
  }
  return resolved;
}

// Returns the substance this row names, or `null` when it names none.
//
// A row with no substance carries no clinical content: it cannot be matched
// against a drug, and the platform's own source of truth for "what is this
// patient allergic to?" already drops it — `mergeAllergyRows` in
// services/clinical/allergySourceService.js skips blank allergens before the
// prescription-safety gate ever sees them. Nothing is hidden by leaving it out
// of a bundle, so it is quarantined and reported, not refused. Both columns
// behind it are nullable on the legacy `allergies` table, so this shape reaches
// production through imports.
function readableAllergen(row) {
  return String(row.allergy_name || '').trim().replace(/\s+/gu, ' ') || null;
}

function readableRowPrecedence(row) {
  if (row.source === 'patient_allergies' && row.has_fhir_receipt) return 0;
  if (row.source === 'patient_allergies') return 1;
  return 2;
}

function mergeReadableAllergyRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const patientUid = readablePatientUid(row);
    const allergen = readableAllergen(row);
    // Quarantined: with no patient there is nothing to build the 1..1
    // `AllergyIntolerance.patient` from, and with no substance there is no
    // clinical content to carry. Dropped here for the same reason the page query
    // filters them out — neither can be rendered as a resource.
    if (!patientUid || !allergen) continue;
    const key = `${patientUid}\n${allergen.toLocaleLowerCase('en-US')}`;
    const candidate = {
      ...row,
      patient_uid: patientUid,
      allergy_name: allergen,
    };
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  }

  const merged = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => (
      readableRowPrecedence(left) - readableRowPrecedence(right)
      || Number(left.id) - Number(right.id)
    ));
    const primary = ordered[0];
    const strongest = [...ordered].sort((left, right) => (
      rankSeverity(right.severity) - rankSeverity(left.severity)
      || readableRowPrecedence(left) - readableRowPrecedence(right)
    ))[0];
    const reactionSource = [...ordered].sort((left, right) => (
      rankSeverity(right.severity) - rankSeverity(left.severity)
      || readableRowPrecedence(left) - readableRowPrecedence(right)
    )).find(row => String(row.reaction || '').trim());
    const identifiers = ordered.map(row => ({
      system: row.source === 'patient_allergies'
        ? 'urn:vhhealth:patient-allergy'
        : 'urn:vhhealth:allergy',
      value: String(row.id),
    })).filter((identifier, index, all) => all.findIndex(candidate => (
      candidate.system === identifier.system && candidate.value === identifier.value
    )) === index);
    merged.push({
      id: primary.id,
      fhir_id: primary.source === 'patient_allergies' ? `pa-${primary.id}` : String(primary.id),
      patient_uid: primary.patient_uid,
      allergy_name: primary.allergy_name,
      severity: strongest?.severity || null,
      reaction: reactionSource ? String(reactionSource.reaction).trim() : null,
      is_active: true,
      created_at: primary.recorded_at || primary.created_at,
      sources: [...new Set(ordered.map(row => row.source))],
      identifiers,
    });
  }

  return merged.sort((left, right) => {
    const leftTime = Date.parse(left.created_at || '') || 0;
    const rightTime = Date.parse(right.created_at || '') || 0;
    return rightTime - leftTime || left.fhir_id.localeCompare(right.fhir_id);
  });
}

const SQL_UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

// One SQL surface over both allergy stores, evaluated exactly ONCE per read.
// `source_rows` is the union the reader used to materialize wholesale into
// Node; `resolved_rows` adds the identity/allergen derivations that
// `readablePatientUid` / `readableAllergen` compute in JS; `classified_rows`
// adds the defect verdict those JS readers would have thrown on, plus the
// grouping and precedence keys the merge uses. The page and the fail-closed
// integrity probe both read `classified_rows`, so Postgres materializes the
// union once and answers both from it. Splitting them into two statements —
// as the first cut of this change did — scanned the union twice and roughly
// doubled the database work relative to the unpaginated original.
const ALLERGY_CLASSIFIED_ROWS_CTE = `
  source_rows AS (
    SELECT 'patient_allergies'::text AS source,
           allergy.id, allergy.allergy_name, allergy.severity,
           allergy.reaction, allergy.created_at, NULL::timestamptz AS recorded_at,
           (receipt.allergy_id IS NOT NULL) AS has_fhir_receipt,
           allergy.patient_uid::text AS patient_uid_raw,
           allergy.patient_id::text AS patient_id_raw,
           uid_patient.uid::text AS patient_uid_match,
           uid_patient.role::text AS patient_uid_role,
           uid_patient.is_active AS patient_uid_active,
           id_patient.uid::text AS patient_id_match,
           id_patient.role::text AS patient_id_role,
           id_patient.is_active AS patient_id_active
      FROM patient_allergies allergy
      LEFT JOIN users uid_patient
        ON uid_patient.tenant_id = allergy.tenant_id
       AND uid_patient.uid = allergy.patient_uid
      LEFT JOIN users id_patient
        ON id_patient.tenant_id = allergy.tenant_id
       AND id_patient.id = allergy.patient_id
      LEFT JOIN fhir_allergy_intolerance_receipts receipt
        ON receipt.tenant_id = allergy.tenant_id
       AND receipt.allergy_id = allergy.id
     WHERE allergy.tenant_id = $1::uuid
       AND COALESCE(allergy.is_active, TRUE) = TRUE
       AND (
         $2::uuid IS NULL
         OR allergy.patient_uid = $2::uuid
         OR id_patient.uid = $2::uuid
       )
    UNION ALL
    SELECT 'allergies'::text AS source,
           allergy.id,
           COALESCE(NULLIF(allergy.allergen, ''), allergy.name) AS allergy_name,
           allergy.severity, allergy.reaction, allergy.created_at,
           allergy.recorded_at, FALSE AS has_fhir_receipt,
           allergy.patient_uid::text AS patient_uid_raw,
           NULL::text AS patient_id_raw,
           patient.uid::text AS patient_uid_match,
           patient.role::text AS patient_uid_role,
           patient.is_active AS patient_uid_active,
           NULL::text AS patient_id_match,
           NULL::text AS patient_id_role,
           NULL::boolean AS patient_id_active
      FROM allergies allergy
      LEFT JOIN users patient
        ON patient.tenant_id = allergy.tenant_id
       AND patient.uid = allergy.patient_uid
     WHERE allergy.tenant_id = $1::uuid
       AND LOWER(BTRIM(COALESCE(allergy.status, 'active'))) NOT IN (
         'inactive', 'resolved', 'entered-in-error'
       )
       AND ($2::uuid IS NULL OR allergy.patient_uid = $2::uuid)
  ),
  resolved_rows AS (
    SELECT source_rows.*,
           LOWER(NULLIF(BTRIM(COALESCE(patient_uid_match, '')), '')) AS uid_resolved,
           LOWER(NULLIF(BTRIM(COALESCE(patient_id_match, '')), '')) AS id_resolved,
           (NULLIF(BTRIM(COALESCE(patient_uid_raw, '')), '') IS NOT NULL) AS uid_present,
           (NULLIF(BTRIM(COALESCE(patient_id_raw, '')), '') IS NOT NULL) AS id_present,
           NULLIF(REGEXP_REPLACE(BTRIM(COALESCE(allergy_name, '')), '\\s+', ' ', 'g'), '') AS allergen
      FROM source_rows
  ),
  classified_rows AS (
    SELECT resolved_rows.*,
           CASE
             WHEN uid_present
              AND (uid_resolved IS NULL OR uid_resolved !~ '${SQL_UUID_RE}')
               THEN 'identity_unresolved'
             WHEN uid_present
              AND (UPPER(BTRIM(COALESCE(patient_uid_role, ''))) <> 'PATIENT'
                OR patient_uid_active IS DISTINCT FROM TRUE)
               THEN 'identity_invalid'
             WHEN id_present
              AND (id_resolved IS NULL OR id_resolved !~ '${SQL_UUID_RE}')
               THEN 'identity_unresolved'
             WHEN id_present
              AND (UPPER(BTRIM(COALESCE(patient_id_role, ''))) <> 'PATIENT'
                OR patient_id_active IS DISTINCT FROM TRUE)
               THEN 'identity_invalid'
             WHEN uid_present AND id_present
              AND uid_resolved IS DISTINCT FROM id_resolved
               THEN 'identity_conflict'
             WHEN COALESCE(uid_resolved, id_resolved) IS NULL
               THEN 'patient_unresolved'
             WHEN allergen IS NULL
               THEN 'allergen_missing'
             ELSE NULL
           END AS defect,
           CASE
             WHEN source = 'patient_allergies' AND has_fhir_receipt THEN 0
             WHEN source = 'patient_allergies' THEN 1
             ELSE 2
           END AS precedence,
           COALESCE(uid_resolved, id_resolved) AS group_patient_uid,
           LOWER(allergen) AS group_allergen
      FROM resolved_rows
  )`;

// Two dispositions, split on ONE question: does the row carry clinical content
// that a reader could be missing?
//
// REFUSE — the row names a substance and a severity but we cannot tell whose
// allergy it is (unknown uid, a staff/inactive user, uid and id disagreeing).
// Serving the rest could omit a real, named allergy from the very patient being
// read. That is the case fail-closed exists for, and it still refuses the whole
// read rather than serving a page that happens to exclude it. The verdict is
// computed over the WHOLE matching set in `classified_rows`, not just the page.
//
// QUARANTINE — the row cannot be rendered as an AllergyIntolerance at all, and
// no reader is missing anything as a result:
//   * `patient_unresolved` — states no patient key, so it belongs to nobody,
//     can never appear on any patient's list, and is already invisible to every
//     patient-scoped read (the patient filter drops it).
//   * `allergen_missing` — names no substance, so it carries no clinical
//     content; the platform's own allergy source of truth already drops these
//     before the prescription-safety gate (allergySourceService.mergeAllergyRows).
// Both shapes are reachable with real data — `patient_allergies.patient_id` and
// `.patient_uid` are both nullable, as are `allergies.allergen` and `.name` —
// and refusing on them took every patient's allergy list in the tenant down
// with a 500 over a row that told nobody anything. They are excluded from the
// page, counted, and reported. Never served, never silent.
const ALLERGY_INTEGRITY_DEFECTS = {
  identity_unresolved: [
    'FHIR AllergyIntolerance source row has an unresolved patient identity',
    'FHIR_ALLERGY_PATIENT_UNRESOLVED',
  ],
  identity_invalid: [
    'FHIR AllergyIntolerance source row does not belong to an active patient',
    'FHIR_ALLERGY_PATIENT_INVALID',
  ],
  identity_conflict: [
    'FHIR AllergyIntolerance source row has conflicting patient identities',
    'FHIR_ALLERGY_PATIENT_IDENTITY_CONFLICT',
  ],
};

// Anything NOT named here refuses, so a classification added to the SQL without
// a deliberate decision fails safe rather than being served.
const ALLERGY_QUARANTINED_DEFECTS = ['patient_unresolved', 'allergen_missing'];
const ALLERGY_QUARANTINED_DEFECTS_SQL = ALLERGY_QUARANTINED_DEFECTS
  .map(defect => `'${defect}'`)
  .join(', ');

// The verdict an unrecognised classification falls back to. It refuses, and it
// describes the actual situation: the read produced an identity verdict this
// build does not know how to interpret.
const ALLERGY_UNKNOWN_DEFECT = ALLERGY_INTEGRITY_DEFECTS.identity_unresolved;

// How many quarantined row identities are named in the ops log. The count is
// always exact; the sample is bounded so one badly-imported tenant cannot write
// an unbounded log line.
const ALLERGY_QUARANTINE_SAMPLE_LIMIT = 20;

// The page, the refusal verdict AND the quarantine report in one statement over
// one materialization of the union.
//
// `integrity_defect` keeps its ORDER BY so the reported defect stays
// deterministic, but that sort is no longer what forces the union to be
// evaluated: `classified_rows` is materialized for the page regardless, and the
// sort's input is only the rows that already failed `defect IS NOT NULL` —
// zero of them on every healthy read.
//
// `quarantined_rows` re-scans `classified_rows` for the quarantine classes,
// which is NOT the "second materialization of the same wide rows" the comment
// below warns about: it projects three narrow columns of a subset that is empty
// on every healthy read, and it is what lets the read survive a row that tells
// nobody anything instead of 500-ing every patient's allergy list.
//
// The `defect IS NULL` filter is repeated rather than hoisted into its own CTE
// on purpose: a second CTE is a second materialization of the same wide rows,
// which costs more than re-applying a cheap predicate to the tuplestore.
//
// The page filters on `defect IS NULL` where the previous cut filtered on
// `COALESCE(uid_resolved, id_resolved) IS NOT NULL AND allergen IS NOT NULL`.
// The two still agree exactly: those are the two quarantine classes, and the
// refusing classes never reach a served page at all.
//
// `verdict` yields at most ONE row and only when there is something to say, so
// a clean read returns exactly the page rows it always did.
const ALLERGY_PAGE_SQL = `WITH ${ALLERGY_CLASSIFIED_ROWS_CTE},
  integrity_defect AS (
    SELECT defect
      FROM classified_rows
     WHERE defect IS NOT NULL
       AND defect NOT IN (${ALLERGY_QUARANTINED_DEFECTS_SQL})
     ORDER BY CASE WHEN source = 'patient_allergies' THEN 0 ELSE 1 END, id
     LIMIT 1
  ),
  quarantined_rows AS (
    SELECT defect, source, id
      FROM classified_rows
     WHERE defect IN (${ALLERGY_QUARANTINED_DEFECTS_SQL})
  ),
  verdict AS (
    SELECT integrity_defect.defect AS defect,
           counted.row_count AS quarantined_rows,
           counted.sample AS quarantined_sample
      FROM (
        SELECT (SELECT COUNT(*)::int FROM quarantined_rows) AS row_count,
               (SELECT STRING_AGG(
                         capped.defect || ':' || capped.source || ':' || capped.id::text, ','
                         ORDER BY capped.defect, capped.source, capped.id)
                  FROM (
                    SELECT defect, source, id
                      FROM quarantined_rows
                     ORDER BY defect, source, id
                     LIMIT ${ALLERGY_QUARANTINE_SAMPLE_LIMIT}
                  ) capped) AS sample
      ) counted
      LEFT JOIN integrity_defect ON TRUE
     WHERE integrity_defect.defect IS NOT NULL
        OR counted.row_count > 0
  ),
  primaries AS (
    SELECT DISTINCT ON (group_patient_uid, group_allergen)
           group_patient_uid, group_allergen,
           CASE
             WHEN source = 'patient_allergies' THEN 'pa-' || id::text
             ELSE id::text
           END AS fhir_id,
           COALESCE(recorded_at, created_at) AS sort_at
      FROM classified_rows
     WHERE defect IS NULL
     ORDER BY group_patient_uid, group_allergen, precedence, id
  ),
  page AS (
    SELECT group_patient_uid, group_allergen
      FROM primaries
     ORDER BY sort_at DESC NULLS LAST, fhir_id COLLATE "C" ASC
     LIMIT $3::integer OFFSET $4::integer
  )
  SELECT NULL::text AS integrity_defect,
         NULL::int AS quarantined_rows,
         NULL::text AS quarantined_sample,
         classified_rows.source, classified_rows.id, classified_rows.allergy_name,
         classified_rows.severity, classified_rows.reaction, classified_rows.created_at,
         classified_rows.recorded_at, classified_rows.has_fhir_receipt,
         classified_rows.patient_uid_raw, classified_rows.patient_id_raw,
         classified_rows.patient_uid_match, classified_rows.patient_uid_role,
         classified_rows.patient_uid_active, classified_rows.patient_id_match,
         classified_rows.patient_id_role, classified_rows.patient_id_active
    FROM classified_rows
    JOIN page
      ON page.group_patient_uid = classified_rows.group_patient_uid
     AND page.group_allergen = classified_rows.group_allergen
   WHERE classified_rows.defect IS NULL
  UNION ALL
  SELECT verdict.defect,
         verdict.quarantined_rows,
         verdict.quarantined_sample,
         NULL::text, NULL::integer, NULL::varchar,
         NULL::varchar, NULL::text, NULL::timestamptz,
         NULL::timestamptz, NULL::boolean,
         NULL::text, NULL::text,
         NULL::text, NULL::text,
         NULL::boolean, NULL::text,
         NULL::text, NULL::boolean
    FROM verdict`;

async function findReceipt(tx, { tenantId, resourceFingerprint }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT receipt.tenant_id::text, receipt.resource_fingerprint,
            receipt.payload_sha256, receipt.patient_uid::text,
            receipt.allergy_id, receipt.timeline_event_id::text,
            receipt.audit_event_id::text, receipt.recorded_at,
            allergy.id, allergy.allergy_name, allergy.severity, allergy.reaction,
            allergy.is_active, allergy.created_at
       FROM fhir_allergy_intolerance_receipts receipt
       JOIN patient_allergies allergy
         ON allergy.tenant_id = receipt.tenant_id
        AND allergy.id = receipt.allergy_id
      WHERE receipt.tenant_id = $1::uuid
        AND receipt.resource_fingerprint = $2
      LIMIT 1`,
    tenantId,
    resourceFingerprint,
  );
  return rows[0] || null;
}

function assertMatchingReceipt(receipt, { patientUid, payloadSha256 }) {
  if (
    String(receipt.patient_uid).toLowerCase() !== patientUid
    || receipt.payload_sha256 !== payloadSha256
  ) {
    throw AppError.conflict(
      'This patient and allergen were already recorded with different clinical content',
      'FHIR_ALLERGY_RECEIPT_IDENTITY_DRIFT',
    );
  }
}

async function findUnreceiptedAllergy(tx, {
  tenantId, patientUid, allergen, severity, reaction,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT allergy.id, allergy.patient_uid::text, allergy.allergy_name,
            allergy.severity, allergy.reaction, allergy.is_active,
            allergy.created_at
       FROM patient_allergies allergy
       LEFT JOIN fhir_allergy_intolerance_receipts receipt
         ON receipt.tenant_id = allergy.tenant_id
        AND receipt.allergy_id = allergy.id
      WHERE allergy.tenant_id = $1::uuid
        AND allergy.patient_uid = $2::uuid
        AND LOWER(REGEXP_REPLACE(BTRIM(allergy.allergy_name), '\\s+', ' ', 'g')) = LOWER($3)
        AND UPPER(COALESCE(allergy.severity, 'MILD')) = $4
        AND LOWER(COALESCE(REGEXP_REPLACE(BTRIM(allergy.reaction), '\\s+', ' ', 'g'), '')) = LOWER(COALESCE($5, ''))
        AND allergy.is_active IS NOT FALSE
        AND receipt.allergy_id IS NULL
      ORDER BY allergy.created_at ASC NULLS LAST, allergy.id ASC
      LIMIT 1
      FOR UPDATE OF allergy`,
    tenantId,
    patientUid,
    allergen,
    severity,
    reaction,
  );
  return rows[0] || null;
}

async function assertClinicalPatient(tx, { tenantId, patientUid }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT uid::text
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = true
        AND UPPER(BTRIM(COALESCE(role::text, ''))) = 'PATIENT'
      LIMIT 1
      FOR SHARE`,
    tenantId,
    patientUid,
  );
  if (!rows[0]) {
    throw AppError.notFound(
      'FHIR AllergyIntolerance patient not found',
      'FHIR_ALLERGY_PATIENT_INVALID',
    );
  }
}

export async function createFhirAllergyIntolerance(input = {}) {
  const normalized = normalizeAllergyInput(input);
  const {
    tenantId,
    patientUid,
    allergen,
    severity,
    reaction,
    resourceFingerprint,
    payloadSha256,
  } = normalized;

  return setTenantTx(tenantId, async (tx) => {
    await assertClinicalPatient(tx, { tenantId, patientUid });

    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(
         pg_catalog.hashtextextended($1::text, 666)
       )::text AS lock_result`,
      `${tenantId}:fhir-allergy:${resourceFingerprint}`,
    );

    const existing = await findReceipt(tx, { tenantId, resourceFingerprint });
    if (existing) {
      assertMatchingReceipt(existing, { patientUid, payloadSha256 });
      return { created: false, duplicate: true, allergy: publicAllergy(existing), receipt: existing };
    }

    let detail = await findUnreceiptedAllergy(tx, {
      tenantId,
      patientUid,
      allergen,
      severity,
      reaction,
    });
    const adopted = Boolean(detail);
    if (!detail) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO patient_allergies
           (patient_uid, allergy_name, severity, reaction, is_active, tenant_id, created_at)
         VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())
         RETURNING id, patient_uid::text, allergy_name, severity, reaction,
                   is_active, created_at`,
        patientUid,
        allergen,
        severity,
        reaction,
        tenantId,
      );
      detail = rows[0];
    }

    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      eventType: 'allergy.recorded',
      eventStatus: 'active',
      sourceTable: 'patient_allergies',
      sourceId: String(detail.id),
      resourceType: 'allergy',
      resourceId: String(detail.id),
      actorUid: input.actorUid || null,
      actorRole: input.actorRole || 'FHIR_CLIENT',
      visibleToPatient: true,
      requestId: input.requestId || null,
      summary: `Allergy recorded: ${detail.allergy_name}`,
      payload: {
        allergy_id: detail.id,
        allergy_name: detail.allergy_name,
        severity: detail.severity,
        reaction: detail.reaction,
        status: 'active',
        source: 'FHIR R4',
      },
      afterState: {
        allergy_id: detail.id,
        allergy_name: detail.allergy_name,
        severity: detail.severity,
        reaction: detail.reaction,
        adopted_existing_detail: adopted,
      },
      metadata: {
        protocol: 'FHIR R4',
        resource_type: 'AllergyIntolerance',
        resource_fingerprint: resourceFingerprint,
        payload_sha256: payloadSha256,
      },
      timelineIdempotencyKey: `fhir-allergy:${tenantId}:${resourceFingerprint}:timeline`,
      auditIdempotencyKey: `fhir-allergy:${tenantId}:${resourceFingerprint}:audit`,
    }, { db: tx, strict: true });

    const receipts = await tx.$queryRawUnsafe(
      `INSERT INTO fhir_allergy_intolerance_receipts
         (tenant_id, resource_fingerprint, payload_sha256, patient_uid,
          allergy_id, timeline_event_id, audit_event_id)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6::uuid, $7::uuid)
       RETURNING tenant_id::text, resource_fingerprint, payload_sha256,
                 patient_uid::text, allergy_id, timeline_event_id::text,
                 audit_event_id::text, recorded_at`,
      tenantId,
      resourceFingerprint,
      payloadSha256,
      patientUid,
      detail.id,
      canonical.timeline.id,
      canonical.audit.id,
    );

    return {
      created: !adopted,
      duplicate: adopted,
      allergy: publicAllergy(detail),
      receipt: receipts[0],
    };
  });
}

export async function listFhirAllergyIntolerances(input = {}) {
  const tenantId = requiredUuid(input.tenantId, 'FHIR tenant id');
  const patientUid = input.patientUid == null || input.patientUid === ''
    ? null
    : requiredUuid(input.patientUid, 'FHIR patient id');
  const limit = Number.parseInt(input.limit, 10);
  const offset = Number.parseInt(input.offset, 10);
  const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 1000) : 200;
  const boundedOffset = Number.isInteger(offset) ? Math.max(offset, 0) : 0;

  // The union, the duplicate collapse, the page boundary, the fail-closed
  // integrity verdict AND the quarantine report are all resolved by one
  // statement over one materialization of the union, so only the rows backing
  // the requested page cross the wire and the union is read once per request
  // rather than once per concern. Folding the probe in also closes the window in
  // which a row could turn unreadable between a separate probe statement and the
  // page statement.
  const rows = await setTenantTx(tenantId, async (tx) => tx.$queryRawUnsafe(
    ALLERGY_PAGE_SQL,
    tenantId,
    patientUid,
    boundedLimit,
    boundedOffset,
  ));

  // At most one verdict row rides alongside the page, and only when the read
  // has something to report.
  const isVerdictRow = row => row.integrity_defect != null || row.quarantined_rows != null;
  const verdict = rows.find(isVerdictRow);

  // Refuse the whole read before building anything, exactly as the standalone
  // probe did: one MIS-ATTRIBUTED row anywhere in the matching set still fails
  // closed rather than serving a page that happens to exclude it.
  if (verdict?.integrity_defect) {
    const [message, code] = ALLERGY_INTEGRITY_DEFECTS[verdict.integrity_defect]
      || ALLERGY_UNKNOWN_DEFECT;
    throw AppError.internal(message, code);
  }

  // Quarantined rows are the other half of that decision: they carry nothing a
  // reader could be missing, so they are excluded from the page rather than
  // allowed to hide every patient's allergy list behind a 500. Excluding them
  // silently would be its own failure, so the read reports them — count exact,
  // identities bounded, and no PHI (the sample is a defect class, a table name
  // and a row id; neither class names a patient or a substance).
  const quarantined = Number(verdict?.quarantined_rows || 0);
  if (quarantined > 0) {
    logger.warn(
      'FHIR AllergyIntolerance read excluded unrenderable source rows',
      {
        code: 'FHIR_ALLERGY_SOURCE_QUARANTINED',
        tenantId,
        patientScoped: patientUid != null,
        excludedRows: quarantined,
        sample: verdict.quarantined_sample,
      },
    );
  }

  // The page's rows still go through the same merge, so severity ranking,
  // reaction selection, identifiers, and the response shape are unchanged. The
  // verdict columns are stripped here so they can never reach a response body.
  const pageRows = rows
    .filter(row => !isVerdictRow(row))
    .map(({
      integrity_defect: _verdict,
      quarantined_rows: _excluded,
      quarantined_sample: _sample,
      ...row
    }) => row);
  return mergeReadableAllergyRows(pageRows).map(publicAllergy);
}

export const __testing__ = {
  ALLERGY_PAGE_SQL,
  allergyIdentityFingerprint,
  allergyPayloadFingerprint,
  mergeReadableAllergyRows,
  normalizeAllergyInput,
  publicAllergy,
};

export default {
  createFhirAllergyIntolerance,
  listFhirAllergyIntolerances,
};
