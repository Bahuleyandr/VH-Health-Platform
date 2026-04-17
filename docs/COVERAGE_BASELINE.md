# Test coverage baseline — 2026-04-17

> Measured snapshot taken after the 2026-04-14 + 2026-04-17 passes, then
> re-measured post the 2026-04-17 coverage bump (admin jest unbreak + 39
> new tests). Source of truth for progress on Phase 2 coverage items
> (2.1, 2.5, 2.9, 2.12 in `FINISH_BUILDING.md`). Update this doc when a
> sweep closes any of those items — or when coverage drops materially on
> any repo.

## Real coverage — current (end of 2026-04-17 coverage pass)

| Repo                | Runs? | Lines  | Stmts  | Funcs  | Branches | Tests       |
|---------------------|-------|--------|--------|--------|----------|-------------|
| `vh-health-backend` | ✔     | **23.81%** | 23.28% | 21.61% | 17.53%   | 578 (559✔ / 10✘ / 9 skip) |
| `VH-Health-Adminportal` | ✔ | **5.15%**  | 5.15%  | 7.67%  | 28.86%   | 157 (all pass, 7 suites) |
| `VH-health` (patient) | 🚫 SDK mismatch | — | — | — | — | 112 test cases across 8 files |
| `VHhealth-staff`    | 🚫 SDK mismatch | — | — | — | — | 70 test cases across 5 files |
| `vhhealth-core`     | 🚫 SDK mismatch | — | — | — | — | 78 test cases across 9 files |

### Delta vs the morning-of 2026-04-17 baseline

| Repo    | Lines                     | Stmts  | Funcs  | Branches | Tests            |
|---------|---------------------------|--------|--------|----------|------------------|
| Backend | 22.57 → **23.81** (+1.24) | +1.23  | +2.38  | +1.49    | 498 → 578 (+80)  |
| Admin   | 0 → **5.15** (ran at all) | +5.15  | +7.67  | +28.86   | 0 → 157          |

### Tests added across the day

**Backend — 80 new tests:**

| File | Tests | Focus |
|---|---|---|
| `tests/unit/coreUtils.test.js` | 30 | `AppError`, `phoneUtils`, `piiMask`, `sanitize`, `responseHelper` |
| `tests/revenue-cycle-deep.test.js` | 13 | Claim queue / AR aging / mark-submitted / denials |
| `tests/mar-due-deep.test.js` | 11 | `/clinical/mar/due`, `/clinical/mar/verify` + drug identifiers |
| `tests/admin-stats-deep.test.js` | 15 | `/admin/dashboard`, `/stats/*`, `/health/*`, `/refresh-cache` |
| `tests/prescription-diagnosis-deep.test.js` | 11 | RxNorm structural gate + SNOMED validation |

**Admin portal — 157 tests (0 before today):**

| File | Tests | Focus |
|---|---|---|
| Existing 5 suites | 138 | Pre-existing; now runnable after jest polyfill unbreak |
| `__tests__/lib/exportToCsv.test.ts` | 9 | `buildCsv` + DOM side effects + UTF-8 BOM |
| `__tests__/components/shared.test.tsx` | 10 | `LoadingSpinner`, `EmptyState` |

Integration tests deliver more coverage per test because each one
exercises full route → service → SQL paths.

### Latent bugs surfaced by writing the integration tests

1. `medication_administrations` has no `hold_reason` column despite
   `marService.holdMedication` writing to it — any call to
   `/clinical/mar/:id/hold` would 500 in prod. Not fixed in this pass;
   tracked as a cleanup follow-up.
2. `scheduled_time` + `NOW()` interact badly when the Postgres server
   timezone != UTC. The 5-rights time check does `new Date(scheduled_time)`
   which parses the naive timestamp using Node's local tz, so a Postgres
   cluster in IST gives verify a 5.5h skew. Production runs in UTC so
   the bug sleeps there; dev is where it bites.
