# W2 — DB Schema Multi-Tenancy Completeness (design)

- **Date:** 2026-06-19 · **Wave:** 2 of the [multi-tenancy program](2026-06-19-multi-tenancy-program-design.md).
- **Status:** Design — drafted while the W1 gate runs; refine + confirm current max migration number before implementing.
- **Branch:** `feat/multi-tenancy-program`.
- **Depends on:** independent of W1 at the schema level, but W1's fail-closed resolution is what makes the new columns *enforced* in practice. Coordinates with W4 (per-tenant login) for the patient-identity change.

## Objective

Every tenant-owned table carries `tenant_id` + `ENABLE`/`FORCE ROW LEVEL SECURITY` + a `tenant_isolation` policy + the GUC-reading `tenant_id` DEFAULT (mig-310 pattern), and **every human-facing identifier is unique per tenant**. Patient identity becomes per-tenant (§8.1). `admins` becomes tenant-bound for `ADMIN` (§8.2). Audit/activity logs get `tenant_id` (§8.4). After W2 there are no tenant-owned-in-spirit tables left unisolated and no global-unique constraint that breaks on tenant #2.

## Migration discipline (unchanged house rules)

- Bare DDL `src/migrations/NNN_*.sql`, single transaction, **no `CONCURRENTLY`**, **safe on existing data** (dup-precheck `DO` blocks + `RAISE`). Current max is **327** (audit remediation) → W2 starts at **328** (verify with `ls src/migrations | tail`).
- After each migration: `prisma db pull` (as `qa_writer`) + `node scripts/check-schema-drift.mjs` → drift clean. Regenerate `000_baseline.sql` only via the documented pgvector docker path if needed.
- Existing prod data is single-tenant (everything is the literal default tenant), so backfilling `tenant_id = DEFAULT` and making uniques `(tenant_id, col)` is **safe** — no collisions in current data.
- The chunked-as-postgres gate must run on a **rebuilt** QA DB (new migrations) — full reset recipe in [[tools_vhhealth_qa_cluster]].

## The two reusable patterns

**(A) Add tenant isolation to a table** (mirror migration 236/310/304):
```sql
ALTER TABLE <t> ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE <t> SET tenant_id = COALESCE(tenant_id, <backfill source>) WHERE tenant_id IS NULL;
-- backfill source: linked users.tenant_id via patient_uid/uid, or parent FK's tenant_id,
-- else the literal default '00000000-0000-4000-8000-000000000001'.
ALTER TABLE <t> ALTER COLUMN tenant_id SET DEFAULT
  COALESCE(NULLIF(NULLIF(current_setting('app.current_tenant_id', true),''),'bypass')::uuid,
           '00000000-0000-4000-8000-000000000001'::uuid);
ALTER TABLE <t> ALTER COLUMN tenant_id SET NOT NULL;            -- after backfill
ALTER TABLE <t> ADD CONSTRAINT <t>_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t>
  USING (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  )
  WITH CHECK (
    current_setting('app.current_tenant_id', true) IS NULL
    OR current_setting('app.current_tenant_id', true) = ''
    OR current_setting('app.current_tenant_id', true) = 'bypass'
    OR tenant_id = public.app_current_tenant_id_uuid()
  );
```
(Confirmed against migrations 304/316 + the `public.app_current_tenant_id_uuid()` helper in 000_baseline. This is the canonical permissive-when-unset / bypass-aware policy used platform-wide.)

**(B) Tenant-scope a global unique** (safe on single-tenant data):
```sql
ALTER TABLE <t> DROP CONSTRAINT <existing_global_unique>;
ALTER TABLE <t> ADD CONSTRAINT <t>_tenant_<col>_key UNIQUE (tenant_id, <col>);
```
For append-only/audit tables, prefer a partial/standard unique that includes `tenant_id`; never drop an index a hot path depends on without re-adding the tenant-scoped equivalent.

## Scope, grouped into migrations (≈9)

Source of truth = the 2026-06-19 schema audit (Agent 1). Each migration is independently gated.

