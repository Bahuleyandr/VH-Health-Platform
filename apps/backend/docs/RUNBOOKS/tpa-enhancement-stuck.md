# Runbook — TPA enhancement chain stuck or cap-alert missing

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P2 (degraded TPA workflow — clinician can't submit
enhancement, finance can't project caps, or live-bill alert isn't
firing. No patient-safety surface.)

The TPA enhancement workflow landed across Wave 2.4 (commits
`97c4e427`, `d0625c28`, `7174f7a5`, `ee2971d4`, `3ad6b93b`). Read
`apps/backend/CLAUDE.md` → "Insurance claim tables are deliberately
split" first — `insurance_claims` (legacy billing) and `tpa_claims`
(Sprint 5 cashless workflow) are **distinct concepts**, and enhancement
flows live on `insurance_preauth.parent_preauth_id` with
`request_type='enhancement'` (not as a child row in either claim
table).

## Symptoms

- Clinician reports: `POST /api/v1/admissions/:admissionId/tpa-enhancement`
  returns 500 — error message is generic.
- Patient TPA portal shows the wrong cumulative-approved total.
- Finance reports: bill is at ₹X, TPA cap is at ₹Y < X, but no
  `clinical_alerts` row of severity ≥ WARNING fired.
- Admin TPA desk reports: partial-approval form submits but the
  enhancement child preauth shows `response_type='approved'` not
  `partially_approved`.

## Mental model

Routes:

- `/api/v1/admissions/:admissionId/tpa-enhancement` (commit `d0625c28`)
  — clinician-facing chart route. Resolves the parent preauth from the
  admission, delegates to `claimsService.createPreauth` with
  `request_type='enhancement'`.
- `/api/v1/insurance/preauth/:id` — admin/billing detail. Folds in
  `cumulative_approved` / `cumulative_requested` / `root_preauth_id` /
  `chain_length` from `claimsService.chainTotalsFor` (commit `7174f7a5`).
- `/api/v1/insurance/claims/:id/caps` — cap CRUD with the table-split
  resolver (migration 197).
- TPA cap-proximity alert emission lives in
  `billingV2Service.maybeEmitTpaCapAlerts` (commit `ee2971d4`),
  triggered from `recomputeInvoiceTotals` (item add/remove/discount) and
  `issueInvoice` (DRAFT → ISSUED).

Alert thresholds: WARNING at 80% utilisation, CRITICAL at 100%.
Idempotent per (admission_id, severity) — won't double-emit if a prior
alert is unacknowledged.

## Investigation steps

### 1. Establish which surface failed

Find the most recent enhancement request for the named admission:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT ip.id, ip.parent_preauth_id, ip.request_type,
           ip.status, ip.response_type, ip.expected_cost,
           ip.sanctioned_amount, ip.conditions,
           ip.submitted_at, ip.tenant_id,
           a.id AS admission_id, a.patient_uid
    FROM insurance_preauth ip
    JOIN admissions a ON a.patient_uid = ip.patient_uid
    WHERE a.id = <ADMISSION_ID>
    ORDER BY ip.submitted_at DESC NULLS LAST
    LIMIT 10;"
```

The **root preauth** has `parent_preauth_id IS NULL` and
`request_type='initial'`. Children have `parent_preauth_id` pointing at
the root and `request_type='enhancement'`.

### 2. Failed enhancement create

`POST /admissions/:admissionId/tpa-enhancement` returning 500 — check
the backend log for the Postgres-error-code line that
`billingService.createEnhancementClaim` (`97c4e427`) emits on the catch
path:

```bash
kubectl -n vhhealth logs deployment/vhhealth-backend --since=15m \
  | grep -i "enhancement\|preauth\|TPA_CLAIM\|tpa_claim_id" \
  | head -40
```

Common failures:
- **`23505 — duplicate key violates unique constraint`** — two
  concurrent enhancement requests both allocated `-E1` on the same
  parent's `claim_number`. `billingService.createEnhancementClaim`
  wraps the allocation + insert in a `$transaction` (commit
  `97c4e427`); the wrap was added specifically for this race. If still
  seeing it, the wrap may have regressed — `git log -p
  apps/backend/src/services/billing/billingService.js | head -40`.
- **`23503 — foreign key violation on policy_id`** — the parent's
  `insurance_policies.id` was deleted. Restore the policy row or
  refuse the enhancement at the route layer.
- **`22001 — value too long for type character varying(30)`** — the
  parent `claim_number` exceeded 26 chars and the suffix `-E<n>`
  pushed the result past 30. `createEnhancementClaim` clamps the
  parent to 26 chars defensively — confirm the clamp is still there.

### 3. Wrong cumulative-approved on TPA portal

The cumulative computation is `claimsService.chainTotalsFor`. Sample
its math by hand:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    WITH RECURSIVE chain AS (
      SELECT id, parent_preauth_id, expected_cost, sanctioned_amount,
             response_type, request_type
      FROM insurance_preauth
      WHERE id = <ROOT_PREAUTH_ID>
      UNION ALL
      SELECT p.id, p.parent_preauth_id, p.expected_cost, p.sanctioned_amount,
             p.response_type, p.request_type
      FROM insurance_preauth p
      JOIN chain c ON p.parent_preauth_id = c.id
    )
    SELECT
      COUNT(*) AS chain_length,
      SUM(expected_cost) AS cumulative_requested,
      SUM(CASE
            WHEN response_type IN ('approved', 'partially_approved')
            THEN COALESCE(sanctioned_amount, expected_cost)
            ELSE 0
          END) AS cumulative_approved
    FROM chain;"
```

