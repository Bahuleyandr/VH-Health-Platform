# Composition-based drug search — Phase 2 (backend API) plan

**Date:** 2026-06-30
**Spec:** `docs/superpowers/specs/2026-06-30-composition-based-drug-search-design.md` (rev.3, approved)
**Phase 1 (foundation):** merged to `main` (migration 350, `compositionParser`, backfill,
curation resolve, write-path enrichment) — inert; feature gated off.
**This phase:** the backwards-compatible backend API slice. No Flutter/UI change (Phases 3–4).

## Guiding invariants (apply to every task)

1. **Server-authoritative identity.** The server derives composition identity from the
   **tenant-scoped `pharmacy_catalog` row keyed by `catalog_id`**. A client-sent
   `composition_id` is **never stored or trusted as fact**. (Spec → Authority.)
2. **Guarded + availability-gated.** Every new composition code path is wrapped in its
   **own try/catch** and checks that the migration-350 columns/tables exist before using
   them, so a staggered deploy (columns not present everywhere) degrades to "no composition
   behavior" — never an exception, never a block. `validatePrescriptionSafety` is
   **fail-closed** and "never throws"; the new block must preserve that.
3. **Per-tenant feature flag, off by default.** Clinician-visible composition *behavior*
   (the `/alternatives` results and the composition allergy/duplicate warnings) is shown
   only when the tenant's flag is ON. Below the acceptance gate the catalog search keeps
   working unchanged and composition behavior stays hidden.
4. **Backwards compatible.** Additive response fields, additive optional request fields,
   additive routes. Existing callers and existing name-based allergy logic are untouched.
5. **Confidence gating.** Alternatives and same-composition duplicate warnings fire only for
   **`high` confidence** composition rows. `medium/low` go to the curation queue (Phase 1),
   never surfaced.
6. **Canonical clinical timeline.** Any persisted clinical write already routes through the
   canonical layer; we only *enrich* `details`/`medications` and *add* an audit event — we
   do not add a new parallel write path. (Root `CLAUDE.md` invariant.)
