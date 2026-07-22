// src/services/portal/portalAccessService.js
//
// Roadmap E6 — result release rules + formal proxy access.
//
//   * Release semantics: a lab result is patient-visible when it is signed
//     off AND not on hold AND (the auto-release delay has elapsed OR a
//     clinician released it early). The delay is
//     PORTAL_RESULT_RELEASE_DELAY_HOURS (default 24); migration 294
//     backfilled pre-existing signed-off rows as released so nothing a
//     patient could already see disappears.
//   * Doctor hold requires a reason and blocks release until lifted or
//     overridden by an explicit early release. Both are audited.
//   * Proxy access: portal_proxy_grants rows are the consent trail
//     (method/reference/grantor/expiry/revocation). Every proxy read is
//     audited with the grant id.

import prisma, { isTenantTransactionClient, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin, isClinical } from '../../utils/roleHelpers.js';
import {
  currentCanonicalTransactionRevision,
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
} from '../clinical/canonicalClinicalPlatformService.js';
import { publishEvent } from '../events/eventOutboxService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { resolveCurrentHumanActorTx } from '../workflow/workflowHumanOwnerService.js';

export function releaseDelayHours() {
  const n = Number(process.env.PORTAL_RESULT_RELEASE_DELAY_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : 24;
}

/**
 * SQL predicate for patient-visible lab results. `delayParam` is the
 * placeholder (e.g. '$3') that carries releaseDelayHours() at call time.
 */
export function releaseVisibilitySql(delayParam) {
  return `LOWER(COALESCE(status, '')) IN ('final', 'corrected', 'verified', 'amended')
    AND signed_off_at IS NOT NULL
    AND release_hold = false
    AND (
      (released_to_patient_at IS NOT NULL AND released_to_patient_at <= NOW())
      OR (signed_off_at IS NOT NULL AND signed_off_at <= NOW() - make_interval(hours => ${delayParam}::int))
    )`;
}

const STRUCTURED_RELEASE_FIELDS = [
  'status',
  'signed_off_at',
  'release_hold',
  'released_to_patient_at',
];

export function evaluateResultRelease(row, {
  delayHours = releaseDelayHours(),
  now = new Date(),
} = {}) {
  if (typeof row?.release_visible === 'boolean') {
    return Object.freeze({ outcome: row.release_visible ? 'visible' : 'not_visible' });
  }
  if (!row || STRUCTURED_RELEASE_FIELDS.some((field) => !(field in row))) {
    return Object.freeze({ outcome: 'unsupported_source' });
  }
  const status = String(row.status || '').trim().toLowerCase();
  const signedAt = row.signed_off_at ? new Date(row.signed_off_at) : null;
  const releasedAt = row.released_to_patient_at
    ? new Date(row.released_to_patient_at)
    : null;
  const nowMs = new Date(now).getTime();
  const signedMs = signedAt?.getTime();
  const releasedMs = releasedAt?.getTime();
  const supportedStatus = ['final', 'corrected', 'verified', 'amended'].includes(status);
  const validSignedAt = Number.isFinite(signedMs);
  const explicitRelease = Number.isFinite(releasedMs) && releasedMs <= nowMs;
  const elapsedRelease = validSignedAt
    && signedMs <= nowMs - (Number(delayHours) * 60 * 60 * 1000);
  return Object.freeze({
    outcome: supportedStatus
      && validSignedAt
      && row.release_hold === false
      && (explicitRelease || elapsedRelease)
      ? 'visible'
      : 'not_visible',
  });
}

export function evaluatePanelRelease(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return Object.freeze({ outcome: 'unsupported_source' });
  }
  const decisions = rows.map((row) => evaluateResultRelease(row, options));
  if (decisions.some((decision) => decision.outcome === 'unsupported_source')) {
    return Object.freeze({ outcome: 'unsupported_source' });
  }
  return Object.freeze({
    outcome: decisions.every((decision) => decision.outcome === 'visible')
      ? 'visible'
      : 'not_visible',
  });
}

