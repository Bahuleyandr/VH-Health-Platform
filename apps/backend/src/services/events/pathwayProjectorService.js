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
      'Current projector generation requires the canonical registry',
      'PATHWAY_PROJECTOR_REGISTRY_IDENTITY_MISMATCH',
    );
  }
  return registry;
}

function materializationResult(rows, {
  completed,
  scanned,
  historicalCutoffEventId,
  backfillCursorEventId,
}) {
  Object.defineProperties(rows, {
    completed: { value: completed, enumerable: false },
    scanned: { value: scanned, enumerable: false },
    historical_cutoff_event_id: { value: historicalCutoffEventId, enumerable: false },
    backfill_cursor_event_id: { value: backfillCursorEventId, enumerable: false },
  });
  return rows;
}

async function readEventConsumerOffset(db, consumerKey, generation, { lock = false } = {}) {
  const rows = await db.$queryRawUnsafe(
    `SELECT consumer_key,
            generation,
            historical_cutoff_event_id::text,
            backfill_cursor_event_id::text,
            backfill_completed_at,
            intake_retired_at,
            registered_at,
            updated_at
       FROM public.pathway_projector_offset_get(
         $1::text,
         $2::integer,
         $3::boolean
       )`,
    consumerKey,
    generation,
    lock,
  );
  return rows[0] || null;
}

export async function registerEventConsumer({
  consumerKey = PATHWAY_PROJECTOR_CONSUMER_KEY,
  generation = PATHWAY_PROJECTOR_GENERATION,
} = {}) {
  const safeConsumerKey = requireConsumerKey(consumerKey);
  const safeGeneration = requireGeneration(generation);
  const registered = await readEventConsumerOffset(prisma, safeConsumerKey, safeGeneration);
  if (registered && !registered.intake_retired_at) return registered;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'LOCK TABLE public.event_outbox IN SHARE ROW EXCLUSIVE MODE',
    );
    const afterLock = await readEventConsumerOffset(tx, safeConsumerKey, safeGeneration);
    if (afterLock && !afterLock.intake_retired_at) return afterLock;
    if (afterLock?.intake_retired_at) {
      throw AppError.conflict(
        'Projector consumer generation is retired',
        'PATHWAY_PROJECTOR_GENERATION_RETIRED',
      );
    }

    const knownRegistrations = await tx.$queryRawUnsafe(
      `SELECT consumer_key,
              generation,
              backfill_completed_at,
              intake_retired_at
         FROM public.pathway_projector_offsets_list($1::text, TRUE)
        ORDER BY generation`,
      safeConsumerKey,
    );
    const highestKnownGeneration = knownRegistrations.at(-1)?.generation ?? 0;
    if (safeGeneration <= highestKnownGeneration) {
      throw AppError.conflict(
        'Projector consumer generation must advance monotonically',
        'PATHWAY_PROJECTOR_GENERATION_OUT_OF_ORDER',
      );
    }

    const liveRegistrations = knownRegistrations.filter(
      (registration) => !registration.intake_retired_at,
    );
    if (liveRegistrations.length > 1) {
      throw AppError.internal(
        'Projector consumer has multiple live generations',
        'PATHWAY_PROJECTOR_LIFECYCLE_INVARIANT_VIOLATION',
      );
    }
    const liveRegistration = liveRegistrations[0] || null;
    if (liveRegistration && !liveRegistration.backfill_completed_at) {
      throw AppError.conflict(
        'Projector consumer generation handoff is blocked by incomplete backfill',
        'PATHWAY_PROJECTOR_GENERATION_HANDOFF_BLOCKED',
      );
    }

    if (liveRegistration) {
      const retired = await tx.$queryRawUnsafe(
        `SELECT generation
           FROM public.pathway_projector_offset_retire(
             $1::text,
             $2::integer
           )`,
        safeConsumerKey,
        liveRegistration.generation,
      );
      if (retired.length !== 1) {
        throw AppError.internal(
          'Projector consumer generation handoff lost its lifecycle fence',
          'PATHWAY_PROJECTOR_LIFECYCLE_FENCE_LOST',
        );
      }
    }

    const cutoffs = await tx.$queryRawUnsafe(
      `SELECT COALESCE(MAX(id), 0)::text AS cutoff,
              MAX(id) IS NULL AS completed
         FROM event_outbox`,
    );
    const rows = await tx.$queryRawUnsafe(
      `SELECT consumer_key,
              generation,
              historical_cutoff_event_id::text,
              backfill_cursor_event_id::text,
              backfill_completed_at,
              intake_retired_at,
              registered_at,
              updated_at
         FROM public.pathway_projector_offset_register(
           $1::text,
           $2::integer,
           $3::bigint,
           $4::boolean
         )`,
      safeConsumerKey,
      safeGeneration,
      cutoffs[0].cutoff,
      cutoffs[0].completed,
    );
    return rows[0];
  });
}