7. **Enrich BEFORE safety, persist the SAME enriched object (ordering, verifier-flagged).**
   In `createOrder`, `runCDSChecks` runs **before** `clinical_orders.create`. So IPD identity
   enrichment must happen **before** `runCDSChecks`, and the *same* enriched `details` is what
   gets persisted. For e-Rx, enrich the `medications` array **before** `validatePrescriptionSafety`
   and persist that *same* enriched array. One server-side enrichment per request feeds both
   the safety check and the write — never enrich twice with divergent results, never
   safety-check an un-enriched array then persist an enriched one (or vice-versa).
   (`validatePrescriptionSafety` still self-enriches defensively from `catalog_id` — idempotent
   — so callers that don't pre-enrich still get correct checks.)

## Grounding facts (verified 2026-07-01)

- **Search endpoint:** `pharmacyOrderController.getCatalog` — `apps/backend/src/controllers/pharmacy/pharmacyOrderController.js:1435`.
  `SELECT id, name, generic_name, category, manufacturer, price, unit_price, pack_size,
  COALESCE(stock_quantity, stock) AS stock, in_stock, is_available, requires_prescription,
  reorder_level, description, created_at FROM pharmacy_catalog ${where} ${orderBy} LIMIT $N`
  via `prisma.$queryRawUnsafe`, response `success(res, result, 'Catalog')`.
  **JOIN footgun:** `drug_compositions` also has columns `id` and `created_at`; a
  `LEFT JOIN drug_compositions dc ON dc.id = pharmacy_catalog.composition_id` makes `id`
  and `created_at` ambiguous — those two must be qualified `pharmacy_catalog.id` /
  `pharmacy_catalog.created_at`.
- **Upsert (write path, Phase 1 done):** `upsertCatalog` (~L1485) already derives+persists
  structured composition columns via `enrichCatalogRowForWrite`.
- **Routes:** `apps/backend/src/routes/pharmacy/index.js:73` —
  `wrapAutoRBAC(router, 'pharmacyCatalogRoutes', { get: [['/catalog', [], getCatalog]] })`.
  RBAC in `apps/backend/src/config/rbacConfig.js:133` (`pharmacyCatalogRoutes`).
  Response helper `success(res, data, message)` → `{ success, message, data, requestId }`.
- **Safety checker:** `validatePrescriptionSafety(patientId, medications)` —
  `apps/backend/src/utils/clinical/prescriptionSafetyCheck.js:767`. Pulls unified allergies
  (`getUnifiedActiveAllergies`); **name-substring** allergy match (L782–814, brand misses
  molecule); active-e-Rx duplicate query (L891–917) — **does NOT query `clinical_orders`
  (IPD)**; returns `{ safe, warnings, blockers }`; top-level try/catch (L1122–1136) — never
  throws. Severity helpers: `rankSeverity`, `SEVERE_BLOCK_RANK`.
- **e-Rx save:** `ePrescriptionController.js` — CREATE (safety L912, INSERT
  `medications=$8::jsonb` L1023–1052) and UPDATE (safety L1355, UPDATE `medications=$3::jsonb`
  L1376–1396). Medications persisted verbatim; **no server enrichment today**. Medications
  parsed by `normalizeMedicationList(req.body.medications)` (L886).
- **IPD medication order save:** `orderEntryService.createOrder(data)` —
  `apps/backend/src/services/emr/orderEntryService.js:627`. `normalizeOrderInput` (L452)
  shapes `details`; `runCDSChecks(patient_uid, order_type, details)` (L639) is the CDS choke
  that reaches the safety checker; `tx.clinical_orders.create({ data: { details: n.details }})`
  (single L667, bulk L794). `createOrder` already has `data.tenantId`. `details` is a Json
  column. `drugChartService.medicationPayloadFromOrder` (L70) reconstructs the safety payload
  from `details` (will prefer persisted identity when present).
- **Audit writer:** `recordClinicalAuditEvent(input, options)` —
  `apps/backend/src/services/clinical/canonicalClinicalPlatformService.js:489`. Input keys:
  `tenantId, action, actionStatus, patientUid, encounterId, actorUid, actorRole,
  resourceType, resourceTable, resourceId, requestId, ipAddress, userAgent, beforeState,
  afterState, metadata, idempotencyKey, occurredAt`. Returns null on failure (never throws).
- **Feature-flag service (global):** `apps/backend/src/services/featureFlags/featureFlagService.js`
  — table `feature_flags(name unique, enabled, rollout_percentage, allowed_roles)`, cached 60s.
  **Global, no `tenant_id`** → not sufficient for the spec's per-tenant requirement.
- **RLS Pattern-A** `tenant_isolation` (USING + WITH CHECK + FORCE, `app_current_tenant_id_uuid()`,
  GUC `app.current_tenant_id`, `bypass` branch) — copy from migrations 328/335/336/350.
- **Migrations are tracker-driven raw SQL** (`src/migrations/NNN_*.sql`); after any
  Prisma-modelled table change, regenerate `prisma/schema.prisma` via `npx prisma db pull`
  and run `check-schema-drift.mjs`. Highest existing migration is `350`.
- **Test DB:** QA cluster `postgresql://postgres:postgres@127.0.0.1:55432/vhhealth_test`
  (superuser → bypasses RLS; intended for tests). Deep tests: `src/tests/*-deep.test.js`;
  assert exactly. Raw params are **spread** (`$queryRawUnsafe(sql, ...params)`), and bare
  params inside `jsonb_build_*` need `::type` casts.

---

## Task 1 — Per-tenant feature flag: migration 351 + `compositionFeatureService`

**Why:** The spec requires a **per-tenant**, off-by-default flag (each tenant curates its own
catalog, so coverage — and the flip — differ per tenant). The existing `feature_flags` table
is global. Add a minimal per-tenant settings table that also stores the acceptance-gate
snapshot at flip time, so enabling is evidence-based and auditable.

**TDD:**

1. Write `apps/backend/src/tests/composition-feature-flag.deep.test.js` first. Assert:
   - default: no row for a tenant ⇒ `isCompositionSearchEnabled(tenantId)` resolves `false`.
   - `setCompositionSearchEnabled(tenantId, true, { actorUid, snapshot })` upserts a row with
     `enabled=true`, `enabled_at` set, `enabled_by=actorUid`, `acceptance_snapshot=snapshot`;
     then `isCompositionSearchEnabled` resolves `true`.
   - flipping back to `false` clears `enabled` and resolves `false`.
   - unknown/`null` tenantId ⇒ `false` (never throws).
   - cache: two reads within the TTL hit the cache (optional — assert value stability, not internals).
2. **Migration** `apps/backend/src/migrations/351_composition_search_settings.sql`:
   ```
   CREATE TABLE IF NOT EXISTS composition_search_settings (
     tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
     enabled BOOLEAN NOT NULL DEFAULT FALSE,
     enabled_at TIMESTAMPTZ,
     enabled_by UUID,
     acceptance_snapshot JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   ```
   Add full Pattern-A `tenant_isolation` RLS (USING + WITH CHECK + FORCE), copied verbatim in
   shape from migration 350's curation-queue block. **`tenant_id` has no GUC default** (it is
   the PK) → writes must supply it explicitly (the service always does).
