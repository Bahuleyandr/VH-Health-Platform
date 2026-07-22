import { randomUUID } from 'node:crypto';

import { isPathwayReconciliationRepairEnabled } from '../../config/pathwayReconciliationConfig.js';
import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  CANONICAL_PATHWAY_KEYS,
  PATHWAY_MODES,
} from './pathwayMode.js';
import {
  computeCanonicalChecksum,
  isPathwayReconciliationRegistry,
  pathwayReconciliationRegistry,
} from './pathwayReconciliationRegistry.js';
import {
  assertGovernanceApprovalEvidence,
  resolvePathwayModeTx,
} from './pathwayRuntimePersistence.js';

const RESULT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,119}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHECK_RESULTS = 200;
const MAX_REPAIR_CANDIDATES_PER_DESCRIPTOR = 100;

function nonNegativeInteger(value, label) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return number;
}

function result(code, {
  findingCount = 0,
  repairCount = 0,
  errorCount = 0,
} = {}) {
  if (typeof code !== 'string' || !RESULT_CODE_PATTERN.test(code)) {
    throw new TypeError('Reconciliation result code must be a stable canonical identifier');
  }
  return Object.freeze({
    code,
    finding_count: nonNegativeInteger(findingCount, `${code}.finding_count`),
    repair_count: nonNegativeInteger(repairCount, `${code}.repair_count`),
    error_count: nonNegativeInteger(errorCount, `${code}.error_count`),
  });
}

function normalizeCheckResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Reconciliation check returned an invalid result');
  }
  return result(value.code, {
    findingCount: value.finding_count,
    repairCount: value.repair_count,
    errorCount: value.error_count,
  });
}

export function computePathwayReconciliationPass({
  pathwayMode,
  registryComplete,
  governanceCount,
  coveredGovernanceCount,
  expectedCheckCount,
  executedCheckCount,
  findingCount,
  repairCount,
  errorCount,
} = {}) {
  return pathwayMode === PATHWAY_MODES.SHADOW
    && registryComplete === true
    && nonNegativeInteger(governanceCount, 'governanceCount') > 0
    && nonNegativeInteger(coveredGovernanceCount, 'coveredGovernanceCount')
      === nonNegativeInteger(governanceCount, 'governanceCount')
    && nonNegativeInteger(expectedCheckCount, 'expectedCheckCount') > 0
    && nonNegativeInteger(executedCheckCount, 'executedCheckCount')
      === nonNegativeInteger(expectedCheckCount, 'expectedCheckCount')
    && nonNegativeInteger(findingCount, 'findingCount') === 0
    && nonNegativeInteger(repairCount, 'repairCount') === 0
    && nonNegativeInteger(errorCount, 'errorCount') === 0;
}

function requireRegistry(registry) {
  if (!isPathwayReconciliationRegistry(registry)) {
    throw new TypeError('Care pathway reconciliation requires a branded registry');
  }
  return registry;
}

function requirePathwayKey(pathwayKey) {
  if (!CANONICAL_PATHWAY_KEYS.includes(pathwayKey)) {
    throw new TypeError('Care pathway reconciliation requires a canonical pathway key');
  }
  return pathwayKey;
}

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value.toLowerCase();
}

function canonicalGovernanceTuple(row) {
  return Object.freeze({
    governance_id: String(row.governance_id).toLowerCase(),
    workflow_definition_id: Number(row.workflow_definition_id),
    definition_version: Number(row.definition_version),
    definition_checksum: String(row.definition_checksum).trim().toLowerCase(),
  });
}

async function captureDatabaseTime(tx) {
  const rows = await tx.$queryRawUnsafe('SELECT clock_timestamp() AS captured_at');
  return new Date(rows[0].captured_at);
}