export async function getResultEpisodeReleaseDecision({
  tenantId,
  patientUid,
  investigationId = null,
  bookingId = null,
  db = prisma,
} = {}) {
  const tid = requireTenantId(tenantId);
  const sourceId = investigationId != null ? Number(investigationId) : Number(bookingId);
  const sourceColumn = investigationId != null ? 'investigation_id' : 'booking_id';
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || !patientUid) {
    return Object.freeze({ outcome: 'unsupported_source' });
  }
  const rows = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS result_count,
            COALESCE(BOOL_AND(${releaseVisibilitySql('$4')}), false) AS all_visible
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND ${sourceColumn} = $3::int`,
    tid,
    String(patientUid),
    sourceId,
    releaseDelayHours(),
  );
  const summary = rows[0];
  if (!summary || Number(summary.result_count) === 0) {
    return Object.freeze({ outcome: 'unsupported_source' });
  }
  return Object.freeze({ outcome: summary.all_visible ? 'visible' : 'not_visible' });
}

export async function getDiagnosticGenerationReleaseDecisionTx({
  tx,
  tenantId,
  generationId,
} = {}) {
  if (!isTenantTransactionClient(tx)) {
    throw AppError.internal(
      'Diagnostic release evaluation requires a tenant transaction',
      'DIAGNOSTIC_RELEASE_TX_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  const generations = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, source_kind, classification, item_count
       FROM diagnostic_result_generations
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      LIMIT 1
      FOR SHARE`,
    tid,
    generationId,
  );
  const generation = generations[0] || null;
  if (!generation || generation.source_kind !== 'lab_panel') {
    return Object.freeze({
      outcome: 'unsupported_source',
      policy: 'lab_result_visibility.v1',
      generation_id: generationId ? String(generationId) : null,
    });
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT COUNT(*)::integer AS result_count,
            COALESCE(BOOL_AND(${releaseVisibilitySql('$3')}), false) AS all_visible
       FROM diagnostic_result_generation_items AS item
       JOIN lab_results AS result
         ON result.tenant_id = item.tenant_id
        AND result.id::text = item.source_row_id
      WHERE item.tenant_id = $1::uuid
        AND item.generation_id = $2::uuid
        AND item.source_table = 'lab_results'`,
    tid,
    generation.id,
    releaseDelayHours(),
  );
  const resultCount = Number(rows[0]?.result_count || 0);
  const complete = resultCount === Number(generation.item_count) && resultCount > 0;
  return Object.freeze({
    outcome: complete && rows[0]?.all_visible === true ? 'visible' : 'not_visible',
    policy: 'lab_result_visibility.v1',
    generation_id: String(generation.id),
    result_count: resultCount,
    generation_item_count: Number(generation.item_count),
    complete,
  });
}

function isResultReleaseActorRole(role) {
  return isClinical(role) || isAdmin(role) || role === 'SUPER_ADMIN';
}

async function resolveReleaseActorTx(tx, tenantId, {
  actorUid,
  actorRole,
  actorRoles = [],
  actorRawRole = null,
}) {
  return resolveCurrentHumanActorTx({
    tx,
    tenantId,
    actorUid,
    authenticatedRoles: actorRoles.length ? actorRoles : [actorRole],
    authenticatedPrimaryRole: actorRole,
    authenticatedRawRole: actorRawRole || actorRole,
    rolePredicate: isResultReleaseActorRole,
  });
}

// ── staff: hold / early release ──────────────────────────────────────────

async function getResult(tx, resultId, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, patient_uid, investigation_id, booking_id, test_name, status,
            signed_off_at, release_hold, release_hold_reason, released_to_patient_at
       FROM lab_results
      WHERE id = $1::int
        AND tenant_id = $2::uuid
      FOR UPDATE`,
    Number(resultId), tenantId,
  );
  if (!rows.length) throw AppError.notFound('Lab result not found', 'PORTAL_RESULT_NOT_FOUND');
  return rows[0];
}

