# Composition-based drug search — design

**Date:** 2026-06-30
**Status:** Approved (design); pending implementation plan
**Surfaces:** staff app — IPD drug chart + prescription (e-Rx)

## Problem & goal

When a clinician searches for a drug while charting (IPD drug chart) or
prescribing (e-Rx), the search only matches the typed text against a catalog
product's `name` or `generic_name`. Typing a **brand** ("Augmentin") returns
only that brand; it never surfaces **other brands with the same composition**
(e.g. Clavam, Moxikind — same amoxicillin+clavulanate from different
manufacturers).

**Goal:** when a drug is selected, show the *other brands with the same
composition*, grouped by strength, in-stock brands first — plus three safety/UX
layers: duplicate-therapy detection, composition-level allergy flagging, and
in-stock prioritisation. The clinician can swap to an equivalent brand in one
tap, and is warned about same-composition duplicates and molecule allergies even
when only a brand name was typed.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Match rule | **Same molecules, grouped by strength** — show all same-molecule brands, grouped/sorted by strength + form, matched strength first |
| Scope | **Both surfaces** — prescription (e-Rx) **and** IPD drug chart |
| Enhancements | **All three** — in-stock-first, duplicate-therapy warning, composition-level allergy flag |
| Matching strategy | **Structured composition table** (`drug_compositions`) — robust, future-proof; leaves a clean path to a licensed drug-DB import |

## Current implementation (baseline)

- **Search API:** `GET /api/v1/pharmacy-orders/catalog?search=<q>` →
  `pharmacyOrderController.getCatalog()`
  (`apps/backend/src/controllers/pharmacy/pharmacyOrderController.js` ~L1434),
  route `apps/backend/src/routes/pharmacy/index.js` ~L73. SQL: `SELECT … FROM
  pharmacy_catalog WHERE is_active AND (name ILIKE $q OR generic_name ILIKE $q)
  ORDER BY <rank>, stock DESC LIMIT N`.
- **`pharmacy_catalog` columns:** `id, name, generic_name, category,
  manufacturer, unit_price, price, pack_size, requires_prescription, in_stock,
  is_active, is_available, stock_quantity, stock, reorder_level, description,
  created_at, updated_at, tenant_id`. **No `strength`, no `form`, no
  `composition_id`.** `generic_name` is the molecule set (e.g. `Amoxicillin+Clav`,
  `Paracetamol`); strength + form live inside the free-text `name`
  (`"Paracetamol 1g Injection"`, `"Ondansetron Syrup 2mg/5ml"`).
- **Flutter client:** `MedicalApiService.searchMedicationCatalog()`
  (`apps/staff/lib/core/services/medical_api_service.dart` ~L561).
- **Prescription UI:** `apps/staff/lib/features/doctor/screens/prescriptions_screen.dart`
  — rich autocomplete (`RawAutocomplete<Map>`, ~L2424), `_MedicationEntry` model
  (~L99), already shows `generic_name` + stock in result rows.
- **Drug-chart UI:** `apps/staff/lib/features/ipd/screens/drug_chart_screen.dart`
  — name-only autocomplete (`RawAutocomplete<String>`, `_DrugAutocompleteField`
  ~L977); result rows show the drug name string only.
- **Safety:** `validatePrescriptionSafety()` (backend
  `src/utils/clinical/prescriptionSafetyCheck.js`) — allergy + duplicate checks;
  patient allergies are on `users.allergies`.
- The drug **knowledge base** (`drug_kb_monographs`, migration 277) is a separate
  *safety* KB (allergy/interaction class grouping), **not** the prescribing
  catalog. It is not used for the catalog search and is out of scope here.

## Data model

**New table `drug_compositions`** — global (not tenant-scoped; a molecule set is
a universal medical fact with no PHI):

| column | type | purpose |
|---|---|---|
| `id` | serial PK | |
| `composition_key` | varchar, **unique** | canonical normalized molecule set, e.g. `amoxicillin+clavulanic_acid` |
| `display_label` | varchar | human label, e.g. "Amoxicillin + Clavulanic acid" |
| `active_ingredients` | text[] | individual molecules — powers allergy matching |
| `source` | varchar | `parsed` \| `curated` \| `imported` — precedence so a future curated/licensed value can supersede a parsed one |
| `created_at`, `updated_at` | timestamptz | |

**`pharmacy_catalog` — three added columns** (parsed once from the existing
free-text fields; raw `name`/`generic_name` are never rewritten):

- `composition_id int` → FK `drug_compositions(id)` (nullable; the grouping key)
- `strength varchar` — e.g. `"625 mg"`, `"100mg/5ml"`
- `form varchar` — e.g. `tablet`, `syrup`, `injection`, `drops`

Index: `pharmacy_catalog(composition_id)`.

**Principles:**
1. **Non-destructive & backwards-compatible** — additive columns + a backfill;
   the existing search keeps working at every step.
2. **`source` precedence** — parsed values are the floor; curated/imported data
   override without a redesign.

## Parsing & backfill

A single pure, unit-tested module `compositionParser`
(`apps/backend/src/services/pharmacy/compositionParser.js`):

- `compositionKey(genericName)` → `{ key, activeIngredients[], displayLabel }`.
  Lowercase; split on `+ & - , /` and `"and"`; trim each molecule; apply a small
  alias map for the common combos (`clav → clavulanic acid`, `d3 → cholecalciferol`,
  etc.); sort molecules; join with `+`.
- `parseStrength(name)` → e.g. `"625 mg"`, `"100mg/5ml"` (number+unit and ratio
  regex; units mg/g/mcg/µg/ml/IU/%).
- `parseForm(name)` → `tablet | capsule | syrup | suspension | drops |
  injection | cream | ointment | gel | spray | inhaler | …` (keyword table).

