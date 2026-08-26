import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  releaseDelayHours,
  structuredDiagnosticReleaseVisibilitySql,
} from '../portal/portalAccessService.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { recordPatientFeedNotificationWithReceipt } from '../../utils/notifications/patientNotificationFeed.js';
import {
  PREPERSISTED_FEED_NOTIFICATION_ID_PAYLOAD_KEY,
} from '../../utils/notifications/tenantNotificationChannels.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const NOTIFICATION_SETTING = 'diagnostic_result_notifications';
const NOTIFICATION_KIND = 'result_ready';
const POLICY_VERSION = 'structured_diagnostic_result_ready.v1';

function boundedLimit(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function notificationEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'enabled';
}

async function listCandidates(tenantId, limit) {
  return setTenantTx(tenantId, async (tx) => {
    const mode = await resolvePathwayModeTx({
      tx,
      tenantId,
      pathwayKey: CARE_PATHWAY_KEYS.DIAGNOSTICS,
    });
    const settingsRows = await tx.$queryRawUnsafe(
      `SELECT settings #>> ARRAY['care_pathways', $2::text] AS notification_mode
         FROM tenants
        WHERE id = $1::uuid`,
      tenantId,
      NOTIFICATION_SETTING,
    );
    const enabled = notificationEnabled(settingsRows[0]?.notification_mode);
    if (mode !== PATHWAY_MODES.ACTIVE || !enabled) {
      return { mode, enabled, generationIds: [] };
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT generation.id
         FROM diagnostic_result_generations AS generation
         JOIN diagnostic_result_release_states AS release_state
           ON release_state.tenant_id = generation.tenant_id
          AND release_state.generation_id = generation.id
          AND release_state.patient_uid = generation.patient_uid
        WHERE generation.tenant_id = $1::uuid
          AND generation.source_kind IN ('radiology_report', 'anatomical_pathology_report')
          AND NOT EXISTS (
            SELECT 1
              FROM diagnostic_result_generations AS successor
             WHERE successor.tenant_id = generation.tenant_id
               AND successor.predecessor_generation_id = generation.id
          )
          AND (${structuredDiagnosticReleaseVisibilitySql('$2')})
          AND NOT EXISTS (
            SELECT 1
              FROM diagnostic_result_patient_notifications AS receipt
             WHERE receipt.tenant_id = generation.tenant_id
               AND receipt.generation_id = generation.id
               AND receipt.notification_kind = '${NOTIFICATION_KIND}'
          )
        ORDER BY generation.signed_at, generation.id
        LIMIT $3::integer`,
      tenantId,
      releaseDelayHours(),
      limit,
    );
    return {
      mode,
      enabled,
      generationIds: rows.map((row) => String(row.id)),
    };
  });
}

async function queueGenerationNotification(tenantId, generationId) {
  return setTenantTx(tenantId, async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(
                hashtextextended($1::text || ':' || $2::text, 0)
              ) IS NULL AS lock_acquired`,
      tenantId,
      generationId,
    );
    const rolloutRows = await tx.$queryRawUnsafe(
      `SELECT LOWER(TRIM(COALESCE(
                settings #>> ARRAY['care_pathways', $2::text],
                'off'
              ))) AS pathway_mode,
              settings #>> ARRAY['care_pathways', $3::text] AS notification_mode
         FROM tenants
        WHERE id = $1::uuid
        FOR SHARE`,
      tenantId,
      CARE_PATHWAY_KEYS.DIAGNOSTICS,
      NOTIFICATION_SETTING,
    );
    const rollout = rolloutRows[0] || {};
    if (
      rollout.pathway_mode !== PATHWAY_MODES.ACTIVE
      || !notificationEnabled(rollout.notification_mode)
    ) {
      return Object.freeze({ queued: false, outcome: 'rollout_disabled' });
    }
    const rows = await tx.$queryRawUnsafe(
      `SELECT generation.id, generation.patient_uid, patient.phone
         FROM diagnostic_result_generations AS generation
         JOIN diagnostic_result_release_states AS release_state
           ON release_state.tenant_id = generation.tenant_id
          AND release_state.generation_id = generation.id
          AND release_state.patient_uid = generation.patient_uid
         JOIN users AS patient
           ON patient.tenant_id = generation.tenant_id
          AND patient.uid = generation.patient_uid
        WHERE generation.tenant_id = $1::uuid
          AND generation.id = $2::uuid
          AND generation.source_kind IN ('radiology_report', 'anatomical_pathology_report')
          AND NOT EXISTS (
            SELECT 1
              FROM diagnostic_result_generations AS successor
             WHERE successor.tenant_id = generation.tenant_id
               AND successor.predecessor_generation_id = generation.id
          )
          AND (${structuredDiagnosticReleaseVisibilitySql('$3')})
          AND NOT EXISTS (
            SELECT 1
              FROM diagnostic_result_patient_notifications AS receipt
             WHERE receipt.tenant_id = generation.tenant_id
               AND receipt.generation_id = generation.id
               AND receipt.notification_kind = '${NOTIFICATION_KIND}'
          )
        LIMIT 1
        FOR UPDATE OF release_state`,
      tenantId,
      generationId,
      releaseDelayHours(),
    );
    const generation = rows[0] || null;
    if (!generation) return Object.freeze({ queued: false, outcome: 'not_eligible' });

    const feedReceipt = await recordPatientFeedNotificationWithReceipt({
      client: tx,
      tenantId,
      uid: String(generation.patient_uid),
      phone: generation.phone || null,
      title: 'New report available',
      body: 'Open VH Health to securely view your latest report.',
      type: 'diagnostic_result_ready',
      data: {
        generation_id: String(generation.id),
        route: '/portal/diagnostic-results',
      },
      context: 'structured-diagnostic-result-ready',
    });
    if (!feedReceipt.written) {
      throw new Error('Diagnostic result notification feed insert was not confirmed');
    }

    const outboxRows = await tx.$queryRawUnsafe(
      `INSERT INTO notification_outbox
         (tenant_id, type, recipient_id, recipient_phone, title, body,
          payload, status, created_at)
       VALUES
         ($1::uuid, 'diagnostic_result_ready', $2::text, $3::text,
          'New report available',
          'Open VH Health to securely view your latest report.',
          jsonb_build_object(
            'tenant_id', $1::text,
            'type', 'diagnostic_result_ready',
            'route', '/portal/diagnostic-results',
            'generation_id', $6::text,
            $4::text, $5::integer
          ),
          'PENDING', NOW())
       RETURNING id`,
      tenantId,
      String(generation.patient_uid),
      generation.phone || null,
      PREPERSISTED_FEED_NOTIFICATION_ID_PAYLOAD_KEY,
      feedReceipt.notificationId,
      String(generation.id),
    );
    const outboxId = Number(outboxRows[0]?.id);
    if (!Number.isSafeInteger(outboxId) || outboxId <= 0) {
      throw new Error('Diagnostic result notification outbox insert returned no id');
    }
    const receipts = await tx.$queryRawUnsafe(
      `INSERT INTO diagnostic_result_patient_notifications
         (tenant_id, generation_id, patient_uid, notification_kind,
          policy_version, notification_outbox_id)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::integer)
       RETURNING id, notification_outbox_id`,
      tenantId,
      generation.id,
      generation.patient_uid,
      NOTIFICATION_KIND,
      POLICY_VERSION,
      outboxId,
    );
    return Object.freeze({
      queued: true,
      outcome: 'queued',
      receipt_id: String(receipts[0].id),
      notification_outbox_id: outboxId,
    });
  });
}