export async function setResultReleaseHold(resultId, { hold, reason = null }, {
  actorUid = null,
  actorRole = null,
  actorRoles = [],
  actorRawRole = null,
  tenantId,
} = {}) {
  const tid = requireTenantId(tenantId);
  const wantHold = Boolean(hold);
  const normalizedReason = reason == null ? null : String(reason).trim();
  if (wantHold && (!reason || !String(reason).trim())) {
    throw AppError.badRequest('A reason is required to hold a result from the patient', 'PORTAL_HOLD_REASON_REQUIRED');
  }
  return setTenantTx(tid, async (tx) => {
    const actor = await resolveReleaseActorTx(tx, tid, {
      actorUid, actorRole, actorRoles, actorRawRole,
    });
    const result = await getResult(tx, resultId, tid);
    const effectiveReason = wantHold ? normalizedReason : null;
    if (
      result.release_hold === wantHold
      && (wantHold ? result.release_hold_reason === effectiveReason : true)
    ) {
      return {
        id: result.id,
        release_hold: result.release_hold,
        release_hold_reason: result.release_hold_reason,
        released_to_patient_at: result.released_to_patient_at,
      };
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE lab_results
       SET release_hold = $2,
           release_hold_by = $3::uuid,
           release_hold_reason = $4,
           release_hold_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $1::int
         AND tenant_id = $5::uuid
         AND release_hold IS NOT DISTINCT FROM $6::boolean
       RETURNING id, release_hold, release_hold_reason, released_to_patient_at`,
      result.id,
      wantHold,
      wantHold ? actor.uid : null,
      effectiveReason,
      tid,
      result.release_hold,
    );
    if (!rows.length) {
      throw AppError.conflict('Result release state changed concurrently', 'PORTAL_RELEASE_STATE_RACE');
    }
    const revision = await currentCanonicalTransactionRevision(tx);
    const action = wantHold ? 'lab.result_release_hold' : 'lab.result_release_unhold';
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: result.patient_uid,
      eventType: action,
      eventSubtype: 'lab',
      eventStatus: wantHold ? 'held' : 'released',
      sourceTable: 'lab_results',
      sourceId: String(result.id),
      resourceType: 'lab_result',
      resourceTable: 'lab_results',
      resourceId: String(result.id),
      actorUid: actor.uid,
      actorRole: actor.rawRole,
      visibleToPatient: false,
      summary: wantHold ? 'Lab result release held' : 'Lab result release hold lifted',
      beforeState: {
        release_hold: result.release_hold,
        release_hold_reason: result.release_hold_reason,
        released_to_patient_at: result.released_to_patient_at,
      },
      afterState: rows[0],
      metadata: { reason: effectiveReason },
      timelineIdempotencyKey: `lab_results:${result.id}:${action}:tx:${revision}`,
      auditIdempotencyKey: `lab_results:${result.id}:audit:${action}:tx:${revision}`,
    }, { db: tx });
    return rows[0];
  });
}

export async function releaseResultNow(resultId, {
  actorUid = null,
  actorRole = null,
  actorRoles = [],
  actorRawRole = null,
  tenantId,
} = {}) {
  const tid = requireTenantId(tenantId);
  const committed = await setTenantTx(tid, async (tx) => {
    const actor = await resolveReleaseActorTx(tx, tid, {
      actorUid, actorRole, actorRoles, actorRawRole,
    });
    const result = await getResult(tx, resultId, tid);
    if (!result.signed_off_at) {
      throw AppError.badRequest('Only signed-off results can be released to the patient', 'PORTAL_RELEASE_UNSIGNED');
    }
    if (result.released_to_patient_at && result.release_hold === false) {
      return { row: result, result, changed: false };
    }
    const rows = await tx.$queryRawUnsafe(
      `UPDATE lab_results
       SET released_to_patient_at = NOW(), release_hold = false,
           release_hold_by = NULL, release_hold_reason = NULL, release_hold_at = NULL,
           updated_at = NOW()
       WHERE id = $1::int
         AND tenant_id = $2::uuid
         AND signed_off_at IS NOT NULL
         AND release_hold IS NOT DISTINCT FROM $3::boolean
         AND released_to_patient_at IS NOT DISTINCT FROM $4::timestamptz
       RETURNING id, released_to_patient_at, release_hold`,
      result.id,
      tid,
      result.release_hold,
      result.released_to_patient_at,
    );
    if (!rows.length) {
      throw AppError.conflict('Result release state changed concurrently', 'PORTAL_RELEASE_STATE_RACE');
    }
    const revision = await currentCanonicalTransactionRevision(tx);
    await recordCanonicalClinicalEvent({
      tenantId: tid,
      patientUid: result.patient_uid,
      eventType: 'lab.result_released_early',
      eventSubtype: 'lab',
      eventStatus: 'released',
      sourceTable: 'lab_results',
      sourceId: String(result.id),
      resourceType: 'lab_result',
      resourceTable: 'lab_results',
      resourceId: String(result.id),
      actorUid: actor.uid,
      actorRole: actor.rawRole,
      visibleToPatient: false,
      summary: 'Lab result released to patient',
      beforeState: {
        release_hold: result.release_hold,
        release_hold_reason: result.release_hold_reason,
        released_to_patient_at: result.released_to_patient_at,
      },
      afterState: rows[0],
      metadata: { was_on_hold: result.release_hold },
      timelineIdempotencyKey: `lab_results:${result.id}:lab.result_released_early:tx:${revision}`,
      auditIdempotencyKey: `lab_results:${result.id}:audit:lab.result_released_early:tx:${revision}`,
    }, { db: tx });
    const generations = await tx.$queryRawUnsafe(
      `SELECT DISTINCT generation.id
         FROM diagnostic_result_generation_items AS item
         JOIN diagnostic_result_generations AS generation
           ON generation.tenant_id = item.tenant_id
          AND generation.id = item.generation_id
        WHERE item.tenant_id = $1::uuid
          AND item.source_table = 'lab_results'
          AND item.source_row_id = $2::text
          AND generation.classification = 'normal'
          AND NOT EXISTS (
            SELECT 1
              FROM diagnostic_result_generations AS successor
             WHERE successor.tenant_id = generation.tenant_id
               AND successor.predecessor_generation_id = generation.id
          )
        ORDER BY generation.id`,
      tid,
      String(result.id),
    );
    for (const generation of generations) {
      const releaseDecision = await getDiagnosticGenerationReleaseDecisionTx({
        tx,
        tenantId: tid,
        generationId: String(generation.id),
      });
      if (releaseDecision.outcome !== 'visible') continue;
      await publishEvent({
        eventType: 'diagnostic.result.release_became_eligible',
        aggregateType: 'diagnostic_result_generation',
        aggregateId: String(generation.id),
        patientUid: result.patient_uid,
        tenantId: tid,
        tx,
        payload: {
          generation_id: String(generation.id),
          release_source: 'explicit_early_release',
          lab_result_id: String(result.id),
        },
      });
    }
    return { row: rows[0], result, changed: true };
  });
  if (committed.changed) {
    const decision = await getResultEpisodeReleaseDecision({
      tenantId: tid,
      patientUid: committed.result.patient_uid,
      investigationId: committed.result.investigation_id,
      bookingId: committed.result.booking_id,
    });
    if (decision.outcome === 'visible') {
      try {
        const { notifyPatientResultRecipients } = await import('../lab/labResultsService.js');
        await notifyPatientResultRecipients({
          tenantId: tid,
          patientUid: committed.result.patient_uid,
          type: 'lab_result_ready',
          title: 'Lab results ready',
          patientBody: 'Your lab results are ready to view.',
          guardianBody: 'Lab results for your dependent are ready to view.',
          data: {
            investigation_id: committed.result.investigation_id,
            booking_id: committed.result.booking_id,
            patient_uid: committed.result.patient_uid,
          },
        });
      } catch (error) {
        logger.warn('Lab result-ready notification after early release failed', {
          error: error?.message,
          resultId: committed.result.id,
        });
      }
    }
  }
  return committed.row;
}

// ── proxy grants (consent trail) ─────────────────────────────────────────

export async function createProxyGrant({
  patientUid, proxyUid, relationship = null, scope = ['results'],
  consentMethod, consentRef = null, expiresAt = null, signatureProof = null,
}, { actorUid = null, actorRole = null } = {}) {
  if (!patientUid || !proxyUid) {
    throw AppError.badRequest('patient_uid and proxy_uid are required', 'PORTAL_PROXY_IDS_REQUIRED');
  }
  if (String(patientUid) === String(proxyUid)) {
    throw AppError.badRequest('A patient cannot be their own proxy', 'PORTAL_PROXY_SELF');
  }
  if (!['written', 'verbal_documented', 'otp', 'guardian_minor'].includes(consentMethod)) {
    throw AppError.badRequest('consent_method must be written, verbal_documented, otp, or guardian_minor', 'PORTAL_CONSENT_METHOD_INVALID');
  }
  // The patient grants for themself; staff may record a grant on the
  // patient's behalf (consent captured out-of-band, referenced here).
  const isSelfGrant = actorUid && String(actorUid) === String(patientUid);
  if (!isSelfGrant && !actorRole) {
    throw AppError.forbidden('Only the patient or staff may create a proxy grant', 'PORTAL_PROXY_GRANTOR_INVALID');
  }

  const users = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    patientUid, proxyUid,
  );
  if (users.length !== 2) {
    throw AppError.notFound('Patient or proxy account not found', 'PORTAL_PROXY_USER_NOT_FOUND');
  }

  const cleanScope = (Array.isArray(scope) && scope.length ? scope : ['results']).map(String);

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO portal_proxy_grants
         (patient_uid, proxy_uid, relationship, scope, consent_method, consent_ref,
          signature_storage_key, signature_storage_url, signature_mime_type,
          signature_file_size, signature_sha256_hash, signature_captured_at,
          granted_by, expires_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5, $6,
               $7, $8, $9, $10::int, $11::text, CASE WHEN $11::text IS NULL THEN NULL ELSE NOW() END,
               $12::uuid, $13::timestamptz)
       RETURNING *`,
      patientUid, proxyUid, relationship || null, cleanScope,
      consentMethod, consentRef || null,
      signatureProof?.storageKey || null,
      signatureProof?.storageUrl || null,
      signatureProof?.mimeType || null,
      signatureProof?.fileSize || null,
      signatureProof?.sha256Hash || null,
      actorUid, expiresAt || null,
    );
    const grant = rows[0];

    await recordClinicalAuditEvent({
      patientUid,
      action: 'portal.proxy_granted',
      resourceTable: 'portal_proxy_grants',
      resourceId: String(grant.id),
      actorUid,
      actorRole,
      metadata: {
        proxy_uid: proxyUid, relationship, scope: cleanScope,
        consent_method: consentMethod, consent_ref: consentRef, expires_at: expiresAt,
        signature_sha256_hash: signatureProof?.sha256Hash || null,
      },
    });

    return grant;
  } catch (err) {
    if (String(err.message).includes('uq_portal_proxy_grants_active')) {
      throw AppError.conflict('An active grant for this proxy already exists', 'PORTAL_PROXY_GRANT_EXISTS');
    }
    throw err;
  }
}

export async function revokeProxyGrant(grantId, { reason = null }, { actorUid = null, actorRole = null } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, proxy_uid, status FROM portal_proxy_grants WHERE id = $1::int`,
    Number(grantId),
  );
  if (!rows.length) throw AppError.notFound('Proxy grant not found', 'PORTAL_PROXY_GRANT_NOT_FOUND');
  const grant = rows[0];
  const isOwner = actorUid && String(actorUid) === String(grant.patient_uid);
  if (!isOwner && !actorRole) {
    throw AppError.forbidden('Only the patient or staff may revoke a grant', 'PORTAL_PROXY_REVOKE_FORBIDDEN');
  }
  if (grant.status !== 'active') {
    throw AppError.invalidTransition(grant.status, 'revoked', ['active']);
  }

  const updated = await prisma.$queryRawUnsafe(
    `UPDATE portal_proxy_grants
     SET status = 'revoked', revoked_at = NOW(), revoked_by = $2::uuid, revoked_reason = $3, updated_at = NOW()
     WHERE id = $1::int AND status = 'active'
     RETURNING id, status, revoked_at`,
    grant.id, actorUid, reason || null,
  );
  if (!updated.length) throw AppError.conflict('Grant state changed concurrently', 'PORTAL_PROXY_RACE');

  await recordClinicalAuditEvent({
    patientUid: grant.patient_uid,
    action: 'portal.proxy_revoked',
    resourceTable: 'portal_proxy_grants',
    resourceId: String(grant.id),
    actorUid,
    actorRole,
    metadata: { proxy_uid: grant.proxy_uid, reason },
  });

  return updated[0];
}

export async function listProxyGrants(uid) {
  const grantedByMe = await prisma.$queryRawUnsafe(
    `SELECT id, proxy_uid, relationship, scope, status, consent_method,
            signature_sha256_hash, signature_captured_at,
            granted_at, expires_at, revoked_at
     FROM portal_proxy_grants WHERE patient_uid = $1::uuid ORDER BY granted_at DESC`,
    uid,
  );
  const heldByMe = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, relationship, scope, status, granted_at, expires_at
     FROM portal_proxy_grants
     WHERE proxy_uid = $1::uuid AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY granted_at DESC`,
    uid,
  );
  return { granted_by_me: grantedByMe, held_by_me: heldByMe };
}

