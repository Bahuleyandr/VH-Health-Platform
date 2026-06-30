# Composition-based drug search — design

**Date:** 2026-06-30 (rev. 3 — incorporates 2nd-round verifier review)
**Status:** Approved (design); pending implementation plan
**Surfaces:** staff app — IPD drug chart + prescription (e-Rx)

## Problem & goal

When a clinician searches for a drug while charting (IPD drug chart) or
prescribing (e-Rx), search only matches the typed text against a catalog
product's `name` or `generic_name`. Typing a **brand** ("Augmentin") returns
only that brand; it never surfaces **other brands with the same composition**
(Clavam, Moxikind — same amoxicillin+clavulanate from other manufacturers).

**Goal:** when a drug is selected, surface other brands with the same
composition (grouped by strength/form, in-stock first), let the clinician swap to
a *directly substitutable* equivalent in one tap, and warn — even when only a
brand was typed — about same-composition duplicates and molecule allergies. The
feature must be **governable** (confidence-gated, curatable, auditable), not
dependent on parser luck.

## Decisions

| Decision | Choice |
|---|---|
| Match rule | Same molecules, **grouped by strength + form**, matched strength surfaced first |
| Scope | Both surfaces — prescription **and** IPD drug chart |
| Enhancements | All three — in-stock-first, duplicate-therapy, composition-level allergy |
| Matching strategy | **Structured composition table** (`drug_compositions`), per-row confidence + curation |
| Substitutability | One-tap swap only for **directly substitutable** items: same molecules **+ per-ingredient strengths + form + route + release-type** (where known); other same-molecule items are **informational** |
| Rollout | **Off by default** behind a per-tenant feature flag; enabled only after a coverage **acceptance gate** (row-count **and usage-weighted**) is met |
| Authority | Server **derives + persists** identity (`composition_id/strength/form/strength_components`) from the tenant-scoped catalog row keyed by `catalog_id`; a client-sent `composition_id` is **never stored or trusted as fact**. Allergy/duplicate checks are authoritative server-side in `validatePrescriptionSafety`. |
| Deploy safety | The new composition enrichment is **independently guarded** (own try/catch + migration/feature availability check) so missing columns/table during a staggered deploy can never disturb existing allergy checks or block prescribing |

## Current implementation (verified baseline)

- **Search API:** `GET /api/v1/pharmacy-orders/catalog?search=<q>` →
  `pharmacyOrderController.getCatalog()`
  (`apps/backend/src/controllers/pharmacy/pharmacyOrderController.js:1434`); route
  `apps/backend/src/routes/pharmacy/index.js:73`. `SELECT … FROM pharmacy_catalog
  WHERE is_active AND (name ILIKE $q OR generic_name ILIKE $q) ORDER BY <rank>,
  stock DESC LIMIT N`.
- **`pharmacy_catalog`** (tenant-scoped via `tenant_id`): `id, name,
  generic_name, category, manufacturer, unit_price, price, pack_size,
  requires_prescription, in_stock, is_active, is_available, stock_quantity, stock,
  reorder_level, description, created_at, updated_at, tenant_id`. **No `strength`,
  `form`, or `composition_id`.** `generic_name` is the molecule set
  (`Amoxicillin+Clav`, `Paracetamol`); strength + form live in the free-text
  `name` (`"Paracetamol 1g Injection"`).
- **Catalog write paths (BOTH must integrate the parser):** admin upsert
  (catalog endpoints) **and** the importer
  `apps/backend/scripts/import-hospital-medicine-list.mjs:291` (`UPDATE
  pharmacy_catalog SET name, generic_name, …`).
- **Flutter client:** `MedicalApiService.searchMedicationCatalog()`
  (`apps/staff/lib/core/services/medical_api_service.dart:561`).
- **Prescription UI:**
  `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart` — rich
  autocomplete (`RawAutocomplete<Map>` ~L2424); `_MedicationEntry` (~L99) already
  carries `catalogId`, `genericName`, and `daw` (do-not-substitute) and shows
  `generic_name` + stock.
- **Drug-chart UI:**
  `apps/staff/lib/features/ipd/screens/drug_chart_screen.dart` — name-only
  autocomplete (`_DrugAutocompleteField` ~L977). **Order payload
  (`apps/staff/lib/core/services/order_payloads.dart:31`) sends only
  `medication_name/dose/route/frequency/...` in `details`** — no catalog/composition
  identity. `drugChartService.medicationPayloadFromOrder()`
  (`apps/backend/src/services/clinical/drugChartService.js:70`) reconstructs the
  safety payload from that free text.