export async function runStructuredDiagnosticPatientNotificationSweep({
  tenantId,
  limit = DEFAULT_LIMIT,
} = {}) {
  const tid = requireTenantId(tenantId);
  const candidates = await listCandidates(tid, boundedLimit(limit));
  if (candidates.mode !== PATHWAY_MODES.ACTIVE || !candidates.enabled) {
    return Object.freeze({
      tenant_id: tid,
      pathway_mode: candidates.mode,
      notifications_enabled: candidates.enabled,
      candidates: 0,
      queued: 0,
      deferred: 0,
      errors: 0,
    });
  }

  let queued = 0;
  let deferred = 0;
  let errors = 0;
  for (const generationId of candidates.generationIds) {
    try {
      const outcome = await queueGenerationNotification(tid, generationId);
      if (outcome.queued) queued += 1;
      else deferred += 1;
    } catch (error) {
      errors += 1;
      logger.error('diagnostic-result-patient-notification generation failed', {
        tenantId: tid,
        generationId,
        error: error?.message || String(error),
      });
    }
  }
  return Object.freeze({
    tenant_id: tid,
    pathway_mode: candidates.mode,
    notifications_enabled: candidates.enabled,
    candidates: candidates.generationIds.length,
    queued,
    deferred,
    errors,
  });
}

export const __testing__ = Object.freeze({
  notificationEnabled,
  queueGenerationNotification,
  NOTIFICATION_SETTING,
  NOTIFICATION_KIND,
  POLICY_VERSION,
});

export default { runStructuredDiagnosticPatientNotificationSweep };
