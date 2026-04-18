# VH Health Monorepo — Bug Hunt Report (2026-04-18)

Scope: static review across backend, admin, patient, staff, and shared package in this monorepo.

## Method used

- Searched for stale monorepo paths, auth anti-patterns, TODO stubs, and config drift.
- Checked test footprint quickly by counting `*.test.*` / `*.spec.*` files.
- Performed targeted source review on high-risk auth/API files.

## High-confidence issues found

### 1) Admin investigations upload used legacy localStorage token path (fixed)

- **File:** `apps/admin/src/lib/api/investigations.ts`
- **Issue:** `uploadBookingResult` read `localStorage.getItem("token")` and attempted to pass it in request options.
- **Why this is a bug:** Current auth model is httpOnly cookie + `/api/proxy`; token is not expected in localStorage.
- **Fix applied in this branch:** Removed localStorage token read and removed `token` option from upload call.
- **Risk:** Medium (auth behavior inconsistency; brittle if legacy key is absent).

### 2) Admin architecture doc contradicted implemented auth model (fixed)

- **File:** `apps/admin/CLAUDE.md`
- **Issue:** Top-level auth summary still claimed JWT in localStorage and referenced `adminToken` cookie name in layout notes.
- **Why this matters:** Misleads future contributors, causes regressions toward insecure token handling.
- **Fix applied in this branch:** Updated docs to `auth_token` httpOnly model and monorepo-local related app paths.
- **Risk:** Medium (developer-experience/documentation drift, security confusion).

### 3) Core codegen playbook used pre-monorepo paths (fixed)

- **File:** `packages/vhhealth_core/docs/API_CODEGEN.md`
- **Issue:** Commands referenced `cd vhhealth-core` and `../vh-health-backend/...` paths.
- **Why this matters:** New contributors cannot run codegen successfully from monorepo without manual path translation.
- **Fix applied in this branch:** Updated commands to monorepo paths under `packages/` and `apps/backend/`.
- **Risk:** Low-to-medium (tooling workflow breakage).

## Additional backlog items (not modified in this patch)

### A) Legacy path references remain in multiple docs

- Examples:
  - `packages/vhhealth_core/CLAUDE.md`
  - `apps/patient/CLAUDE.md`
  - `apps/staff/CLAUDE.md`
  - `apps/backend/README.md` includes template `your-org` repo URLs
- **Recommendation:** Do one dedicated “docs monorepo path normalization” pass across all CLAUDE/README docs.

### B) Backend DB port references are mixed between local docs and CI defaults

- CI uses PostgreSQL `5432`, while several backend docs/local examples use `5433`.
- **Recommendation:** Keep both intentionally documented but add one canonical “port policy” note to prevent confusion.

### C) Staff app contains explicit TODO endpoint placeholders

- `apps/staff/lib/features/**` has TODOs for housekeeping/nursing/HR/directory endpoint wiring.
- **Recommendation:** label each TODO with a backend issue ID and expected endpoint contract.

### D) Test depth is still uneven by app

- Quick count snapshot (from static file scan):
  - Admin source files: 314
  - Admin test files: 10
  - Backend test files: 50
  - Flutter/shared tests (patient+staff+core): 31
- **Recommendation:** raise minimum coverage gates for admin and add auth/proxy contract tests.

## Suggested next pass

1. Repo-wide documentation normalization PR (paths + auth nomenclature + setup commands).
2. Admin auth integration tests around `/api/login`, `/api/refresh`, and upload endpoints.
3. Staff TODO endpoint closure plan (or explicit feature flags for unimplemented modules).
