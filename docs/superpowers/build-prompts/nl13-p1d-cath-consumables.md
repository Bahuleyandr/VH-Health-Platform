# BUILD: NL-13 P1d — Cath consumables & implants: per-case usage, batch/expiry, inventory decrement, billing hook

You are implementing **NL-13 P1d (Cath consumables & implant tracking)** for the VH Health Platform. The precedents to read FIRST and mirror: the **dialysis billing hook** (`apps/backend/src/migrations/420_dialysis_billing_hook.sql` + its service wiring — procedure completion → billing event) and the existing pharmacy/inventory rails (stock, batch, expiry). Read `_worker-common.md`, `docs/CANONICAL_CLINICAL_TIMELINE.md`, `apps/backend/CLAUDE.md`, and the merged cath P1 (`apps/backend/src/services/clinical/cathLabService.js`, migs 482–488).

**SEQUENCING: launch AFTER NL13-P1b (cath reporting) is MERGED to main** — both extend cathLabService/the staff cath workbench; running concurrently guarantees service-file conflicts. The start gate enforces this.

**Parallel-safety (once gate passes):** extends cath service/screens + touches inventory/billing services; disjoint from P1c (STEMI) and P1f; overlaps only regen artifacts with them.

## Start gate (run before anything)
```
git fetch github
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^55[5-7]_"   # P1b reporting MERGED to main
git ls-tree --name-only github/main:apps/backend/src/migrations | grep -qE "^48[2-8]_"   # cath P1 on main
```
Exit 0 → proceed. Exit 1 → STOP and report (P1b must land first).

## Workspace setup (run first, exactly this)
```bash
MAIN="D:/Dev/Projects/VH Health/VH-Health-Platform"
WT="D:/Dev/_codex/worktrees/VH-Health-Platform-nl13-p1d"
git -C "$MAIN" fetch github
git -C "$MAIN" worktree add "$WT" -b feat/nl13-p1d-cath-consumables github/main
cp "$MAIN/apps/backend/.env" "$WT/apps/backend/.env"
cd "$WT" && npm --prefix apps/backend install && npm --prefix apps/admin install
dart pub get
```

## Environment & isolation (MANDATORY)
- Shared-checkout ban; scratch-DB schema-regen law; openapi generate/check/sync-core; staff strings all five locales; dart-format-check before push; phi/schema-drift checks.
- **Your reserved migration numbers: 563–566** (in order; leave unused untaken). Siblings: P1b 555–557, P1c 558–562, P1e 567–568, P1f 569–571.
- All tables PHI-adjacent (patient-linked usage): mig-356 RLS boilerplate; explicit tenant_id.
- Proxy-allowlist + routePolicy law for any new admin `api/v1/<family>`/segment (same commit).

## Scope (deliver all)
1. **`cath_consumable_catalog`** (mig **563**) — tenant-scoped catalog of cath consumables/implants: item name, category CHECK (`stent`,`balloon`,`guidewire`,`catheter`,`sheath`,`closure_device`,`pacemaker`,`lead`,`other`), manufacturer/model, is_implant flag, **batch_tracked** flag, default unit cost reference, billing item mapping slot (owner-supplied billing code, INERT until mapped), active/retired. Link (nullable FK) to existing pharmacy/inventory item where one exists — reuse, don't fork, the inventory master.
2. **`cath_case_consumable_usage`** (mig **564**) — per case + optional procedure_log: catalog item, quantity, **batch/lot number + expiry (REQUIRED when catalog row is batch_tracked — CHECK)**, serial number for implants, used_by, wasted flag + reason (opened-not-used tracking), recorded canonical audit event. Implant rows feed the patient implant record surface where one exists (link, don't duplicate).
3. **Inventory decrement seam** (in 564 or **565**) — on usage save, decrement the linked inventory stock via the EXISTING inventory service (no parallel stock ledger); insufficient-stock warns but never blocks documentation (clinical record > stock accuracy); wastage decrements too, flagged.
4. **Billing hook** (mig **565/566** as needed) — the dialysis-hook pattern: completed procedure log + usage rows → billing events for procedure package + billable consumables (only items with owner-mapped billing codes; unmapped items surface on an "unbilled usage" report instead of silently dropping — FAIL-VISIBLE). Respects billingV2; no direct invoice mutation; goes through the existing billing-event path.
5. **Staff workbench** — usage capture on the procedure screen (scan-or-search catalog, quantity, batch/serial pickers, wastage toggle); per-case usage summary on the case view; strings all five locales.
6. **Admin** — catalog management page under an EXISTING gated segment or new segment WITH routePolicy + proxy entries; "unbilled usage" report view.
7. **Owner-decision inert slots** — billing-code mapping per item (owner supplies), unit costs (owner), which categories require batch tracking beyond the defaults (stents/implants default ON).

## Tests
- Unit: batch/expiry CHECK enforcement (batch_tracked items reject missing lot/expiry); wastage flow; unmapped-item → unbilled-report (never silent); insufficient-stock warns-not-blocks.
- Deep (real DB): catalog → case usage (implant with serial) → inventory decrement asserted → procedure completed → billing events for mapped items + unbilled report row for unmapped → canonical audit trail → RLS both directions.
- Staff widget: usage capture flow, batch picker appears only for batch-tracked items.
- Regression: existing cath P1/P1b suites green; dialysis billing hook untouched.

## Deliverable
Branch `feat/nl13-p1d-cath-consumables`, PR titled `NL-13 P1d: cath consumables & implant tracking (batch/expiry, inventory, billing hook)`. Build ledger. ALL checks green. **STOP after the PR**; one scope = one PR; no force-push after open.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `docs/superpowers/build-prompts/nl13-p1d-cath-consumables.md` and `_worker-common.md` beside it; execute EXACTLY (start gate → workspace → scope → tests). Your migration block: 563–566. STOP after opening the PR with all checks green; do not merge, do not force-push after the PR opens, do not open a second PR for the same scope. Report back with the PR number and your build ledger.