/**
 * Resolve the effective patient uid for a portal read. Self-access passes
 * through; proxy access requires an active, unexpired grant covering the
 * requested scope and is audited with the grant id.
 */
export async function resolvePortalPatient({ requesterUid, forPatientUid = null, scope = 'results' }) {
  if (!forPatientUid || String(forPatientUid) === String(requesterUid)) {
    return { patientUid: requesterUid, proxy: false };
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, scope FROM portal_proxy_grants
     WHERE patient_uid = $1::uuid AND proxy_uid = $2::uuid AND status = 'active'
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    forPatientUid, requesterUid,
  );
  if (!rows.length || !rows[0].scope.includes(scope)) {
    throw AppError.forbidden('No active proxy grant for this patient', 'PORTAL_PROXY_NOT_GRANTED');
  }

  // Consent trail: every proxy read is audited (best-effort, never blocks).
  recordClinicalAuditEvent({
    patientUid: forPatientUid,
    action: 'portal.proxy_access',
    resourceTable: 'portal_proxy_grants',
    resourceId: String(rows[0].id),
    actorUid: requesterUid,
    metadata: { scope },
    idempotencyKey: `proxy-access-${rows[0].id}-${requesterUid}-${new Date().toISOString().slice(0, 13)}`,
  }).catch((err) => logger.warn('proxy access audit failed', { error: err.message }));

  return { patientUid: forPatientUid, proxy: true, grantId: rows[0].id };
}