Used in **two** places so structured data never drifts from the source text:
1. **Backfill script** (`apps/backend/scripts/backfill-drug-compositions.mjs`),
   idempotent: upserts `drug_compositions` and sets the three catalog columns for
   existing rows; prints a **coverage report** (clean / partial / unresolved
   counts + sample unresolved). Run on the real catalog and review before relying
   on it.
2. **Catalog write path** — the admin create/update catalog endpoints call the
   parser so new products get `composition_id`/`strength`/`form` automatically.
   (Application-layer, not a DB trigger — same JS module, testable.)

## Backend API

1. **Enhance `GET /pharmacy-orders/catalog`** to also return `composition_id`,
   `composition_label`, `strength`, `form` per row. Additive → backwards
   compatible.
2. **New `GET /pharmacy-orders/catalog/:id/alternatives`** → the full
   same-composition sibling set for catalog row `:id`, **grouped by strength +
   form**, **in-stock first** (`ORDER BY in_stock DESC, COALESCE(stock_quantity,
   stock,0) DESC, strength`). Tenant-scoped on the catalog rows. Response: the
   composition `display_label` + sibling rows (brand, manufacturer, strength,
   form, stock). This powers the "other brands" panel (search is capped at ~12
   rows, so siblings need their own fetch).
3. **Extend `validatePrescriptionSafety`** to match the selected drug's
   composition `active_ingredients` against the patient's allergies — so a
   *brand* name still trips an `amoxicillin` allergy. Severity-aware
   (blocker vs warning), reusing the existing blockers/warnings shape.
4. Add the new route to `src/docs/openapi.json` (+ `openapi:sync-core`) so the
   drift check stays green.

## Flutter UX (both screens)

- **Search dropdown:** consistent richer result row on both surfaces — **brand**
  (title) · **composition + strength + form + stock badge** (subtitle/trailing).
  The drug-chart dropdown is upgraded from name-only to this row.
- **Alternatives panel (`CompositionAlternativesPanel`, shared widget):** under a
  selected drug, an expandable affordance *"⇄ N brands · same composition ▾"*.
  Expanding calls `/alternatives`; lists siblings grouped by strength + form,
  in-stock first, matched strength surfaced first; each row = *brand ·
  manufacturer · strength/form · stock badge*; **tap swaps** the selection. The
  widget is screen-agnostic: takes a `compositionId` + `onSwap(brandRow)`.
- **Duplicate-therapy warning:** amber chip on the entry — *"⚠ Same composition
  as Augmentin (already added)"*. Client-side, instant, via each entry's
  `composition_id`. Backend also re-checks at order submit (defense-in-depth).
- **Composition allergy warning:** severity-aware banner on the entry — hard
  blocker (*"Patient allergic to amoxicillin"*) or soft warning, from the backend
  safety check; shown even when a brand name was typed.
- **Drug-chart entry model:** stops being a bare `String` for *selected* catalog
  drugs — on selection it captures `composition_id`/`strength`/`form` (typed name
  still kept).
- **Graceful degradation:** a drug with no `composition_id` (free-text or
  unresolved) simply shows no panel and no warnings — the feature never blocks
  normal prescribing/charting.

### Component boundaries
- `compositionParser` (backend): pure functions; in → free text, out → structured
  composition/strength/form. No DB.
- `/alternatives` endpoint: in → catalog id + tenant; out → grouped sibling rows.
- `CompositionAlternativesPanel` (Flutter): in → `compositionId` + `onSwap`
  callback; knows nothing about either screen's entry model.
- Each screen keeps its own autocomplete wiring (minimal-risk) but feeds the
  shared result-row + panel widgets.

## Phasing — four independently-shippable slices

1. **Foundation (data, inert):** migration + `compositionParser` + idempotent
   backfill + coverage report + write-path hook. No UI change; existing search
   untouched. **Gate:** review backfill coverage on the real catalog before
   relying on it.
2. **Backend API:** additive search fields + `/alternatives` + composition-allergy
   in the safety check + openapi sync. Backwards-compatible.
3. **Prescription UI** (already rich → lower risk first): richer rows +
   alternatives panel + both warnings.
4. **Drug-chart UI:** dropdown + entry-model upgrade + same shared
   panel/warnings.

Each slice degrades gracefully, so a pause between any of them leaves a working
app.

## Testing

- **Parser unit tests** (table-driven, real catalog name samples): `compositionKey`
  normalization, strength/ratio parsing, form keywords, junk input.
- **Backend deep tests:** `/alternatives` (strength+form grouping, in-stock-first
  order, tenant scoping); the additive search fields; the **brand-name-trips-
  molecule-allergy** safety case; backfill idempotency + coverage on a seeded DB.
- **Flutter widget tests:** `CompositionAlternativesPanel` (grouping/order/swap);
  duplicate warning fires on a shared `composition_id`; allergy warning shows;
  free-text → no panel (graceful degradation). API mocked.

## Risks → mitigations

- **Messy real `generic_name`** → coverage report + `source=curated` override
  path; unresolved rows just hide the feature.
- **Fuzzy strength/form parsing** → raw `name` always kept; parsed values are
  best-effort; **form-aware grouping** prevents injection-as-tablet suggestions.
- **Performance** → index on `composition_id`; the join + the alternatives query
  are simple indexed lookups; negligible.
- **Multi-tenant** → compositions global; catalog tenant-scoped (RLS); the
  alternatives query respects tenant scope on the catalog rows.

## Out of scope (YAGNI — the model leaves the door open)

Licensed drug-DB import, drug–drug interaction checking, dose-range checking. The
`source` column + structured composition model make these clean later additions;
we do not build them now.
