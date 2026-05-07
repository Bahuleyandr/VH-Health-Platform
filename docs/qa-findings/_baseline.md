# QA harness — baseline snapshot

**Snapshot taken:** 2026-05-07
**Author:** Claude Code (Trenzalore session)
**Purpose:** Pin the starting point for the agent-driven QA loop so future
findings can be replayed against a known repo + deploy state.

---

## Repo state at baseline

| Thing | Value |
|---|---|
| Local working tree | clean |
| Local `main` SHA | `56ae53fc6a95df26713ff4915740114263459991` |
| `origin/main` SHA | `56ae53fc6a95df26713ff4915740114263459991` (same) |
| Latest commit subject | `sprint 22: dialysis unit (HD/CRRT/PD) + adequacy + serology` |
| Dalekdefender deploy SHA | `e1ecb6925ab35db08d3f1b134c53ce5ad5f1e460` (≈ 6 commits behind local) |
| Dalekdefender redeploy needed? | yes, before any Dalekdefender-target run |

> Dalekdefender is the live home-tailnet k3s deploy used for manual
> drive-bug discovery. The QA harness in this iteration does **not** target
> Dalekdefender — see "Architectural decision" below.

## Architectural decision: QA target is the LOCAL smoke env

The six existing PowerShell smoke scripts under `scripts/smoke-*.ps1` are
hardcoded to local hosts and ports. They mint their own JWT, hit
`http://127.0.0.1:5206` (backend) and `http://127.0.0.1:3201/api/proxy`
(admin), and seed Postgres on `127.0.0.1:55432` against database
`vhhealth_test`.

Wrapping those scripts in a higher-level orchestrator means the QA target
is the **local smoke environment on Trenzalore** — not Dalekdefender. The
one exception is `smoke-staff-role-workflows.ps1`, which already accepts a
live `VH_BASE_URL` for Dalekdefender and is kept as an opt-in mode.

**Rationale.** Reproducible findings need a deterministic seed and a hard
reset between runs. Dalekdefender carries real-ish in-progress data that
manual driving has been adding to. Wiping it on every QA pass would
destroy that work. Local smoke env is disposable by design.

## Trenzalore (this PC) hosts the harness

The QA orchestrator, any Playwright/Maestro driver, and any future
DeerFlow harness all run on **Trenzalore**:
- 32 GB RAM, dedicated GPU.
- Already runs Postgres 17 on `:55432` for tests, has Flutter 3.41,
  Node 22, dart, lefthook, melos, act, Docker-in-WSL.
- Active subscriptions: Claude Max 20x + Codex 20x — any LLM hops use
  OAuth subscription path, no API spend.

Dalekdefender stays as the deployment target for ad-hoc live driving;
RAM-constrained, not suitable for a heavy harness.

## Existing smoke surface (what we wrap)

| Script | Lines | Hits |
|---|---:|---|
| `scripts/smoke-admin-crud.ps1` | ~285 | admin proxy CRUD: users, depts, doctors, system settings, clinical AI |
| `scripts/smoke-patient-routing.ps1` | ~462 | patient: dashboard, appts, vitals, notifications, devices, SOS, pharmacy, investigations, prescriptions |
| `scripts/smoke-staff-routing.ps1` | ~275 | staff: campus locations, dietary, messaging, investigations, pharmacy queues |
| `scripts/smoke-staff-clinical-safety.ps1` | ~452 | MAR 5-rights, CDS allergy blocking, override workflow |
| `scripts/smoke-staff-role-workflows.ps1` | ~553 | live-deploy 8-role sweep (EMP-1001..1008); only one with `VH_BASE_URL` support |
| `scripts/smoke-staff-desktop.ps1` | ~48 | flutter integration test on Windows |

CI workflow at `.github/workflows/smoke-e2e.yml` already runs admin /
patient / staff / clinical-safety on PR.

## Existing infra we reuse