export async function loadGovernanceSnapshotTx({ tx, tenantId, pathwayKey, capturedAt }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT d.id AS workflow_definition_id,
            d.version AS definition_version,
            g.id AS governance_id,
            g.definition_checksum,
            g.approved_by AS governance_approved_by,
            g.approved_at AS governance_approved_at,
            a.status AS approval_status,
            a.approval_kind,
            a.subject_resource_type AS approval_subject_resource_type,
            a.subject_resource_id AS approval_subject_resource_id,
            a.required_approvers AS approval_required_approvers,
            a.approved_by AS approval_approved_by,
            a.decided_by AS approval_decided_by,
            a.decided_at AS approval_decided_at,
            a.metadata AS approval_metadata
       FROM workflow_definitions AS d
       JOIN care_pathway_definition_governance AS g
         ON g.tenant_id = d.tenant_id
        AND g.workflow_definition_id = d.id
       LEFT JOIN approvals AS a
         ON a.tenant_id = g.tenant_id
        AND a.id = g.approval_id
      WHERE d.tenant_id = $1::uuid
        AND d.workflow_key = $2::text
        AND d.is_active = TRUE
        AND g.governance_status = 'approved'
        AND g.definition_checksum IS NOT NULL
        AND (g.effective_from IS NULL OR g.effective_from <= $3::timestamptz)
        AND (g.effective_until IS NULL OR g.effective_until >= $3::timestamptz)
      ORDER BY g.id, d.id, d.version`,
    tenantId,
    pathwayKey,
    capturedAt,
  );
  const tuples = [];
  let invalidApprovalCount = 0;
  for (const row of rows) {
    try {
      assertGovernanceApprovalEvidence({ ...row, id: row.workflow_definition_id });
      tuples.push(canonicalGovernanceTuple(row));
    } catch {
      invalidApprovalCount += 1;
    }
  }
  tuples.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return Object.freeze({
    tuples: Object.freeze(tuples),
    checksum: computeCanonicalChecksum(tuples),
    invalidApprovalCount,
  });
}

async function acquireFenceTx({ tx, tenantId, pathwayKey }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT pg_try_advisory_xact_lock(
              hashtext('care_pathway_reconciliation'),
              hashtext($1::text || ':' || $2::text)
            ) AS locked`,
    tenantId,
    pathwayKey,
  );
  return rows[0]?.locked === true;
}