- **328 — `payment_transactions` (BLOCKER).** Pattern A. Legacy money table, no `tenant_id` today (`000_baseline.sql:14008`); backfill via `invoice_id → invoices.tenant_id`.
- **329 — document-number uniques → per-tenant (BLOCKER + HIGH).** Pattern B on tables that ALREADY have `tenant_id`: `invoices.invoice_number`, `billing_invoices.invoice_number`, `appointments.visit_no` (`217:18`), `insurance_claims.claim_number`, `tpa_claims.claim_number`, `pmjay_cases.case_number`, `insurance_preauth.preauth_number`, `referrals.referral_number`, `investigation_bookings.booking_number`, `clinical_orders.order_number`, `ward_indents.indent_number`, `incident_reports.report_number`, `quality_incidents.incident_number`, `staff_grievances.grievance_number`, `advance_deposits.receipt_number`, `attendant_passes.pass_number`, `or_rooms.code`, `or_procedure_catalog.procedure_code`, `clinical_order_sets.code`, `billing_service_master.code`, barcodes (`investigations.sample_barcode`, `pharmacy_orders.pack_barcode` — verify they aren't tenant-prefixed-by-construction first).
- **330 — payroll/salary cluster (HIGH, PII).** Pattern A: `payslips`, `payroll_runs`, `staff_salary`, `salary_advances/arrears/revisions`, `leave_encashments`, `full_final_settlements`, `advance_deductions`, `annual_tax_summaries`, `investment_declarations`, `bulk_revision_jobs`, `billing_invoice_items`, `billing_advance_settlements`. Backfill via `staff`/`invoices`. Then Pattern B: `payroll_runs(month,year)` → `(tenant_id,month,year)`.
- **331 — top-level patient PHI (HIGH).** Pattern A: `consultations` (`:7422`), `health_records` (`:9502`), `sos_alerts` (`:16225`) — keyed only by uid/phone today; backfill via `users.tenant_id`.
- **332 — clinical directory / facility config (HIGH).** Pattern A: `staff` (`:16268`), `doctors` (`:8287`), `departments` (`:7704`), `wards` (`:18188`). Add a real unique on `staff.employee_id` → `(tenant_id, employee_id)`; `departments.name` → `(tenant_id, name)`.
- **333 — per-tenant patient identity (§8.1).** Pattern B on `users`: `(tenant_id, phone)`, `(tenant_id, firebase_uid)`, `(tenant_id, email)` replacing the global uniques (keep `uid` global PK). Pattern A on the phone-keyed global-auth tables: `otp_sessions`, `otp_logs`, `password_reset_otps`, `user_sessions`/`user_active_sessions` (add `tenant_id`; `totp_challenges`/`invalidated_tokens` stay global). **⚠ Coordinate with W4** — once `(tenant_id, phone)` is unique, login MUST supply the tenant (the per-tenant build/subdomain does; W4 wires the exchange). Until W4 lands, single-tenant login is unaffected (all rows = default tenant).
- **334 — `admins` tenant-binding (§8.2).** Add nullable `tenant_id` (null = platform `SUPER_ADMIN`, non-null = tenant `ADMIN`); make admin identity uniques per-tenant for non-null tenant (partial unique `WHERE tenant_id IS NOT NULL`). RLS optional here (admins is platform-managed) — at minimum the column + uniqueness; decide policy vs app-enforcement during impl.
- **335 — audit / activity logs (§8.4).** Pattern A (column + backfill + RLS) **preserving append-only** (mig-324 guards): `medical_activity_logs`, `pharmacy_activity_logs`, `file_access_logs`, `file_metadata`, `audit_logs`, `audit_log`, the other `*_activity_logs`, `notification_outbox`. SUPER_ADMIN cross-tenant audit reads via the audited bypass. Verify the append-only triggers tolerate the new column.
- **336 — MEDIUM tail.** HR/staff-ops (attendance/shifts/roster/leave/overtime/geofence/anomalies), housekeeping cluster, config (`investigation_templates`, `investigation_template_tests`, `pharmacy_catalog`, `notification_templates`), `staff_devices`/`staff_auth_sessions`, and the document/serial uniques on these (`housekeeping_*.request_number/log_number`, `leave_types.leave_type`, `salary_revisions.revision_number`, `data_breaches.breach_id`). Consider `tenant_id` on Group-C child tables or confirm parent-join is enforced (`chemo_protocol_drugs` RLS was explicitly skipped — add it).

**Do NOT scope (global by design):** `tenants`, terminology/ICD catalogs, drug KB, `clinical_ai_modules` catalog, `totp_challenges`, `invalidated_tokens`, `_migrations`, `interop_replay_guard`, `feature_flags`.

## Testing & gate

- Extend the **2-tenant isolation deep suite**: seed tenant A + B; for each newly-isolated table assert (a) a tenant-A session cannot read/write tenant-B rows, (b) tenant B can create a document whose number already exists in tenant A (no `23505`), (c) SUPER_ADMIN bypass still reads cross-tenant.
- `check:phi-tenant-id` allowlist must stay empty; `check:no-default-tenant-fallback` stays clean.
- Per migration: `check-schema-drift` clean; the chunked-as-postgres gate green on a rebuilt DB.
- The `check-phi-tenant-id` guard may newly require these tables — update its expectations as they land.

## Risks

- **Backfill correctness** — a wrong backfill source mis-assigns rows. Single-tenant data → all default, so safe today; write the backfill so it's correct for the eventual multi-tenant data too (join to the authoritative parent).
- **FORCE RLS on parent-joined child tables** — a direct query not joining the isolated parent becomes RLS-filtered by its own (new) `tenant_id`; ensure backfill populates it.
- **Unique-constraint swaps** — must re-add the tenant-scoped equivalent in the same migration; check no FK/index depends on the dropped constraint name.
- **Append-only audit tables** (335) — the mig-324 triggers must tolerate the new column; test an audit write after the migration.
- **Patient-identity (333)** is the highest-coordination item — it changes login semantics once W4 lands; keep it behind the same single-tenant-safe backfill and verify the existing login deep tests stay green (all default-tenant).

## Done-criteria

1. Migrations 328–336 applied; `check-schema-drift` clean; `check-phi-tenant-id` allowlist empty.
2. 2-tenant isolation suite covers every newly-isolated table; chunked-as-postgres gate green on a rebuilt DB.
3. No global-unique-that-breaks-on-tenant-2 remains (the §3a/§3b audit list cleared).
4. ff `main` (local, HOLD); program memory + spec wave-status updated; on to W3.