| Asset | Path | Role |
|---|---|---|
| Test DB bootstrap | `apps/backend/scripts/ensure-test-db.mjs` | brings up Postgres 17 on `:55432`, syncs schema via `prisma db push` + `ci-setup-db.mjs` + `ensureCompatibilityTables` |
| Comprehensive seed | `apps/backend/scripts/seed-comprehensive-test-data.mjs` | reference seed; has `isLocalTestDatabase` guard. `DEFAULT_TENANT_ID = 00000000-0000-4000-8000-000000000001`. SEED_TAG = `vh_seed` |
| Migrations | `apps/backend/src/migrations/*.sql` | 168 raw SQL files; **schema source of truth**, not Prisma |
| Smoke CI | `.github/workflows/smoke-e2e.yml` | PR-gate sweep |

## QA-tenant scope decision

**Database:** reuse the existing `vhhealth_test` DB on `127.0.0.1:55432`.
Rationale: smokes already wired there, no churn cost, keeps reset simple.
**Caveat (documented in skill):** do not run Jest concurrently with a QA
run — they share the DB.

**Tenant identification:** the harness writes one row to a
`qa_seed_meta` table created lazily (`CREATE TABLE IF NOT EXISTS`) by
`scripts/qa-reset.mjs`. Schema:

```sql
CREATE TABLE IF NOT EXISTS qa_seed_meta (
    id SERIAL PRIMARY KEY,
    seed_version TEXT NOT NULL,    -- sha256 of seeder source
    seeded_at TIMESTAMPTZ DEFAULT now(),
    git_sha TEXT,
    seed_tag TEXT DEFAULT 'qa_seed',
    notes TEXT
);
```

Not a real migration. No corresponding Prisma model. QA-scope only.

## Reset guardrails (Phase 1 will enforce)

`scripts/qa-reset.mjs` will refuse to run unless **all six** are true:

1. `DATABASE_URL` host is `127.0.0.1` or `localhost`.
2. `DATABASE_URL` database name matches the configured QA DB exactly
   (default `vhhealth_test`).
3. `NODE_ENV=qa` (or `test`) — never `production`.
4. The DB user is the dedicated `qa_writer` Postgres role (not
   `postgres` superuser).
5. `VH_QA_RESET_CONFIRM=<dbname>` is set to the exact target DB name.
6. A Postgres advisory lock (`pg_try_advisory_lock(919117)`) acquires
   first try — fails fast if a run is already in flight.

The `qa_writer` role setup (one-off, documented in the skill):

```sql
CREATE ROLE qa_writer WITH LOGIN PASSWORD 'qa_writer_local';
GRANT CONNECT ON DATABASE vhhealth_test TO qa_writer;
GRANT USAGE, CREATE ON SCHEMA public TO qa_writer;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO qa_writer;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO qa_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO qa_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO qa_writer;
```

## Operating modes

- **report-mode (default).** Run smokes, classify failures, write
  Markdown findings to `docs/qa-findings/<date>-<slug>.md`. Never edit
  product code.
- **fix-mode (gated).** Per-finding human approval. Branch off main,
  one finding → one branch → one PR. Always re-run the orchestrator
  before merge.

## Repository conventions

- `qa-runs/` — gitignored. Raw run output (stdout/stderr/JSON) per `run_id`.
- `docs/qa-findings/` — committed. Markdown findings + this baseline.
- `docs/qa/` — committed. Schema, README, modes doc.
- `.claude/skills/vh-health-qa/` — committed (carve-out in `.gitignore`).
  Project-scope skill for the harness.

## Phase deliverables snapshot (planned, not yet written)

| Phase | Files |
|---|---|
| 0 — baseline | this file (✓), `.gitignore` carve-out (✓) |
| 1 — reset spine | `scripts/seed-qa-tenant.mjs`, `scripts/qa-reset.mjs` |
| 2 — orchestrator | `scripts/qa-orchestrator.mjs` |
| 3 — findings | `docs/qa/finding-schema.json`, `.claude/skills/vh-health-qa/SKILL.md`, `docs/qa/README.md`, `docs/qa/MODES.md` |
| 4 — first run | `docs/qa-findings/2026-05-07-<slug>.md` (one or more) |
| 5 — UI agents | `scripts/qa-playwright.mjs`, `scripts/qa-maestro.mjs` (or wrappers) |
| 6 — deerflow gate | `docs/qa/DEERFLOW_GATE.md` |
| 7 — bug→fix loop | section appended to skill + `docs/qa/MODES.md` |
