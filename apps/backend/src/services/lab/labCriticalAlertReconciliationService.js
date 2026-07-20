import prisma, { setTenantTx } from '../../lib/prisma.js';
import { lockResultsInboxResourceTx } from '../results/resultsInboxResourceLock.js';
import { materializeLabCriticalAlertGeneration } from './labCriticalAlertService.js';
import {
  assertConfiguredCriticalAnalytesNumeric,
  evaluateCriticalThreshold,
} from './labCriticalThresholdService.js';

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

function boundedBatchSize(value) {
  const size = Number(value);
  if (!Number.isInteger(size) || size <= 0 || size > MAX_BATCH_SIZE) {
    throw new Error(`Lab alert reconciliation batch size must be 1-${MAX_BATCH_SIZE}`);
  }
  return size;
}

function sameUid(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

/**
 * Return every corrected/amended sign-off result that lacks typed generation
 * evidence. Free-form generation metadata is intentionally not a clean signal:
 * a sign-off is represented only by its direct alert FK or an immutable receipt.
 */
export async function listLateLegacyCorrectiveSignoffs({
  db = prisma,
  limit = DEFAULT_BATCH_SIZE,
  tenantId = null,
} = {}) {
  const batchSize = boundedBatchSize(limit);
  return db.$queryRawUnsafe(
    `SELECT signoff.id AS signoff_id,
            signoff.tenant_id,
            signoff.patient_uid,
            signoff.signed_off_by,
            signoff.decision,
            signoff.signed_at,
            expanded.result_id
       FROM lab_pathologist_signoffs AS signoff
       CROSS JOIN LATERAL unnest(signoff.result_ids) AS expanded(result_id)
      WHERE signoff.decision IN ('corrected', 'amended')
        AND ($2::uuid IS NULL OR signoff.tenant_id = $2::uuid)
        AND NOT EXISTS (
          SELECT 1
            FROM lab_critical_alerts AS represented_alert
           WHERE represented_alert.tenant_id = signoff.tenant_id
             AND represented_alert.result_id = expanded.result_id
             AND represented_alert.generation_signoff_id = signoff.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM lab_critical_alert_reconciliation_receipts AS receipt
           WHERE receipt.tenant_id = signoff.tenant_id
             AND receipt.result_id = expanded.result_id
             AND receipt.signoff_id = signoff.id
        )
      ORDER BY signoff.tenant_id, expanded.result_id, signoff.id DESC
      LIMIT $1::int`,
    batchSize,
    tenantId,
  );
}

async function loadLockedCandidate({ tx, candidate }) {
  const tenantId = String(candidate.tenant_id);
  const resultId = Number(candidate.result_id);
  const signoffId = Number(candidate.signoff_id);
  await lockResultsInboxResourceTx({
    tx,
    tenantId,
    resourceType: 'lab_result',
    resourceId: String(resultId),
  });
  const rows = await tx.$queryRawUnsafe(
    `SELECT result.id, result.patient_uid, result.investigation_id,
            result.loinc_code, result.test_code, result.test_name,
            result.value_text, result.value_numeric, result.unit,
            result.is_critical,
            signoff.id AS signoff_id,
            signoff.patient_uid AS signoff_patient_uid,
            signoff.signed_off_by,
            signoff.decision,
            signoff.signed_at
       FROM lab_pathologist_signoffs AS signoff
       JOIN lab_results AS result
         ON result.tenant_id = signoff.tenant_id
        AND result.id = $3::int
      WHERE signoff.tenant_id = $1::uuid
        AND signoff.id = $2::int
        AND $3::int = ANY(signoff.result_ids)
      LIMIT 1
      FOR UPDATE OF result`,
    tenantId,
    signoffId,
    resultId,
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`Late lab correction ${tenantId}/${resultId}/${signoffId} lost its result binding`);
  }
  if (!sameUid(row.patient_uid, row.signoff_patient_uid)) {
    throw new Error(`Late lab correction ${tenantId}/${resultId}/${signoffId} has a patient binding mismatch`);
  }
  return row;
}

