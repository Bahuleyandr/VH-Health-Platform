import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';

export const AUDIT_RETENTION_SINKS = Object.freeze([
  Object.freeze({
    table: 'audit_log',
    deleteSql: `DELETE FROM audit_log
      WHERE tenant_id = $1::uuid AND created_at < $2::timestamptz`,
  }),
  Object.freeze({
    table: 'audit_logs',
    deleteSql: `DELETE FROM audit_logs
      WHERE tenant_id = $1::uuid
        AND created_at < ($2::timestamptz AT TIME ZONE 'UTC')`,
  }),
  Object.freeze({
    table: 'clinical_audit_events',
    deleteSql: `DELETE FROM clinical_audit_events
      WHERE tenant_id = $1::uuid AND occurred_at < $2::timestamptz`,
  }),
  Object.freeze({
    table: 'hipaa_access_log',
    deleteSql: `DELETE FROM hipaa_access_log
      WHERE tenant_id = $1::uuid AND accessed_at < $2::timestamptz`,
  }),
  Object.freeze({
    table: 'patient_access_audit_log',
    deleteSql: `DELETE FROM patient_access_audit_log
      WHERE tenant_id = $1::uuid AND created_at < $2::timestamptz`,
  }),
]);

function normalizeNow(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest('Audit retention now must be a valid date');
  }
  return date;
}

export function decideAuditRetentionAction(policy) {
  if (!policy) {
    return { decision: 'skip', reason: 'no_active_policy' };
  }
  if (policy.action !== 'erase') {
    return {
      decision: 'skip',
      reason: policy.action === 'archive'
        ? 'archive_not_implemented'
        : `unsupported_action_${policy.action || 'missing'}`,
    };
  }
  if (policy.legal_hold_aware !== false) {
    return { decision: 'skip', reason: 'legal_hold_decision_not_implemented' };
  }
  const retentionDays = Number(policy.retention_days);
  if (!Number.isInteger(retentionDays) || retentionDays < 0) {
    return { decision: 'skip', reason: 'invalid_retention_days' };
  }
  return { decision: 'erase', reason: 'policy_allows_erasure', retentionDays };
}

export async function purgeAuditEvidenceForTenant({ tenantId = null, now = new Date() } = {}) {
  const tid = requireTenantId(tenantId);
  const sweepTime = normalizeNow(now);

  return setTenantTx(tid, async (tx) => {
    const policies = await tx.$queryRawUnsafe(
      `SELECT id, tenant_id, policy_code, applies_to_table, retention_days,
              action, legal_hold_aware, status, metadata
         FROM data_retention_policies
        WHERE tenant_id = $1::uuid
          AND status = 'active'
          AND applies_to_table IN (
            'audit_log',
            'audit_logs',
            'clinical_audit_events',
            'hipaa_access_log',
            'patient_access_audit_log'
          )`,
      tid,
    );
    const policyByTable = new Map(
      (Array.isArray(policies) ? policies : []).map((policy) => [policy.applies_to_table, policy]),
    );

    const sinks = [];
    let deletedTotal = 0;
    let bypassEnabled = false;

    for (const sink of AUDIT_RETENTION_SINKS) {
      const policy = policyByTable.get(sink.table) || null;
      const verdict = decideAuditRetentionAction(policy);
      if (verdict.decision !== 'erase') {
        sinks.push({
          table: sink.table,
          policy_id: policy?.id ?? null,
          policy_code: policy?.policy_code ?? null,
          action: policy?.action ?? null,
          retention_days: policy?.retention_days ?? null,
          decision: verdict.decision,
          reason: verdict.reason,
          deleted: 0,
        });
        continue;
      }

      if (!bypassEnabled) {
        await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
        bypassEnabled = true;
      }
      const cutoff = new Date(
        sweepTime.getTime() - verdict.retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const deleted = Number(await tx.$executeRawUnsafe(sink.deleteSql, tid, cutoff)) || 0;
      deletedTotal += deleted;
      sinks.push({
        table: sink.table,
        policy_id: policy.id,
        policy_code: policy.policy_code,
        action: policy.action,
        retention_days: verdict.retentionDays,
        cutoff,
        decision: verdict.decision,
        reason: verdict.reason,
        deleted,
      });
    }

    return {
      tenant_id: tid,
      evaluated_at: sweepTime.toISOString(),
      deleted_total: deletedTotal,
      sinks,
    };
  });
}

export default {
  AUDIT_RETENTION_SINKS,
  decideAuditRetentionAction,
  purgeAuditEvidenceForTenant,
};
