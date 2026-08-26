import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { canonicalizeRequestRole } from '../../utils/roles.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { resolveCurrentHumanActorTx } from '../workflow/workflowHumanOwnerService.js';
import {
  assertNoOverlappingCatalogScopes,
  normalizeCatalogEntryInput,
  normalizePolicyRuleInput,
  policyContentSha256,
} from './labThresholdPolicyContract.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RULES = 1000;
const MAX_LIST = 500;
const POLICY_AUTHOR_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'LAB_INCHARGE']);
const POLICY_APPROVER_ROLES = new Set(['PATHOLOGIST']);
const POLICY_ACTIVATOR_ROLES = new Set(['SUPER_ADMIN']);

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function uuid(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw AppError.badRequest(`${label} must be a UUID`);
  return normalized;
}

function requiredText(value, label, max) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw AppError.badRequest(`${label} is required`);
  if (normalized.length > max) {
    throw AppError.badRequest(`${label} must be at most ${max} characters`);
  }
  return normalized;
}

function metadata(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('metadata must be an object');
  }
  return value;
}

function timestamp(value, label, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw AppError.badRequest(`${label} must be a timestamp`);
  return parsed;
}

function sha256(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw AppError.badRequest(`${label} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

async function requireCurrentGovernanceActorTx(tx, {
  tenantId,
  actorUid,
  actorRole,
  allowedRoles,
}) {
  const allowedCanonicalRoles = new Set(
    [...allowedRoles].map(canonicalizeRequestRole).filter(Boolean),
  );
  const currentActor = await resolveCurrentHumanActorTx({
    tx,
    tenantId,
    actorUid,
    authenticatedRoles: [actorRole],
    authenticatedPrimaryRole: actorRole,
    authenticatedRawRole: actorRole,
    rolePredicate: role => allowedCanonicalRoles.has(role),
  });
  if (!allowedRoles.has(currentActor.rawRole)) {
    throw AppError.forbidden(
      'Current actor is not authorized for this work item',
      'CURRENT_HUMAN_ACTOR_FORBIDDEN',
    );
  }
  return currentActor;
}

async function auditTx(tx, {
  tenantId,
  actorUid,
  actorRole,
  action,
  resource,
  resourceId,
  details = {},
}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, actor_uid, role, action, resource, resource_id, metadata, created_at)
     VALUES ($1::uuid, $2::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, NOW())`,
    tenantId,
    actorUid,
    actorRole || null,
    action,
    resource,
    String(resourceId),
    JSON.stringify(details),
  );
}