async function loadLatestCorrectiveSignoff({ tx, tenantId, resultId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT signoff.id, signoff.patient_uid, signoff.signed_off_by,
            signoff.decision, signoff.signed_at
       FROM lab_pathologist_signoffs AS signoff
      WHERE signoff.tenant_id = $1::uuid
        AND $2::int = ANY(signoff.result_ids)
        AND signoff.decision IN ('corrected', 'amended')
      ORDER BY signoff.id DESC
      LIMIT 1`,
    tenantId,
    resultId,
  );
  return rows[0] || null;
}

async function findTypedSuccessorRepresentation({ tx, tenantId, resultId, signoffId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT newer.id AS signoff_id,
            newer.patient_uid,
            represented_alert.id AS successor_alert_id,
            represented_receipt.id AS successor_receipt_id
       FROM lab_pathologist_signoffs AS newer
       LEFT JOIN lab_critical_alerts AS represented_alert
         ON represented_alert.tenant_id = newer.tenant_id
        AND represented_alert.result_id = $2::int
        AND represented_alert.generation_signoff_id = newer.id
       LEFT JOIN lab_critical_alert_reconciliation_receipts AS represented_receipt
         ON represented_receipt.tenant_id = newer.tenant_id
        AND represented_receipt.result_id = $2::int
        AND represented_receipt.signoff_id = newer.id
      WHERE newer.tenant_id = $1::uuid
        AND $2::int = ANY(newer.result_ids)
        AND newer.decision IN ('corrected', 'amended')
        AND newer.id > $3::int
        AND (represented_alert.id IS NOT NULL OR represented_receipt.id IS NOT NULL)
      ORDER BY newer.id ASC,
               represented_alert.id NULLS LAST,
               represented_receipt.id NULLS LAST
      LIMIT 1`,
    tenantId,
    resultId,
    signoffId,
  );
  return rows[0] || null;
}

