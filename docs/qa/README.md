# VH Health QA harness — overview

Agent-driven QA loop that drives the local smoke environment, classifies
failures, and files structured findings.

This directory holds **how the harness works** (schema, modes, gate
decisions). Actual findings — one Markdown file per discovered defect —
live next door at [`../qa-findings/`](../qa-findings/).

## TL;DR for a fresh clone

```bash
# One-time host setup
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres <<'SQL'
CREATE ROLE qa_writer WITH LOGIN PASSWORD 'qa_writer_local';
SQL
psql -h 127.0.0.1 -p 55432 -U postgres -d vhhealth_test <<'SQL'
GRANT CONNECT ON DATABASE vhhealth_test TO qa_writer;
GRANT USAGE, CREATE ON SCHEMA public TO qa_writer;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO qa_writer;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO qa_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO qa_writer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO qa_writer;
SQL

# Per-run env (shared shell exports)
export NODE_ENV=test         # validateEnv rejects "qa"; the reset guardrail accepts qa|test, so "test" satisfies both
export DATABASE_URL='postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test'
export VH_QA_RESET_CONFIRM=vhhealth_test

# The smoke scripts sign JWTs with a fixed secret and send a fixed API key.
# The backend (and the admin proxy) MUST be started with these same values or
# every call 401s (TOKEN_INVALID / Invalid API Key):
export JWT_SECRET=vhhealth-local-admin-smoke-secret-123456789
export API_KEY=vhhealth-local-api-key   # shared fallback key satisfies the patient/staff/admin clients

# Start backend (smoke port) and admin (smoke port) in two separate shells.
#
# Backend — inherits the exports above, plus the smoke port:
#   apps/backend>  PORT=5206 npm run dev
#
# Admin — the proxy must target the local backend (BACKEND_URL), inject the same
# API key (BACKEND_API_KEY), allow the smoke's :3201 Origin (the proxy's CSRF
# mutation guard rejects any other Origin), and verify the smoke cookie JWT
# (JWT_SECRET). Use the dev:qa script — the plain `dev` script hardcodes :3001:
#   apps/admin>  BACKEND_URL=http://127.0.0.1:5206 \
#                BACKEND_API_KEY=vhhealth-local-api-key \
#                NEXT_PUBLIC_ALLOWED_ORIGIN=http://127.0.0.1:3201 \
#                JWT_SECRET=vhhealth-local-admin-smoke-secret-123456789 \
#                npm run dev:qa

# Then drive a full QA pass:
node scripts/qa-orchestrator.mjs
```

## Architecture map

```
┌──────────────────────────────────────────────────────────────────┐
│ scripts/qa-orchestrator.mjs   (Node 22)                          │
│   ├─ probe :5206 backend / :3201 admin                            │
│   ├─ stage: reset      → scripts/qa-reset.mjs                    │
│   │                        ├─ guardrail validation (× 6)          │
│   │                        ├─ pg_try_advisory_lock                │
│   │                        ├─ apps/backend/scripts/ensure-test-db │
│   │                        ├─ apps/backend/scripts/seed-…         │
│   │                        └─ scripts/seed-qa-tenant.mjs          │
│   ├─ stage: admin      → smoke-admin-crud.ps1                    │
│   ├─ stage: patient    → smoke-patient-routing.ps1               │
│   ├─ stage: staff      → smoke-staff-routing.ps1                 │
│   ├─ stage: clinical   → smoke-staff-clinical-safety.ps1         │
│   ├─ stage: role (opt-in)    → smoke-staff-role-workflows.ps1    │
│   ├─ stage: desktop (opt-in) → smoke-staff-desktop.ps1           │
│   └─ qa-runs/<run_id>/<stage>/{stdout,stderr,meta.json}          │
│      qa-runs/<run_id>/summary.json                               │
└──────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────┐
│  Triage (agent or human)                                         │
│   stage stdout/stderr → docs/qa-findings/<date>-<slug>.md        │
│   frontmatter validates against docs/qa/finding-schema.json      │
└──────────────────────────────────────────────────────────────────┘
```

## Files

| Path | What it is |
|---|---|
| `docs/qa/README.md` | this file |
| `docs/qa/MODES.md` | report-mode (default) vs fix-mode (gated) bug→fix loop |
| `docs/qa/finding-schema.json` | JSON Schema for finding frontmatter |
| `docs/qa/DEERFLOW_GATE.md` | criteria for graduating to a DeerFlow-driven harness |
| `docs/qa-findings/_baseline.md` | repo + deploy snapshot at QA harness inception |
| `docs/qa-findings/<date>-<slug>.md` | one finding per defect (committed) |
| `qa-runs/<run_id>/` | raw harness output (gitignored) |
| `scripts/qa-orchestrator.mjs` | top-level driver |
| `scripts/qa-reset.mjs` | guardrail-gated reset spine |
| `scripts/seed-qa-tenant.mjs` | QA-only edge-case seed |
| `.claude/skills/vh-health-qa/SKILL.md` | Claude Code skill — invoke with `/vh-health-qa` |

## What this harness intentionally does NOT do

- **No production targeting.** Six guardrails refuse non-loopback hosts,
  prod DB names, prod role, missing `VH_QA_RESET_CONFIRM`, wrong
  `NODE_ENV`, or contended advisory lock.
- **No silent code edits.** Default mode is "report only". Fix mode is
  gated per-finding; see [MODES.md](MODES.md).
- **No iOS coverage.** Out of scope for this iteration — deliberate.
- **No multi-tenant cross-write tests yet.** Single tenant
  (`00000000-0000-4000-8000-000000000001`) for the first iteration.
