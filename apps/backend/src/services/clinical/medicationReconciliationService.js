// src/services/clinical/medicationReconciliationService.js
//
// Roadmap B6 — formal three-point medication reconciliation.
//
// Lifecycle: startReconciliation() snapshots the patient's medication
// sources (home/chronic meds, active prescriptions, inpatient MAR) into
// per-drug items; clinicians decide each item (continue/stop/change/new/
// hold + reason); completeReconciliation() requires every item decided and
// — for discharge recs — emits the take-home list.
//
// Canonical invariant: start/complete write timeline + audit events in the
// same transaction; per-item decisions write clinical_audit_events.

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { validatePrescriptionSafety } from '../../utils/clinical/prescriptionSafetyCheck.js';
import {
  recordCanonicalClinicalEvent,
  recordClinicalAuditEvent,
  recordMedicationSafetyReviews,
} from './canonicalClinicalPlatformService.js';

export const REC_TYPES = Object.freeze(['admission', 'transfer', 'discharge']);
export const ITEM_DECISIONS = Object.freeze(['continue', 'stop', 'change', 'new', 'hold']);
export const DISCREPANCY_TYPES = Object.freeze(['added', 'omitted', 'dose_changed', 'duplicate', 'unchanged']);

// ---------------------------------------------------------------------------
// Ingredient normalization + high-alert classification (audit §C-2)
// ---------------------------------------------------------------------------
//
// The reconciliation engine must align the home list against the inpatient /
// active list by INGREDIENT, not by raw name — otherwise a brand on one side
// and the generic on the other read as an add + an omission (two false
// discrepancies), and the genuine drop of a home anticoagulant hides in the
// noise. prescriptionSafetyCheck.js already curates brand→generic aliases for
// the antithrombotic class, but it does not export a general ingredient
// normalizer, and its table only covers the bleeding-risk class. Rather than
// reach into another module's private internals, this service keeps its own
// curated INGREDIENT_ALIASES table whose antithrombotic rows are copied
// verbatim from prescriptionSafetyCheck.ANTITHROMBOTIC_DRUGS (same generics,
// same India-first brand aliases) and extends it with the other high-alert
// classes the audit names (insulin / antiepileptic / opioid / chemotherapy).
// Keep the two antithrombotic alias sets in sync if either changes.
//
// HIGH_ALERT_CLASSES is the ISMP "high-alert medication" subset this fix
// guards: omitting or silently dose-changing one of these across a transition
// of care is the canonical med-rec harm (lost anticoagulation, missed insulin,
// breakthrough seizures, uncontrolled pain, interrupted chemo).

// brand/generic aliases → canonical ingredient + optional high-alert class.
// Aliases are matched case-insensitively as substrings against the
// strength/form-stripped name (same matching approach as the safety checker).
const INGREDIENT_ALIASES = [
  // --- Anticoagulants (high-alert) — mirrors prescriptionSafetyCheck.ANTITHROMBOTIC_DRUGS
  { ingredient: 'warfarin', klass: 'anticoagulant', aliases: ['warfarin', 'coumadin'] },
  { ingredient: 'enoxaparin', klass: 'anticoagulant', aliases: ['enoxaparin', 'clexane', 'lovenox'] },
  { ingredient: 'heparin', klass: 'anticoagulant', aliases: ['heparin'] },
  { ingredient: 'apixaban', klass: 'anticoagulant', aliases: ['apixaban', 'eliquis'] },
  { ingredient: 'rivaroxaban', klass: 'anticoagulant', aliases: ['rivaroxaban', 'xarelto'] },
  { ingredient: 'dabigatran', klass: 'anticoagulant', aliases: ['dabigatran', 'pradaxa'] },
  { ingredient: 'acenocoumarol', klass: 'anticoagulant', aliases: ['acenocoumarol', 'acitrom'] },
  // --- Insulins (high-alert)
  { ingredient: 'insulin glargine', klass: 'insulin', aliases: ['insulin glargine', 'glargine', 'lantus', 'basalog', 'glaritus'] },
  { ingredient: 'insulin aspart', klass: 'insulin', aliases: ['insulin aspart', 'aspart', 'novorapid', 'novolog'] },
  { ingredient: 'insulin lispro', klass: 'insulin', aliases: ['insulin lispro', 'lispro', 'humalog'] },
  { ingredient: 'insulin detemir', klass: 'insulin', aliases: ['insulin detemir', 'detemir', 'levemir'] },
  { ingredient: 'insulin degludec', klass: 'insulin', aliases: ['insulin degludec', 'degludec', 'tresiba'] },
  { ingredient: 'insulin', klass: 'insulin', aliases: ['insulin', 'huminsulin', 'actrapid', 'mixtard', 'novomix', 'human mixtard'] },
  // --- Antiepileptics (high-alert)
  { ingredient: 'phenytoin', klass: 'antiepileptic', aliases: ['phenytoin', 'eptoin', 'dilantin'] },
  { ingredient: 'valproate', klass: 'antiepileptic', aliases: ['valproate', 'valproic', 'divalproex', 'sodium valproate', 'valparin', 'encorate', 'depakote'] },
  { ingredient: 'levetiracetam', klass: 'antiepileptic', aliases: ['levetiracetam', 'keppra', 'levipil', 'levesam'] },
  { ingredient: 'carbamazepine', klass: 'antiepileptic', aliases: ['carbamazepine', 'tegretol', 'mazetol', 'zeptol'] },
  { ingredient: 'lamotrigine', klass: 'antiepileptic', aliases: ['lamotrigine', 'lamictal', 'lametec'] },
  { ingredient: 'phenobarbital', klass: 'antiepileptic', aliases: ['phenobarbital', 'phenobarbitone', 'gardenal'] },
  { ingredient: 'lacosamide', klass: 'antiepileptic', aliases: ['lacosamide', 'vimpat'] },
  { ingredient: 'oxcarbazepine', klass: 'antiepileptic', aliases: ['oxcarbazepine', 'oxetol', 'trileptal'] },
  // --- Opioids (high-alert)
  { ingredient: 'morphine', klass: 'opioid', aliases: ['morphine'] },
  { ingredient: 'fentanyl', klass: 'opioid', aliases: ['fentanyl'] },
  { ingredient: 'oxycodone', klass: 'opioid', aliases: ['oxycodone', 'oxycontin'] },
  { ingredient: 'tramadol', klass: 'opioid', aliases: ['tramadol', 'ultracet'] },
  { ingredient: 'buprenorphine', klass: 'opioid', aliases: ['buprenorphine', 'buprenex', 'norspan'] },
  { ingredient: 'hydromorphone', klass: 'opioid', aliases: ['hydromorphone', 'dilaudid'] },
  { ingredient: 'methadone', klass: 'opioid', aliases: ['methadone'] },
  { ingredient: 'tapentadol', klass: 'opioid', aliases: ['tapentadol', 'nucynta'] },
  // --- Chemotherapy / cytotoxics (high-alert)
  { ingredient: 'cisplatin', klass: 'chemotherapy', aliases: ['cisplatin'] },
  { ingredient: 'carboplatin', klass: 'chemotherapy', aliases: ['carboplatin'] },
  { ingredient: 'cyclophosphamide', klass: 'chemotherapy', aliases: ['cyclophosphamide', 'endoxan'] },
  { ingredient: 'methotrexate', klass: 'chemotherapy', aliases: ['methotrexate'] },
  { ingredient: 'doxorubicin', klass: 'chemotherapy', aliases: ['doxorubicin', 'adriamycin'] },
  { ingredient: 'vincristine', klass: 'chemotherapy', aliases: ['vincristine', 'oncovin'] },
  { ingredient: 'paclitaxel', klass: 'chemotherapy', aliases: ['paclitaxel', 'taxol'] },
  { ingredient: 'fluorouracil', klass: 'chemotherapy', aliases: ['fluorouracil', '5-fu', '5 fu'] },
  { ingredient: 'capecitabine', klass: 'chemotherapy', aliases: ['capecitabine', 'xeloda'] },
  { ingredient: 'imatinib', klass: 'chemotherapy', aliases: ['imatinib', 'gleevec', 'glivec'] },
  // --- Common non-high-alert chronic meds, aliased so brand/generic align
  // (prevents false add/omission discrepancies; klass null = not high-alert).
  { ingredient: 'atorvastatin', klass: null, aliases: ['atorvastatin', 'lipitor', 'atorva', 'storvas'] },
  { ingredient: 'rosuvastatin', klass: null, aliases: ['rosuvastatin', 'crestor', 'rosuvas'] },
  { ingredient: 'metformin', klass: null, aliases: ['metformin', 'glycomet', 'glucophage'] },
  { ingredient: 'telmisartan', klass: null, aliases: ['telmisartan', 'telma', 'micardis'] },
  { ingredient: 'amlodipine', klass: null, aliases: ['amlodipine', 'amlong', 'norvasc'] },
  { ingredient: 'pantoprazole', klass: null, aliases: ['pantoprazole', 'pantocid', 'pan 40', 'protonix'] },
  { ingredient: 'amoxicillin', klass: null, aliases: ['amoxicillin', 'amoxil', 'mox'] },
];

