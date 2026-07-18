import { randomUUID } from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
  isPathwayProjectorRegistry,
  pathwayProjectorRegistry,
} from './pathwayProjectorRegistry.js';

const DEFAULT_BATCH_LIMIT = 100;
const MAX_BATCH_LIMIT = 200;
const DEFAULT_LEASE_SECONDS = 300;
const MAX_LEASE_SECONDS = 3600;
const DEFAULT_MAX_ATTEMPTS = 7;
const DEFAULT_MAX_BATCHES = 10;
const MAX_MATERIALIZE_BATCHES = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BIGINT_ID_PATTERN = /^[1-9][0-9]*$/;

function boundedInteger(value, fallback, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError('Pathway projector numeric option must be a positive integer');
  }
  return Math.min(parsed, maximum);
}

function requireConsumerKey(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 120
    || value.trim() !== value
  ) {
    throw new TypeError('Pathway projector consumer key is malformed');
  }
  return value;
}

function requireGeneration(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError('Pathway projector generation must be a positive integer');
  }
  return value;
}

function requireEventId(value) {
  const eventId = typeof value === 'string' ? value : '';
  if (!BIGINT_ID_PATTERN.test(eventId)) {
    throw new TypeError('Pathway projector event id must be a positive decimal string');
  }
  return eventId;
}

function requireUuid(value, field) {
  const text = typeof value === 'string' ? value : '';
  if (!UUID_PATTERN.test(text)) {
    throw new TypeError(`Pathway projector ${field} must be a UUID`);
  }
  return text;
}

function normalizeClaim(claim) {
  if (!claim || typeof claim !== 'object') {
    throw new TypeError('Pathway projector claim is required');
  }
  return {
    consumer_key: requireConsumerKey(claim.consumer_key ?? claim.consumerKey),
    generation: requireGeneration(claim.generation),
    event_id: requireEventId(claim.event_id ?? claim.eventId),
    tenant_id: requireUuid(claim.tenant_id ?? claim.tenantId, 'tenant id'),
    lease_owner: requireUuid(claim.lease_owner ?? claim.leaseOwner, 'lease owner'),
    attempts: boundedInteger(claim.attempts, 1, Number.MAX_SAFE_INTEGER),
  };
}

function processingErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'PATHWAY_PROJECTOR_PROCESSING_FAILED';
}

function processingFailureMessage(error) {
  switch (processingErrorCode(error)) {
    case 'PATHWAY_PROJECTOR_SOURCE_UNAVAILABLE':
      return 'Source event unavailable for claimed inbox row';
    case 'PATHWAY_PROJECTOR_REGISTRY_GENERATION_MISMATCH':
      return 'Projector registry generation does not match claimed work';
    case 'PATHWAY_PROJECTOR_CLAIM_FENCE_LOST':
      return 'Projector claim owner token is no longer current';
    default:
      return 'Registered shadow observer processing failed';
  }
}

function requireRegistry(registry, generation) {
  if (!isPathwayProjectorRegistry(registry)) {
    throw AppError.internal(
      'Projector registry provenance is invalid',
      'PATHWAY_PROJECTOR_REGISTRY_PROVENANCE_MISMATCH',
    );
  }
  if (registry.generation !== generation) {
    throw AppError.internal(
      'Projector registry generation mismatch',
      'PATHWAY_PROJECTOR_REGISTRY_GENERATION_MISMATCH',
    );
  }
  if (generation === PATHWAY_PROJECTOR_GENERATION && registry !== pathwayProjectorRegistry) {
    throw AppError.internal(
      'Projector generation 1 requires the canonical registry',
      'PATHWAY_PROJECTOR_REGISTRY_IDENTITY_MISMATCH',
    );
  }
  return registry;
}

export async function materializeMissingInboxRows({
  consumerKey = PATHWAY_PROJECTOR_CONSUMER_KEY,
  generation = PATHWAY_PROJECTOR_GENERATION,
  limit = DEFAULT_BATCH_LIMIT,
} = {}) {
  const safeConsumerKey = requireConsumerKey(consumerKey);
  const safeGeneration = requireGeneration(generation);
  const safeLimit = boundedInteger(limit, DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT);

  return prisma.$queryRawUnsafe(
    `INSERT INTO pathway_projector_inbox
       (tenant_id, consumer_key, generation, event_id)
     SELECT e.tenant_id, $1::text, $2::integer, e.id
       FROM event_outbox e
      WHERE NOT EXISTS (
        SELECT 1
          FROM pathway_projector_inbox i
         WHERE i.consumer_key = $1::text
           AND i.generation = $2::integer
           AND i.event_id = e.id
      )
      ORDER BY e.id
      LIMIT $3::integer
     ON CONFLICT (consumer_key, generation, event_id) DO NOTHING
     RETURNING event_id::text, tenant_id::text`,
    safeConsumerKey,
    safeGeneration,
    safeLimit,
  );
}