- **Safety choke point:** `validatePrescriptionSafety(patientId, medications)`
  (`apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:767`) — pulls
  unified allergies (`getUnifiedActiveAllergies`) and currently does **name
  substring** allergy matching (so a brand misses a molecule allergy). This is
  the right place to add composition allergy + duplicate, enriched server-side.
- The drug **knowledge base** (`drug_kb_monographs`, migration 277) is a separate
  *safety* KB and stays separate — **not** overloaded as the prescribing catalog.
  Same-class/spectrum stewardship duplicates remain its (existing CDS) job.

## Data model

**New table `drug_compositions`** — global (no PHI; a molecule set is universal):

| column | purpose |
|---|---|
| `id` (PK) | |
| `composition_key` (unique) | canonical molecule set, e.g. `amoxicillin+clavulanic_acid` |
| `display_label` | "Amoxicillin + Clavulanic acid" |
| `active_ingredients text[]` | individual molecules — powers allergy matching |
| `source` | `parsed` \| `curated` \| `imported` (precedence) |
| `atc_code` (nullable) | the one widely-available code worth keeping inline |
| `created_at, updated_at` | |

*External-identifier escape hatch:* richer codes (RxNorm/SNOMED/vendor + import
batch) are **deferred to a normalized `drug_external_identifiers(composition_id,
system, code, import_batch_id)` table added with the importer** (out of scope
now) — a table ages better than fixed code columns, and adding it later is purely
additive (no reshuffle of existing columns).

**`pharmacy_catalog` — added columns** (parsed; raw `name`/`generic_name` never
rewritten):
- `composition_id` → FK `drug_compositions(id)` (nullable)
- `strength` (display, e.g. `"625 mg"`) + **`strength_key`** (canonical for
  grouping — lowercased, spaces stripped, `µg`→`mcg`, ratios normalized
  `100mg/5ml`)
- **`strength_components` (jsonb)** — per-ingredient strengths, e.g.
  `[{ingredient:"amoxicillin",amount:500,unit:"mg"},{ingredient:"clavulanic_acid",amount:125,unit:"mg"}]`.
  **Total strength alone is ambiguous for combinations** (Augmentin 625 =
  500+125); a *directly substitutable* combo must match per-ingredient strengths.
  Often unparseable from the catalog name → typically `curated`/`imported`, which
  is exactly why combos default to lower confidence until reviewed.
- `form` (display, e.g. `injection`) + **`form_key`** (canonical) + **`release_key`**
  (`ir|sr|er|xr|null`)
- `route` (where derivable; else null)
- `composition_source` (`parsed|curated|imported`) + **`composition_confidence`**
  (`high|medium|low`) + `parsed_notes` (per-row parse provenance/quality)

Index: tenant-aware composite for the alternatives lookup —
`pharmacy_catalog(tenant_id, composition_id, strength_key, form_key, release_key)`
(partial, `WHERE is_active`), not a bare `composition_id` index.

**New table `drug_composition_curation_queue`** (tenant-scoped) — the backfill
writes every unresolved / partial-strength / ambiguous-molecule-split /
ambiguous-form row here for admin/pharmacy review (status: `open|resolved|skip`,
reviewer, timestamp, notes). It needs **a way out**: a curation API/script
(below) that marks a row curated — setting `composition_id`, `strength_components`,
confidence, reviewer, timestamp, notes — so the queue is a worklist, not a
graveyard.

**Principles:** non-destructive + backwards-compatible (additive columns +
backfill; existing search untouched); `source` precedence; **confidence-gated**
(alternatives shown only for `high` confidence; `medium/low` go to curation).

## Parsing & backfill

Single pure, unit-tested module `compositionParser`
(`apps/backend/src/services/pharmacy/compositionParser.js`):
- `compositionKey(genericName)` → `{ key, activeIngredients[], displayLabel,
  confidence, notes }` (lowercase; split on `+ & - , / "and"`; trim; small alias
  map for top combos; sort; join; confidence reflects clean split vs ambiguous).
- `parseStrength(name)` → `{ display, key, components?, confidence }` — total
  strength (number+unit + ratio) always; per-ingredient `components` only when the
  name is unambiguous (e.g. `"500mg + 125mg"`), else null + a curation flag (combos
  rarely encode per-ingredient strength in the name).
- `parseForm(name)` → `{ form, formKey, releaseKey, route?, confidence }`.

**Called from every write path** so structured data never drifts: the **backfill
script** (idempotent; emits coverage report **and** populates the curation
queue), the **admin catalog upsert**, and the **importer**
(`import-hospital-medicine-list.mjs`) — or, minimally, a mandatory post-import
backfill the importer invokes.