// Strength / form / route / frequency tokens that are NOT part of the
// ingredient identity. Stripped before matching + as the fallback ingredient
// key when no alias is known (so "Drug 5mg" and "Drug 10mg" still collapse).
const STRENGTH_FORM_RX = new RegExp(
  [
    '\\b\\d+(?:\\.\\d+)?\\s*(?:mg|mcg|µg|ug|g|ml|iu|units?|u|%)\\b', // strengths/units
    '\\b\\d+(?:\\.\\d+)?\\s*mg\\s*\\/\\s*\\d*(?:\\.\\d+)?\\s*ml\\b', // mg/ml strengths
    '\\b(?:tablet|tab|capsule|cap|syrup|suspension|susp|injection|inj|drops?|cream|ointment|gel|patch|spray|inhaler|solution|soln|sachet|powder|sr|xr|er|cr|od|bd|tds|qid|hs|sos|stat|prn|once|twice|daily|oral|iv|im|sc|s\\/c|po|pr|sl|topical)\\b', // forms/routes/freqs
    '[(),]',
  ].join('|'),
  'gi',
);

/**
 * Reduce a medication name to a canonical ingredient key. Brand → generic via
 * the curated alias table; otherwise the strength/form-stripped, whitespace-
 * collapsed lower-cased remainder. Pure — exported for unit tests.
 */
export function normalizeMedicationIngredient(name) {
  const raw = String(name || '').toLowerCase().trim();
  if (!raw) return '';
  const stripped = raw.replace(STRENGTH_FORM_RX, ' ').replace(/\s+/g, ' ').trim();
  const haystack = stripped || raw;
  for (const entry of INGREDIENT_ALIASES) {
    if (entry.aliases.some((alias) => haystack.includes(alias))) return entry.ingredient;
  }
  // No known alias — fall back to the stripped name so at least
  // strength/form variants of the same unknown drug collapse together.
  return haystack;
}

/**
 * Return the high-alert medication class for a name, or null. Brand or generic.
 * Classes: anticoagulant / insulin / antiepileptic / opioid / chemotherapy
 * (ISMP high-alert subset relevant to transition-of-care omission). Pure —
 * exported for unit tests.
 */
export function classifyHighAlertIngredient(name) {
  const haystack = String(name || '').toLowerCase();
  if (!haystack.trim()) return null;
  for (const entry of INGREDIENT_ALIASES) {
    if (!entry.klass) continue;
    if (entry.aliases.some((alias) => haystack.includes(alias))) return entry.klass;
  }
  return null;
}