async function lockCatalogStateTx(tx, { tenantId, facilityId, actorUid }) {
  const facilities = await tx.$queryRawUnsafe(
    `SELECT id
       FROM facilities
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND status = 'active'
      LIMIT 1`,
    tenantId,
    facilityId,
  );
  if (!facilities[0]) throw AppError.notFound('Active facility not found');

  await tx.$executeRawUnsafe(
    `INSERT INTO lab_threshold_catalog_states
       (tenant_id, facility_id, current_revision, updated_by, updated_at)
     VALUES ($1::uuid, $2::int, 0, $3::uuid, NOW())
     ON CONFLICT (tenant_id, facility_id) DO NOTHING`,
    tenantId,
    facilityId,
    actorUid,
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT tenant_id, facility_id, current_revision, updated_by, updated_at
       FROM lab_threshold_catalog_states
      WHERE tenant_id = $1::uuid
        AND facility_id = $2::int
      FOR UPDATE`,
    tenantId,
    facilityId,
  );
  if (!rows[0]) throw AppError.conflict('Lab threshold catalogue state is unavailable');
  return rows[0];
}

async function currentCatalogEntriesTx(tx, { tenantId, facilityId }) {
  return tx.$queryRawUnsafe(
    `SELECT id, tenant_id, facility_id, introduced_revision, retired_revision,
            test_code, loinc_code, test_name, specimen_type, evaluation_mode,
            unit, normalized_unit,
            sex, age_min_days, age_max_days, pregnancy_scope,
            criticality_required, exemption_reason, created_by, created_at, metadata
       FROM lab_threshold_catalog_entries
      WHERE tenant_id = $1::uuid
        AND facility_id = $2::int
        AND retired_revision IS NULL
      ORDER BY upper(test_code), loinc_code NULLS LAST, specimen_type,
               normalized_unit, sex NULLS FIRST, age_min_days NULLS FIRST, id`,
    tenantId,
    facilityId,
  );
}

async function catalogEntriesAtRevisionTx(tx, { tenantId, facilityId, revision }) {
  return tx.$queryRawUnsafe(
    `SELECT id, tenant_id, facility_id, introduced_revision, retired_revision,
            test_code, loinc_code, test_name, specimen_type, evaluation_mode,
            unit, normalized_unit,
            sex, age_min_days, age_max_days, pregnancy_scope,
            criticality_required, exemption_reason, created_by, created_at, metadata
       FROM lab_threshold_catalog_entries
      WHERE tenant_id = $1::uuid
        AND facility_id = $2::int
        AND introduced_revision <= $3::int
        AND (retired_revision IS NULL OR retired_revision > $3::int)
      ORDER BY upper(test_code), loinc_code NULLS LAST, specimen_type,
               normalized_unit, sex NULLS FIRST, age_min_days NULLS FIRST, id`,
    tenantId,
    facilityId,
    revision,
  );
}

async function bundleForUpdateTx(tx, { tenantId, bundleId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, tenant_id, facility_id, bundle_version, catalog_revision,
            lifecycle_status, source_reference, content_sha256,
            effective_from, effective_until, created_by, created_at,
            submitted_by, submitted_at, approved_by, approved_at,
            approval_reason, approval_evidence_reference,
            approval_evidence_sha256, activated_by, activated_at,
            superseded_by_bundle_id, superseded_at, rejected_by,
            rejected_at, rejection_reason, metadata, updated_at
       FROM lab_threshold_policy_bundles
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    bundleId,
  );
  if (!rows[0]) throw AppError.notFound('Lab threshold policy bundle not found');
  return rows[0];
}

async function bundleRulesTx(tx, { tenantId, bundleId }) {
  return tx.$queryRawUnsafe(
    `SELECT id, tenant_id, facility_id, bundle_id, catalog_entry_id,
            reference_low, reference_high, critical_low, critical_high,
            notes, created_by, created_at, updated_at
       FROM lab_threshold_policy_rules
      WHERE tenant_id = $1::uuid
        AND bundle_id = $2::uuid
      ORDER BY catalog_entry_id, id`,
    tenantId,
    bundleId,
  );
}

async function coverageReportTx(tx, bundle) {
  const states = await tx.$queryRawUnsafe(
    `SELECT current_revision
       FROM lab_threshold_catalog_states
      WHERE tenant_id = $1::uuid
        AND facility_id = $2::int
      LIMIT 1`,
    bundle.tenant_id,
    Number(bundle.facility_id),
  );
  const currentRevision = Number(states[0]?.current_revision ?? -1);
  const entries = await catalogEntriesAtRevisionTx(tx, {
    tenantId: bundle.tenant_id,
    facilityId: Number(bundle.facility_id),
    revision: Number(bundle.catalog_revision),
  });
  assertNoOverlappingCatalogScopes(entries);
  const rules = await bundleRulesTx(tx, {
    tenantId: bundle.tenant_id,
    bundleId: bundle.id,
  });
  const ruleByEntry = new Map(rules.map((rule) => [String(rule.catalog_entry_id), rule]));
  const blockers = [];
  if (currentRevision !== Number(bundle.catalog_revision)) {
    blockers.push({
      code: 'CATALOG_REVISION_STALE',
      expected_revision: Number(bundle.catalog_revision),
      current_revision: currentRevision,
    });
  }
  if (entries.length === 0) blockers.push({ code: 'CATALOG_EMPTY' });

  const coverage = entries.map((entry) => {
    const rule = ruleByEntry.get(String(entry.id)) || null;
    const missing = [];
    if (entry.evaluation_mode === 'qualitative_exempt') {
      if (rule) missing.push('numeric_rule_must_be_absent');
    } else if (!rule) {
      missing.push('rule');
    } else {
      if (rule.reference_low == null && rule.reference_high == null) {
        missing.push('reference_bound');
      }
      if (
        entry.criticality_required === true
        && rule.critical_low == null
        && rule.critical_high == null
      ) missing.push('critical_bound');
    }
    if (missing.length) {
      blockers.push({
        code: 'CATALOG_ENTRY_UNCOVERED',
        catalog_entry_id: String(entry.id),
        missing,
      });
    }
    return { entry, rule, covered: missing.length === 0, missing };
  });
  const extraRuleIds = rules
    .filter((rule) => !entries.some((entry) => String(entry.id) === String(rule.catalog_entry_id)))
    .map((rule) => String(rule.id));
  if (extraRuleIds.length) blockers.push({ code: 'STALE_POLICY_RULES', rule_ids: extraRuleIds });

  return {
    bundle_id: String(bundle.id),
    facility_id: Number(bundle.facility_id),
    bundle_version: Number(bundle.bundle_version),
    catalog_revision: Number(bundle.catalog_revision),
    current_catalog_revision: currentRevision,
    entry_count: entries.length,
    covered_count: coverage.filter((row) => row.covered).length,
    missing_count: coverage.filter((row) => !row.covered).length,
    activatable: blockers.length === 0,
    blockers,
    coverage,
    entries,
    rules,
  };
}

function requireActivatable(report) {
  if (report.activatable) return;
  throw AppError.conflict(
    'Lab threshold policy bundle does not cover the current facility catalogue',
    'LAB_THRESHOLD_POLICY_COVERAGE_INCOMPLETE',
    { blockers: report.blockers },
  );
}

export async function listLabThresholdCatalog({ tenantId, facilityId }) {
  const tid = requireTenantId(tenantId);
  const facility = positiveInteger(facilityId, 'facility_id');
  return setTenantTx(tid, async (tx) => {
    const stateRows = await tx.$queryRawUnsafe(
      `SELECT current_revision, updated_by, updated_at
         FROM lab_threshold_catalog_states
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      tid,
      facility,
    );
    const entries = await currentCatalogEntriesTx(tx, { tenantId: tid, facilityId: facility });
    return {
      facility_id: facility,
      current_revision: Number(stateRows[0]?.current_revision ?? 0),
      entries,
    };
  });
}