3. `apps/backend/src/services/pharmacy/compositionFeatureService.js`, mirroring
   `featureFlagService.js`'s cache *shape* but **keyed per-tenant** (verifier-flagged):
   - **Do NOT do a global `SELECT tenant_id, enabled FROM composition_search_settings` refresh.**
     `composition_search_settings` has RLS; if `isCompositionSearchEnabled` is ever called
     inside an active tenant GUC scope, a global refresh loads only the current tenant's row
     and evicts every other tenant from the cache. Instead cache **per tenant** (Map keyed by
     `tenantId`, each entry `{ enabled, fetchedAt }` with its own 60s TTL) and read with an
     explicit filter `WHERE tenant_id = $1::uuid` (correct regardless of GUC state).
   - `isCompositionSearchEnabled(tenantId): Promise<boolean>` — false when `tenantId` falsy,
     table missing (guarded try/catch → false), or no row / `enabled=false`.
   - `setCompositionSearchEnabled(tenantId, enabled, { actorUid = null, snapshot = null } = {})`
     — `INSERT … ON CONFLICT (tenant_id) DO UPDATE`; when enabling set `enabled_at=NOW()`,
     `enabled_by`, `acceptance_snapshot`; refresh cache entry; return the row.
   - Reads via `prisma.$queryRawUnsafe`, spread params, `snapshot` cast `$4::jsonb`.
4. Regenerate `prisma/schema.prisma` (`npx prisma db pull`) and run
   `npm --prefix apps/backend run check:schema-drift` — must be clean.

**Files:** new migration, new service, new test. **Do NOT** wire it into any endpoint yet
(Tasks 4–5 consume it).

**Acceptance:** deep test green; drift check clean.

---

## Task 2 — Additive composition fields on `GET /pharmacy-orders/catalog`

**Why:** Spec Backend-API §1 — the search response additionally returns composition metadata
so the client can render richer rows. Additive, backwards compatible, **ungated** (catalog
metadata, not PHI, not clinician-facing behavior — the UI only *uses* it under the flag).

**TDD:**

1. Add to `apps/backend/src/tests/*` (extend the existing pharmacy catalog deep test, or a new
   `pharmacy-catalog-composition-fields.deep.test.js`). Seed a `drug_compositions` row + a
   `pharmacy_catalog` row with `composition_id` set (high confidence) and one row with
   `composition_id NULL`. Assert `GET /pharmacy-orders/catalog?search=…` returns, per row:
   `composition_id, composition_label, strength, strength_key, form, form_key, release_key,
   composition_confidence`; the null-composition row returns `composition_id: null` and
   `composition_label: null` (no crash), and **all pre-existing fields are unchanged**.
2. In `getCatalog` (pharmacyOrderController.js ~L1472), change the query:
   - Add `LEFT JOIN drug_compositions dc ON dc.id = pharmacy_catalog.composition_id` between
     `FROM pharmacy_catalog` and `${where}`.
   - **Qualify the two ambiguous columns** in the SELECT: `pharmacy_catalog.id AS id`,
     `pharmacy_catalog.created_at AS created_at` (drug_compositions also has `id`/`created_at`).
   - Append: `pharmacy_catalog.composition_id, dc.display_label AS composition_label,
     pharmacy_catalog.strength, pharmacy_catalog.strength_key, pharmacy_catalog.form,
     pharmacy_catalog.form_key, pharmacy_catalog.release_key,
     pharmacy_catalog.composition_confidence`.
   - Leave `${where}` / `${orderBy}` param builders and `LIMIT $N` untouched (their columns —
     `is_active, name, generic_name, category, stock` — are unambiguous under the join).
3. Confirm the response envelope is unchanged (`success(res, result, 'Catalog')`).

**Acceptance:** deep test green; existing pharmacy catalog tests still green.

---