async function findExistingSweepTx({ tx, tenantId, pathwayKey, sweepId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, sweep_id, tenant_id, pathway_key, pathway_mode,
            registry_checksum, governance_checksum, passed, completed_at
       FROM care_pathway_reconciliation_checks
      WHERE tenant_id = $1::uuid
        AND pathway_key = $2::text
        AND sweep_id = $3::uuid
      LIMIT 1`,
    tenantId,
    pathwayKey,
    sweepId,
  );
  return rows[0] || null;
}

async function loadOverdueRuleSourcesTx({ tx, tenantId, pathwayKey, capturedAt }) {
  return tx.$queryRawUnsafe(
    `SELECT sla.rule_code,
            COALESCE(sla.source_table, '') AS source_table,
            COUNT(DISTINCT sla.id)::integer AS finding_count
       FROM workflow_sla_instances AS sla
       JOIN tasks AS task
         ON task.tenant_id = sla.tenant_id
        AND task.workflow_sla_instance_id = sla.id
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = task.tenant_id
        AND pathway.workflow_run_id = task.workflow_run_id
      WHERE sla.tenant_id = $1::uuid
        AND pathway.pathway_key = $2::text
        AND sla.status = 'active'
        AND sla.completed_at IS NULL
        AND sla.due_at IS NOT NULL
        AND sla.due_at < $3::timestamptz
      GROUP BY sla.rule_code, COALESCE(sla.source_table, '')
      ORDER BY sla.rule_code, COALESCE(sla.source_table, '')`,
    tenantId,
    pathwayKey,
    capturedAt,
  );
}

function validRepairCandidate(candidate) {
  return candidate
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && typeof candidate.slaId === 'string'
    && UUID_PATTERN.test(candidate.slaId);
}

async function executeRepairDescriptorTx({
  tx,
  tenantId,
  pathwayKey,
  capturedAt,
  descriptor,
}) {
  const candidates = await descriptor.findCandidates({
    tx,
    tenantId,
    pathwayKey,
    capturedAt,
    limit: MAX_REPAIR_CANDIDATES_PER_DESCRIPTOR,
  });
  if (!Array.isArray(candidates) || candidates.length > MAX_REPAIR_CANDIDATES_PER_DESCRIPTOR) {
    throw new TypeError('Repair descriptor returned an invalid candidate set');
  }
  let repaired = 0;
  let invalidSource = 0;
  let invalidOwner = 0;
  let lostCas = 0;
  for (const candidate of candidates) {
    if (!validRepairCandidate(candidate)) {
      throw new TypeError('Repair descriptor returned an invalid candidate');
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT sla.*
         FROM workflow_sla_instances AS sla
         JOIN tasks AS task
           ON task.tenant_id = sla.tenant_id
          AND task.workflow_sla_instance_id = sla.id
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = task.tenant_id
          AND pathway.workflow_run_id = task.workflow_run_id
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $2::uuid
          AND sla.rule_code = $3::text
          AND sla.source_table = $4::text
          AND pathway.pathway_key = $5::text
        LIMIT 1
        FOR UPDATE OF sla`,
      tenantId,
      candidate.slaId,
      descriptor.ruleCode,
      descriptor.sourceTable,
      pathwayKey,
    );
    const sla = rows[0];
    if (
      !sla
      || sla.status !== 'active'
      || sla.completed_at
      || !sla.due_at
      || new Date(sla.due_at) >= capturedAt
    ) continue;
    const source = await descriptor.validateSource({
      tx,
      tenantId,
      pathwayKey,
      capturedAt,
      sla,
      candidate,
    });
    if (!source || source.valid !== true) {
      invalidSource += 1;
      continue;
    }
    const owner = await descriptor.resolveOwner({
      tx,
      tenantId,
      pathwayKey,
      capturedAt,
      sla,
      source,
      candidate,
    });
    if (!owner || owner.valid !== true) {
      invalidOwner += 1;
      continue;
    }
    const changed = await tx.$queryRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'breached',
              breached_at = COALESCE(breached_at, $5::timestamptz),
              updated_at = $5::timestamptz
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND rule_code = $3::text
          AND source_table = $4::text
          AND status = 'active'
          AND completed_at IS NULL
          AND due_at < $5::timestamptz
      RETURNING id`,
      tenantId,
      sla.id,
      descriptor.ruleCode,
      descriptor.sourceTable,
      capturedAt,
    );
    if (changed.length !== 1) {
      lostCas += 1;
      continue;
    }
    const materialized = await descriptor.materializeTask({
      tx,
      tenantId,
      pathwayKey,
      capturedAt,
      sla: { ...sla, status: 'breached', breached_at: sla.breached_at || capturedAt },
      source,
      owner,
      candidate,
      strict: true,
    });
    if (!materialized || materialized.ok !== true) {
      throw new Error('Registered pathway repair producer refused materialization');
    }
    repaired += 1;
  }
  return Object.freeze({ repaired, invalidSource, invalidOwner, lostCas });
}

export async function executeRegisteredRepairsTx({
  tx,
  tenantId,
  pathwayKey,
  capturedAt,
  registry,
  repairEnabled,
} = {}) {
  const trustedRegistry = requireRegistry(registry);
  const profile = trustedRegistry.resolveProfile(requirePathwayKey(pathwayKey));
  if (!repairEnabled) return Object.freeze([]);
  const results = [];
  for (const descriptor of profile.repairDescriptors) {
    if (descriptor.enabled !== true) continue;
    const counts = await executeRepairDescriptorTx({
      tx,
      tenantId,
      pathwayKey,
      capturedAt,
      descriptor,
    });
    if (counts.repaired > 0) {
      results.push(result('SLA_REPAIR_APPLIED', { repairCount: counts.repaired }));
    }
    if (counts.invalidSource > 0) {
      results.push(result('SLA_REPAIR_SOURCE_INVALID', { findingCount: counts.invalidSource }));
    }
    if (counts.invalidOwner > 0) {
      results.push(result('SLA_REPAIR_OWNER_INVALID', { findingCount: counts.invalidOwner }));
    }
    if (counts.lostCas > 0) {
      results.push(result('SLA_REPAIR_CAS_LOST', { findingCount: counts.lostCas }));
    }
  }
  return Object.freeze(results);
}

function aggregate(results) {
  if (!Array.isArray(results) || results.length > MAX_CHECK_RESULTS) {
    throw new TypeError('Reconciliation results exceed the bounded evidence contract');
  }
  const normalized = results.map(normalizeCheckResult);
  return Object.freeze({
    results: Object.freeze(normalized),
    findingCount: normalized.reduce((sum, entry) => sum + entry.finding_count, 0),
    repairCount: normalized.reduce((sum, entry) => sum + entry.repair_count, 0),
    errorCount: normalized.reduce((sum, entry) => sum + entry.error_count, 0),
  });
}

async function insertEvidenceTx({
  tx,
  sweepId,
  tenantId,
  pathwayKey,
  pathwayMode,
  registry,
  governance,
  coveredGovernanceCount,
  expectedCheckCount,
  executedCheckCount,
  registryComplete,
  results,
  startedAt,
  completedAt,
}) {
  const totals = aggregate(results);
  const passed = computePathwayReconciliationPass({
    pathwayMode,
    registryComplete,
    governanceCount: governance.tuples.length,
    coveredGovernanceCount,
    expectedCheckCount,
    executedCheckCount,
    findingCount: totals.findingCount,
    repairCount: totals.repairCount,
    errorCount: totals.errorCount,
  });
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO care_pathway_reconciliation_checks
       (sweep_id, tenant_id, pathway_key, pathway_mode,
        registry_version, registry_checksum, governance_checksum,
        governance_count, covered_governance_count,
        expected_check_count, executed_check_count,
        finding_count, repair_count, error_count,
        registry_complete, passed, check_results,
        started_at, completed_at, created_at)
     VALUES
       ($1::uuid, $2::uuid, $3::text, $4::text,
        $5::integer, $6::char(64), $7::char(64),
        $8::integer, $9::integer,
        $10::integer, $11::integer,
        $12::integer, $13::integer, $14::integer,
        $15::boolean, $16::boolean, $17::jsonb,
        $18::timestamptz, $19::timestamptz, $19::timestamptz)
     RETURNING id::text, sweep_id, tenant_id, pathway_key, pathway_mode,
               registry_checksum, governance_checksum, registry_complete,
               finding_count, repair_count, error_count, passed, completed_at`,
    sweepId,
    tenantId,
    pathwayKey,
    pathwayMode,
    registry.version,
    registry.checksum,
    governance.checksum,
    governance.tuples.length,
    coveredGovernanceCount,
    expectedCheckCount,
    executedCheckCount,
    totals.findingCount,
    totals.repairCount,
    totals.errorCount,
    registryComplete,
    passed,
    JSON.stringify(totals.results),
    startedAt,
    completedAt,
  );
  return rows[0];
}

