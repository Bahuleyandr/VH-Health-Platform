# Runbook — Cashier shift-close drawer reconciliation stuck

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P2 (degraded billing — cashier can't close out their
shift, but no patient-safety surface).

The cash-drawer reconciliation surface landed in commit `7aa0d5a2`
(Wave 2.2, migration 198). A cashier opens a session at shift start,
records every cash transaction during the shift, and at close time
submits a counted denomination breakdown. The service computes
`system_total` from `billing_payments` where `mode=CASH` and the
cashier/shift match, derives `variance = counted_total - (system_total
+ opening_float)`, and either auto-reviews (variance within tolerance)
or stays at `requires_review=true` until a `FINANCE_INCHARGE` / `ADMIN`
/ `SUPER_ADMIN` signs off.

## Symptoms

- Cashier reports: "POST /cash-drawer/sessions/:id/close returns 500
  and my shift won't close"
- Cashier reports: "Variance shows ₹0 but I'm definitely short / over"
- Reviewer reports: "POST /cash-drawer/sessions/:id/review returns 403
  for a user I expect to have the role"
- Audit shows a `cash_drawer_sessions` row stuck at `status='closed'`
  with `requires_review=true` for > 24h

## Mental model

Routes (`apps/backend/src/routes/billing/billingV2Routes.js`):

- `POST /api/v1/billing/v2/cash-drawer/sessions/open` — `requireStaffOrAdmin`
- `POST /api/v1/billing/v2/cash-drawer/sessions/:id/close` —
  `requireStaffOrAdmin`
- `POST /api/v1/billing/v2/cash-drawer/sessions/:id/review` —
  `requireCashDrawerReviewer` (FINANCE_INCHARGE / ADMIN / SUPER_ADMIN)
- `GET /api/v1/billing/v2/cash-drawer/sessions` + `:id` — list + detail

Service (`apps/backend/src/services/billing/cashDrawerService.js`)
applies the Phase 0 / 1 / 1.5 / 2 transaction shape (see
`apps/backend/CLAUDE.md` → Key Architecture Decisions).

Partial unique index on `(cashier_uid, shift) WHERE status='open'`
enforces "one open session per cashier per shift" — re-opening before
closing the prior session fails with a unique-constraint error.

## Investigation steps

### 1. Find the offending session

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT id, cashier_uid, shift, opened_at, closed_at, status,
           opening_float, counted_total, system_total, variance,
           short_count, over_count, requires_review,
           reviewed_by, reviewed_at
    FROM cash_drawer_sessions
    WHERE status IN ('open', 'closed')
      AND opened_at > NOW() - INTERVAL '48 hours'
    ORDER BY opened_at DESC
    LIMIT 20;"
```

Note the session `id` and `cashier_uid` for the stuck row.

### 2. Cross-check the computed system_total

The service computes `system_total` as the SUM of `billing_payments`
where `mode='CASH'`, the same `cashier_uid`/`shift`, and `created_at >=
opened_at`. Re-run that query:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT COUNT(*) AS txn_count, COALESCE(SUM(amount), 0) AS expected_system_total
    FROM billing_payments
    WHERE mode = 'CASH'
      AND cashier_uid = '<CASHIER_UID>'::uuid
      AND created_at >= '<OPENED_AT>'::timestamptz
      AND (closed_at IS NULL OR created_at < '<CLOSED_AT>'::timestamptz);"
```

If `expected_system_total` ≠ `system_total` from §1, the session was
closed against a stale snapshot OR new payments were back-dated into
the closed-shift window after close. Look at
`billing_payments.created_at` and compare to `cash_drawer_sessions.closed_at`.

### 3. Check the reviewer-role on the stuck reviewer

If §1 shows a row at `status='closed'` + `requires_review=true` and
the named reviewer can't sign off:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT u.uid, u.name, u.role, s.is_active, s.employee_id
    FROM users u
    LEFT JOIN staff s ON s.user_id = u.uid
    WHERE u.uid = '<REVIEWER_UID>'::uuid;"
```

`requireCashDrawerReviewer` accepts roles `FINANCE_INCHARGE`, `ADMIN`,
`SUPER_ADMIN` only. If the named user is `BILLING_STAFF` or `CASHIER`
they will 403. Re-route to a qualifying user OR escalate to admin for
a role grant (separate process, not in this runbook).

### 4. Stuck `requires_review` with the variance inside tolerance

The tolerance comes from `VH_CASH_DRAWER_VARIANCE_TOLERANCE_INR` env
(default ₹50 — confirm with the actual deploy). If the variance from
§1 is below tolerance but `requires_review=true`, the service may have
flipped the flag during an earlier mid-close retry. Confirm by:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT id, variance, requires_review,
           ABS(variance) <= 50 AS within_default_tolerance
    FROM cash_drawer_sessions
    WHERE id = <SESSION_ID>;"
```

If `within_default_tolerance=t` but `requires_review=t`, file an audit
note and have the FINANCE_INCHARGE issue a `/review` POST with
`approve=true` + `note='auto-tolerance-misflag-postmortem-<incident_id>'`.
**Do not** UPDATE the row directly — the audit chain requires the
HTTP path.

### 5. Drawer won't OPEN — partial-unique violation

If a cashier reports they can't open a session because of a unique-
constraint error, an earlier session for the same `(cashier_uid,
shift)` is still `status='open'`:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT id, cashier_uid, shift, opened_at, status
    FROM cash_drawer_sessions
    WHERE cashier_uid = '<CASHIER_UID>'::uuid
      AND status = 'open'
    ORDER BY opened_at DESC;"
```

Have the cashier close the prior session via the normal `/close` flow
with their actual end-of-prior-shift count. **Don't** bulk-UPDATE
`status` — the variance + counted-denominations must come from the
cashier's count, not the on-call's keyboard.

## Action

- Variance dispute → escalate to FINANCE_INCHARGE for the `/review`
  decision. Document in `audit_logs`.
- Stale snapshot (back-dated payment) → file `clinical-safety`-adjacent
  ticket for the billing flow that allowed back-dating; correct the
  cashier's counted-total + re-close.
- Reviewer-role 403 → escalate to admin, not patched here.
- Stuck partial-unique → cashier closes prior session per §5; never
  raw UPDATE.

## Post-incident

- [ ] Add a row to `docs/incidents/cash-drawer-issues-$(year).md`:
      session id, cashier (anonymized), variance, root cause,
      remediation.
- [ ] If variance ≥ ₹10,000, page on-call finance per
      `docs/qa/MODES.md` — financial-incident channel.
- [ ] If the same cashier triggers ≥ 3 review-required closes in 30
      days, raise a training ticket.
- [ ] NEVER bulk-UPDATE `cash_drawer_sessions` to bypass the review
      gate — auditors require the per-row reviewer signature.