## Task 3 — Server-side composition-identity resolver (`compositionIdentityService`)

**Why:** A single guarded, tenant-scoped helper that turns `catalog_id`s into authoritative
composition identity, reused by the safety checks (Task 5) and identity persistence (Task 6).
Centralizes invariant #1 (never trust client `composition_id`) and #2 (guarded/availability).

**TDD:**

1. `apps/backend/src/tests/composition-identity-resolver.deep.test.js`. Seed compositions +
   catalog rows across **two tenants**. Assert:
   - `resolveCompositionIdentitiesByCatalogIds(tenantId, [id1, id2])` returns a `Map` keyed by
     `catalog_id` → `{ catalog_id, composition_id, composition_key, active_ingredients,
     display_label, strength, strength_key, form, form_key, release_key, route,
     composition_confidence, generic_name, name }`, **scoped to `tenantId`** (a catalog id
     from the other tenant is absent from the map).
   - `enrichMedicationsWithComposition(tenantId, meds)` returns a **new** array where each med
     carrying a `catalog_id` gains server-derived identity fields; a client-supplied
     `composition_id` on the input med is **discarded/overwritten** by the server-derived one
     (assert the fabricated client value never appears in output).
   - meds without `catalog_id` pass through unchanged.
   - **Guarded:** with a non-existent table simulated (or `tenantId` null / empty ids) the
     helpers return an empty map / the meds unchanged and **never throw**.
2. `apps/backend/src/services/pharmacy/compositionIdentityService.js`:
   - `resolveCompositionIdentitiesByCatalogIds(tenantId, catalogIds)` — one batched
     `SELECT … FROM pharmacy_catalog pc LEFT JOIN drug_compositions dc ON dc.id = pc.composition_id
     WHERE pc.tenant_id = $1::uuid AND pc.id = ANY($2::int[]) AND pc.is_active` (empty ids →
     empty Map without a query). Wrap in try/catch → empty Map on any error (missing column/table).
   - `enrichMedicationsWithComposition(tenantId, meds)` — resolve unique `catalog_id`s once,
     then map meds; strip any incoming `composition_id` before merging server identity.
   - Export a small `COMPOSITION_IDENTITY_FIELDS` constant (the derived keys) so callers persist
     a consistent subset.

**Files:** new service + test. No endpoint wiring here.

**Acceptance:** deep test green (incl. tenant scoping + client-id-ignored + guarded).

---

## Task 4 — `GET /pharmacy-orders/catalog/:id/alternatives` (gated)

**Why:** Spec Backend-API §2 — catalog-id-keyed, tenant-scoped alternatives, grouped by
strength+form, in-stock first, substitutability-tagged. Off unless the tenant flag is ON and
the selected row is `high` confidence.

**TDD:**

