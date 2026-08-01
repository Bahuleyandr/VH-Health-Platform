import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION,
  DEFAULT_TENANT_ID,
  loadActiveClinicalContinuityPolicyForFacilityTx
} from './clinicalContinuityPolicyService.js';

const DELIVERY_MAX_BYTES = 256 * 1024;
const TENANT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DELIVERY_STATE_SQL = `
  SELECT policy.lifecycle_state,
         policy.policy_schema_version,
         policy.policy_version,
         policy.effective_from,
         policy.effective_until,
         policy.supersedes_policy_id,
         policy.policy_signing_key_id,
         policy.revoked_key_ids,
         policy_key.status AS policy_key_status,
         transaction_timestamp() AS trusted_now
    FROM clinical_continuity_policy_versions AS policy
    JOIN encryption_keys AS policy_key
      ON policy_key.tenant_id = policy.tenant_id
     AND policy_key.key_id = policy.policy_signing_key_id
   WHERE policy.tenant_id = $1::uuid
     AND policy.facility_id = $2::integer
     AND policy.policy_schema_version = $3::integer
   ORDER BY policy.policy_version DESC`;

function deliveryError(statusCode, code, message) {
  return new AppError(message, statusCode, code);
}

function tenantId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!TENANT_PATTERN.test(normalized) || normalized === DEFAULT_TENANT_ID) {
    throw deliveryError(
      403,
      'CONTINUITY_POLICY_FACILITY_FORBIDDEN',
      'Clinical continuity policy access is forbidden'
    );
  }
  return normalized;
}

function facilityId(value) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 2_147_483_647) {
    throw deliveryError(
      403,
      'CONTINUITY_POLICY_FACILITY_FORBIDDEN',
      'Clinical continuity policy access is forbidden'
    );
  }
  return normalized;
}

function revokedKeyIds(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRevoked(row) {
  return (
    ['revoked', 'compromised'].includes(String(row.policy_key_status || '').toLowerCase()) ||
    revokedKeyIds(row.revoked_key_ids).includes(row.policy_signing_key_id)
  );
}

function timestamp(value) {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new TypeError('invalid policy lifecycle timestamp');
  return parsed;
}

function recordSecurityFailure(code, { tenant, facility }) {
  logger.warn('Clinical continuity policy delivery denied', {
    code,
    facilityId: facility,
    tenantId: tenant
  });
}

function classifyUnavailable(rows, { tenant, facility }) {
  if (rows.length === 0) {
    throw deliveryError(
      404,
      'CONTINUITY_POLICY_NOT_PUBLISHED',
      'No clinical continuity policy has been published'
    );
  }
  const latest = rows[0];
  if (isRevoked(latest)) {
    recordSecurityFailure('CONTINUITY_POLICY_REVOKED', { tenant, facility });
    throw deliveryError(
      410,
      'CONTINUITY_POLICY_REVOKED',
      'Clinical continuity policy authority has been revoked'
    );
  }
  if (latest.lifecycle_state === 'retired') {
    recordSecurityFailure('CONTINUITY_POLICY_SUPERSEDED', { tenant, facility });
    throw deliveryError(
      410,
      'CONTINUITY_POLICY_SUPERSEDED',
      'Clinical continuity policy has been superseded'
    );
  }
  throw deliveryError(
    409,
    'CONTINUITY_POLICY_NOT_ACTIVATED',
    'Clinical continuity policy is not activated'
  );
}

export function ifNoneMatchMatches(value, currentEtag) {
  const header = String(value || '').trim();
  if (!header) return false;
  return header.split(',').some(raw => {
    const candidate = raw.trim();
    if (candidate === '*') return true;
    return candidate.replace(/^W\//i, '') === currentEtag;
  });
}

export async function loadClinicalContinuityPolicyDelivery({
  tenantId: rawTenantId,
  facilityId: rawFacilityId,
  scopeRunner = setTenantTx,
  policyLoader = loadActiveClinicalContinuityPolicyForFacilityTx
} = {}) {
  const tenant = tenantId(rawTenantId);
  const facility = facilityId(rawFacilityId);
  return scopeRunner(
    tenant,
    async tx => {
      const rows = await tx.$queryRawUnsafe(
        DELIVERY_STATE_SQL,
        tenant,
        facility,
        CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION
      );
      const activeRows = rows.filter(row => row.lifecycle_state === 'active');
      if (activeRows.length === 0) classifyUnavailable(rows, { tenant, facility });
      if (activeRows.length !== 1) {
        recordSecurityFailure('CONTINUITY_POLICY_ACTIVE_AMBIGUOUS', { tenant, facility });
        throw deliveryError(
          503,
          'CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED',
          'Clinical continuity policy delivery integrity failed'
        );
      }
      const active = activeRows[0];
      if (isRevoked(active)) {
        recordSecurityFailure('CONTINUITY_POLICY_REVOKED', { tenant, facility });
        throw deliveryError(
          410,
          'CONTINUITY_POLICY_REVOKED',
          'Clinical continuity policy authority has been revoked'
        );
      }
      let trustedNow;
      let effectiveFrom;
      let effectiveUntil;
      try {
        trustedNow = timestamp(active.trusted_now);
        effectiveFrom = timestamp(active.effective_from);
        effectiveUntil = timestamp(active.effective_until);
      } catch {
        recordSecurityFailure('CONTINUITY_POLICY_LIFECYCLE_INVALID', { tenant, facility });
        throw deliveryError(
          503,
          'CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED',
          'Clinical continuity policy delivery integrity failed'
        );
      }
      if (trustedNow < effectiveFrom) {
        throw deliveryError(
          409,
          'CONTINUITY_POLICY_NOT_ACTIVATED',
          'Clinical continuity policy is not activated'
        );
      }
      if (trustedNow >= effectiveUntil) {
        recordSecurityFailure('CONTINUITY_POLICY_SUPERSEDED', { tenant, facility });
        throw deliveryError(
          410,
          'CONTINUITY_POLICY_SUPERSEDED',
          'Clinical continuity policy has been superseded'
        );
      }

      try {
        const policy = await policyLoader({
          tx,
          tenantId: tenant,
          facilityId: facility
        });
        const delivery = policy?.policyDelivery;
        if (
          policy?.policySchemaVersion !== CLINICAL_CONTINUITY_ACTION_POLICY_SCHEMA_VERSION ||
          !delivery ||
          delivery.byteLength > DELIVERY_MAX_BYTES ||
          Buffer.byteLength(delivery.canonicalBody, 'utf8') !== delivery.byteLength
        ) {
          throw new Error('invalid verified policy delivery representation');
        }
        return Object.freeze({
          body: Buffer.from(delivery.canonicalBody, 'utf8'),
          contentDigest: delivery.contentDigest,
          envelopeSha256: delivery.envelopeSha256,
          etag: delivery.etag,
          mediaType: delivery.mediaType,
          policyChecksum: policy.policyChecksum,
          trustedNow: policy.trustedNow
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED') {
          throw error;
        }
        recordSecurityFailure(error?.code || 'CONTINUITY_POLICY_VERIFICATION_FAILED', {
          tenant,
          facility
        });
        throw deliveryError(
          503,
          'CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED',
          'Clinical continuity policy delivery integrity failed'
        );
      }
    },
    { readOnly: true, isolationLevel: 'RepeatableRead' }
  );
}

export const __clinicalContinuityPolicyDeliveryContractForTests = Object.freeze({
  stateSql: DELIVERY_STATE_SQL
});