export async function addLabThresholdCatalogEntry({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  entry,
  metadata: entryMetadata = null,
}) {
  const tid = requireTenantId(tenantId);
  const facility = positiveInteger(facilityId, 'facility_id');
  const actor = uuid(actorUid, 'actor_uid');
  const normalized = normalizeCatalogEntryInput(entry);
  const criticalityRequired = normalized.criticalityRequired;
  return setTenantTx(tid, async (tx) => {
    const currentActor = await requireCurrentGovernanceActorTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole,
      allowedRoles: POLICY_AUTHOR_ROLES,
    });
    const state = await lockCatalogStateTx(tx, {
      tenantId: tid,
      facilityId: facility,
      actorUid: actor,
    });
    const current = await currentCatalogEntriesTx(tx, { tenantId: tid, facilityId: facility });
    assertNoOverlappingCatalogScopes([
      ...current,
      {
        ...normalized,
        id: null,
        test_code: normalized.testCode,
        loinc_code: normalized.loincCode,
        specimen_type: normalized.specimenType,
        evaluation_mode: normalized.evaluationMode,
        normalized_unit: normalized.normalizedUnit,
        age_min_days: normalized.ageMinDays,
        age_max_days: normalized.ageMaxDays,
        pregnancy_scope: normalized.pregnancyScope,
      },
    ]);
    const revision = Number(state.current_revision) + 1;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO lab_threshold_catalog_entries
         (tenant_id, facility_id, introduced_revision, test_code, loinc_code,
          test_name, specimen_type, evaluation_mode, unit, normalized_unit,
          sex, age_min_days, age_max_days, pregnancy_scope,
          criticality_required, exemption_reason, created_by, metadata)
       VALUES ($1::uuid, $2::int, $3::int, $4, $5, $6, $7, $8, $9, $10,
               $11, $12::int, $13::int, $14, $15::boolean, $16, $17::uuid, $18::jsonb)
       RETURNING id, tenant_id, facility_id, introduced_revision, retired_revision,
                 test_code, loinc_code, test_name, specimen_type, evaluation_mode,
                 unit, normalized_unit, sex, age_min_days, age_max_days,
                 pregnancy_scope, criticality_required, exemption_reason,
                 created_by, created_at, metadata`,
      tid,
      facility,
      revision,
      normalized.testCode,
      normalized.loincCode,
      normalized.testName,
      normalized.specimenType,
      normalized.evaluationMode,
      normalized.unit,
      normalized.normalizedUnit,
      normalized.sex,
      normalized.ageMinDays,
      normalized.ageMaxDays,
      normalized.pregnancyScope,
      criticalityRequired,
      normalized.exemptionReason,
      actor,
      JSON.stringify(metadata(entryMetadata)),
    );
    await tx.$executeRawUnsafe(
      `UPDATE lab_threshold_catalog_states
          SET current_revision = $3::int, updated_by = $4::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      tid,
      facility,
      revision,
      actor,
    );
    await auditTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole: currentActor.rawRole,
      action: 'LAB_THRESHOLD_CATALOG_ENTRY_ADDED',
      resource: 'lab_threshold_catalog_entries',
      resourceId: rows[0].id,
      details: { facility_id: facility, catalog_revision: revision },
    });
    return { entry: rows[0], current_revision: revision };
  });
}

