# BUILD: NL-5 P3 — Order-set / pathway content studio

**Spec:** `docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md` §3 + §Phased Plan P3. Read it fully, plus `_worker-common.md` (all rules apply). The safety cornerstone: `applyOrderSet` → `createOrder` → `runCDSChecks` stays the ONLY path — the studio changes which rows are pickable, never how orders are created.

## Start gate
```
git fetch github
git grep -q "Order-Set / Pathway Content Studio" github/main -- docs/superpowers/specs/2026-07-06-nl5-terminology-content-studio-design.md
```

## Workspace
Worktree `VH-Health-Platform-nl5-p3`, branch `feat/nl5-p3-content-studio`. Backend + admin (`npm --prefix apps/admin install`).

## Scope (spec §3.2–3.5)
1. **Governance schema** (2 migrations from your assigned block): new columns on `clinical_order_sets` — `family_key` (backfill = code), `version` default 1, `status` CHECK draft|in_review|approved|retired **DEFAULT 'approved'** (grandfathers existing rows — the mig-311 trick), `approved_by/at`, `review_note`, `superseded_by` FK, `source` authored|imported, `import_batch_id`; partial unique index = exactly one non-retired approved+active `(tenant_id, family_key)`. Companion tables: `order_set_review_events` (append-only, tenant RLS), `order_set_import_batches` (mig-311 clone), `content_studio_settings` (tenant flag, mig-351 pattern — studio fully inert until enabled per tenant).
2. **Lifecycle**: draft → in_review → approved(deployed) → retired. Approved sets are IMMUTABLE — editing clones a new version row into draft; approving retires the predecessor (`superseded_by`) in the same tx. Rollback = retire current + re-activate predecessor, one audited admin action.
3. **Enforcement (small, targeted)**: `getOrderSets` adds `status='approved'` beside the existing active filter; `applyOrderSet` same guard + stamps `order_set_family`/`order_set_version` into each created order's JSONB details (no schema change on clinical_orders); `createOrderSet` becomes the author entry point (draft when the tenant flag is on; grandfathered approved when off). Item-payload validation at save/approve: reuse `orderRequestFromItem` kind mapping + `VALID_ORDER_TYPES`; soft-validate codings via `terminologyService.validateCode` — warnings to the approver, only structural invalidity blocks. Approval never runs patient CDS.
4. **Roles**: `ORDER_SET_AUTHOR_ROLES` (DOCTOR+ADMIN/SUPER_ADMIN), `ORDER_SET_APPROVER_ROLES` (ADMIN/SUPER_ADMIN + QUALITY_OFFICER + designated senior clinician); med-containing sets need a second PHARMACY_INCHARGE review event before approval; self-approval rejected server-side.
5. **Routes** under `/api/v1/emr/orders/sets/*` extensions of `orderRoutes.js` (list-for-studio incl. drafts, submit, approve, reject, retire, rollback, import) with `wrapAutoRBAC`; composer-facing `GET /emr/orders/sets` shape unchanged. OpenAPI regen mandatory.
6. **Import**: `vh-order-set/1` JSON format exactly as spec §3.5 (codings in item payload JSONB; `phases[]` wrapper = pathway content); `scripts/order-set-import.mjs` (dry-run, per-tenant, batch provenance, always lands draft); small reviewable starter pack under `docs/content/order-sets/` (no licensed content — that's why this format is repo-safe).
7. **Admin studio UI**: author/review queue page. Composer untouched except the picker transparently shows only deployed versions.

## Tests
Full lifecycle walk (draft→review→approve→deploy→new version→rollback) asserting exactly-one-deployed-per-family, immutability, event-log completeness; `applyOrderSet` refuses draft/retired + stamps provenance; **CDS non-bypass regression** — a deployed set containing a contraindicated med for a seeded allergic patient still produces the CDS blocker through apply AND the composer bulk path (extend `cpoe-cds-fail-closed.deep.test.js` + `orderSetItemRouting.test.js`); import dry-run/idempotency/dark-landing; tenant isolation on all new tables.

## Deliverable
PR `NL-5 P3: order-set content studio (lifecycle, import, governance)` with build ledger. Migrations: **2**. Stop after the PR.

## Kickoff line
> You are a build worker for the VH Health Platform. Read `D:\Dev\Projects\VH Health\VH-Health-Platform\docs\superpowers\build-prompts\nl5-p3-content-studio.md` and `_worker-common.md` beside it; execute EXACTLY. Your migration block: <ASSIGN>. STOP after opening the PR; report PR number + build ledger.
