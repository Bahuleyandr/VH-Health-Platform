// src/services/pharmacy/compositionSubstitutionAudit.js
//
// Persisted-only brand-substitution audit (Phase 2).
//
// When a saved prescription / medication order's CHOSEN brand (`catalog_id`)
// differs from the ORIGINALLY-selected brand (`original_catalog_id`), record one
// `clinical_audit_events` row so a substitution is attributable after the fact.
// Exploratory taps in the alternatives panel are NOT audited — only a persisted
// save reaches this helper.
//
// Security invariant: the caller supplies the two catalog ids as IDENTIFIERS
// ONLY. The before/after brand + composition text is SERVER-RESOLVED from the
// tenant-scoped `pharmacy_catalog` rows via resolveCompositionIdentitiesByCatalogIds
// — a client-supplied brand/composition string is never trusted or stored. If
// either id fails to resolve (missing / wrong-tenant / inactive), we DO NOT
// fabricate state — the audit is skipped.
//
// Best-effort: this helper NEVER throws and never blocks/fails the persisted
// save. Every failure path returns null.

import { resolveCompositionIdentitiesByCatalogIds } from './compositionIdentityService.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import logger from '../../logging/logger.js';

// Coerce an arbitrary value to a positive integer id, or null if not one.
function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Shape the server-resolved catalog identity into the audit before/after state.
function toBrandState(identity) {
  return {
    catalog_id: identity.catalog_id,
    brand_name: identity.name ?? null,
    composition_id: identity.composition_id ?? null,
    composition_label: identity.composition_label ?? null,
  };
}

/**
 * Record a brand-substitution audit event — persisted-only, best-effort.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} [params.patientUid]
 * @param {string} [params.encounterId]
 * @param {string} [params.actorUid]
 * @param {string} [params.actorRole]
 * @param {string} params.surface          'prescription' | 'drug_chart'
 * @param {string} params.resourceTable    'e_prescriptions' | 'clinical_orders'
 * @param {number|string} params.resourceId
 * @param {number|string} params.originalCatalogId  first-selected brand
 * @param {number|string} params.finalCatalogId     saved brand
 * @param {string} [params.reason]
 * @param {string} [params.requestId]
 * @returns {Promise<object|null>} the audit row, or null when nothing was recorded
 */
export async function recordBrandSubstitutionAudit({
  tenantId,
  patientUid,
  encounterId,
  actorUid,
  actorRole,
  surface,
  resourceTable,
  resourceId,
  originalCatalogId,
  finalCatalogId,
  reason,
  requestId,
} = {}) {
  try {
    const originalId = toPositiveInt(originalCatalogId);
    const finalId = toPositiveInt(finalCatalogId);

    // Nothing to record: a missing/invalid id, or the same brand (not a swap).
    if (originalId === null || finalId === null || originalId === finalId) {
      return null;
    }

    // Server-resolve BOTH ids, tenant-scoped. Treat the client values as
    // identifiers only — the brand/composition text comes from the DB rows.
    const identities = await resolveCompositionIdentitiesByCatalogIds(tenantId, [
      originalId,
      finalId,
    ]);
    const originalIdentity = identities.get(originalId);
    const finalIdentity = identities.get(finalId);

    // If EITHER id fails to resolve (missing / wrong-tenant / inactive), do not
    // fabricate state — skip the audit.
    if (!originalIdentity || !finalIdentity) {
      return null;
    }

    const beforeState = toBrandState(originalIdentity);
    const afterState = toBrandState(finalIdentity);

    return await recordClinicalAuditEvent({
      tenantId,
      patientUid,
      encounterId,
      actorUid,
      actorRole,
      action: 'medication.brand_substitution',
      actionStatus: 'success',
      resourceType: 'medication_brand_substitution',
      resourceTable,
      resourceId: String(resourceId),
      requestId,
      beforeState,
      afterState,
      metadata: {
        surface,
        reason: reason ?? null,
        original_catalog_id: originalId,
        final_catalog_id: finalId,
      },
      idempotencyKey: `brand_sub:${resourceTable}:${resourceId}:${originalId}:${finalId}`,
    });
  } catch (err) {
    // Best-effort: an audit failure must never break a persisted save.
    logger.warn(`recordBrandSubstitutionAudit failed: ${err?.message || err}`);
    return null;
  }
}