Compare to what `GET /api/v1/insurance/preauth/:id` returns. If they
disagree, the chain may have a row with
`response_type='partially_approved'` but `sanctioned_amount IS NULL`
— the SUM falls back to `expected_cost` which over-counts. Fix the
sanctioned_amount column on that row via the TPA desk UI partial-
approval form (NOT a raw UPDATE — the audit log needs the
acknowledged-with-reason path).

### 4. Cap-proximity alert not firing

The alert is best-effort and may be silently catching an error.
Confirm the most recent invoice update for the admission:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT bi.id, bi.status, bi.total_charged, bi.admission_id,
           bi.updated_at
    FROM billing_invoices bi
    WHERE bi.admission_id = <ADMISSION_ID>
    ORDER BY bi.updated_at DESC
    LIMIT 5;"
```

Then check what TPA cap the admission resolves to:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT icc.id, icc.claim_id, icc.tpa_claim_id, icc.category,
           icc.max_amount, tc.id AS tpa_claim_id_resolved,
           tc.policy_id
    FROM insurance_claim_caps icc
    LEFT JOIN tpa_claims tc ON tc.id = icc.tpa_claim_id
    LEFT JOIN insurance_preauth ip ON ip.id = tc.preauth_id
    JOIN admissions a ON a.patient_uid = ip.patient_uid
    WHERE a.id = <ADMISSION_ID>
      AND icc.category IN ('room_rent', 'overall')
    ORDER BY icc.created_at DESC;"
```

Compute utilisation = `total_charged / max_amount`. If ≥ 80% but no
`clinical_alerts` row exists with `category='TPA_CAP_ALERT'`:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT id, severity, category, patient_id, admission_id,
           acknowledged_at, created_at, message
    FROM clinical_alerts
    WHERE admission_id = <ADMISSION_ID>
      AND category = 'TPA_CAP_ALERT'
    ORDER BY created_at DESC
    LIMIT 5;"
```

If no rows, look at the backend log for `maybeEmitTpaCapAlerts`'s
catch path — it logs but doesn't throw. Common silent failures:
- `clinical_alerts.patient_id` is INT; the helper resolves
  `users.uid` → `users.id` via a lookup. If the lookup fails
  (race-condition on a freshly-created admission), the alert insert
  fails silently. Re-issue the invoice via the normal flow to
  re-trigger.
- The idempotency-per-(admission, severity) guard may have a stale
  unacknowledged alert blocking new ones. Verify by querying for
  unacknowledged rows at the SAME severity.

### 5. Partial-approval shows as 'approved'

Admin TPA desk form sends `response_type` + `sanctioned_amount` +
`conditions` to the standard `claimsService.respondToPreauth`
endpoint. If the form submits and the backend stores
`response_type='approved'` instead of `'partially_approved'`:

- Check the admin commit `3ad6b93b` is still on `main` and the
  `PreauthTab.tsx` "Partial" button is wired to send the right value
  (validated: positive amount, must be < `expected_cost`).
- Backend should reject `partially_approved` with a sanctioned amount
  >= expected_cost (that would be a full approval). If it accepts
  silently, the form is sending the wrong shape.

## Action

- 500 on enhancement create → bisect from §2, restart backend if the
  in-flight prisma client got into a bad state.
- Wrong cumulative → fix the bad preauth row via the TPA desk partial-
  approval flow, not a raw UPDATE.
- Missing cap alert → re-trigger via the invoice flow, audit-log the
  reason.
- Wrong response_type → check admin commit `3ad6b93b` parity.

## Post-incident

- [ ] Add a row to `docs/incidents/tpa-enhancement-$(year).md`: admission
      id (anonymized), root cause, remediation.
- [ ] If a 500 was caused by a stale prisma client → file a tooling
      ticket (the prestart `db:generate` hook should have caught it).
- [ ] If cap alert silently failed → file a `clinical-safety`-adjacent
      ticket to bubble the error up to ops (alerts should fail-loud,
      not fail-silent, for cap proximity).
- [ ] NEVER raw-UPDATE `insurance_preauth.sanctioned_amount` to "fix"
      a chain — the audit chain requires the partial-approval-with-
      conditions HTTP path.