1. `apps/backend/src/tests/pharmacy-catalog-alternatives.deep.test.js`. Seed one composition
   (e.g. amoxicillin+clavulanic_acid) with several catalog brands across strengths/forms in
   **tenant A**, one brand in **tenant B**, and one different-composition brand. With the flag
   **ON** for tenant A, assert `GET /pharmacy-orders/catalog/:id/alternatives` for a tenant-A
   brand:
   - **excludes the selected brand** (its own id never in the result);
   - returns only same-`composition_id` tenant-A rows (tenant-B brand and other-composition
     brand absent — tenant scoping + composition match);
   - **grouped** by `strength_key` + `form_key`; the selected row's matched strength/form group
     surfaced first;
   - **in-stock first**: `ORDER BY (COALESCE(stock_quantity, stock) > 0) DESC,
     COALESCE(stock_quantity, stock) DESC, strength_key`;
   - each item tagged `substitutable: true` only when molecules **and** `strength_key`
     **and** `form_key` **and** `route` **and** `release_key` match the selected row (for a
     combo whose `strength_components` differ but total matches → `substitutable: false`);
   - each item carries **`availability_status: "in_stock" | "may_be_available" | "out_of_stock"`**
     (verifier-flagged — call it *status*, not *freshness*: the catalog has no true
     `stock_updated_at`, so we can't claim freshness). Map: positive `stock_quantity` ⇒
     `in_stock`; `in_stock=true` with null/zero count ⇒ `may_be_available`; else `out_of_stock`.
   - **Deterministic status codes (verifier-flagged — pick one, no ambiguity):**
     - **Flag OFF** (tenant with no settings row / `enabled=false`) ⇒ **200** `{ alternatives: [], groups: [] }`.
     - **Flag ON + selected `catalog_id` missing or not in caller's tenant** ⇒ **404**.
     - **Flag ON + row found but `composition_confidence != 'high'` or `composition_id NULL`** ⇒
       **200** `{ alternatives: [], groups: [] }` (the brand exists but has no surfaced alternatives).
2. Controller `getCatalogAlternatives(req, res)` in pharmacyOrderController.js:
   - Resolve `tenantId` from `req` (same source the file already uses for tenant-scoped reads).
   - `isCompositionSearchEnabled(tenantId)` (Task 1) false ⇒ **200** `success(res, { alternatives: [], groups: [] }, 'Alternatives')` (do NOT 404 — flag-off is a valid, empty answer).
   - Load the selected row (tenant-scoped) via Task 3 resolver / a direct tenant-scoped select.
     Missing / wrong-tenant `catalog_id` ⇒ **404** (`AppError.notFound`). Row found but no
     `composition_id` or `composition_confidence != 'high'` ⇒ **200** empty.
   - Query siblings (tenant-scoped, `is_active`, `composition_id = selected`, `id <> :id`),
     compute `availability_status`, build groups + tags as above.
3. Route: after pharmacy/index.js:77 add
   `wrapAutoRBAC(router, 'pharmacyCatalogAlternativesRoutes', { get: [['/catalog/:id/alternatives', [], pharmacyOrderController.getCatalogAlternatives]] });`
   and add `pharmacyCatalogAlternativesRoutes` to `rbacConfig.js` (mirror `pharmacyCatalogRoutes`
   roles — prescribers + pharmacy + admin; do not broaden).

**Acceptance:** deep test green; route reachable under RBAC; flag-off path returns empty.

---

## Task 5 — Composition allergy + same-composition duplicate in `validatePrescriptionSafety` (gated, guarded)

**Why:** Spec Backend-API §3 — molecule-level allergy (brand trips a molecule allergy) and
same-composition duplicate vs submitted meds **and active existing e-Rx and active IPD
orders**, enriched server-side from `catalog_id`. Must not disturb the existing fail-closed
name-based logic.

**TDD:**

1. `apps/backend/src/tests/prescription-safety-composition.deep.test.js`. Seed a patient with
   an **amoxicillin** allergy, compositions/catalog for Augmentin (amoxicillin+clav) and Clavam
   (same composition). With the tenant flag **ON** and passing `{ tenantId }`:
   - submitting **Clavam by `catalog_id`** (brand only, no molecule in name) produces a
     composition **allergy** warning/blocker naming molecule **and** brand
     ("Clavam contains amoxicillin; patient has an amoxicillin allergy"), severity per existing
     rules (`rankSeverity`/`SEVERE_BLOCK_RANK`).
   - a **client-sent `composition_id`** that points at an unrelated composition is **ignored**
     (server derives from `catalog_id`); the allergy still fires on the real molecule.
   - **duplicate**: two submitted meds sharing `composition_id` ⇒ `DUPLICATE_COMPOSITION`
     warning; a submitted med sharing composition with an **active existing e-Rx** ⇒ warning;
     sharing with an **active IPD `clinical_orders` medication order** (`order_type='medication'`,
     non-terminal status, `details->>'composition_id'`) ⇒ warning.
   - duplicate fires only when **both** sides resolve at **high** confidence.
   - **Guarded/gated:** flag OFF, or `tenantId` absent, or simulated missing column/table ⇒
     composition block is **skipped**, the pre-existing name-based allergy + active-e-Rx
     duplicate checks still run, and **nothing new is thrown or blocked**.
   - `{ safe, warnings, blockers }` shape unchanged; never throws.
2. Extend the signature to `validatePrescriptionSafety(patientId, medications, options = {})`
   (backwards compatible). Read `options.tenantId`. After the existing checks, add a **new
   composition block wrapped in its own try/catch**:
   - Short-circuit unless `options.tenantId` and `isCompositionSearchEnabled(tenantId)`.
   - `enrichMedicationsWithComposition(tenantId, medications)` (Task 3).
   - Composition allergy: for each enriched med with high-confidence `active_ingredients`,
     match each molecule against `getUnifiedActiveAllergies` — **reuse the existing beta-lactam
     cross-reactivity logic** (`medicationConflictsWithAllergen`, prescriptionSafetyCheck.js
     ~L172), NOT just exact molecule/allergen substring equality (verifier-flagged: a
     **penicillin** allergy must catch amoxicillin/clavulanate). Run each molecule through the
     same cross-reactivity check + `rankSeverity`; push warning/blocker with the molecule+brand
     message.
   - Same-composition duplicate: within submitted meds; vs active e-Rx (a tenant-scoped query
     resolving each active e-Rx med's `composition_id` via its `catalog_id`, or extend the
     L891 query to also surface `catalog_id`); vs active IPD orders. **Resolve the patient's
     `patient_uid` once first (verifier-flagged):** `validatePrescriptionSafety` receives the
     integer `users.id`, but `clinical_orders` are keyed by `patient_uid` (UUID) — do a single
     `users` lookup (id → uid) before the IPD query
     (`clinical_orders … patient_uid = $uid … order_type='medication' … non-terminal status …
     details->>'composition_id'`). Emit `DUPLICATE_COMPOSITION` distinct from the existing
     name-based `DUPLICATE_MEDICATION`.
3. Thread `tenantId` at the callers that matter:
   - **e-Rx:** `ePrescriptionController.js` CREATE (L912) + UPDATE (L1355) — pass
     `{ tenantId: req.tenantId }`.
   - **IPD:** `orderEntryService.createOrder` → `runCDSChecks(patient_uid, order_type, details, { tenantId })`;
     thread `tenantId` through `runCDSChecks` to its `validatePrescriptionSafety` call (and
     `drugChartService.buildSafetyByOrder` if it is on the create path). Other callers
     (canonicalClinicalPlatformService, polypharmacyAiService) may keep the 2-arg form — they
     degrade to no composition checks.

**Acceptance:** deep test green; existing prescription-safety tests still green (no behavior
change when `options.tenantId` omitted).

---

## Task 6 — Server-derived identity persistence (IPD + e-Rx)

**Why:** Spec Backend-API §4 — the drug-chart order and the e-Rx save persist server-derived
`composition_id/strength/form/strength_components/generic_name` from the tenant-scoped catalog
row, so downstream duplicate/allergy checks read reliable identity, not text-luck. **Guarded
but not flag-gated** (harmless metadata enrichment; makes an eventual flip immediately
effective on in-flight orders). A client-sent `composition_id` is never persisted as fact.

**TDD:**

1. `apps/backend/src/tests/composition-identity-persistence.deep.test.js`.
   - **IPD:** create a medication order via the CPOE path with `details.catalog_id` set (and a
     bogus `details.composition_id`). Assert the persisted `clinical_orders.details` carries
     the **server-derived** `composition_id` (from the catalog row), `strength`, `form`,
     `strength_components`, `generic_name`; the bogus client `composition_id` is overwritten.
   - **e-Rx:** create/update a prescription whose `medications[].catalog_id` is set; assert the
     stored `e_prescriptions.medications` JSONB is enriched with server-derived composition
     fields; bogus client `composition_id` overwritten.
   - **Guarded:** simulate missing column/table (or no `catalog_id`) ⇒ order/prescription still
     saves normally with no composition fields; nothing thrown.
2. **IPD (enrich BEFORE CDS — invariant #7):** in `orderEntryService.createOrder`, enrich
   `details` **before `runCDSChecks(...)`** (which runs at L639, *before* the persist), not just
   before `tx.clinical_orders.create`. When `order_type==='medication'` and `details.catalog_id`
   present, call the Task 3 resolver with the order's `tenantId`, strip any client
   `composition_id`, and merge the `COMPOSITION_IDENTITY_FIELDS` subset into `details`. Then the
   **same enriched `details`** flows into both `runCDSChecks` and the create (single L667 + bulk
   L794 — enrich each item in the bulk path too). Do the enrichment once (e.g. a step at the top
   of `createOrder` right after `normalizeOrderInput`, or inside `normalizeOrderInput` given it
   is `async` and already awaits DB). Own try/catch — failure leaves `details` untouched and the
   order still saves. Thread `tenantId` into `runCDSChecks` per Task 5.
3. **e-Rx (enrich BEFORE safety — invariant #7):** in `ePrescriptionController.js` CREATE + UPDATE,
   run `enrichMedicationsWithComposition(req.tenantId, medications)` **before**
   `validatePrescriptionSafety(...)` (L912 / L1355), and persist that **same enriched array**
   (`JSON.stringify(enriched)` at L1044 / L1391). Strip client `composition_id` (the resolver
   does). Own try/catch — failure falls back to the original array (safety + persist both use
   the fallback). The safety-checked array and the persisted array must be identical.

**Acceptance:** deep test green; existing CPOE + e-Rx tests still green.

---

## Task 7 — Substitution audit (persisted-only)

**Why:** Spec Backend-API §5 — audit on **save** when the chosen brand differs from the
originally-selected one. Exploratory panel taps are **not** audited (only persisted saves).

**TDD:**

1. `apps/backend/src/tests/composition-substitution-audit.deep.test.js`.
   - Save an e-Rx / IPD order where the med carries `original_catalog_id` (client-supplied first
     selection) **different** from the final `catalog_id`. Assert a `clinical_audit_events` row
     with `action='medication.brand_substitution'`, `resource_table` = `e_prescriptions` /
     `clinical_orders`, `before_state` = original brand+catalog+composition, `after_state` =
     final brand+catalog+composition, `actor_uid`, and `metadata.surface` (`prescription`|`drug_chart`).
   - When `original_catalog_id` is absent or equals the final `catalog_id` ⇒ **no** audit row.
   - Audit failure must not fail the save (writer already returns null on error).
2. Helper `recordBrandSubstitutionAudit({ tenantId, patientUid, encounterId, actorUid,
   actorRole, surface, resourceTable, resourceId, originalCatalogId, finalCatalogId, reason })`
   (place in the pharmacy composition service area). **Treat `original_catalog_id` and the final
   `catalog_id` as identifiers only (verifier-flagged): resolve BOTH rows tenant-scoped on the
   server** (via the Task 3 resolver) to build `before_state` (original brand name + catalog_id
   + composition_id/label) and `after_state` (final brand name + catalog_id + composition_id/label)
   — never take brand/composition text from the client. Then call `recordClinicalAuditEvent`.
   Use a deterministic `idempotencyKey`
   (e.g. `brand_sub:${resourceTable}:${resourceId}:${originalCatalogId}:${finalCatalogId}`).
3. Call it post-persist in the e-Rx CREATE/UPDATE and IPD create paths when
   `original_catalog_id` is present and differs from the final `catalog_id`. Best-effort
   (never blocks the save). If either id fails to resolve tenant-scoped, skip the audit (do not
   fabricate state).

**Acceptance:** deep test green; save paths unaffected when no substitution.

---

## Task 8 — OpenAPI: document the new route + fields; sync-core

**Why:** Spec Backend-API §7 + the OpenAPI contract pipeline invariant (run `openapi:check`
after any route add/remove).

**Steps (light TDD — the gate *is* the test):**

1. Add to `apps/backend/src/docs/openapi.json`:
   - `GET /pharmacy-orders/catalog/{id}/alternatives` (path param `id`, response schema:
     `{ alternatives: [...], groups: [...] }` with the substitutable/stock-freshness fields).
   - The additive composition fields on the existing `GET /pharmacy-orders/catalog` response
     schema.
2. Run `npm --prefix apps/backend run openapi:sync-core` then
   `npm --prefix apps/backend run openapi:check` — must pass (watch the null-in-enum Spectral
   crash + controllers-wrap-responses gotchas from prior OpenAPI work).

**Acceptance:** `openapi:check` green.

---

## Final review (after Task 8)

Dispatch a whole-slice code reviewer over the Phase-2 diff against this plan + the spec.
Confirm: invariants #1–#6 hold; no behavior change when the flag is off / `tenantId` omitted;
`validatePrescriptionSafety` still never throws; drift check + `openapi:check` + the full
backend gate (`npm run test:ci` chunked, or the relevant deep tests) green. Then run
`superpowers:finishing-a-development-branch` (merge to main, delete branch, keep hygiene).

## Coverage note (rollout gate — NOT a Phase-2 code task)

Enabling a tenant (`setCompositionSearchEnabled(tenant, true, { snapshot })`) is an
operator/evidence step gated on the Phase-1 backfill coverage report meeting the acceptance
gate (row-count ≥90% high-confidence + ≥80% strength/form on common categories; usage-weighted
≥95% of top-N dispensed; zero ambiguous injectables). On the current seed catalog (44 high / 9
medium) the gate is **not** met — the flag stays off; Phase 2 ships inert, exactly like Phase 1.