// Normalize a dose/route/frequency tuple into a comparable signature so
// "500mg" vs "500 mg" don't read as a dose change but "500mg" vs "1g" do.
// Returns '' when no regimen field is populated — the caller treats an empty
// signature on EITHER side as "not comparable" rather than a change, so a home
// med captured as free text (no structured dose) vs an active order with a
// parsed dose is not a false dose_changed. The high-alert OMISSION gate is the
// hard safety net; we deliberately do not manufacture a dose-change discrepancy
// out of missing structured data.
function regimenSignature(item) {
  const sig = ['dose', 'route', 'frequency']
    .map((f) => String(item?.[f] ?? '').toLowerCase().replace(/\s+/g, '').trim())
    .join('|');
  return /[^|]/.test(sig) ? sig : '';
}

// Build ingredient → entry maps for the home side and the (active ∪ MAR) side
// from a start-time source snapshot. First occurrence wins per ingredient.
function buildSourceIndex(sources = {}) {
  const homeList = Array.isArray(sources.home) ? sources.home : [];
  const otherList = [
    ...(Array.isArray(sources.active_prescriptions) ? sources.active_prescriptions : []),
    ...(Array.isArray(sources.inpatient_mar) ? sources.inpatient_mar : []),
  ];
  const homeByIngredient = new Map();
  for (const m of homeList) {
    const ing = normalizeMedicationIngredient(m.medication_name);
    if (ing && !homeByIngredient.has(ing)) homeByIngredient.set(ing, m);
  }
  const otherByIngredient = new Map();
  for (const m of otherList) {
    const ing = normalizeMedicationIngredient(m.medication_name);
    if (ing && !otherByIngredient.has(ing)) otherByIngredient.set(ing, m);
  }
  return { homeByIngredient, otherByIngredient };
}

/**
 * Classify a list of medication items against a start-time source snapshot,
 * aligning the home list vs (active orders ∪ inpatient MAR) by ingredient.
 *
 * `keyFn(item, index)` selects the key the verdict is filed under — the DB id
 * at completion, or the array index at start (before ids exist). Returns a
 * Map<key, discrepancyType> plus per-type counts. An item is:
 *   - omitted      : ingredient on the home list, absent from the active/MAR
 *                    side (the drug is being dropped at this transition).
 *   - added        : ingredient on the active/MAR side, not on the home list.
 *   - dose_changed : ingredient on both sides, both regimens known and differ.
 *   - duplicate    : a later item whose ingredient an earlier item already
 *                    represented.
 *   - unchanged    : ingredient on both sides with the same (or unknown)
 *                    regimen, or an item with no counterpart to compare.
 *
 * Pure — exported for unit tests.
 */
export function classifyDiscrepancies(items, sources, keyFn = (item) => item.id) {
  const { homeByIngredient, otherByIngredient } = buildSourceIndex(sources || {});
  const byType = {};
  const result = new Map();
  const seenIngredients = new Set();
  (items || []).forEach((item, index) => {
    const ing = normalizeMedicationIngredient(item.medication_name);
    let type;
    if (ing && seenIngredients.has(ing)) {
      type = 'duplicate';
    } else {
      const inHome = homeByIngredient.has(ing);
      const inOther = otherByIngredient.has(ing);
      if (inHome && !inOther) {
        type = 'omitted';
      } else if (!inHome && inOther) {
        type = 'added';
      } else if (inHome && inOther) {
        const a = regimenSignature(homeByIngredient.get(ing));
        const b = regimenSignature(otherByIngredient.get(ing));
        // Only call a dose change when BOTH sides carry a comparable regimen
        // and they differ; missing structured data ≠ a change.
        type = (a && b && a !== b) ? 'dose_changed' : 'unchanged';
      } else {
        // Ingredient resolved to neither snapshot bucket (e.g. a manually-added
        // line) — nothing to diff against, treat as unchanged.
        type = 'unchanged';
      }
    }
    if (ing) seenIngredients.add(ing);
    result.set(keyFn(item, index), type);
    byType[type] = (byType[type] || 0) + 1;
  });
  return { byKey: result, counts: byType };
}

/**
 * Convenience wrapper that classifies a persisted reconciliation (items carry
 * DB ids; the snapshot is `rec.source_lists`). Returns { byItemId, counts }.
 */
export function computeDiscrepancies(rec) {
  const { byKey, counts } = classifyDiscrepancies(rec?.items || [], rec?.source_lists || {});
  return { byItemId: byKey, counts };
}

/**
 * Decide whether a discrepancy on a high-alert drug has been explicitly
 * addressed by a clinician. An `omitted` or `dose_changed` high-alert item must
 * carry a deliberate, reasoned decision: stop/hold/change with a reason
 * (decision_reason), or a change spelling out the new regimen. A bare
 * `continue` does NOT resolve an omission — continue on an item whose drug was
 * dropped from the active list is precisely the silent loss the gate exists to
 * catch.
 */
function highAlertDiscrepancyResolved(item, discrepancyType) {
  const reason = String(item.decision_reason || '').trim();
  if (discrepancyType === 'omitted') {
    // An omission is resolved only by a documented decision to stop/hold the
    // drug (with reason) or to re-add/continue it WITH an explicit reason that
    // shows the clinician saw the gap.
    return ['stop', 'hold', 'change', 'new'].includes(item.decision) && reason.length > 0
      || (item.decision === 'continue' && reason.length > 0);
  }
  if (discrepancyType === 'dose_changed') {
    // A dose change on a high-alert drug must be an explicit `change` (which
    // already requires a reason + change detail) — never an unexamined continue.
    return item.decision === 'change' && reason.length > 0;
  }
  return true;
}

function tenantIdFromContext(context = {}) {
  return context.tenantId || context.tenant_id || null;
}