export async function materializeMissingInboxRows({
  consumerKey = PATHWAY_PROJECTOR_CONSUMER_KEY,
  generation = PATHWAY_PROJECTOR_GENERATION,
  limit = DEFAULT_BATCH_LIMIT,
} = {}) {
  const safeConsumerKey = requireConsumerKey(consumerKey);
  const safeGeneration = requireGeneration(generation);
  const safeLimit = boundedInteger(limit, DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT);
  await registerEventConsumer({
    consumerKey: safeConsumerKey,
    generation: safeGeneration,
  });

  return prisma.$transaction(async (tx) => {
    const offset = await readEventConsumerOffset(
      tx,
      safeConsumerKey,
      safeGeneration,
      { lock: true },
    );
    if (!offset) {
      throw AppError.internal(
        'Projector consumer registration unavailable',
        'PATHWAY_PROJECTOR_REGISTRATION_UNAVAILABLE',
      );
    }
    if (offset.intake_retired_at) {
      throw AppError.conflict(
        'Projector consumer generation is retired',
        'PATHWAY_PROJECTOR_GENERATION_RETIRED',
      );
    }
    if (offset.backfill_completed_at) {
      return materializationResult([], {
        completed: true,
        scanned: 0,
        historicalCutoffEventId: offset.historical_cutoff_event_id,
        backfillCursorEventId: offset.backfill_cursor_event_id,
      });
    }

    const scanned = await tx.$queryRawUnsafe(
      `SELECT tenant_id::text, id::text AS event_id
         FROM event_outbox
        WHERE id > $1::bigint
          AND id <= $2::bigint
        ORDER BY id
        LIMIT $3::integer`,
      offset.backfill_cursor_event_id,
      offset.historical_cutoff_event_id,
      safeLimit,
    );

    let inserted = [];
    if (scanned.length > 0) {
      inserted = await tx.$queryRawUnsafe(
        `INSERT INTO pathway_projector_inbox
           (scope_kind, tenant_id, consumer_key, generation, event_id)
         SELECT 'pathway_registry', source.tenant_id, $1::text,
                $2::integer, source.event_id
           FROM unnest($3::uuid[], $4::bigint[]) AS source(tenant_id, event_id)
         ON CONFLICT DO NOTHING
         RETURNING event_id::text, tenant_id::text`,
        safeConsumerKey,
        safeGeneration,
        scanned.map((row) => row.tenant_id),
        scanned.map((row) => row.event_id),
      );
    }

    const lastScannedEventId = scanned.at(-1)?.event_id
      ?? offset.historical_cutoff_event_id;
    const completed = scanned.length === 0
      || lastScannedEventId === offset.historical_cutoff_event_id;
    const progress = await tx.$queryRawUnsafe(
      `SELECT historical_cutoff_event_id::text,
              backfill_cursor_event_id::text,
              backfill_completed_at
         FROM public.pathway_projector_offset_advance(
           $1::text,
           $2::integer,
           $3::bigint,
           $4::boolean
         )`,
      safeConsumerKey,
      safeGeneration,
      lastScannedEventId,
      completed,
    );

    return materializationResult(inserted, {
      completed: Boolean(progress[0]?.backfill_completed_at),
      scanned: scanned.length,
      historicalCutoffEventId: progress[0].historical_cutoff_event_id,
      backfillCursorEventId: progress[0].backfill_cursor_event_id,
    });
  });
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
       SELECT tenant_id, consumer_key, generation, event_id
         FROM pathway_projector_inbox
        WHERE scope_kind = 'pathway_registry'
          AND consumer_key = $1::text
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
        AND i.tenant_id = due.tenant_id
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
       WHERE scope_kind = 'pathway_registry'
        AND consumer_key = $1::text
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
                e.created_at::text AS recorded_at,
                e.occurred_at::text AS occurred_at,
                e.occurred_at_source,
                e.recovery_inbox_id::text,
                e.recovery_effect_disposition,
                recovery.status AS recovery_status,
                recovery.pending_task_id AS recovery_pending_task_id
           FROM pathway_projector_inbox i
           LEFT JOIN event_outbox e
             ON e.id = i.event_id
            AND e.tenant_id = i.tenant_id
           LEFT JOIN pathway_projector_inbox recovery
             ON recovery.inbox_id = e.recovery_inbox_id
            AND recovery.tenant_id = e.tenant_id
            AND recovery.scope_kind = 'external_interface'
           WHERE i.scope_kind = 'pathway_registry'
            AND i.consumer_key = $1::text
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

      const latePendingOnly = row.recovery_effect_disposition === 'late_pending_only';
      if (
        latePendingOnly
        && (
          !row.recovery_inbox_id
          || row.recovery_status !== 'handled'
          || !row.recovery_pending_task_id
        )
      ) {
        throw AppError.internal(
          'Late recovery event is missing terminal pending-work evidence',
          'PATHWAY_PROJECTOR_LATE_PENDING_WORK_MISSING',
        );
      }
      const handler = latePendingOnly ? null : safeRegistry.resolve(row.event_type);
      const terminalStatus = handler ? 'handled' : 'ignored';
      const outcomeCode = latePendingOnly
        ? 'late_pending_only_pathway_suppressed'
        : null;
      let metadata = latePendingOnly
        ? {
          outcome_code: outcomeCode,
          recovery_inbox_id: row.recovery_inbox_id,
          pending_task_id: row.recovery_pending_task_id,
        }
        : null;
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
            occurred_at: row.occurred_at,
            occurred_at_source: row.occurred_at_source,
            recorded_at: row.recorded_at,
          }),
        });
      }

      const terminalRows = await tx.$queryRawUnsafe(
        `UPDATE pathway_projector_inbox
            SET status = $7::text,
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_error = NULL,
                outcome_at = NOW(),
                outcome_code = $8::text
          WHERE scope_kind = 'pathway_registry'
            AND consumer_key = $1::text
            AND generation = $2::integer
            AND event_id = $3::bigint
            AND tenant_id = $4::uuid
            AND status = 'pending'
             AND lease_owner = $5::uuid
             AND attempts = $6::integer
           RETURNING event_id::text, tenant_id::text, status, attempts,
                     outcome_at, outcome_code`,
        normalizedClaim.consumer_key,
        normalizedClaim.generation,
        normalizedClaim.event_id,
        normalizedClaim.tenant_id,
        normalizedClaim.lease_owner,
        normalizedClaim.attempts,
        terminalStatus,
        outcomeCode,
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
       SELECT tenant_id, consumer_key, generation, event_id, attempts, lease_owner
         FROM pathway_projector_inbox
         WHERE scope_kind = 'pathway_registry'
           AND consumer_key = $1::text
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
        AND i.tenant_id = stale.tenant_id
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

  await registerEventConsumer({
    consumerKey: safeConsumerKey,
    generation: safeGeneration,
  });

  for (let batch = 0; batch < safeMaxBatches; batch += 1) {
    const rows = await materializeMissingInboxRows({
      consumerKey: safeConsumerKey,
      generation: safeGeneration,
      limit: safeMaterializeLimit,
    });
    counts.materialized += rows.length;
    if (rows.completed) break;
  }

  const maxDispatches = safeMaxBatches * safeClaimLimit;
  for (let dispatch = 0; dispatch < maxDispatches; dispatch += 1) {
    const claims = await claimDueInboxRows({
      consumerKey: safeConsumerKey,
      generation: safeGeneration,
      limit: 1,
      leaseSeconds: safeLeaseSeconds,
    });
    if (claims.length === 0) break;
    counts.claimed += 1;
    const [claim] = claims;
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
  registerEventConsumer,
  materializeMissingInboxRows,
  claimDueInboxRows,
  processClaimedInboxRow,
  reapStaleInboxLeases,
  runPathwayProjectorShadowTick,
};