## Backend API

1. **Enhance `GET /pharmacy-orders/catalog`** — additionally return
   `composition_id, composition_label, strength, strength_key, form, form_key,
   release_key, composition_confidence` per row (additive; backwards compatible).
2. **New `GET /pharmacy-orders/catalog/:id/alternatives`** — by **catalog id**
   (not a client composition id), so the backend authoritatively infers tenant,
   the selected row's composition + strength/form/release, **excludes the
   selected brand**, and only returns rows it's allowed to (tenant/RLS scoped on
   `pharmacy_catalog`). Returns siblings grouped by `strength_key` + `form_key`,
   **in-stock first** (`ORDER BY (stock_quantity>0) DESC, stock_quantity DESC,
   strength_key`), each tagged `substitutable: true|false` (true only when
   molecules+strength+form+route+release match the selected row) and a stock
   freshness flag.
3. **Composition checks inside `validatePrescriptionSafety`** — after server-side
   enrichment from each med's `catalog_id` (exact tenant-scoped catalog lookup;
   never trusting a client `composition_id`). `validatePrescriptionSafety` already
   "never throws"; the new composition block is **additionally wrapped in its own
   try/catch + a migration/feature-availability check**, so a missing column/table
   silently skips composition checks without disturbing the existing allergy logic
   or blocking prescribing.
   - **Composition allergy:** match the composition's `active_ingredients` against
     unified allergies; message names molecule **and** brand —
     *"Clavam contains amoxicillin; patient has an amoxicillin allergy."*
     Severity-aware per existing rules.
   - **Same-composition duplicate:** flag when a submitted med shares
     `composition_id` with another submitted med **or with an active existing
     e-prescription or active inpatient medication order** (resolved by
     `catalog_id`/`composition_id` where available). High-confidence/immediate —
     distinct from the softer class/spectrum CDS stewardship warning (unchanged).
4. **IPD payload + server-derived identity:** the drug-chart order sends the
   trusted `catalog_id` (+ display name); the **backend derives and persists**
   `composition_id, strength, form, strength_components, generic_name` into
   `clinical_orders.details` from the tenant-scoped catalog row — a client-sent
   `composition_id` is never persisted as fact. `drugChartService` uses the
   persisted identity (falls back to text reconstruction when absent) so IPD
   duplicate/allergy checks are reliable, not text-luck. (The e-Rx write path
   derives the same way.)
5. **Substitution audit (persisted only):** audit on **save** of a
   prescription/order whose chosen brand differs from the originally-selected one
   — original `catalog_id`, final `catalog_id`, actor, surface, reason — via
   `clinical_audit_events`. **Exploratory taps in the panel are not audited.**
6. **Curation API/script:** mark a curation-queue row resolved — set
   `composition_id`, `strength_components`, confidence, reviewer, timestamp, notes
   on the catalog row (and upsert the composition); the parser/backfill respects
   `source=curated` precedence so it's never overwritten.
7. Add the new route(s) to `src/docs/openapi.json` (+ `openapi:sync-core`).

## Flutter UX (both screens)

- **Search dropdown:** consistent richer row on both — brand (title) · composition
  + strength + form + stock badge. Drug-chart dropdown upgraded from name-only.
- **`CompositionAlternativesPanel` (shared widget):** takes the **selected
  catalog row / `catalogId`** + `onSwap(brandRow)`. Expands to call
  `/catalog/:id/alternatives`; lists siblings grouped by strength + form, in-stock
  first, matched strength first. **Directly-substitutable** siblings are one-tap
  swap; **non-substitutable** same-molecule siblings (different form/strength/
  release) are shown **informational only**. **Respects `do_not_substitute`/`daw`**:
  if set, the whole panel is information-only (no one-tap swap). Only shown when
  `composition_confidence = high`.
- **Stock label:** distinguish positive `stock_quantity` ("In stock") from
  `in_stock=true` with stale/null count ("May be available") — don't imply a
  guarantee.
- **Warnings (inline on the entry):** duplicate-therapy (amber, instant
  client-side via `composition_id`, *authoritatively re-checked server-side*);
  composition allergy (severity-aware, molecule+brand message, server-driven).
- **Drug-chart entry model:** captures `catalog_id/composition_id/strength/form`
  on selection (typed name still kept). **Free-text drugs still work** — no
  composition ⇒ no panel/warnings (graceful degradation).

### Component boundaries
- `compositionParser` (backend): pure; free text → `{composition, strength, form,
  confidence}`. No DB.