export async function retireLabThresholdCatalogEntry({
  tenantId,
  facilityId,
  catalogEntryId,
  reason,
  actorUid,
  actorRole,
}) {
  const tid = requireTenantId(tenantId);
  const facility = positiveInteger(facilityId, 'facility_id');
  const entryId = uuid(catalogEntryId, 'catalog_entry_id');
  const actor = uuid(actorUid, 'actor_uid');
  const retirementReason = requiredText(reason, 'reason', 500);
  return setTenantTx(tid, async (tx) => {
    const currentActor = await requireCurrentGovernanceActorTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole,
      allowedRoles: POLICY_AUTHOR_ROLES,
    });
    const state = await lockCatalogStateTx(tx, {
      tenantId: tid,
      facilityId: facility,
      actorUid: actor,
    });
    const revision = Number(state.current_revision) + 1;
    const rows = await tx.$queryRawUnsafe(
      `UPDATE lab_threshold_catalog_entries
          SET retired_revision = $4::int, retired_by = $5::uuid,
              retired_at = NOW(), retirement_reason = $6
        WHERE tenant_id = $1::uuid
          AND facility_id = $2::int
          AND id = $3::uuid
          AND retired_revision IS NULL
      RETURNING id, test_code, loinc_code, specimen_type, unit, retired_revision`,
      tid,
      facility,
      entryId,
      revision,
      actor,
      retirementReason,
    );
    if (!rows[0]) throw AppError.notFound('Active lab threshold catalogue entry not found');
    await tx.$executeRawUnsafe(
      `UPDATE lab_threshold_catalog_states
          SET current_revision = $3::int, updated_by = $4::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      tid,
      facility,
      revision,
      actor,
    );
    await auditTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole: currentActor.rawRole,
      action: 'LAB_THRESHOLD_CATALOG_ENTRY_RETIRED',
      resource: 'lab_threshold_catalog_entries',
      resourceId: entryId,
      details: { facility_id: facility, catalog_revision: revision, reason: retirementReason },
    });
    return { entry: rows[0], current_revision: revision };
  });
}

export async function createLabThresholdPolicyBundle({
  tenantId,
  facilityId,
  actorUid,
  actorRole,
  metadata: bundleMetadata = null,
}) {
  const tid = requireTenantId(tenantId);
  const facility = positiveInteger(facilityId, 'facility_id');
  const actor = uuid(actorUid, 'actor_uid');
  return setTenantTx(tid, async (tx) => {
    const currentActor = await requireCurrentGovernanceActorTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole,
      allowedRoles: POLICY_AUTHOR_ROLES,
    });
    const state = await lockCatalogStateTx(tx, {
      tenantId: tid,
      facilityId: facility,
      actorUid: actor,
    });
    if (Number(state.current_revision) < 1) {
      throw AppError.conflict(
        'A facility catalogue entry is required before creating a threshold bundle',
        'LAB_THRESHOLD_CATALOG_EMPTY',
      );
    }
    const versions = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(bundle_version), 0) + 1 AS next_version
         FROM lab_threshold_policy_bundles
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      tid,
      facility,
    );
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO lab_threshold_policy_bundles
         (tenant_id, facility_id, bundle_version, catalog_revision,
          lifecycle_status, created_by, metadata)
       VALUES ($1::uuid, $2::int, $3::int, $4::int, 'draft', $5::uuid, $6::jsonb)
       RETURNING id, tenant_id, facility_id, bundle_version, catalog_revision,
                 lifecycle_status, created_by, created_at, metadata, updated_at`,
      tid,
      facility,
      Number(versions[0].next_version),
      Number(state.current_revision),
      actor,
      JSON.stringify(metadata(bundleMetadata)),
    );
    await auditTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole: currentActor.rawRole,
      action: 'LAB_THRESHOLD_POLICY_BUNDLE_CREATED',
      resource: 'lab_threshold_policy_bundles',
      resourceId: rows[0].id,
      details: {
        facility_id: facility,
        bundle_version: Number(rows[0].bundle_version),
        catalog_revision: Number(rows[0].catalog_revision),
      },
    });
    return rows[0];
  });
}

