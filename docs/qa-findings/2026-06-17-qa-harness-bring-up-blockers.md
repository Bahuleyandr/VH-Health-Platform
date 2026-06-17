---
id: 2026-06-17-qa-harness-bring-up-blockers
run_id: 2026-06-17-8232feba
started_at: 2026-06-17T04:58:25.384Z
finished_at: 2026-06-17T04:58:48.069Z
git_sha: 092911ba
seed_version: 608828461dff197e
base_url: http://127.0.0.1:5206
tenant_id: 00000000-0000-4000-8000-000000000001
scenario: harness bring-up + full default pass (reset, admin, patient, staff, clinical)
command: node scripts/qa-orchestrator.mjs
exit_code: 1
severity: high
area: qa-harness
confidence: high
status: fixed
repro_steps: |
  1. Follow docs/qa/README.md verbatim: export NODE_ENV=qa, start backend with
     PORT=5206 npm run dev and admin with PORT=3201 npm run dev.
  2. Backend crashes at validateEnv (NODE_ENV=qa not allowed; only
     development/production/test). Admin starts on :3001 (dev script hardcodes
     `next dev --turbopack -p 3001`, ignoring PORT), so the orchestrator's
     :3201 admin probe never succeeds.
  3. Even with NODE_ENV=test + admin forced to :3201, every journey 401s:
     the smoke scripts sign JWTs with a fixed secret
     (vhhealth-local-admin-smoke-secret-123456789) and send a fixed API key
     (vhhealth-local-api-key) — neither documented in the README env block.
expected: |
  The harness boots and runs per docs/qa/README.md, producing a measurable
  journey pass/fail count.
actual: |
  The harness is un-runnable as documented. Four distinct config gaps each block
  bring-up. Once worked around, journeys partially run (see below).
---

## Symptom

The `vh-health-qa` **live-HTTP smoke harness** cannot be brought up by following
`docs/qa/README.md`. NOTE: this harness is a *complement* to the deterministic
in-CI **journey gate** (the 11 journeys became blocking CI tests per WS3 B3.1 —
that gate is green); it is NOT itself the milestone measurement. So this is a
QA-tooling drift finding, not evidence the milestone is unmet.

## Reproduction

Bringing the smoke env up surfaced **four** independent bring-up blockers:

1. **`NODE_ENV=qa` is rejected by the backend.** `apps/backend/src/utils/validateEnv.js:54-56`
   allows only `development|production|test`. The README's `export NODE_ENV=qa`
   crashes the backend at startup. (`scripts/qa-reset.mjs` guardrail-3 wants
   `qa|test`, so the only value satisfying **both** is `test`.)
2. **Admin port is hardcoded.** `apps/admin/package.json` `dev` =
   `next dev --turbopack -p 3001`, so the README/orchestrator instruction
   `PORT=3201 npm run dev` is ignored — admin lands on `:3001` while the
   orchestrator probes `:3201` (`scripts/qa-orchestrator.mjs:40`). Must launch
   `npx next dev --turbopack -p 3201` directly.
3. **JWT secret undocumented.** Smoke scripts sign tokens with a fixed
   `JwtSecret = "vhhealth-local-admin-smoke-secret-123456789"`
   (`scripts/smoke-admin-crud.ps1:15`, `smoke-clinical-ai-local-ollama.ps1:23`).
   The backend `JWT_SECRET` must equal this or every call 401s `TOKEN_INVALID`.
   The README env block omits it.
4. **API key undocumented + per-client.** Patient/staff/clinical smoke send
   `ApiKey = "vhhealth-local-api-key"`; admin sends a *different* (admin-tier)
   key. A single `API_KEY` cannot satisfy both — the per-client
   `API_KEY_ADMIN`/`API_KEY_PATIENT`/`API_KEY_STAFF` must be set to the smoke's
   values. The README env block omits these.

## Partial-run results (after working around 1–4 with the patient/staff key)

| Stage | Result | Notes |
|---|---|---|
| reset | **PASS** | DB seeded cleanly |
| staff | **PASS (13/13)** | fully green |
| patient | **31/32** | 1 fail: `investigations_booking_create` → 403 "Please re-login before clinical entries can be saved." |
| admin | 0/19 | reads 401 "Invalid API Key" (admin needs its own key); **all mutations 403 "cross-origin mutation blocked"** |
| clinical | 0/12 | `mar_schedule` 403 "Patient record access denied: no active care-team…" (care-team ABAC); downstream asserts cascade |

**Key conclusion: no broad feature regression surfaced.** Every read/GET that ran
returned 200; staff is fully green and patient nearly so. The remaining red is
**config/policy**, not broken features:
- **Cross-origin mutation guard** (403) blocks every admin mutation — needs the
  right Origin/CSRF handling in the smoke env, or is a real CSRF-config issue.
  *(Candidate for its own finding.)*