async function persistHistoricalGapReceipt({
  tx,
  tenantId,
  result,
  successor,
  source,
}) {
  if (!sameUid(result.patient_uid, successor.patient_uid)) {
    throw new Error(
      `Late lab correction ${tenantId}/${result.id}/${result.signoff_id} has a successor patient mismatch`,
    );
  }
  const successorAlertId = successor.successor_alert_id == null
    ? null
    : Number(successor.successor_alert_id);
  const successorReceiptId = successorAlertId == null
    ? successor.successor_receipt_id
    : null;
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO lab_critical_alert_reconciliation_receipts
       (tenant_id, result_id, patient_uid, signoff_id, signoff_decision,
        signoff_signed_at, outcome, source, successor_signoff_id,
        successor_alert_id, successor_receipt_id, evidence)
     SELECT $1::uuid, $2::int, $3::uuid, $4::int, signoff.decision,
            signoff.signed_at, 'superseded_by_later_generation', $5,
            $6::int, $7::int, $8::bigint, $9::jsonb
       FROM lab_pathologist_signoffs AS signoff
      WHERE signoff.tenant_id = $1::uuid
        AND signoff.id = $4::int
        AND signoff.patient_uid = $3::uuid
        AND $2::int = ANY(signoff.result_ids)
     ON CONFLICT (tenant_id, result_id, signoff_id) DO NOTHING
     RETURNING *`,
    tenantId,
    Number(result.id),
    result.patient_uid,
    Number(result.signoff_id),
    source,
    Number(successor.signoff_id),
    successorAlertId,
    successorReceiptId,
    JSON.stringify({
      reason: 'older_unrepresented_signoff_superseded_by_typed_later_generation',
    }),
  );
  if (inserted[0]) return { receipt: inserted[0], inserted: true };
  const existing = await tx.$queryRawUnsafe(
    `SELECT *
       FROM lab_critical_alert_reconciliation_receipts
      WHERE tenant_id = $1::uuid
        AND result_id = $2::int
        AND signoff_id = $3::int
      LIMIT 1`,
    tenantId,
    Number(result.id),
    Number(result.signoff_id),
  );
  if (!existing[0]) throw new Error('Historical lab correction evidence could not be persisted');
  return { receipt: existing[0], inserted: false };
}

async function reconcileCandidate(candidate) {
  const tenantId = String(candidate.tenant_id);
  return setTenantTx(tenantId, async (tx) => {
    const result = await loadLockedCandidate({ tx, candidate });
    const latest = await loadLatestCorrectiveSignoff({
      tx,
      tenantId,
      resultId: Number(result.id),
    });
    if (!latest) throw new Error('Late lab correction no longer has a corrective sign-off');
    if (!sameUid(result.patient_uid, latest.patient_uid)) {
      throw new Error(
        `Late lab correction ${tenantId}/${result.id}/${latest.id} has a patient binding mismatch`,
      );
    }

    if (Number(latest.id) !== Number(result.signoff_id)) {
      const successor = await findTypedSuccessorRepresentation({
        tx,
        tenantId,
        resultId: Number(result.id),
        signoffId: Number(result.signoff_id),
      });
      if (!successor) {
        throw new Error(
          `Late lab correction ${tenantId}/${result.id}/${result.signoff_id} has no typed successor representation`,
        );
      }
      const historical = await persistHistoricalGapReceipt({
        tx,
        tenantId,
        result,
        successor,
        source: 'lab_post_drain_reconciliation',
      });
      return {
        represented: true,
        createdAlert: false,
        createdReceipt: historical.inserted,
        historicalGap: true,
      };
    }

    await assertConfiguredCriticalAnalytesNumeric({
      client: tx,
      tenantId,
      results: [result],
    });
    const materialized = await materializeLabCriticalAlertGeneration({
      tx,
      tenantId,
      resultId: Number(result.id),
      expectedPatientUid: String(result.patient_uid),
      evaluateCriticality: ({ tx: alertTx, result: currentResult }) => evaluateCriticalThreshold({
        client: alertTx,
        tenantId,
        result: currentResult,
      }),
      source: 'lab_post_drain_reconciliation',
      generationSignoffId: Number(result.signoff_id),
      generationDecision: String(result.decision),
      generationActorUid: String(result.signed_off_by),
    });
    if (materialized.created) {
      return {
        represented: true,
        createdAlert: true,
        createdReceipt: false,
        historicalGap: false,
      };
    }
    if (materialized.receipt) {
      return {
        represented: true,
        createdAlert: false,
        createdReceipt: true,
        historicalGap: false,
      };
    }
    if (['corrective_signoff_already_materialized'].includes(materialized.skippedReason)) {
      return {
        represented: true,
        createdAlert: false,
        createdReceipt: false,
        historicalGap: false,
      };
    }
    throw new Error(
      `Late lab correction ${tenantId}/${result.id}/${result.signoff_id} was not represented: ${materialized.skippedReason || 'unknown'}`,
    );
  });
}

export async function reconcileLateLegacyLabCriticalAlerts({
  db = prisma,
  batchSize = DEFAULT_BATCH_SIZE,
  tenantId = null,
} = {}) {
  const size = boundedBatchSize(batchSize);
  let observed = 0;
  let reconciled = 0;
  let alertGenerations = 0;
  let receipts = 0;
  let historicalGaps = 0;

  for (;;) {
    const candidates = await listLateLegacyCorrectiveSignoffs({
      db,
      limit: size,
      tenantId,
    });
    if (candidates.length === 0) break;
    observed += candidates.length;
    let progressed = 0;

    for (const candidate of candidates) {
      const resolution = await reconcileCandidate(candidate);
      if (!resolution.represented) continue;
      progressed += 1;
      reconciled += 1;
      if (resolution.createdAlert) alertGenerations += 1;
      if (resolution.createdReceipt) receipts += 1;
      if (resolution.historicalGap) historicalGaps += 1;
    }

    const remaining = await listLateLegacyCorrectiveSignoffs({
      db,
      limit: size,
      tenantId,
    });
    if (remaining.length === 0) break;
    if (progressed === 0) {
      const sample = remaining
        .slice(0, 5)
        .map((row) => `${row.tenant_id}/${row.result_id}/${row.signoff_id}`)
        .join(', ');
      throw new Error(`Late lab correction reconciliation made no progress: ${sample}`);
    }
  }

  return {
    observed,
    reconciled,
    alertGenerations,
    receipts,
    historicalGaps,
  };
}

export default {
  listLateLegacyCorrectiveSignoffs,
  reconcileLateLegacyLabCriticalAlerts,
};