export async function replaceLabThresholdPolicyRules({
  tenantId,
  bundleId,
  actorUid,
  actorRole,
  rules,
}) {
  const tid = requireTenantId(tenantId);
  const policyBundleId = uuid(bundleId, 'bundle_id');
  const actor = uuid(actorUid, 'actor_uid');
  if (!Array.isArray(rules) || rules.length > MAX_RULES) {
    throw AppError.badRequest(`rules must contain 0 to ${MAX_RULES} entries`);
  }
  return setTenantTx(tid, async (tx) => {
    const currentActor = await requireCurrentGovernanceActorTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole,
      allowedRoles: POLICY_AUTHOR_ROLES,
    });
    const bundle = await bundleForUpdateTx(tx, { tenantId: tid, bundleId: policyBundleId });
    if (bundle.lifecycle_status !== 'draft') {
      throw AppError.conflict('Only a draft lab threshold bundle can be edited');
    }
    const entries = await catalogEntriesAtRevisionTx(tx, {
      tenantId: tid,
      facilityId: Number(bundle.facility_id),
      revision: Number(bundle.catalog_revision),
    });
    const entryById = new Map(entries.map((entry) => [String(entry.id), entry]));
    const seen = new Set();
    const normalizedRules = rules.map((rule) => {
      const entryId = uuid(rule.catalog_entry_id ?? rule.catalogEntryId, 'catalog_entry_id');
      if (seen.has(entryId)) throw AppError.badRequest('rules contain duplicate catalog_entry_id values');
      seen.add(entryId);
      return normalizePolicyRuleInput(
        { ...rule, catalog_entry_id: entryId },
        entryById.get(entryId),
      );
    });

    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_policy_rules
        WHERE tenant_id = $1::uuid AND bundle_id = $2::uuid`,
      tid,
      policyBundleId,
    );
    const inserted = [];
    for (const rule of normalizedRules) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO lab_threshold_policy_rules
           (tenant_id, facility_id, bundle_id, catalog_entry_id,
            reference_low, reference_high, critical_low, critical_high,
            notes, created_by)
         VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid,
                 $5::numeric, $6::numeric, $7::numeric, $8::numeric,
                 $9, $10::uuid)
         RETURNING id, tenant_id, facility_id, bundle_id, catalog_entry_id,
                   reference_low, reference_high, critical_low, critical_high,
                   notes, created_by, created_at, updated_at`,
        tid,
        Number(bundle.facility_id),
        policyBundleId,
        rule.catalogEntryId,
        rule.referenceLow,
        rule.referenceHigh,
        rule.criticalLow,
        rule.criticalHigh,
        rule.notes,
        actor,
      );
      inserted.push(rows[0]);
    }
    await tx.$executeRawUnsafe(
      `UPDATE lab_threshold_policy_bundles
          SET content_sha256 = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      tid,
      policyBundleId,
    );
    await auditTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole: currentActor.rawRole,
      action: 'LAB_THRESHOLD_POLICY_RULES_REPLACED',
      resource: 'lab_threshold_policy_bundles',
      resourceId: policyBundleId,
      details: { rule_count: inserted.length, catalog_revision: Number(bundle.catalog_revision) },
    });
    return coverageReportTx(tx, bundle);
  });
}

export async function getLabThresholdPolicyCoverage({ tenantId, bundleId }) {
  const tid = requireTenantId(tenantId);
  const policyBundleId = uuid(bundleId, 'bundle_id');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, facility_id, bundle_version, catalog_revision,
              lifecycle_status, source_reference, content_sha256,
              effective_from, effective_until, created_by, created_at,
              submitted_by, submitted_at, approved_by, approved_at,
              approval_reason, approval_evidence_reference,
              approval_evidence_sha256, activated_by, activated_at,
              superseded_by_bundle_id, superseded_at, metadata, updated_at
         FROM lab_threshold_policy_bundles
        WHERE tenant_id = $1::uuid AND id = $2::uuid
        LIMIT 1`,
      tid,
      policyBundleId,
    );
    if (!rows[0]) throw AppError.notFound('Lab threshold policy bundle not found');
    return coverageReportTx(tx, rows[0]);
  });
}