- **Care-team ABAC** (403 "no active care-team") blocks the clinical MAR — the
  seed doesn't establish a clinician↔patient care-team link, or enforcement
  flipped from shadow to enforce. *(Candidate for its own finding.)*

## Hypothesis

(Hypothesis, not yet confirmed) The harness env contract drifted: `validateEnv`
dropped/never-had `qa`, the admin dev script gained a hardcoded `-p 3001`, and
the README's env block was never updated with the smoke `JWT_SECRET` + per-client
API keys. The fix is small (README env block + either accept `qa` in validateEnv
or standardise on `test`, + un-hardcode the admin port / make it `-p ${PORT:-3001}`)
and would restore the live-HTTP smoke as a usable complement to the CI journey
gate. The partial run that DID complete (staff 13/13, patient 31/32, all reads
200) is consistent with the green CI gate — no contradicting signal.

## Artifacts

- `qa-runs/2026-06-17-8232feba/` — summary.json + per-stage stdout/stderr.
- Earlier runs `2026-06-17-ab9eaf52` (all-401, throwaway secret),
  `2026-06-17-f78af30d` (admin 7/19 with admin key) show the progression as
  each blocker was worked around.
- Post-fix run `qa-runs/2026-06-17-dbe2e998/` — admin 19/19, clinical 18/18,
  staff 13/13, reset pass (patient 31/32, see Fix below).

## Fix (2026-06-17)

Branch `qa-fix/qa-harness-bring-up-blockers`. All four bring-up blockers plus the
two downstream 403s were resolved as a single **env-contract correction** — no
product, auth, or RLS code changed (only the harness docs, the smoke seed, an
admin npm script, and orchestrator hint strings):

1. **NODE_ENV** — `docs/qa/README.md` now exports `NODE_ENV=test` (the only value
   that satisfies both `validateEnv` and the reset guardrail).
2. **Admin port** — added `apps/admin/package.json` script
   `"dev:qa": "next dev --turbopack -p 3201"`; README + `qa-orchestrator.mjs`
   start hints now use it instead of the ignored `PORT=3201 npm run dev`.
3. **JWT secret + API key** — README documents
   `JWT_SECRET=vhhealth-local-admin-smoke-secret-123456789` and
   `API_KEY=vhhealth-local-api-key`. One shared fallback key satisfies the
   patient/staff/admin clients; the admin proxy injects it via `BACKEND_API_KEY`.
   (The earlier "admin needs a *different* key" reading was a mis-set
   `BACKEND_API_KEY`, not a real per-client requirement.)
4. **Cross-origin mutation 403** (investigated by Agent A; same root cause as #2) —
   the admin proxy's `validateMutationOrigin` Origin allowlist is **correct**, not a
   CSRF flaw. The smoke sends `Origin: http://127.0.0.1:3201`; the admin just has to
   allow it. `dev:qa` is started with `NEXT_PUBLIC_ALLOWED_ORIGIN=http://127.0.0.1:3201`
   + `BACKEND_URL=http://127.0.0.1:5206`. This is the same issue tracked by the
   previously-open finding
   [`2026-05-15-admin-proxy-csrf-origin-port-mismatch.md`](2026-05-15-admin-proxy-csrf-origin-port-mismatch.md)
   (now resolved by this change).
5. **Care-team ABAC 403** (investigated by Agent B) — the `/api/v1/clinical` mount is
   a **legacy enforce site** (it is not `careTeamModeGoverned`, so it was never under
   shadow mode and nothing "flipped to enforce"). The smoke simply never seeded the
   nurse↔patient relationship the enforce path requires. `smoke-staff-clinical-safety.ps1`
   now seeds an active `care_teams` + `care_team_members` row with
   `tenant_id = 00000000-0000-4000-8000-000000000001` (the value
   `deriveTenantIdFromRequest()` resolves for the smoke JWT, which the relationship
   query filters on). No product code or enforcement flag changed.

### Verification — `qa-runs/2026-06-17-dbe2e998/` (full default pass, the documented recipe)

| Stage | Before | After |
|---|---|---|
| reset | PASS | **PASS** |
| admin | 0/19 (cross-origin 403 on every mutation) | **PASS — 19/19** |
| patient | 31/32 | 31/32 (unchanged) |
| staff | 13/13 | **PASS — 13/13** |
| clinical | 0/12 (care-team 403) | **PASS — 18/18** |

The harness now boots and runs by following `docs/qa/README.md` verbatim. The one
remaining red — patient `investigations_booking_create` → 403 *"Please re-login
before clinical entries can be saved"* — is **pre-existing and out of scope** for
this bring-up finding (untouched by this fix) and is a candidate for its own finding.