export async function claimDueInboxRows({
  consumerKey = PATHWAY_PROJECTOR_CONSUMER_KEY,
  generation = PATHWAY_PROJECTOR_GENERATION,
  limit = DEFAULT_BATCH_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  leaseOwner = randomUUID(),
} = {}) {
  const safeConsumerKey = requireConsumerKey(consumerKey);
  const safeGeneration = requireGeneration(generation);
  const safeLimit = boundedInteger(limit, DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT);
  const safeLeaseSeconds = boundedInteger(leaseSeconds, DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS);
  const safeLeaseOwner = requireUuid(leaseOwner, 'lease owner');

  return prisma.$queryRawUnsafe(
    `WITH due AS (
       SELECT consumer_key, generation, event_id
         FROM pathway_projector_inbox
         WHERE consumer_key = $1::text
          AND generation = $2::integer
          AND status = 'pending'
          AND next_attempt_at <= NOW()
          AND lease_owner IS NULL
        ORDER BY next_attempt_at, event_id
        FOR UPDATE SKIP LOCKED
         LIMIT $3::integer
     )
     UPDATE pathway_projector_inbox i
        SET lease_owner = $4::uuid,
            lease_expires_at = NOW() + ($5::integer * INTERVAL '1 second'),
            attempts = i.attempts + 1
       FROM due
      WHERE i.consumer_key = due.consumer_key
        AND i.generation = due.generation
        AND i.event_id = due.event_id
     RETURNING i.consumer_key,
               i.generation,
               i.event_id::text,
               i.tenant_id::text,
               i.attempts,
               i.lease_owner::text,
               i.lease_expires_at`,
    safeConsumerKey,
    safeGeneration,
    safeLimit,
    safeLeaseOwner,
    safeLeaseSeconds,
  );
}