export async function submitLabThresholdPolicyBundle({
  tenantId,
  bundleId,
  actorUid,
  actorRole,
  sourceReference,
  effectiveFrom,
  effectiveUntil = null,
}) {
  const tid = requireTenantId(tenantId);
  const policyBundleId = uuid(bundleId, 'bundle_id');
  const actor = uuid(actorUid, 'actor_uid');
  const source = requiredText(sourceReference, 'source_reference', 500);
  const startsAt = timestamp(effectiveFrom, 'effective_from', { required: true });
  const endsAt = timestamp(effectiveUntil, 'effective_until');
  if (endsAt && endsAt <= startsAt) {
    throw AppError.badRequest('effective_until must be after effective_from');
  }
  return setTenantTx(tid, async (tx) => {
    const currentActor = await requireCurrentGovernanceActorTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole,
      allowedRoles: POLICY_AUTHOR_ROLES,
    });
    const bundle = await bundleForUpdateTx(tx, { tenantId: tid, bundleId: policyBundleId });
    if (bundle.lifecycle_status !== 'draft') {
      throw AppError.conflict('Only a draft lab threshold bundle can be submitted');
    }
    await lockCatalogStateTx(tx, {
      tenantId: tid,
      facilityId: Number(bundle.facility_id),
      actorUid: actor,
    });
    const report = await coverageReportTx(tx, bundle);
    requireActivatable(report);
    const digest = policyContentSha256({
      bundle,
      entries: report.entries,
      rules: report.rules,
    });
    const rows = await tx.$queryRawUnsafe(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'in_review', source_reference = $3,
              content_sha256 = $4, effective_from = $5::timestamptz,
              effective_until = $6::timestamptz, submitted_by = $7::uuid,
              submitted_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      RETURNING id, tenant_id, facility_id, bundle_version, catalog_revision,
                lifecycle_status, source_reference, content_sha256,
                effective_from, effective_until, created_by, created_at,
                submitted_by, submitted_at, metadata, updated_at`,
      tid,
      policyBundleId,
      source,
      digest,
      startsAt,
      endsAt,
      actor,
    );
    await auditTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole: currentActor.rawRole,
      action: 'LAB_THRESHOLD_POLICY_BUNDLE_SUBMITTED',
      resource: 'lab_threshold_policy_bundles',
      resourceId: policyBundleId,
      details: { content_sha256: digest, source_reference: source },
    });
    return rows[0];
  });
}

export async function approveLabThresholdPolicyBundle({
  tenantId,
  bundleId,
  actorUid,
  actorRole,
  reason,
  evidenceReference,
  evidenceSha256,
}) {
  const tid = requireTenantId(tenantId);
  const policyBundleId = uuid(bundleId, 'bundle_id');
  const actor = uuid(actorUid, 'actor_uid');
  const approvalReason = requiredText(reason, 'reason', 1000);
  const evidence = requiredText(evidenceReference, 'evidence_reference', 500);
  const evidenceDigest = sha256(evidenceSha256, 'evidence_sha256');
  return setTenantTx(tid, async (tx) => {
    const currentActor = await requireCurrentGovernanceActorTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole,
      allowedRoles: POLICY_APPROVER_ROLES,
    });
    const bundle = await bundleForUpdateTx(tx, { tenantId: tid, bundleId: policyBundleId });
    if (bundle.lifecycle_status !== 'in_review') {
      throw AppError.conflict('Only an in-review lab threshold bundle can be approved');
    }
    if (actor === String(bundle.created_by) || actor === String(bundle.submitted_by)) {
      throw AppError.conflict(
        'The clinical approver must be distinct from the author and submitter',
        'LAB_THRESHOLD_DISTINCT_APPROVER_REQUIRED',
      );
    }
    await lockCatalogStateTx(tx, {
      tenantId: tid,
      facilityId: Number(bundle.facility_id),
      actorUid: actor,
    });
    const report = await coverageReportTx(tx, bundle);
    requireActivatable(report);
    const digest = policyContentSha256({ bundle, entries: report.entries, rules: report.rules });
    if (digest !== bundle.content_sha256) {
      throw AppError.conflict(
        'Lab threshold bundle content changed after submission',
        'LAB_THRESHOLD_POLICY_CONTENT_CHANGED',
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'approved', approved_by = $3::uuid,
              approved_at = NOW(), approval_reason = $4,
              approval_evidence_reference = $5,
              approval_evidence_sha256 = $6, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      RETURNING id, tenant_id, facility_id, bundle_version, catalog_revision,
                lifecycle_status, source_reference, content_sha256,
                effective_from, effective_until, created_by, submitted_by,
                submitted_at, approved_by, approved_at, approval_reason,
                approval_evidence_reference, approval_evidence_sha256,
                metadata, updated_at`,
      tid,
      policyBundleId,
      actor,
      approvalReason,
      evidence,
      evidenceDigest,
    );
    await auditTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole: currentActor.rawRole,
      action: 'LAB_THRESHOLD_POLICY_BUNDLE_APPROVED',
      resource: 'lab_threshold_policy_bundles',
      resourceId: policyBundleId,
      details: {
        content_sha256: digest,
        approval_evidence_reference: evidence,
        approval_evidence_sha256: evidenceDigest,
        reason: approvalReason,
      },
    });
    return rows[0];
  });
}