// SEC-3 — open an interactive transaction that is RLS-tenant-scoped when a
// tenantId is known, falling back to the legacy permissive `prisma.$transaction`
// for untenanted/single-tenant callers (setTenantTx throws without a tenantId,
// and the start INSERT COALESCEs tenant_id to a default, so a null tenant is a
// legitimate state). When scoped, every write inside the tx against the
// tenant_isolation tables (medication_reconciliations,
// medication_reconciliation_items, medication_safety_reviews) is constrained to
// the caller's tenant — USING on lookups/locks and WITH CHECK on writes —
// instead of falling through to migration 075/304's permissive branch. A bare
// `prisma.$transaction` leaves app.current_tenant_id unset, so the policy never
// fires; setTenantTx sets the GUC as the first statement of the tx.
function scopedTx(tenantId, fn) {
  return tenantId ? setTenantTx(tenantId, fn) : prisma.$transaction(fn);
}

/**
 * Normalize one medication entry from any source (string or object) into
 * the item shape. Pure — exported for unit tests.
 */
export function normalizeMedicationEntry(entry, source, sourceRef = null) {
  if (entry == null) return null;
  if (typeof entry === 'string') {
    const name = entry.trim();
    return name ? { medication_name: name, dose: null, frequency: null, route: null, source, source_ref: sourceRef } : null;
  }
  const name = (entry.name || entry.medication_name || entry.drug_name || '').trim();
  if (!name) return null;
  return {
    medication_name: name,
    dose: entry.dose || entry.dosage || entry.strength || null,
    frequency: entry.frequency || entry.freq || entry.timing || null,
    route: entry.route || null,
    source,
    source_ref: sourceRef,
  };
}

/**
 * Carry a source's catalog identity onto a snapshot item.
 *
 * A completed reconciliation is itself an active-therapy authority source:
 * prescriptionSafetyCheck reads medication_reconciliation_items.metadata
 * ->>'catalog_id' when it rebuilds the patient's active therapy. Items were
 * being snapshotted with an empty metadata, so every drug a reconciliation
 * kept came back identity-unresolved and failed the NEXT safety screen closed
 * (ACTIVE_THERAPY_IDENTITY_UNRESOLVED) — including the next reconciliation.
 * The identity travels with the drug instead: whatever catalog the source
 * (home profile entry, e-prescription line, MAR clinical order) was pinned to
 * is the catalog the reconciled item keeps.
 *
 * This carries identity, never trust: the id is only ever read back through a
 * tenant-scoped `is_active` catalog lookup, so a stale or foreign id still
 * fails closed exactly as an absent one does.
 */
function withSourceCatalogId(item, rawCatalogId) {
  if (!item) return null;
  const catalogId = Number(rawCatalogId);
  if (!Number.isSafeInteger(catalogId) || catalogId <= 0) return item;
  return { ...item, catalog_id: catalogId };
}

/**
 * Merge medication lists, deduping case-insensitively by name and keeping
 * the FIRST occurrence (source priority = caller's ordering). Pure —
 * exported for unit tests.
 */