async function runObservationTx({
  tx,
  tenantId,
  pathwayKey,
  sweepId,
  registry,
  repairEnabled,
}) {
  const pathwayMode = await resolvePathwayModeTx({ tx, tenantId, pathwayKey });
  if (pathwayMode === PATHWAY_MODES.OFF) {
    return Object.freeze({ tenant_id: tenantId, pathway_key: pathwayKey, skipped: 'off' });
  }
  const startedAt = await captureDatabaseTime(tx);
  const locked = await acquireFenceTx({ tx, tenantId, pathwayKey });
  if (!locked) {
    const governance = Object.freeze({ tuples: Object.freeze([]), checksum: computeCanonicalChecksum([]) });
    return insertEvidenceTx({
      tx,
      sweepId,
      tenantId,
      pathwayKey,
      pathwayMode,
      registry,
      governance,
      coveredGovernanceCount: 0,
      expectedCheckCount: 0,
      executedCheckCount: 0,
      registryComplete: false,
      results: [result('RECONCILIATION_FENCE_BUSY', { errorCount: 1 })],
      startedAt,
      completedAt: await captureDatabaseTime(tx),
    });
  }
  const existing = await findExistingSweepTx({ tx, tenantId, pathwayKey, sweepId });
  if (existing) return Object.freeze({ ...existing, duplicate: true });
  const governance = await loadGovernanceSnapshotTx({
    tx,
    tenantId,
    pathwayKey,
    capturedAt: startedAt,
  });
  if (pathwayMode === PATHWAY_MODES.ACTIVE) {
    return insertEvidenceTx({
      tx,
      sweepId,
      tenantId,
      pathwayKey,
      pathwayMode,
      registry,
      governance,
      coveredGovernanceCount: 0,
      expectedCheckCount: 0,
      executedCheckCount: 0,
      registryComplete: false,
      results: [result('ACTIVE_WITHOUT_ACTIVATION_AUTHORITY', { errorCount: 1 })],
      startedAt,
      completedAt: await captureDatabaseTime(tx),
    });
  }

  const profile = registry.resolveProfile(pathwayKey);
  const adapters = governance.tuples.map((tuple) => registry.matchDomainAdapter(pathwayKey, {
    governanceId: tuple.governance_id,
    workflowDefinitionId: tuple.workflow_definition_id,
    definitionVersion: tuple.definition_version,
    definitionChecksum: tuple.definition_checksum,
  }));
  const coveredGovernanceCount = adapters.filter(Boolean).length;
  const uniqueAdapters = [...new Set(adapters.filter(Boolean))];
  const expectedChecks = [
    ...profile.commonCheckIds.map((id) => registry.resolveCommonCheck(id)),
    ...uniqueAdapters.flatMap((adapter) => adapter.checks),
  ];
  const results = [];
  let executedCheckCount = 0;
  for (const check of expectedChecks) {
    results.push(normalizeCheckResult(await check.run({
      tx,
      tenantId,
      pathwayKey,
      capturedAt: startedAt,
      governance: governance.tuples,
    })));
    executedCheckCount += 1;
  }
  if (governance.invalidApprovalCount > 0) {
    results.push(result('GOVERNANCE_APPROVAL_INVALID', {
      findingCount: governance.invalidApprovalCount,
    }));
  }
  if (governance.tuples.length === 0) {
    results.push(result('EFFECTIVE_GOVERNANCE_MISSING', { findingCount: 1 }));
  }
  if (governance.tuples.length > coveredGovernanceCount) {
    results.push(result('GOVERNANCE_ADAPTER_MISSING', {
      findingCount: governance.tuples.length - coveredGovernanceCount,
    }));
  }
  if (profile.blockingReason) {
    results.push(result('REGISTRY_PROFILE_INCOMPLETE', { findingCount: 1 }));
  }

  results.push(...await executeRegisteredRepairsTx({
    tx,
    tenantId,
    pathwayKey,
    capturedAt: startedAt,
    registry,
    repairEnabled,
  }));
  let unknownOverdueCount = 0;
  let disabledRepairCount = 0;
  const overdueSources = await loadOverdueRuleSourcesTx({
    tx,
    tenantId,
    pathwayKey,
    capturedAt: startedAt,
  });
  for (const overdue of overdueSources) {
    const countValue = nonNegativeInteger(overdue.finding_count, 'overdue finding_count');
    const repair = registry.resolveRepair(pathwayKey, overdue.rule_code, overdue.source_table);
    const excluded = registry.resolveClockExclusion(
      pathwayKey,
      overdue.rule_code,
      overdue.source_table,
    );
    if (excluded) continue;
    if (!repair || repair.enabled !== true) {
      unknownOverdueCount += countValue;
    } else if (!repairEnabled) {
      disabledRepairCount += countValue;
    }
  }
  if (unknownOverdueCount > 0) {
    results.push(result('UNREGISTERED_OVERDUE_SLA_SOURCE', {
      findingCount: unknownOverdueCount,
    }));
  }
  if (disabledRepairCount > 0) {
    results.push(result('OVERDUE_SLA_REPAIR_DISABLED', {
      findingCount: disabledRepairCount,
    }));
  }

  const registryComplete = Boolean(
    !profile.blockingReason
    && governance.tuples.length > 0
    && governance.invalidApprovalCount === 0
    && coveredGovernanceCount === governance.tuples.length
    && unknownOverdueCount === 0
    && executedCheckCount === expectedChecks.length
  );
  return insertEvidenceTx({
    tx,
    sweepId,
    tenantId,
    pathwayKey,
    pathwayMode,
    registry,
    governance,
    coveredGovernanceCount,
    expectedCheckCount: expectedChecks.length,
    executedCheckCount,
    registryComplete,
    results,
    startedAt,
    completedAt: await captureDatabaseTime(tx),
  });
}

