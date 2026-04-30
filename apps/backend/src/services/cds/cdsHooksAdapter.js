/**
 * CDS Hooks adapter — translate VH Health's internal CDS alerts into
 * standards-compliant CDS Hooks JSON cards (https://cds-hooks.org/).
 *
 * cdsEngine returns alerts in our internal shape:
 *   { type, severity: 'critical' | 'warning' | 'info', title, description,
 *     canOverride, sourceData }
 *
 * CDS Hooks consumers (other EHRs) expect:
 *   { uuid, summary, indicator, source: { label, url? }, detail?, ... }
 *
 * This module is a pure-function adapter: no DB, no LLM. Routes call into
 * cdsEngine to get the alert objects, then translate via the helpers here
 * before returning the standards-compliant response.
 *
 * Closes substrate hole S4 in docs/AI_FEATURE_GAP_BACKLOG.md. Pairs with
 * Phase D2 of docs/HEALTHCARE_AI_SPEC_AUDIT.md.
 */

import crypto from 'crypto';

const SERVICE_LABEL = 'VH Health Clinical Decision Support';
const SERVICE_URL = 'https://docs.vhhealth.app/cds';

/**
 * Service catalogue advertised by GET /cds-services. Each entry maps a
 * standard hook ID to an in-cdsEngine evaluator that the route handler
 * will call.
 */
export const CDS_HOOKS_SERVICES = [
  {
    id: 'vh-patient-view',
    hook: 'patient-view',
    title: 'VH Health patient-view alerts',
    description:
      'Returns active CDS alerts and protocol reminders for the patient on chart open.',
  },
  {
    id: 'vh-medication-prescribe',
    hook: 'medication-prescribe',
    title: 'VH Health medication-prescribe checks',
    description:
      'Drug-drug interaction, allergy conflict, and duplicate-therapy checks before a clinician signs a medication order.',
  },
  {
    id: 'vh-order-select',
    hook: 'order-select',
    title: 'VH Health order-select advisories',
    description:
      'Lightweight advisories on draft orders the clinician has selected but not yet signed.',
  },
  {
    id: 'vh-order-sign',
    hook: 'order-sign',
    title: 'VH Health order-sign safety checks',
    description:
      'Full CDS safety checks on each order being signed, including drug interaction, allergy, duplicate, and recent-result checks.',
  },
  {
    id: 'vh-encounter-start',
    hook: 'encounter-start',
    title: 'VH Health encounter-start advisories',
    description:
      'Advisories surfaced when an encounter (visit) is opened: active patient alerts, protocol reminders, follow-up plans due, allergies on file, recent critical labs.',
  },
  {
    id: 'vh-encounter-discharge',
    hook: 'encounter-discharge',
    title: 'VH Health encounter-discharge readiness checks',
    description:
      'Pre-discharge readiness advisories: unsigned orders, pending follow-up plans, missing discharge summary, unacknowledged critical alerts. Note: hook id "encounter-discharge" matches the CDS Hooks v1.0 spec; "encounter-close" is the verb shorthand used internally.',
  },
];

/**
 * Map our internal severity to a CDS Hooks indicator. CDS Hooks defines:
 *   - 'info': informational
 *   - 'warning': clinically significant; clinician should review
 *   - 'critical': blocking-level concern
 * cdsEngine emits the same three values, but rename in case we ever add
 * more internal severities.
 */
export function severityToIndicator(severity) {
  const value = String(severity || '').toLowerCase();
  if (value === 'critical') return 'critical';
  if (value === 'warning' || value === 'high') return 'warning';
  return 'info';
}

/**
 * Trim a string to the CDS Hooks summary cap (140 chars per spec).
 */
