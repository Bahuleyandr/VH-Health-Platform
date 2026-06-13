# Change Management — VH Health Platform

**Created:** 2026-06-13
**Owner:** Platform lead
**Applies to:** All changes to `main` affecting deployed services (backend, infra, Flutter apps, admin).

This is a lightweight CAB-lite process appropriate for a single-team clinical platform.
It exists to ensure production PHI systems have an audit trail of significant changes,
a rollback plan, and evidence that testing occurred.

---

## 1. Change classes

| Class | Examples | Approval | Lead time |
|---|---|---|---|
| **Standard** | Routine bug fix, dependency bump, doc edit, test addition | Committer self-approves; gates pass | Zero |
| **Normal** | New feature, schema migration, config change, infra update | Committer + one async review (PR comment or session note) | 1 business day |
| **Significant** | Multi-table schema change, new RBAC role, new external integration, monitoring/alerting change, feature-freeze waiver | Committer + explicit change record below + full CI gate green | 2 business days |
| **Emergency** | Incident response: prod-down, active PHI leak, critical CVE | Committer; document in change log within 24 h of resolution | Zero |

Clinical AI changes (enabling a module for production use, changing governance thresholds,
modifying approval workflows) are always **Significant** regardless of code size.

---

## 2. Significant/Emergency change record

For each Significant or Emergency change, append a row to §5 (Change log) with:

| Field | Notes |
|---|---|
| **Date** | YYYY-MM-DD |
| **Type** | Significant / Emergency |
| **Title** | One line |
| **Batch/ADR** | Link to ADR or roadmap batch if applicable |
| **What merged** | Brief description (commits, migration numbers, routes affected) |
| **Rationale** | Why this change, why now |
| **Risk** | Identified risks and mitigations |
| **Rollback** | How to reverse if needed |
| **Gate** | What CI/test evidence exists (`test:ci` chunk count, specific tests, manual verification) |
| **Approver** | Who approved (for solo projects: committer + "self-approved, no other reviewers") |

---

## 3. Rollback procedures

### Backend

```bash
# Identify the last-known-good commit
git log --oneline -20

# Revert on main (prefer revert over reset to preserve history)
git revert <bad-commit-sha> --no-edit
git push origin main

# If schema migration is involved, run the down-migration (if one exists)
# or apply the archived pre-migration schema dump:
#   apps/backend/src/migrations/<NNN>_<name>.sql.bak (if present)
# Contact: platform lead before reverting any migration in prod.
```

### Infra / k8s

ArgoCD GitOps: revert the offending commit in `infra/kubernetes/` and ArgoCD
will converge back to the prior state on the next sync cycle (typically < 2 min).

```bash
git revert <bad-commit-sha> --no-edit
git push origin main
# Then in ArgoCD: sync the affected Application
```

### Flutter apps

Apps are distributed via Firebase App Distribution (staging) and Play Store (prod).
If a bad build is pushed:
- Staging: re-deploy the prior build artifact from Firebase App Distribution.
- Production: initiate a Play Store rollout halt + re-publish the prior version.
  (See `docs/DEPLOYMENT_GUIDE.md` §Release rollback.)

---

## 4. Feature-freeze policy

When a feature freeze is declared (typically at a milestone gate):

- All `main`-bound work is restricted to: bugs surfaced by the active quality gate,
  dependency security patches, doc fixes.
- Any waiver (merging feature work during a declared freeze) is a **Significant** change
  and must be logged in §5 with explicit rationale.
- Freezes are lifted when the milestone condition is met (e.g. all CI journey tests green).

---

## 5. Change log

Newest first.

---

### 2026-06-13 — S-tier roadmap: WS0–WS8 batch sequence initiated

**Type:** Significant (multiple sub-changes; summary record)
**ADR/Batch:** `docs/S_TIER_ROADMAP.md`; ADR-001 through ADR-005

