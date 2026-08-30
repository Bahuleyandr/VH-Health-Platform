import * as prismaRuntime from '../lib/prisma.js';

const PATIENT_MERGE_LOCK_NAMESPACE = 'vhhealth:patient-merge-tenant:';
export const PATIENT_MERGE_STABILITY_TIMEOUT_MS = 300_000;

const stabilityLeaseBindings = new WeakMap();

function normalizedTenantId(tenantId) {
  const tenant = tenantId == null ? '' : String(tenantId).trim().toLowerCase();
  if (!tenant) throw new TypeError('A tenant id is required for patient merge stability');
  return tenant;
}

function assertTenantTransactionClient(tx) {
  if (typeof prismaRuntime.isTenantTransactionClient !== 'function'
      || !prismaRuntime.isTenantTransactionClient(tx)) {
    throw new TypeError(
      'Patient merge stability requires an active tenant transaction client',
    );
  }
}

/**
 * Keep a tenant-wide merge-survivor snapshot stable while allowing unrelated
 * workflows to run concurrently. The caller must hold the supplied transaction
 * open for the full workflow.
 */
export async function lockTenantPatientMergeStability(tx, tenantId) {
  const tenant = normalizedTenantId(tenantId);
  await tx.$queryRawUnsafe(
    `SELECT 1 AS locked
       FROM pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))`,
    `${PATIENT_MERGE_LOCK_NAMESPACE}${tenant}`,
  );

  const lease = Object.freeze(Object.create(null));
  stabilityLeaseBindings.set(lease, { tx, tenantId: tenant });
  return lease;
}

/**
 * Prove that a caller acquired merge stability on this exact transaction and
 * tenant before it began taking domain locks. Lease bindings stay in this
 * module-private WeakMap, so a boolean or look-alike object cannot forge them.
 */
export function assertTenantPatientMergeStabilityLease(lease, { tx, tenantId }) {
  assertTenantTransactionClient(tx);
  const binding = lease && typeof lease === 'object'
    ? stabilityLeaseBindings.get(lease)
    : null;
  if (!binding
      || binding.tx !== tx
      || binding.tenantId !== normalizedTenantId(tenantId)) {
    throw new TypeError(
      'collectPayment with a caller transaction requires its merge-stability lease',
    );
  }
}

/**
 * Exclude every merge-stability reader while committing a patient merge.
 * This must be the first domain lock acquired by the merge transaction.
 */
export async function lockTenantPatientMergeExecutionExclusive(tx, tenantId) {
  const tenant = normalizedTenantId(tenantId);
  await tx.$queryRawUnsafe(
    `SELECT 1 AS locked
       FROM pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    `${PATIENT_MERGE_LOCK_NAMESPACE}${tenant}`,
  );
}