export async function rejectLabThresholdPolicyBundle({
  tenantId,
  bundleId,
  actorUid,
  actorRole,
  reason,
}) {
  const tid = requireTenantId(tenantId);
  const policyBundleId = uuid(bundleId, 'bundle_id');
  const actor = uuid(actorUid, 'actor_uid');
  const rejectionReason = requiredText(reason, 'reason', 1000);
  return setTenantTx(tid, async (tx) => {
    const currentActor = await requireCurrentGovernanceActorTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole,
      allowedRoles: POLICY_APPROVER_ROLES,
    });
    const bundle = await bundleForUpdateTx(tx, { tenantId: tid, bundleId: policyBundleId });
    if (bundle.lifecycle_status !== 'in_review') {
      throw AppError.conflict('Only an in-review lab threshold bundle can be rejected');
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'rejected', rejected_by = $3::uuid,
              rejected_at = NOW(), rejection_reason = $4, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      RETURNING id, tenant_id, facility_id, bundle_version, catalog_revision,
                lifecycle_status, rejected_by, rejected_at, rejection_reason,
                metadata, updated_at`,
      tid,
      policyBundleId,
      actor,
      rejectionReason,
    );
    await auditTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole: currentActor.rawRole,
      action: 'LAB_THRESHOLD_POLICY_BUNDLE_REJECTED',
      resource: 'lab_threshold_policy_bundles',
      resourceId: policyBundleId,
      details: { reason: rejectionReason },
    });
    return rows[0];
  });
}

export async function activateLabThresholdPolicyBundle({
  tenantId,
  bundleId,
  actorUid,
  actorRole,
  reason,
}) {
  const tid = requireTenantId(tenantId);
  const policyBundleId = uuid(bundleId, 'bundle_id');
  const actor = uuid(actorUid, 'actor_uid');
  const activationReason = requiredText(reason, 'reason', 1000);
  return setTenantTx(tid, async (tx) => {
    const currentActor = await requireCurrentGovernanceActorTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole,
      allowedRoles: POLICY_ACTIVATOR_ROLES,
    });
    const bundle = await bundleForUpdateTx(tx, { tenantId: tid, bundleId: policyBundleId });
    if (!['approved', 'superseded'].includes(bundle.lifecycle_status)) {
      throw AppError.conflict('Only an approved or previously superseded bundle can be activated');
    }
    if ([bundle.created_by, bundle.submitted_by, bundle.approved_by]
      .some(uid => uid != null && actor === String(uid))) {
      throw AppError.conflict(
        'The release activator must be distinct from the author, submitter, and clinical approver',
        'LAB_THRESHOLD_DISTINCT_ACTIVATOR_REQUIRED',
      );
    }
    await lockCatalogStateTx(tx, {
      tenantId: tid,
      facilityId: Number(bundle.facility_id),
      actorUid: actor,
    });
    const report = await coverageReportTx(tx, bundle);
    requireActivatable(report);
    const digest = policyContentSha256({ bundle, entries: report.entries, rules: report.rules });
    if (digest !== bundle.content_sha256) {
      throw AppError.conflict(
        'Lab threshold bundle content no longer matches its clinical approval',
        'LAB_THRESHOLD_POLICY_CONTENT_CHANGED',
      );
    }
    const now = new Date();
    if (!bundle.effective_from || new Date(bundle.effective_from) > now) {
      throw AppError.conflict('Lab threshold bundle is not effective yet');
    }
    if (bundle.effective_until && new Date(bundle.effective_until) <= now) {
      throw AppError.conflict('Lab threshold bundle has expired');
    }

    const activeRows = await tx.$queryRawUnsafe(
      `SELECT id, bundle_version
         FROM lab_threshold_policy_bundles
        WHERE tenant_id = $1::uuid
          AND facility_id = $2::int
          AND lifecycle_status = 'active'
        LIMIT 1
        FOR UPDATE`,
      tid,
      Number(bundle.facility_id),
    );
    const previous = activeRows[0] || null;
    if (previous && String(previous.id) === policyBundleId) {
      return { bundle, previous_bundle_id: null, replayed: true };
    }
    if (previous) {
      await tx.$executeRawUnsafe(
        `UPDATE lab_threshold_policy_bundles
            SET lifecycle_status = 'superseded', superseded_by_bundle_id = $3::uuid,
                superseded_at = NOW(), updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        tid,
        previous.id,
        policyBundleId,
      );
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE lab_threshold_policy_bundles
          SET lifecycle_status = 'active', activated_by = $3::uuid,
              activated_at = NOW(), superseded_by_bundle_id = NULL,
              superseded_at = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'last_activation_reason', $4::text,
                'last_activated_from_bundle_id', $5::uuid
              ),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      RETURNING id, tenant_id, facility_id, bundle_version, catalog_revision,
                lifecycle_status, source_reference, content_sha256,
                effective_from, effective_until, created_by, submitted_by,
                approved_by, approved_at, approval_evidence_reference,
                approval_evidence_sha256, activated_by, activated_at,
                metadata, updated_at`,
      tid,
      policyBundleId,
      actor,
      activationReason,
      previous?.id || null,
    );
    await auditTx(tx, {
      tenantId: tid,
      actorUid: actor,
      actorRole: currentActor.rawRole,
      action: previous ? 'LAB_THRESHOLD_POLICY_BUNDLE_REPLACED' : 'LAB_THRESHOLD_POLICY_BUNDLE_ACTIVATED',
      resource: 'lab_threshold_policy_bundles',
      resourceId: policyBundleId,
      details: {
        facility_id: Number(bundle.facility_id),
        previous_bundle_id: previous ? String(previous.id) : null,
        reason: activationReason,
        content_sha256: digest,
      },
    });
    return {
      bundle: rows[0],
      previous_bundle_id: previous ? String(previous.id) : null,
      replayed: false,
    };
  });
}

export async function listLabThresholdPolicyBundles({
  tenantId,
  facilityId = null,
  lifecycleStatus = null,
  limit = 100,
}) {
  const tid = requireTenantId(tenantId);
  const params = [tid];
  const filters = ['tenant_id = $1::uuid'];
  if (facilityId != null && facilityId !== '') {
    params.push(positiveInteger(facilityId, 'facility_id'));
    filters.push(`facility_id = $${params.length}::int`);
  }
  if (lifecycleStatus) {
    const status = requiredText(lifecycleStatus, 'lifecycle_status', 24);
    if (!['draft', 'in_review', 'approved', 'active', 'superseded', 'rejected'].includes(status)) {
      throw AppError.badRequest('Invalid lifecycle_status');
    }
    params.push(status);
    filters.push(`lifecycle_status = $${params.length}`);
  }
  params.push(Math.min(positiveInteger(limit, 'limit'), MAX_LIST));
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, facility_id, bundle_version, catalog_revision,
              lifecycle_status, source_reference, content_sha256,
              effective_from, effective_until, created_by, created_at,
              submitted_by, submitted_at, approved_by, approved_at,
              approval_reason, approval_evidence_reference,
              approval_evidence_sha256, activated_by, activated_at,
              superseded_by_bundle_id, superseded_at, rejected_by,
              rejected_at, rejection_reason, metadata, updated_at
         FROM lab_threshold_policy_bundles
        WHERE ${filters.join(' AND ')}
        ORDER BY facility_id, bundle_version DESC, id
        LIMIT $${params.length}::int`,
      ...params,
    );
    return { bundles: rows, count: rows.length };
  });
}

export default {
  activateLabThresholdPolicyBundle,
  addLabThresholdCatalogEntry,
  approveLabThresholdPolicyBundle,
  createLabThresholdPolicyBundle,
  getLabThresholdPolicyCoverage,
  listLabThresholdCatalog,
  listLabThresholdPolicyBundles,
  rejectLabThresholdPolicyBundle,
  replaceLabThresholdPolicyRules,
  retireLabThresholdCatalogEntry,
  submitLabThresholdPolicyBundle,
};