async function recordProcessingFailure({ claim, error, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const safeMaxAttempts = boundedInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
  const message = processingFailureMessage(error).slice(0, 500);
  const rows = await setTenantTx(claim.tenant_id, (tx) => tx.$queryRawUnsafe(
    `UPDATE pathway_projector_inbox
        SET status = CASE WHEN attempts >= $7::integer THEN 'dead' ELSE 'pending' END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_attempt_at = CASE
              WHEN attempts >= $7::integer THEN next_attempt_at
              ELSE NOW() + (
                CASE LEAST(GREATEST(attempts, 1), 7)
                  WHEN 1 THEN 30
                  WHEN 2 THEN 120
                  WHEN 3 THEN 600
                  WHEN 4 THEN 1800
                  WHEN 5 THEN 3600
                  WHEN 6 THEN 14400
                  ELSE 28800
                END * INTERVAL '1 second'
              )
            END,
             last_error = $8::text,
            outcome_at = CASE WHEN attempts >= $7::integer THEN NOW() ELSE NULL END
       WHERE consumer_key = $1::text
        AND generation = $2::integer
        AND event_id = $3::bigint
        AND tenant_id = $4::uuid
        AND status = 'pending'
        AND lease_owner = $5::uuid
        AND attempts = $6::integer
      RETURNING event_id::text, tenant_id::text, status, attempts, next_attempt_at, outcome_at`,
    claim.consumer_key,
    claim.generation,
    claim.event_id,
    claim.tenant_id,
    claim.lease_owner,
    claim.attempts,
    safeMaxAttempts,
    message,
  ));
  return rows[0] || null;
}

export async function processClaimedInboxRow({
  claim,
  registry = pathwayProjectorRegistry,
} = {}) {
  const normalizedClaim = normalizeClaim(claim);
  const safeRegistry = requireRegistry(registry, normalizedClaim.generation);

  try {
    return await setTenantTx(normalizedClaim.tenant_id, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT i.consumer_key,
                i.generation,
                i.event_id::text,
                i.tenant_id::text,
                i.status,
                i.attempts,
                i.lease_owner::text,
                e.id::text AS source_event_id,
                e.event_type,
                e.aggregate_type,
                e.aggregate_id,
                e.patient_uid::text,
                e.payload,
                e.created_at
           FROM pathway_projector_inbox i
           LEFT JOIN event_outbox e
             ON e.id = i.event_id
            AND e.tenant_id = i.tenant_id
           WHERE i.consumer_key = $1::text
            AND i.generation = $2::integer
            AND i.event_id = $3::bigint
            AND i.tenant_id = $4::uuid
          FOR UPDATE OF i`,
        normalizedClaim.consumer_key,
        normalizedClaim.generation,
        normalizedClaim.event_id,
        normalizedClaim.tenant_id,
      );
      const row = rows[0];
      if (
        !row
        || row.status !== 'pending'
        || row.lease_owner !== normalizedClaim.lease_owner
        || row.attempts !== normalizedClaim.attempts
      ) {
        throw AppError.internal(
          'Projector claim fence lost',
          'PATHWAY_PROJECTOR_CLAIM_FENCE_LOST',
        );
      }
      if (!row.source_event_id) {
        throw AppError.internal(
          'Projector source event unavailable',
          'PATHWAY_PROJECTOR_SOURCE_UNAVAILABLE',
        );
      }

      const handler = safeRegistry.resolve(row.event_type);
      const terminalStatus = handler ? 'handled' : 'ignored';
      let metadata = null;
      if (handler) {
        metadata = await handler({
          tx,
          consumerKey: normalizedClaim.consumer_key,
          generation: normalizedClaim.generation,
          tenantId: normalizedClaim.tenant_id,
          event: Object.freeze({
            id: row.source_event_id,
            event_id: row.source_event_id,
            event_type: row.event_type,
            aggregate_type: row.aggregate_type,
            aggregate_id: row.aggregate_id,
            patient_uid: row.patient_uid,
            payload: row.payload,
            created_at: row.created_at,
          }),
        });
      }

      const terminalRows = await tx.$queryRawUnsafe(
        `UPDATE pathway_projector_inbox
            SET status = $7::text,
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = NULL,
                outcome_at = NOW()
          WHERE consumer_key = $1::text
            AND generation = $2::integer
            AND event_id = $3::bigint
            AND tenant_id = $4::uuid
            AND status = 'pending'
            AND lease_owner = $5::uuid
            AND attempts = $6::integer
          RETURNING event_id::text, tenant_id::text, status, attempts, outcome_at`,
        normalizedClaim.consumer_key,
        normalizedClaim.generation,
        normalizedClaim.event_id,
        normalizedClaim.tenant_id,
        normalizedClaim.lease_owner,
        normalizedClaim.attempts,
        terminalStatus,
      );
      if (terminalRows.length !== 1) {
        throw AppError.internal(
          'Projector claim fence lost',
          'PATHWAY_PROJECTOR_CLAIM_FENCE_LOST',
        );
      }
      return { ...terminalRows[0], metadata };
    });
  } catch (error) {
    const failed = await recordProcessingFailure({ claim: normalizedClaim, error });
    if (!failed) {
      return {
        status: 'stale',
        event_id: normalizedClaim.event_id,
        tenant_id: normalizedClaim.tenant_id,
        attempts: normalizedClaim.attempts,
      };
    }
    return failed;
  }
}

export async function reapStaleInboxLeases({
  consumerKey = PATHWAY_PROJECTOR_CONSUMER_KEY,
  generation = PATHWAY_PROJECTOR_GENERATION,
  limit = DEFAULT_BATCH_LIMIT,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  const safeConsumerKey = requireConsumerKey(consumerKey);
  const safeGeneration = requireGeneration(generation);
  const safeLimit = boundedInteger(limit, DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT);
  const safeMaxAttempts = boundedInteger(maxAttempts, DEFAULT_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);

  const rows = await prisma.$queryRawUnsafe(
    `WITH stale AS (
       SELECT consumer_key, generation, event_id, attempts, lease_owner
         FROM pathway_projector_inbox
         WHERE consumer_key = $1::text
          AND generation = $2::integer
          AND status = 'pending'
          AND lease_owner IS NOT NULL
          AND lease_expires_at <= NOW()
        ORDER BY lease_expires_at, event_id
        FOR UPDATE SKIP LOCKED
         LIMIT $3::integer
     )
     UPDATE pathway_projector_inbox i
        SET status = CASE WHEN stale.attempts >= $4::integer THEN 'dead' ELSE 'pending' END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_attempt_at = CASE
              WHEN stale.attempts >= $4::integer THEN i.next_attempt_at
              ELSE NOW() + (
                CASE LEAST(GREATEST(stale.attempts, 1), 7)
                  WHEN 1 THEN 30
                  WHEN 2 THEN 120
                  WHEN 3 THEN 600
                  WHEN 4 THEN 1800
                  WHEN 5 THEN 3600
                  WHEN 6 THEN 14400
                  ELSE 28800
                END * INTERVAL '1 second'
              )
            END,
            last_error = 'Claim lease expired before completion',
            outcome_at = CASE WHEN stale.attempts >= $4::integer THEN NOW() ELSE NULL END
       FROM stale
      WHERE i.consumer_key = stale.consumer_key
        AND i.generation = stale.generation
        AND i.event_id = stale.event_id
        AND i.lease_owner = stale.lease_owner
        AND i.attempts = stale.attempts
     RETURNING i.event_id::text, i.tenant_id::text, i.status, i.attempts,
               i.next_attempt_at, i.outcome_at`,
    safeConsumerKey,
    safeGeneration,
    safeLimit,
    safeMaxAttempts,
  );

  const dead = rows.filter((row) => row.status === 'dead').length;
  if (dead > 0) {
    logger.warn('Pathway projector stale lease reaper dead-lettered rows', { dead });
  }
  return {
    reaped: rows.length,
    retried: rows.length - dead,
    dead,
    rows,
  };
}

export async function runPathwayProjectorShadowTick({
  consumerKey = PATHWAY_PROJECTOR_CONSUMER_KEY,
  generation = PATHWAY_PROJECTOR_GENERATION,
  registry = pathwayProjectorRegistry,
  maxBatches = DEFAULT_MAX_BATCHES,
  materializeLimit = DEFAULT_BATCH_LIMIT,
  claimLimit = DEFAULT_BATCH_LIMIT,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
} = {}) {
  const safeConsumerKey = requireConsumerKey(consumerKey);
  const safeGeneration = requireGeneration(generation);
  const safeRegistry = requireRegistry(registry, safeGeneration);
  const safeMaxBatches = boundedInteger(maxBatches, DEFAULT_MAX_BATCHES, MAX_MATERIALIZE_BATCHES);
  const safeMaterializeLimit = boundedInteger(materializeLimit, DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT);
  const safeClaimLimit = boundedInteger(claimLimit, DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT);
  const safeLeaseSeconds = boundedInteger(leaseSeconds, DEFAULT_LEASE_SECONDS, MAX_LEASE_SECONDS);

  const counts = {
    materialized: 0,
    claimed: 0,
    handled: 0,
    ignored: 0,
    retried: 0,
    dead: 0,
  };

  for (let batch = 0; batch < safeMaxBatches; batch += 1) {
    const rows = await materializeMissingInboxRows({
      consumerKey: safeConsumerKey,
      generation: safeGeneration,
      limit: safeMaterializeLimit,
    });
    counts.materialized += rows.length;
    if (rows.length === 0) break;
  }

  const claims = await claimDueInboxRows({
    consumerKey: safeConsumerKey,
    generation: safeGeneration,
    limit: safeClaimLimit,
    leaseSeconds: safeLeaseSeconds,
  });
  counts.claimed = claims.length;

  for (const claim of claims) {
    try {
      const outcome = await processClaimedInboxRow({ claim, registry: safeRegistry });
      if (outcome.status === 'pending') {
        counts.retried += 1;
      } else if (Object.hasOwn(counts, outcome.status)) {
        counts[outcome.status] += 1;
      } else if (outcome.status === 'stale') {
        logger.warn('Pathway projector claim was stale before terminal processing');
      }
    } catch (error) {
      logger.warn('Pathway projector row processing did not complete', {
        error_code: processingErrorCode(error),
      });
    }
  }

  if (counts.dead > 0) {
    logger.warn('Pathway projector shadow tick dead-lettered rows', { dead: counts.dead });
  }

  return counts;
}

export default {
  materializeMissingInboxRows,
  claimDueInboxRows,
  processClaimedInboxRow,
  reapStaleInboxLeases,
  runPathwayProjectorShadowTick,
};
