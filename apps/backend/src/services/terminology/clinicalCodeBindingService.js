// Structured clinical code bindings for diagnoses and problem-list rows.

import prisma from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { normalizeSystemKey } from './terminologyService.js';

// Migration 297 originally allowed diagnosis + patient_problem; migration 720
// widened the CHECK to the downstream document surfaces (WP2). Keep this set
// in lockstep with chk_clinical_code_bindings_resource_type.
const RESOURCE_TYPES = new Set([
  'diagnosis',
  'patient_problem',
  'death_certificate',
  'insurance_preauth',
  'insurance_claim',
  'discharge_summary',
]);
const SOURCE_VALUES = new Set(['manual', 'who_icd_api', 'fhir_import', 'legacy', 'system']);
const ICD11_SYSTEM_URI = 'http://id.who.int/icd/release/11/mms';
const ICD10_SYSTEM_URI = 'http://hl7.org/fhir/sid/icd-10';

function clean(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

export function systemUriForKey(systemKey, coding = {}) {
  if (coding.system_uri) return coding.system_uri;
  if (coding.system) {
    const raw = String(coding.system);
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  }
  if (systemKey === 'ICD11') return coding.linearization_uri || ICD11_SYSTEM_URI;
  if (systemKey === 'ICD10') return ICD10_SYSTEM_URI;
  if (systemKey === 'SNOMED_CT') return 'http://snomed.info/sct';
  if (systemKey === 'LOINC') return 'http://loinc.org';
  if (systemKey === 'ATC') return 'http://www.whocc.no/atc';
  return systemKey;
}

export function normalizeClinicalCodings(codings = []) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(codings) ? codings : []) {
    if (!item || typeof item !== 'object') continue;
    const systemKey = normalizeSystemKey(item.system_key || item.system || item.system_uri);
    const code = clean(item.code);
    if (!systemKey || !code) continue;
    const codingRole = clean(item.coding_role) || 'diagnosis';
    const key = `${systemKey}\u0000${code.toUpperCase()}\u0000${codingRole}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = SOURCE_VALUES.has(item.source) ? item.source : (
      systemKey === 'ICD11' ? 'who_icd_api' : 'manual'
    );
    out.push({
      system_key: systemKey,
      system: systemUriForKey(systemKey, item),
      code,
      display: clean(item.display),
      release_id: clean(item.release_id),
      language: clean(item.language),
      linearization_uri: clean(item.linearization_uri),
      foundation_uri: clean(item.foundation_uri),
      coding_role: codingRole,
      source,
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
    });
  }
  return out;
}

export function legacyIcd10Coding({ code, display, source = 'legacy' } = {}) {
  const cleaned = clean(code);
  if (!cleaned) return null;
  return {
    system: ICD10_SYSTEM_URI,
    system_key: 'ICD10',
    code: cleaned.toUpperCase(),
    display: clean(display),
    coding_role: 'diagnosis',
    source,
  };
}

export function mergeClinicalCodings(...sets) {
  return normalizeClinicalCodings(sets.flat().filter(Boolean));
}

function assertResourceType(resourceType) {
  if (!RESOURCE_TYPES.has(resourceType)) {
    throw new Error(`Unsupported clinical coding resource_type '${resourceType}'`);
  }
}

export async function replaceResourceCodings({
  db = prisma,
  resourceType,
  resourceId,
  tenantId = null,
  patientUid = null,
  codings = [],
  createdBy = null,
} = {}) {
  assertResourceType(resourceType);
  const id = String(resourceId || '').trim();
  if (!id) throw new Error('resourceId is required for clinical code bindings');
  const normalized = normalizeClinicalCodings(codings);

  await db.$executeRawUnsafe(
    `DELETE FROM clinical_code_bindings WHERE resource_type = $1 AND resource_id = $2`,
    resourceType,
    id,
  );
  for (const coding of normalized) {
    await db.$executeRawUnsafe(
      `INSERT INTO clinical_code_bindings
         (tenant_id, patient_uid, resource_type, resource_id, system_key, code, display,
          release_id, language, linearization_uri, foundation_uri, coding_role,
          source, metadata, created_by)
       VALUES (COALESCE($1::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
               $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::uuid)
       ON CONFLICT (resource_type, resource_id, system_key, code, coding_role)
       DO UPDATE SET
         display = EXCLUDED.display,
         release_id = EXCLUDED.release_id,
         language = EXCLUDED.language,
         linearization_uri = EXCLUDED.linearization_uri,
         foundation_uri = EXCLUDED.foundation_uri,
         source = EXCLUDED.source,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      tenantId,
      patientUid,
      resourceType,
      id,
      coding.system_key,
      coding.code,
      coding.display,
      coding.release_id,
      coding.language,
      coding.linearization_uri,
      coding.foundation_uri,
      coding.coding_role,
      coding.source,
      JSON.stringify(coding.metadata || {}),
      createdBy,
    );
  }
  return normalized;
}