- `/catalog/:id/alternatives`: catalog id + tenant → grouped, substitutability-
  tagged sibling rows.
- `validatePrescriptionSafety`: authoritative allergy + duplicate, enriched from
  `catalog_id`.
- `CompositionAlternativesPanel` (Flutter): `catalogId` + `onSwap`; screen-model-
  agnostic.

## Phasing — independently-shippable slices

1. **Foundation (inert):** migrations (`drug_compositions`, catalog columns incl.
   `strength_components`, curation queue) + `compositionParser` + backfill
   (coverage + usage-weighted report + curation-queue population) + all
   write-path hooks + the **curation resolve API/script**. No UI change.
   **Gate:** review coverage (row-count + usage-weighted) before enabling.
2. **Backend API:** additive search fields + `/alternatives` (catalog-id-keyed,
   tenant-scoped, substitutability-tagged) + composition allergy/duplicate in
   `validatePrescriptionSafety` (server-enriched from `catalog_id`, guarded,
   incl. **active existing e-Rx + IPD orders**) + server-derived IPD/e-Rx
   identity persistence + persisted-substitution audit + openapi sync.
   Backwards-compatible.
3. **Prescription UI** (already rich → lower risk first): richer rows + panel +
   DAW handling + warnings.
4. **Drug-chart UI:** dropdown + entry-model + payload + same shared
   panel/warnings.

Each slice degrades gracefully; a pause between any leaves a working app.

## Rollout / acceptance gate

Alternatives are **off by default** behind a per-tenant feature flag. Enable only
after coverage on the real catalog meets both a **row-count** and a
**usage-weighted** bar (a 90% catalog pass can still miss the 10% used daily):
- row-count: **≥ 90%** of active rows composition-resolved at `high` confidence;
  **≥ 80%** strength + form resolved for the common formulary categories;
- usage-weighted: **≥ 95%** of the **top-N dispensed / top-stocked** items
  (by recent dispensing + stock) resolved at `high` confidence;
- **zero** high-risk ambiguous injectables in the enabled set (manually cleared).
Below threshold, the catalog search keeps working unchanged; alternatives simply
stay hidden while pharmacy curates via the queue.

## Testing

- **Parser unit tests** (table-driven, real catalog name samples): composition
  normalization + confidence, strength/ratio + `strength_key`, form/`form_key`/
  `release_key`, junk input.
- **Backend deep tests:** `/alternatives` (strength+form grouping, in-stock-first,
  tenant scoping, selected-brand exclusion, substitutability tagging incl.
  combo per-ingredient-strength gating); additive search fields; **server-enriched**
  composition allergy (brand trips molecule) + same-composition duplicate **against
  active existing e-Rx + IPD orders**; a **client-sent `composition_id` is ignored**
  (server derives from `catalog_id`); **guarded enrichment** — simulate missing
  column/table ⇒ composition checks skipped, existing allergy checks intact, nothing
  blocked; IPD/e-Rx persisted identity is server-derived; substitution audit written
  **only on persisted save** (not on panel taps); curation-resolve sets identity +
  `source=curated` (not overwritten by re-parse); backfill idempotency +
  curation-queue population + row-count & usage-weighted coverage.
- **Flutter widget tests:** panel grouping/order/substitutable-vs-info/DAW/swap;
  duplicate + allergy warnings; stock-freshness label; free-text ⇒ no panel.

## Risks → mitigations

- Messy `generic_name` → confidence gating + curation queue + `source=curated`
  override; unresolved rows just stay hidden.
- Fuzzy strength/form/release → raw name kept; canonical `*_key` for grouping;
  substitutability requires the strict match, so injection/SR are never silent
  swaps.
- Trusting the client → server derives + persists identity from `catalog_id`;
  client `composition_id` never stored/trusted.
- **Staggered deploy** (columns/table not yet present everywhere) → composition
  enrichment is guarded + availability-gated; it degrades to "no composition
  checks," never an exception and never a block, since the safety checker is
  fail-closed.
- Combination ambiguity → per-ingredient `strength_components`; combos stay
  lower-confidence (info-only) until curated, so they're never silent one-tap swaps.
- Stale stock → freshness label, never a false guarantee.
- Multi-tenant → compositions global; catalog tenant/RLS scoped; alternatives
  query respects it.

## Out of scope (YAGNI — model leaves the door open)

Building a class/spectrum duplicate engine (existing CDS already does this); the
licensed drug-DB importer + the `drug_external_identifiers` table it brings (a
clean, purely-additive later add); drug–drug interactions; dose-range checks.