async function appendTechnicalErrorEvidence({
  tenantId,
  pathwayKey,
  sweepId,
  registry,
}) {
  return setTenantTx(tenantId, async (tx) => {
    const pathwayMode = await resolvePathwayModeTx({ tx, tenantId, pathwayKey });
    if (pathwayMode === PATHWAY_MODES.OFF) {
      return Object.freeze({ tenant_id: tenantId, pathway_key: pathwayKey, skipped: 'off' });
    }
    const existing = await findExistingSweepTx({ tx, tenantId, pathwayKey, sweepId });
    if (existing) return Object.freeze({ ...existing, duplicate: true });
    const capturedAt = await captureDatabaseTime(tx);
    return insertEvidenceTx({
      tx,
      sweepId,
      tenantId,
      pathwayKey,
      pathwayMode,
      registry,
      governance: Object.freeze({
        tuples: Object.freeze([]),
        checksum: computeCanonicalChecksum([]),
      }),
      coveredGovernanceCount: 0,
      expectedCheckCount: 0,
      executedCheckCount: 0,
      registryComplete: false,
      results: [result('RECONCILIATION_TECHNICAL_ERROR', { errorCount: 1 })],
      startedAt: capturedAt,
      completedAt: await captureDatabaseTime(tx),
    });
  }, { isolationLevel: 'Serializable' });
}