export async function listResourceCodings({ db = prisma, resourceType, resourceId } = {}) {
  assertResourceType(resourceType);
  const rows = await db.$queryRawUnsafe(
    `SELECT system_key, code, display, release_id, language, linearization_uri,
            foundation_uri, coding_role, source, metadata, created_at, updated_at
       FROM clinical_code_bindings
      WHERE resource_type = $1 AND resource_id = $2
      ORDER BY
        CASE system_key WHEN 'ICD11' THEN 1 WHEN 'ICD10' THEN 2 WHEN 'SNOMED_CT' THEN 3 ELSE 4 END,
        code`,
    resourceType,
    String(resourceId),
  );
  return rows.map((row) => ({
    ...row,
    system: systemUriForKey(row.system_key, row),
  }));
}

export async function attachResourceCodings(rows, {
  db = prisma,
  resourceType,
  idField = 'id',
  tenantId = null,
} = {}) {
  assertResourceType(resourceType);
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const ids = rows.map((row) => String(row[idField])).filter(Boolean);
  if (ids.length === 0) return rows;
  // Tenant-scope the lookup (audit / cross-tenant fix): clinical_code_bindings
  // carries tenant_id (migration 297) but this query previously matched on
  // resource_type + resource_id only. resource_id values are per-table SERIAL
  // ids shared across tenants, so an id collision attached another tenant's
  // ICD-10/SNOMED codings to this tenant's diagnoses/problem rows. The tenant
  // predicate is load-bearing defense-in-depth even before the RLS enforce
  // flip. requireTenantId keeps the house fail-closed semantics: a falsy
  // tenant throws unless ALLOW_DEFAULT_TENANT single-tenant floor is on.
  const scopedTenantId = requireTenantId(tenantId);
  const bindings = await db.$queryRawUnsafe(
    `SELECT resource_id, system_key, code, display, release_id, language,
            linearization_uri, foundation_uri, coding_role, source, metadata
       FROM clinical_code_bindings
      WHERE resource_type = $1 AND resource_id = ANY($2::text[])
        AND tenant_id = $3::uuid
      ORDER BY resource_id,
        CASE system_key WHEN 'ICD11' THEN 1 WHEN 'ICD10' THEN 2 WHEN 'SNOMED_CT' THEN 3 ELSE 4 END,
        code`,
    resourceType,
    ids,
    scopedTenantId,
  );
  const byId = new Map();
  for (const row of bindings) {
    const list = byId.get(row.resource_id) || [];
    list.push({ ...row, system: systemUriForKey(row.system_key, row) });
    byId.set(row.resource_id, list);
  }
  for (const row of rows) {
    row.codings = byId.get(String(row[idField])) || [];
  }
  return rows;
}

export default {
  normalizeClinicalCodings,
  mergeClinicalCodings,
  legacyIcd10Coding,
  replaceResourceCodings,
  listResourceCodings,
  attachResourceCodings,
  systemUriForKey,
};