// ── lab trends (longitudinal series) ─────────────────────────────────────

export async function getLabTrend({ tenantId, patientUid, testCode = null, loincCode = null, months = 24 }) {
  if (!testCode && !loincCode) {
    throw AppError.badRequest('test_code or loinc_code is required', 'PORTAL_TREND_TEST_REQUIRED');
  }
  const span = Math.min(Math.max(Number(months) || 24, 1), 120);
  const byLoinc = Boolean(loincCode);
  const delay = releaseDelayHours();

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, test_code, loinc_code, test_name, value_numeric, unit, reference_range,
            abnormal_flag, COALESCE(performed_at, received_at) AS observation_datetime
     FROM lab_results
     WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
       AND ${byLoinc ? 'loinc_code = $3' : 'test_code = $3'}
       AND value_numeric IS NOT NULL
       AND COALESCE(performed_at, received_at) >= NOW() - make_interval(months => $4::int)
       AND ${releaseVisibilitySql('$5')}
     ORDER BY COALESCE(performed_at, received_at) ASC`,
    requireTenantId(tenantId),
    String(patientUid),
    byLoinc ? String(loincCode) : String(testCode),
    span,
    delay,
  );

  const values = rows.map((r) => Number(r.value_numeric));
  return {
    test_code: byLoinc ? null : String(testCode),
    loinc_code: byLoinc ? String(loincCode) : (rows[0]?.loinc_code ?? null),
    test_name: rows[0]?.test_name ?? null,
    unit: rows[0]?.unit ?? null,
    months: span,
    count: rows.length,
    latest: rows.length ? { value: values[values.length - 1], at: rows[rows.length - 1].observation_datetime } : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    points: rows.map((r) => ({
      id: r.id,
      at: r.observation_datetime,
      value: Number(r.value_numeric),
      abnormal_flag: r.abnormal_flag,
      reference_range: r.reference_range,
    })),
  };
}

export default {
  releaseDelayHours,
  releaseVisibilitySql,
  evaluateResultRelease,
  evaluatePanelRelease,
  getResultEpisodeReleaseDecision,
  getDiagnosticGenerationReleaseDecisionTx,
  setResultReleaseHold,
  releaseResultNow,
  createProxyGrant,
  revokeProxyGrant,
  listProxyGrants,
  resolvePortalPatient,
  getLabTrend,
};
