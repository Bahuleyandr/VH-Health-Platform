---
id: 2026-05-15-admin-proxy-csrf-origin-port-mismatch
run_id: 2026-05-15-35991538
started_at: 2026-05-15T09:23:00.959Z
finished_at: 2026-05-15T09:23:11.503Z
git_sha: 467b207307d99d7cfd7f0f164191d262a366a6ef
seed_version: none
base_url: http://127.0.0.1:3201
tenant_id: 00000000-0000-4000-8000-000000000001
scenario: admin CRUD smoke against local QA env — 12/19 mutation checks rejected at CSRF/Origin gate before reaching backend
command: node scripts/qa-orchestrator.mjs --stages admin,patient,staff,clinical
exit_code: 1
severity: medium
area: admin
repro_steps:
  - "Start local QA env: node apps/backend/scripts/qa-cluster-up.mjs && PORT=5206 NODE_ENV=test DATABASE_URL=postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test npm --prefix apps/backend run dev (background)"
  - "Start admin dev on the orchestrator's expected port: cd apps/admin && npx next dev --turbopack -p 3201 (background) — note: the package.json dev script hardcodes -p 3001, PORT env var is ignored"
  - "Confirm origin mismatch with a manual probe: curl -sS -X POST -H 'Authorization: Bearer <smoke-super-admin-jwt>' -H 'Origin: http://127.0.0.1:3201' -H 'Content-Type: application/json' http://127.0.0.1:3201/api/proxy/api/v1/admin/users/1/status -d '{\"status\":\"inactive\"}'"
  - "Run the orchestrator: node scripts/qa-orchestrator.mjs --stages admin,patient,staff,clinical"
  - "Inspect qa-runs/<run_id>/admin/stdout.txt — 12 mutations come back 403"
expected: |
  Admin smoke mutations (user_status, user_reactivate, staff_reactivate, department_create, doctor_create, system_settings_put) pass through the admin proxy's CSRF/Origin gate and reach the backend, matching the 2026-05-08-final-014 baseline run on the same orchestrator config.
actual: |
  All 12 mutation checks fail at the admin proxy with HTTP 403 and body {"message":"Forbidden: cross-origin mutation blocked"}. Root cause: apps/admin/.env.local sets NEXT_PUBLIC_ALLOWED_ORIGIN=http://127.0.0.1:3001 but the orchestrator + smoke script run admin on 127.0.0.1:3201 and send Origin: http://127.0.0.1:3201. apps/admin/src/app/api/proxy/[...path]/route.ts:111-127 rejects any mutation whose Origin header is not in the allow-list. The non-mutating GETs (users_list, doctors_manage, system_settings_get, clinical_ai_status/modules/reviews/audit) pass because validateMutationOrigin only fires for non-safe methods.
artifacts:
  - qa-runs/2026-05-15-35991538/summary.json
  - qa-runs/2026-05-15-35991538/admin/stdout.txt
  - qa-runs/2026-05-15-35991538/admin/stderr.txt
confidence: high
status: open
---

## Symptom

The 2026-05-15 orchestrator run (against `467b2073` on `main`) shows the
admin stage failing with 12 cross-origin 403s while the patient, staff,
and clinical stages all pass cleanly. The 2026-05-08-final-014 run on
the same orchestrator + same script set passed admin cleanly with the
same `base_url_admin: http://127.0.0.1:3201`, so this is a regression
in environment configuration somewhere between then and now —
not in the smoke script and not in the proxy code (no commits since
2026-05-08 to `apps/admin/src/app/api/proxy/`).

The 12 failing checks are exactly the POST/PUT/PATCH/DELETE
operations:
`user_status_inactive`, `user_reactivate`, `staff_reactivate`,
`department_create`, `doctor_create`, `system_settings_put`,
and their downstream `*_update/delete/availability` checks that
short-circuit with SKIP after `department_create` / `doctor_create`
fail.

Effect: 12 critical admin CRUD surfaces (user lifecycle, department
CRUD, doctor CRUD, system-settings mutation) are uncoverable by the
local-smoke harness today. Tied wave-1–4 surfaces (admin-driven doctor
picker assignment, admin-driven user reactivation feeding staff JWT
rotation) cannot be end-to-end verified against local QA until this is
fixed.

## Reproduction

Backend / admin / QA postgres all up per `.claude/skills/vh-health-qa`
Step 2. Then:

```bash
# Forge the same SUPER_ADMIN JWT the smoke harness uses
JWT=$(cd apps/backend && SMOKE_JWT_SECRET=vhhealth-local-admin-smoke-secret-123456789 \
  SMOKE_ADMIN_UID=f974d551-2d5b-413f-b287-718374374739 \
  node -e "console.log(require('jsonwebtoken').sign({uid:process.env.SMOKE_ADMIN_UID,role:'SUPER_ADMIN'},process.env.SMOKE_JWT_SECRET,{expiresIn:'4h'}))")

# This GET passes the proxy (safe method, no CSRF check) and round-trips to the backend
curl -sS -H "Authorization: Bearer $JWT" \
  http://127.0.0.1:3201/api/proxy/api/v1/admin/users?limit=1

# This POST gets rejected at the proxy CSRF gate before reaching the backend
curl -sS -X POST -H "Authorization: Bearer $JWT" \
  -H "Origin: http://127.0.0.1:3201" \
  -H "Content-Type: application/json" \
  -d '{"status":"inactive"}' \
  http://127.0.0.1:3201/api/proxy/api/v1/admin/users/1/status
# → {"message":"Forbidden: cross-origin mutation blocked"}
```

## Hypothesis

`apps/admin/.env.local` was last updated to:

```
NEXT_PUBLIC_ALLOWED_ORIGIN=http://127.0.0.1:3001
```

…but the orchestrator (`scripts/qa-orchestrator.mjs:5-15`), the admin
smoke (`scripts/smoke-admin-crud.ps1:14`), and the documented start
command in the `vh-health-qa` skill all use port **3201** for the admin.
There's no commit history on `apps/admin/.env.local` that shows when
this drifted; the live env file is gitignored.

Two ways to fix forward, both low-blast-radius:

1. **Env config** — change `apps/admin/.env.local` to
   `NEXT_PUBLIC_ALLOWED_ORIGIN=http://127.0.0.1:3201,http://localhost:3201`
   (comma-separated allow-list is already supported at line 119 of
   the proxy route). The CSRF code does not need to change.
2. **Dev script** — `apps/admin/package.json`'s `"dev": "next dev
   --turbopack -p 3001"` hard-codes the port. Drop the `-p` so
   `PORT=3201 npm run dev` works the way the rest of the harness
   already expects. Then a single env value (`localhost:3201`) is
   enough.

Option 1 is the smaller change. Option 2 is the more honest one —
the package script and the harness are out of sync today.

## Artifacts

- [`qa-runs/2026-05-15-35991538/summary.json`](../../qa-runs/2026-05-15-35991538/summary.json)
- [`qa-runs/2026-05-15-35991538/admin/stdout.txt`](../../qa-runs/2026-05-15-35991538/admin/stdout.txt)
- [`qa-runs/2026-05-15-35991538/admin/stderr.txt`](../../qa-runs/2026-05-15-35991538/admin/stderr.txt)
- Proxy code: `apps/admin/src/app/api/proxy/[...path]/route.ts:107-128`