3. `validateUID` middleware on non-admin write routes requires `uid` in
   the request body even when the route doesn't conceptually need one.
   ADMIN role bypasses it via superuser override. Noted in
   `prescription-diagnosis-deep.test.js` for future integration-test
   authors.

### What unlocked admin coverage

Admin Jest was failing on `ReferenceError: Response is not defined` under
jsdom, which masks four other missing Fetch-API globals
(`TextDecoder`, `TextEncoder`, `Blob` with proper methods,
`ReadableStream`). Fix: new `jest.polyfills.js` in `setupFiles` (runs
before `setupFilesAfterEach`) pulls them from `node:util`, `node:buffer`,
`node:stream/web`, `node:worker_threads`, and forwards undici's fetch /
Request / Response / Headers / FormData. `jest.config.ts` gained a
`setupFiles:` entry. Coverage collection requires `--coverageProvider=v8`
(Istanbul path trips on a `test-exclude`/`util.promisify` bug under
Node 22).

"SDK mismatch" = dev machine has Dart 3.8.1 / Flutter 3.32.8; `vhhealth_core`
pins `json_annotation ^4.11.0` which needs Dart 3.9+. The CI workers use
the correct SDK so the Flutter numbers are recoverable from a CI coverage
artifact — not included here because we haven't wired one yet.

## Proxy metrics (test-file density)

| Repo            | Src files | Test files | Ratio |
|-----------------|-----------|------------|-------|
| Backend         | 560       | 48         | 8.6%  |
| Admin           | 280       | 5          | 1.8%  |
| Patient         | 151       | 8          | 5.3%  |
| Staff           | 101       | 5          | 5.0%  |
| Core            | 34        | 9          | 26.5% |
| **All 5 repos** | **1,126** | **75**     | **6.7%** |

File-count ratio is a weak proxy — one generous `*-deep.test.js` can exercise
hundreds of code paths — but useful as a quick across-repo comparison.

## Known bugs surfaced by the coverage run

1. **Admin portal tests are broken, not just thin.** All 5 suites fail with
   `ReferenceError: Response is not defined` — Jest environment isn't
   polyfilling the `fetch`/`Response` globals. Before any admin test
   numbers are meaningful this needs the setup fix (tracked alongside
   this doc).
2. **Backend has 10 failing tests** in `appointment-deep.test.js` — shape
   + status-code drift (tests expected 201, getting 409 because slot-free
   assumptions about seeded data changed). Not infrastructure, but they
   prevent the suite from going green.

## Target per Phase 2

`FINISH_BUILDING.md` 2.1 / 2.5 / 2.9 / 2.12 all target **≥60% line
coverage** per repo. We are nowhere near that in any repo; backend is the
closest. Realistic ramp:

- Unblock admin jest → quick win, gets 1 suite running.
- Fix backend's 10 failing tests → green gate, enables confident additions.
- Prioritise **route-level integration tests** for code the existing suite
  doesn't hit (admin stats, revenue-cycle, kpi aggregator, terminology
  validators wiring) — biggest coverage lift per test written.
- Defer Flutter sweeps until CI-run coverage is wired + visible; local
  runs on dev machines are blocked by SDK issues for some of the team.

## How to reproduce

```bash
# Backend
cd VH-health-backend
DATABASE_URL=postgresql://vhhealth@localhost:5433/vhhealth \
  JWT_SECRET=dev-secret-at-least-32-chars-long API_KEY=dev \
  NODE_ENV=test \
  node --experimental-vm-modules node_modules/jest/bin/jest.js \
    --coverage --coverageReporters=json-summary --forceExit --silent
cat coverage/coverage-summary.json | jq '.total'

# Admin (once jest setup is fixed)
cd VH-Health-Adminportal
npm test -- --coverage --coverageReporters=json-summary --silent
cat coverage/coverage-summary.json | jq '.total'

# Flutter (on a box with Dart 3.9+)
cd vhhealth-core  # repeat per Flutter repo
flutter test --coverage
# lcov report at coverage/lcov.info — open via genhtml or a VS Code extension.
```