export async function runCarePathwayReconciliationForTenantPathway({
  tenantId,
  pathwayKey,
  sweepId = randomUUID(),
  registry = pathwayReconciliationRegistry,
  repairEnabled = isPathwayReconciliationRepairEnabled(),
} = {}) {
  const trustedRegistry = requireRegistry(registry);
  const normalizedTenantId = requireUuid(tenantId, 'tenantId');
  const normalizedPathwayKey = requirePathwayKey(pathwayKey);
  const normalizedSweepId = requireUuid(sweepId, 'sweepId');
  try {
    return await setTenantTx(normalizedTenantId, (tx) => runObservationTx({
      tx,
      tenantId: normalizedTenantId,
      pathwayKey: normalizedPathwayKey,
      sweepId: normalizedSweepId,
      registry: trustedRegistry,
      repairEnabled: repairEnabled === true,
    }), { isolationLevel: 'Serializable' });
  } catch (error) {
    logger.error('Care pathway reconciliation observation failed', {
      tenantId: normalizedTenantId,
      pathwayKey: normalizedPathwayKey,
      code: 'RECONCILIATION_TECHNICAL_ERROR',
    });
    try {
      return await appendTechnicalErrorEvidence({
        tenantId: normalizedTenantId,
        pathwayKey: normalizedPathwayKey,
        sweepId: normalizedSweepId,
        registry: trustedRegistry,
      });
    } catch {
      throw error;
    }
  }
}

export async function runCarePathwayReconciliationSweep({
  registry = pathwayReconciliationRegistry,
  repairEnabled = isPathwayReconciliationRepairEnabled(),
} = {}) {
  const trustedRegistry = requireRegistry(registry);
  const sweepId = randomUUID();
  const tenants = await setTenantTx(null, (tx) => tx.$queryRawUnsafe(
    `SELECT id::text
       FROM tenants
      ORDER BY id`,
  ), { superAdmin: true });
  const observations = [];
  for (const tenant of tenants) {
    for (const pathwayKey of CANONICAL_PATHWAY_KEYS) {
      try {
        observations.push(await runCarePathwayReconciliationForTenantPathway({
          tenantId: tenant.id,
          pathwayKey,
          sweepId,
          registry: trustedRegistry,
          repairEnabled,
        }));
      } catch {
        observations.push(Object.freeze({
          tenant_id: tenant.id,
          pathway_key: pathwayKey,
          failed: true,
        }));
      }
    }
  }
  return Object.freeze({ sweep_id: sweepId, observations: Object.freeze(observations) });
}

export default {
  computePathwayReconciliationPass,
  executeRegisteredRepairsTx,
  runCarePathwayReconciliationForTenantPathway,
  runCarePathwayReconciliationSweep,
};