function trimSummary(text, max = 140) {
  const value = String(text || '').trim();
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Stable UUID for a card derived from its content. Same alert in two
 * invocations should produce the same UUID, so consumers can de-dup.
 */
function deriveCardUuid(alert) {
  const seed = JSON.stringify({
    type: alert.type,
    severity: alert.severity,
    title: alert.title,
    sourceData: alert.sourceData || null,
  });
  const hash = crypto.createHash('sha1').update(seed).digest('hex');
  // Format as UUID v4-ish (not strictly v4; CDS Hooks doesn't require it,
  // but consumers expect uuid-shape).
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Convert a single internal alert into a CDS Hooks card.
 */
export function alertToCard(alert) {
  if (!alert || !alert.title) return null;
  const card = {
    uuid: deriveCardUuid(alert),
    summary: trimSummary(alert.title),
    indicator: severityToIndicator(alert.severity),
    source: { label: SERVICE_LABEL, url: SERVICE_URL },
  };
  if (alert.description) {
    card.detail = String(alert.description).slice(0, 4000);
  }
  // Surface override eligibility + structured source data to consumers
  // that want to render them. Spec allows additional fields.
  if (alert.canOverride === false) card.overrideReasons = [];
  if (alert.sourceData && typeof alert.sourceData === 'object') {
    card.extension = { vh_source_data: alert.sourceData };
  }
  return card;
}

/**
 * Convert an array of alerts into a CDS Hooks response body.
 */
export function buildCardsResponse(alerts) {
  const cards = (alerts || [])
    .map(alertToCard)
    .filter(Boolean);
  return { cards };
}

/**
 * Extract a bare patient UID from a CDS Hooks context. The spec puts the
 * patient as a FHIR Reference string ("Patient/abc-uid"), but we also
 * accept the raw UID for convenience.
 */
export function extractPatientUid(context) {
  if (!context || typeof context !== 'object') return null;
  const raw = context.patientId || context.patient || null;
  if (!raw) return null;
  const value = String(raw);
  if (value.startsWith('Patient/')) return value.slice('Patient/'.length);
  return value;
}

/**
 * Extract an encounter ID similarly. May be a "Encounter/xyz" reference.
 */
export function extractEncounterId(context) {
  if (!context || typeof context !== 'object') return null;
  const raw = context.encounterId || context.encounter || null;
  if (!raw) return null;
  const value = String(raw);
  if (value.startsWith('Encounter/')) return value.slice('Encounter/'.length);
  return value;
}

/**
 * Pull medication names from a CDS Hooks medication-prescribe context.
 * The spec puts them inside `context.medications.entry[].resource` as
 * FHIR MedicationRequest resources. We accept either that or a flat
 * `medications: [{name}]` shape.
 */
export function extractMedicationNames(context) {
  if (!context || typeof context !== 'object') return [];
  const out = [];
  const medications = context.medications;
  if (!medications) return out;

  // FHIR Bundle shape
  if (Array.isArray(medications.entry)) {
    for (const entry of medications.entry) {
      const resource = entry?.resource;
      if (!resource) continue;
      const code = resource.medicationCodeableConcept?.text
        || resource.medicationCodeableConcept?.coding?.[0]?.display
        || resource.medicationReference?.display
        || null;
      if (code) out.push(String(code));
    }
    return out;
  }

  // Flat array shape
  if (Array.isArray(medications)) {
    for (const item of medications) {
      if (!item) continue;
      if (typeof item === 'string') {
        out.push(item);
      } else if (item.name || item.medication_name || item.display) {
        out.push(String(item.name || item.medication_name || item.display));
      }
    }
  }
  return out;
}

/**
 * Build the discovery response — list of registered hooks. CDS Hooks
 * consumers cache this aggressively, so the response is deliberately
 * static.
 */
export function buildDiscoveryResponse() {
  return {
    services: CDS_HOOKS_SERVICES.map((service) => ({
      hook: service.hook,
      title: service.title,
      description: service.description,
      id: service.id,
    })),
  };
}

export function findServiceById(id) {
  return CDS_HOOKS_SERVICES.find((service) => service.id === id) || null;
}

export default {
  CDS_HOOKS_SERVICES,
  alertToCard,
  buildCardsResponse,
  buildDiscoveryResponse,
  extractEncounterId,
  extractMedicationNames,
  extractPatientUid,
  findServiceById,
  severityToIndicator,
};