export function mergeMedicationLists(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const item of list || []) {
      if (!item?.medication_name) continue;
      const key = item.medication_name.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Gather the medication sources a reconciliation starts from.
 * Returns { home, active_prescriptions, inpatient_mar } arrays of items.
 */
export async function gatherMedicationSources(patientUid, { tenantId = null } = {}) {
  const patientParams = tenantId ? [patientUid, tenantId] : [patientUid];
  const userTenantFilter = tenantId ? ' AND tenant_id = $2::uuid' : '';
  const prescriptionTenantFilter = tenantId ? ' AND u.tenant_id = $2::uuid AND ep.tenant_id = $2::uuid' : '';
  const marTenantFilter = tenantId ? ' AND administration.tenant_id = $2::uuid' : '';
  const [patientRows, prescriptionRows, marRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT id, chronic_medications FROM users WHERE uid = $1::uuid${userTenantFilter} LIMIT 1`,
      ...patientParams,
    ),
    prisma.$queryRawUnsafe(
      `SELECT ep.id,
              COALESCE(NULLIF(TRIM(ep.medication_name), ''), NULLIF(TRIM(med.value->>'name'), ''),
                       NULLIF(TRIM(med.value->>'medication_name'), '')) AS name,
              COALESCE(med.value->>'dose', med.value->>'dosage') AS dose,
              med.value->>'frequency' AS frequency,
              med.value->>'route' AS route,
              COALESCE(NULLIF(med.value->>'catalog_id', ''),
                       NULLIF(med.value->>'original_catalog_id', '')) AS catalog_id
         FROM e_prescriptions ep
         LEFT JOIN LATERAL jsonb_array_elements(COALESCE(ep.medications, '[]'::jsonb)) AS med(value) ON TRUE
         JOIN users u ON u.id = ep.patient_id
        WHERE u.uid = $1::uuid
          ${prescriptionTenantFilter}
          AND LOWER(COALESCE(ep.status, 'active')) IN ('active', 'pharmacy_linked')
          AND (ep.follow_up_date IS NULL OR ep.follow_up_date >= CURRENT_DATE)`,
      ...patientParams,
    ),
    prisma.$queryRawUnsafe(
      // M7 (audit 2026-06-22): include 'administered'. A currently-running med
      // (already given, with no future scheduled dose in the window) was excluded,
      // so med-rec read it as an omission / missed dose. Reconciliation must
      // reflect what the patient is actually ON — which includes administered doses.
      // The MAR row's drug identity lives on its medication clinical order
      // (migration 744 pins that link), so read the catalog id from there.
      `SELECT DISTINCT ON (lower(administration.medication_name))
              administration.id, administration.medication_name,
              administration.dose, administration.route,
              NULLIF(clinical_order.details->>'catalog_id', '') AS catalog_id
         FROM medication_administrations administration
         LEFT JOIN clinical_orders clinical_order
           ON clinical_order.tenant_id = administration.tenant_id
          AND clinical_order.id = administration.clinical_order_id
          AND clinical_order.order_type = 'medication'
        WHERE administration.patient_uid = $1::uuid
          ${marTenantFilter}
          AND administration.status IN ('scheduled', 'held', 'administered')
          AND administration.scheduled_time >= NOW() - INTERVAL '7 days'
        ORDER BY lower(administration.medication_name), administration.scheduled_time DESC`,
      ...patientParams,
    ),
  ]);

  const chronic = patientRows[0]?.chronic_medications;
  const chronicList = Array.isArray(chronic) ? chronic
    : (typeof chronic === 'string' && chronic.trim() ? chronic.split(/[,;\n]/) : []);

  return {
    home: chronicList
      .map((entry) => withSourceCatalogId(
        normalizeMedicationEntry(entry, 'home', 'users.chronic_medications'),
        entry && typeof entry === 'object' ? (entry.catalog_id ?? entry.catalogId) : null,
      ))
      .filter(Boolean),
    active_prescriptions: prescriptionRows
      .map((row) => withSourceCatalogId(
        normalizeMedicationEntry(row, 'active_prescription', `e_prescriptions:${row.id}`),
        row.catalog_id,
      ))
      .filter(Boolean),
    inpatient_mar: marRows
      .map((row) => withSourceCatalogId(
        normalizeMedicationEntry(row, 'inpatient', `medication_administrations:${row.id}`),
        row.catalog_id,
      ))
      .filter(Boolean),
  };
}

const REC_COLUMNS = `
  id, tenant_id, patient_uid, patient_id, admission_id, encounter_id, rec_type, status,
  transfer_context, source_lists, notes, started_by, started_at, completed_by, completed_at,
  metadata, created_at, updated_at`;

export async function getReconciliation(recId, { includeItems = true, tenantId = null } = {}) {
  const params = [recId];
  let tenantFilter = '';
  if (tenantId) {
    params.push(tenantId);
    tenantFilter = ` AND tenant_id = $${params.length}::uuid`;
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${REC_COLUMNS} FROM medication_reconciliations WHERE id = $1::uuid${tenantFilter} LIMIT 1`,
    ...params,
  );
  const rec = rows[0] || null;
  if (!rec || !includeItems) return rec;
  const itemParams = tenantId ? [recId, tenantId] : [recId];
  const itemTenantFilter = tenantId ? ' AND tenant_id = $2::uuid' : '';
  const items = await prisma.$queryRawUnsafe(
    `SELECT id, medication_name, dose, frequency, route, source, source_ref,
            decision, decision_reason, new_instructions,
            changed_dose, changed_route, changed_frequency, safety_review_id,
            discrepancy_type, decided_by, decided_at
       FROM medication_reconciliation_items
      WHERE reconciliation_id = $1::uuid${itemTenantFilter}
      ORDER BY id`,
    ...itemParams,
  );
  return { ...rec, items };
}

export async function listReconciliations(patientUid, { recType = null, tenantId = null } = {}) {
  const params = [patientUid];
  let where = `patient_uid = $1::uuid`;
  if (tenantId) {
    params.push(tenantId);
    where += ` AND tenant_id = $${params.length}::uuid`;
  }
  if (recType) {
    if (!REC_TYPES.includes(recType)) {
      throw AppError.badRequest(`rec_type must be one of ${REC_TYPES.join(', ')}`, 'MEDREC_BAD_TYPE');
    }
    params.push(recType);
    where += ` AND rec_type = $${params.length}`;
  }
  return prisma.$queryRawUnsafe(
    `SELECT ${REC_COLUMNS},
            (SELECT COUNT(*)::int FROM medication_reconciliation_items i WHERE i.reconciliation_id = medication_reconciliations.id) AS item_count,
            (SELECT COUNT(*)::int FROM medication_reconciliation_items i WHERE i.reconciliation_id = medication_reconciliations.id AND i.decision IS NULL) AS undecided_count
       FROM medication_reconciliations
      WHERE ${where}
      ORDER BY created_at DESC`,
    ...params,
  );
}

export async function startReconciliation({
  patientUid, recType, admissionId = null, encounterId = null, transferContext = null, notes = null,
} = {}, context = {}) {
  if (!REC_TYPES.includes(recType)) {
    throw AppError.badRequest(`rec_type must be one of ${REC_TYPES.join(', ')}`, 'MEDREC_BAD_TYPE');
  }
  const tenantId = tenantIdFromContext(context);
  const patientParams = tenantId ? [patientUid, tenantId] : [patientUid];
  const patientTenantFilter = tenantId ? ' AND tenant_id = $2::uuid' : '';
  const patients = await prisma.$queryRawUnsafe(
    `SELECT id, uid, tenant_id FROM users WHERE uid = $1::uuid${patientTenantFilter} AND role = 'PATIENT' LIMIT 1`,
    ...patientParams,
  );
  const patient = patients[0];
  if (!patient) throw AppError.notFound('Patient not found', 'MEDREC_PATIENT_NOT_FOUND');

  const open = await prisma.$queryRawUnsafe(
    `SELECT id FROM medication_reconciliations
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid AND rec_type = $3
        AND COALESCE(admission_id, 0) = COALESCE($4::int, 0)
        AND status = 'in_progress'
      LIMIT 1`,
    patient.tenant_id, patientUid, recType, admissionId,
  );
  if (open.length > 0) {
    throw AppError.conflict(
      `An in-progress ${recType} reconciliation already exists for this patient`,
      'MEDREC_ALREADY_OPEN',
      { reconciliation_id: open[0].id },
    );
  }

  const sources = await gatherMedicationSources(patientUid, { tenantId: patient.tenant_id });
  // Item ordering encodes source priority per rec type: admission starts
  // from home meds; transfer/discharge start from what is actually running.
  const orderedLists = recType === 'admission'
    ? [sources.home, sources.active_prescriptions, sources.inpatient_mar]
    : [sources.inpatient_mar, sources.active_prescriptions, sources.home];
  const items = mergeMedicationLists(...orderedLists);

  // Classify each item against the source snapshot up front (audit §C-2) so the
  // discrepancy verdict — especially an `omitted` high-alert home drug — is
  // visible the moment the reconciliation opens, not only at completion. Keyed
  // by array index because the DB ids don't exist until insert.
  const { byKey: discrepancyByIndex } = classifyDiscrepancies(items, sources, (_item, index) => index);

  const rec = await scopedTx(patient.tenant_id, async (tx) => {
    const recRows = await tx.$queryRawUnsafe(
      `INSERT INTO medication_reconciliations
         (patient_uid, patient_id, tenant_id, admission_id, encounter_id, rec_type,
          transfer_context, source_lists, notes, started_by)
       VALUES ($1::uuid, $2, COALESCE($3::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
               $4::int, $5::uuid, $6, $7, $8::jsonb, $9, $10::uuid)
       RETURNING ${REC_COLUMNS}`,
      patientUid,
      patient.id,
      patient.tenant_id || null,
      admissionId,
      encounterId,
      recType,
      transferContext,
      JSON.stringify(sources),
      notes,
      context.actorUid || null,
    );
    const created = recRows[0];

    for (const [index, item] of items.entries()) {
      await tx.$queryRawUnsafe(
        `INSERT INTO medication_reconciliation_items
           (reconciliation_id, tenant_id, medication_name, dose, frequency, route, source, source_ref, discrepancy_type, metadata)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        created.id,
        created.tenant_id,
        item.medication_name,
        item.dose,
        item.frequency,
        item.route,
        item.source,
        item.source_ref,
        discrepancyByIndex.get(index) || 'unchanged',
        JSON.stringify(item.catalog_id ? { catalog_id: item.catalog_id } : {}),
      );
    }

    await recordCanonicalClinicalEvent({
      tenantId: created.tenant_id,
      patientUid,
      encounterId,
      eventType: 'medrec.started',
      eventStatus: 'in_progress',
      sourceTable: 'medication_reconciliations',
      sourceId: String(created.id),
      resourceType: 'medication_reconciliation',
      resourceId: String(created.id),
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
      summary: `${recType} medication reconciliation started (${items.length} medication(s) on the table)`,
      payload: {
        reconciliation_id: created.id,
        rec_type: recType,
        admission_id: admissionId,
        transfer_context: transferContext,
        item_count: items.length,
        source_counts: {
          home: sources.home.length,
          active_prescriptions: sources.active_prescriptions.length,
          inpatient_mar: sources.inpatient_mar.length,
        },
      },
      afterState: { status: 'in_progress' },
      tags: ['medication', 'med-rec', recType],
      timelineIdempotencyKey: `medication_reconciliations:${created.id}:medrec.started`,
      auditIdempotencyKey: `medication_reconciliations:${created.id}:audit:medrec.started`,
    }, { db: tx });

    return created;
  });

  return getReconciliation(rec.id, { tenantId: patient.tenant_id });
}

/**
 * Build the structured change-detail object for a `change` decision, pulling
 * the "to" side from the explicit changed_* fields and the "from" side from
 * the item's snapshot. Pure — exported for unit tests.
 */
export function buildChangeDetail(item, { changedDose, changedRoute, changedFrequency } = {}) {
  const detail = {};
  const pairs = [
    ['dose', item?.dose ?? null, changedDose],
    ['route', item?.route ?? null, changedRoute],
    ['frequency', item?.frequency ?? null, changedFrequency],
  ];
  for (const [field, from, to] of pairs) {
    if (to != null && String(to).trim() !== '') {
      detail[field] = { from, to: String(to).trim() };
    }
  }
  return detail;
}

export async function decideItem(recId, itemId, {
  decision, reason = null, newInstructions = null,
  changedDose = null, changedRoute = null, changedFrequency = null,
  safetyRationale = null,
} = {}, context = {}) {
  if (!ITEM_DECISIONS.includes(decision)) {
    throw AppError.badRequest(`decision must be one of ${ITEM_DECISIONS.join(', ')}`, 'MEDREC_BAD_DECISION');
  }
  if (['stop', 'change', 'hold'].includes(decision) && !(reason || '').trim()) {
    throw AppError.badRequest(`decision '${decision}' requires a reason`, 'MEDREC_REASON_REQUIRED');
  }
  const hasStructuredChange = [changedDose, changedRoute, changedFrequency]
    .some((v) => v != null && String(v).trim() !== '');
  // A `change` must spell out WHAT changed: either structured dose/route/
  // frequency detail or free-text instructions (or both).
  if (decision === 'change' && !hasStructuredChange && !(newInstructions || '').trim()) {
    throw AppError.badRequest(
      "decision 'change' requires change detail (changed_dose/changed_route/changed_frequency or new_instructions)",
      'MEDREC_CHANGE_DETAIL_REQUIRED',
    );
  }
  // Structured change detail only makes sense on a `change`.
  if (decision !== 'change' && hasStructuredChange) {
    throw AppError.badRequest(
      'changed_dose/changed_route/changed_frequency are only valid for a change decision',
      'MEDREC_CHANGE_DETAIL_UNEXPECTED',
    );
  }
  const rec = await getReconciliation(recId, { includeItems: false, tenantId: tenantIdFromContext(context) });
  if (!rec) throw AppError.notFound('Reconciliation not found', 'MEDREC_NOT_FOUND');
  if (rec.status !== 'in_progress') {
    throw AppError.conflict(`Reconciliation is ${rec.status} — decisions are frozen`, 'MEDREC_NOT_OPEN');
  }

  // Look up the item first so the safety review (recorded BEFORE the row is
  // stamped, to capture its id) can carry the medication name.
  const existingRows = await prisma.$queryRawUnsafe(
    `SELECT id, medication_name, dose, frequency, route, source
       FROM medication_reconciliation_items
      WHERE id = $1::int AND reconciliation_id = $2::uuid AND tenant_id = $3::uuid
      LIMIT 1`,
    itemId,
    recId,
    rec.tenant_id,
  );
  const existing = existingRows[0];
  if (!existing) throw AppError.notFound('Reconciliation item not found', 'MEDREC_ITEM_NOT_FOUND');

  const changeDetail = decision === 'change'
    ? buildChangeDetail(existing, { changedDose, changedRoute, changedFrequency })
    : {};
  // A medication_safety_reviews row is wired when a stop/change carries a
  // clinical safety rationale (e.g. nephrotoxicity, duplicate therapy,
  // interaction). The reconciliation reason itself is the workflow reason;
  // safetyRationale is the explicit safety-significant justification.
  const wantsSafetyReview = ['stop', 'change'].includes(decision)
    && !!(safetyRationale || '').trim();

  const item = await scopedTx(rec.tenant_id, async (tx) => {
    let safetyReviewId = null;
    if (wantsSafetyReview) {
      const reviews = await recordMedicationSafetyReviews({
        tenantId: rec.tenant_id,
        patientUid: rec.patient_uid,
        patientId: rec.patient_id,
        encounterId: rec.encounter_id,
        actorUid: context.actorUid || null,
        safety: {
          safe: false,
          blockers: [],
          warnings: [{
            type: 'med_rec_change',
            severity: 'medium',
            medication_name: existing.medication_name,
            message: safetyRationale.trim(),
            reconciliation_id: recId,
            decision,
          }],
        },
      }, { db: tx });
      safetyReviewId = reviews[0]?.id || null;
    }

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE medication_reconciliation_items SET
         decision = $3, decision_reason = $4, new_instructions = $5,
         changed_dose = $6, changed_route = $7, changed_frequency = $8,
         safety_review_id = COALESCE($9::uuid, safety_review_id),
         decided_by = $10::uuid, decided_at = NOW(), updated_at = NOW()
       WHERE id = $2::int AND reconciliation_id = $1::uuid
         AND tenant_id = $11::uuid
       RETURNING id, medication_name, dose, frequency, route, source, decision,
                 decision_reason, new_instructions, changed_dose, changed_route,
                 changed_frequency, safety_review_id, decided_by, decided_at`,
      recId,
      itemId,
      decision,
      reason,
      newInstructions,
      decision === 'change' ? changedDose : null,
      decision === 'change' ? changedRoute : null,
      decision === 'change' ? changedFrequency : null,
      safetyReviewId,
      context.actorUid || null,
      rec.tenant_id,
    );
    const updated = updatedRows[0];
    if (!updated) throw AppError.notFound('Reconciliation item not found', 'MEDREC_ITEM_NOT_FOUND');

    await recordClinicalAuditEvent({
      tenantId: rec.tenant_id,
      patientUid: rec.patient_uid,
      encounterId: rec.encounter_id,
      action: 'medrec.item_decided',
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
      resourceType: 'medication_reconciliation_item',
      resourceTable: 'medication_reconciliation_items',
      resourceId: String(updated.id),
      afterState: {
        decision,
        reason,
        new_instructions: newInstructions,
        change_detail: changeDetail,
        safety_review_id: safetyReviewId,
      },
      metadata: {
        reconciliation_id: recId,
        rec_type: rec.rec_type,
        medication_name: updated.medication_name,
        safety_review_recorded: !!safetyReviewId,
      },
      idempotencyKey: `medication_reconciliation_items:${updated.id}:decided:${decision}:${Date.now()}`,
    }, { db: tx });

    return updated;
  });

  return { ...item, change_detail: changeDetail };
}

export async function completeReconciliation(recId, context = {}) {
  const rec = await getReconciliation(recId, { tenantId: tenantIdFromContext(context) });
  if (!rec) throw AppError.notFound('Reconciliation not found', 'MEDREC_NOT_FOUND');
  if (rec.status !== 'in_progress') {
    throw AppError.conflict(`Reconciliation is already ${rec.status}`, 'MEDREC_NOT_OPEN');
  }
  const undecided = rec.items.filter((i) => !i.decision);
  if (undecided.length > 0) {
    throw AppError.conflict(
      `${undecided.length} medication(s) still undecided — every drug needs an explicit decision before completion`,
      'MEDREC_UNDECIDED_ITEMS',
      { undecided: undecided.map((i) => ({ id: i.id, medication_name: i.medication_name })) },
    );
  }

  // --- Discrepancy engine (audit §C-2) -------------------------------------
  // Align home vs (active ∪ MAR) by ingredient and classify each item. Persist
  // the verdict per item, then BLOCK completion when a high-alert drug
  // (anticoagulant / insulin / antiepileptic / opioid / chemotherapy) is
  // omitted or dose-changed without a deliberate, reasoned clinician decision.
  // "Every item got a decision" is NOT enough — a bare `continue` on a dropped
  // home anticoagulant is exactly the silent omission med-rec exists to catch.
  const { byItemId: discrepancyByItemId, counts: discrepancyCounts } = computeDiscrepancies(rec);

  const unresolvedHighAlert = [];
  for (const item of rec.items) {
    const discrepancyType = discrepancyByItemId.get(item.id) || 'unchanged';
    const highAlertClass = classifyHighAlertIngredient(item.medication_name);
    if (!highAlertClass) continue;
    if (!['omitted', 'dose_changed'].includes(discrepancyType)) continue;
    if (highAlertDiscrepancyResolved(item, discrepancyType)) continue;
    unresolvedHighAlert.push({
      id: item.id,
      medication_name: item.medication_name,
      high_alert_class: highAlertClass,
      discrepancy_type: discrepancyType,
      decision: item.decision || null,
    });
  }
  if (unresolvedHighAlert.length > 0) {
    throw AppError.conflict(
      `${unresolvedHighAlert.length} high-alert medication discrepancy(ies) need an explicit, documented decision before completion`,
      'MEDREC_UNRESOLVED_DISCREPANCIES',
      { discrepancies: unresolvedHighAlert },
    );
  }

  // --- Medication safety screen over the reconciled (kept) list ------------
  // Run the existing prescription safety checker over the drugs this
  // reconciliation will carry forward (continue/change/new) and surface any
  // hard blockers. Best-effort: a checker failure (it fails CLOSED with a
  // SAFETY_CHECK_ERROR blocker) still blocks here, but never 500s the path.
  const keptForScreen = rec.items
    .filter((i) => ['continue', 'change', 'new'].includes(i.decision))
    .map((i) => ({
      name: i.medication_name,
      medication_name: i.medication_name,
      dose: i.decision === 'change' ? (i.changed_dose ?? i.dose) : i.dose,
      frequency: i.decision === 'change' ? (i.changed_frequency ?? i.frequency) : i.frequency,
      route: i.decision === 'change' ? (i.changed_route ?? i.route) : i.route,
    }));
  let safety = { safe: true, warnings: [], blockers: [] };
  if (keptForScreen.length > 0 && rec.patient_id != null) {
    try {
      safety = await validatePrescriptionSafety(rec.patient_id, keptForScreen, {
        tenantId: rec.tenant_id,
      });
    } catch (err) {
      logger.error('Med-rec safety screen failed (blocking completion):', err.message);
      safety = {
        safe: false,
        warnings: [],
        blockers: [{ type: 'SAFETY_CHECK_ERROR', message: 'Automated safety screen failed — manual review required before completing reconciliation.' }],
      };
    }
  }
  if (!safety.safe && safety.blockers.length > 0) {
    throw AppError.conflict(
      `${safety.blockers.length} medication safety blocker(s) on the reconciled list must be resolved before completion`,
      'MEDREC_SAFETY_BLOCKERS',
      { blockers: safety.blockers },
    );
  }

  const counts = {};
  for (const item of rec.items) counts[item.decision] = (counts[item.decision] || 0) + 1;
  const takeHomeList = rec.rec_type === 'discharge'
    ? rec.items
      .filter((i) => ['continue', 'change', 'new'].includes(i.decision))
      .map((i) => ({
        medication_name: i.medication_name,
        // For a `change`, the take-home dose/route/frequency is the new
        // ("to") value where supplied, falling back to the source value.
        dose: i.decision === 'change' ? (i.changed_dose ?? i.dose) : i.dose,
        frequency: i.decision === 'change' ? (i.changed_frequency ?? i.frequency) : i.frequency,
        route: i.decision === 'change' ? (i.changed_route ?? i.route) : i.route,
        decision: i.decision,
        instructions: i.new_instructions || null,
        change_detail: i.decision === 'change'
          ? buildChangeDetail(i, {
            changedDose: i.changed_dose,
            changedRoute: i.changed_route,
            changedFrequency: i.changed_frequency,
          })
          : null,
        safety_review_id: i.safety_review_id || null,
      }))
    : null;

  const updated = await scopedTx(rec.tenant_id, async (tx) => {
    // Persist each item's discrepancy verdict in the same tx as the status
    // flip so the completed reconciliation is a self-consistent record.
    for (const item of rec.items) {
      await tx.$queryRawUnsafe(
        `UPDATE medication_reconciliation_items
            SET discrepancy_type = $3, updated_at = NOW()
          WHERE id = $1::int AND reconciliation_id = $2::uuid AND tenant_id = $4::uuid`,
        item.id,
        recId,
        discrepancyByItemId.get(item.id) || 'unchanged',
        rec.tenant_id,
      );
    }

    const rows = await tx.$queryRawUnsafe(
      `UPDATE medication_reconciliations SET
         status = 'completed', completed_by = $2::uuid, completed_at = NOW(),
         metadata = metadata || $3::jsonb, updated_at = NOW()
       WHERE id = $1::uuid AND status = 'in_progress' AND tenant_id = $4::uuid
       RETURNING ${REC_COLUMNS}`,
      recId,
      context.actorUid || null,
      JSON.stringify({
        decision_counts: counts,
        discrepancy_counts: discrepancyCounts,
        take_home_list: takeHomeList,
      }),
      rec.tenant_id,
    );
    const row = rows[0];
    if (!row) throw AppError.conflict('Reconciliation was completed concurrently', 'MEDREC_NOT_OPEN');

    await recordCanonicalClinicalEvent({
      tenantId: row.tenant_id,
      patientUid: row.patient_uid,
      encounterId: row.encounter_id,
      eventType: 'medrec.completed',
      eventStatus: 'completed',
      sourceTable: 'medication_reconciliations',
      sourceId: String(row.id),
      resourceType: 'medication_reconciliation',
      resourceId: String(row.id),
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
      summary: `${row.rec_type} medication reconciliation completed (${rec.items.length} drug(s): `
        + `${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`,
      payload: {
        reconciliation_id: row.id,
        rec_type: row.rec_type,
        decision_counts: counts,
        discrepancy_counts: discrepancyCounts,
        take_home_list: takeHomeList,
        item_count: rec.items.length,
      },
      beforeState: { status: 'in_progress' },
      afterState: { status: 'completed' },
      tags: ['medication', 'med-rec', row.rec_type],
      timelineIdempotencyKey: `medication_reconciliations:${row.id}:medrec.completed`,
      auditIdempotencyKey: `medication_reconciliations:${row.id}:audit:medrec.completed`,
    }, { db: tx });

    return row;
  });

  logger.info('Medication reconciliation completed', {
    reconciliation_id: recId, rec_type: updated.rec_type, counts, discrepancy_counts: discrepancyCounts,
  });
  // Re-read items so callers see the persisted discrepancy_type verdicts.
  const finalItems = rec.items.map((i) => ({
    ...i,
    discrepancy_type: discrepancyByItemId.get(i.id) || 'unchanged',
  }));
  return {
    ...updated,
    items: finalItems,
    take_home_list: takeHomeList,
    decision_counts: counts,
    discrepancy_counts: discrepancyCounts,
  };
}

export default {
  REC_TYPES,
  ITEM_DECISIONS,
  DISCREPANCY_TYPES,
  normalizeMedicationEntry,
  mergeMedicationLists,
  buildChangeDetail,
  normalizeMedicationIngredient,
  classifyHighAlertIngredient,
  classifyDiscrepancies,
  computeDiscrepancies,
  gatherMedicationSources,
  getReconciliation,
  listReconciliations,
  startReconciliation,
  decideItem,
  completeReconciliation,
};