**What merged (WS0, landed 2026-06-13):**
- `fix(security)`: hash admin password-reset OTP + attempt lockout (SEC-1, B0.3)
- `fix(security)`: staff refresh requires type=refresh + jti blacklist (SEC-2, B0.4)
- `fix(emr)`: canonical clinical-timeline writes atomic (BA-1, B0.5)
- `fix(infra)`: non-superuser DB role + wire image-signature gate (INF-4/8/1/2, B0.2/B0.6)

**WS1 (landed 2026-06-13):**
- `fix(db)`: full multi-tenant RLS policy coverage on 283 tables (DB-1, B1.1/B1.2)
- `fix(security)`: tenant-scope login identity + denied-PHI audit + OTP/CSRF (SEC-5/6/7/8, B1.6)
- `fix(db)`: tenant-scope interactive transactions + replica-aware setTenant (SEC-3, B1.3)
- `test(rls)`: blocking cross-tenant HTTP gate (B1.4)
- `feat(security)`: envelope/KMS field encryption + rotation (SEC-4, B1.5)
- `docs(security)`: pen-test readiness pack + controls self-assessment (B1.7)

**WS2 (partial, 2026-06-13):**
- `feat(infra)`: deploy monitoring/alerting via GitOps + Watchdog (REL-1, B2.1)
- `fix(infra)`: ingress security headers, admin IP allowlist, Vault TLS, Ollama non-root (INF-3/9/10/11)
- `fix(reliability)`: HTTP server timeouts + app-layer statement_timeout (REL-4/DB-2, B2.4/B2.8)

**WS6 (partial, 2026-06-13):**
- `feat(mobile)`: PHI hardening — screenshot block, encrypted storage, clipboard clearance (B6.1)
- `fix(patient)`: App Check, _isLoading guard, push-route allowlist (B6.2)
- `fix(admin)`: dev-gate fetch handle, ROLE_RANK consolidation, DataTable a11y (B6.3)
- `fix(staff)`: structured override-reason for MAR 5-rights + CDS allergy blocker (STF-2, B6.4)

**Rationale:** Platform audit (2026-06-13) scored overall B−. WS0 criticals were
deploy-blockers; WS1/WS2/WS6 items directly addressed PHI-safety and reliability gaps.
All batches ran with local `test:ci` gates green before merge.

**Risk:** Large migration surface (283 tables). Mitigated by blocking cross-tenant
CI gate + `logTenantRlsRolePosture()` health check.

**Rollback:** Each WS batch is a separate `--no-ff` merge commit; can be individually
reverted. Schema migrations: down-migrations are not shipped; restore from WAL/PITR
backup if a migration causes prod data issues.

**Gate:** `test:ci` 58/58 chunks green on combined tree post-merge. RLS cross-tenant
gate green. Flutter analyze + test green. Admin type-check green.

**Approver:** Bahuleyandr (self-approved; solo project, no other reviewers).

---

### 2026-06-10 — Pillar A–G feature work (see ADR-005)

**Type:** Significant (feature-freeze waiver)
**ADR:** [ADR-005](adr/ADR-005-pillar-a-g-feature-work-during-freeze.md)

**What merged:** Pillar A (reliability), B (clinical loops), C (interoperability),
D (missing modules), E (experience parity), F (analytics warehouse), G (outcome scoreboard) +
D5 (infection control, ICD-11). ~561 commits, ~300 migration files, ~7 new service domains.

**Rationale:** Swarm quality gate had been stopped 21 days; freeze instrument was dead.
Pillar work fixed underlying blocker bugs the swarm had surfaced. Feature freeze formally
superseded by S-tier roadmap (created 2026-06-13).

**Risk:** Large surface area; potential for missed test coverage. Mitigated by per-pillar
`test:ci` green gates and full 58-chunk suite green on combined tree.

**Rollback:** Not recommended (too many interdependent migrations). Revert individual
pillar branches if specific regression identified.

**Gate:** Full `test:ci` 58 chunks green after D5/ICD-11 combined. Per-pillar local CI
gates run before each merge.

**Approver:** Bahuleyandr (self-approved; solo project).
