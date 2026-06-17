---
id: 2026-06-17-patient-investigation-booking-mobile-blocked
run_id: 2026-06-17-dbe2e998
started_at: 2026-06-17T05:39:20.644Z
finished_at: 2026-06-17T05:39:22.391Z
git_sha: 96449584
seed_version: 608828461dff197e
base_url: http://127.0.0.1:5206
tenant_id: 00000000-0000-4000-8000-000000000001
scenario: patient self-service investigation booking blocked by the staff phone-mode clinical-write guard
command: node scripts/qa-orchestrator.mjs --stages patient
exit_code: 1
severity: high
area: investigation
confidence: high
status: fixed
repro_steps: |
  Live reproduction against the running smoke backend (:5206). Sign a PATIENT
  JWT (smoke secret) with each device-type and POST the patient booking:

    POST /api/v1/investigations/bookings/create
      {"selected_tests":[1],"collection_type":"walk_in","preferred_date":"2026-06-20"}

  - deviceType absent           → 403 DEVICE_TYPE_MISSING
                                   "Please re-login before clinical entries can be saved."
  - deviceType "mobile"         → 403 CLINICAL_WRITE_DESKTOP_ONLY
                                   "Clinical entries must be completed on Staff Desktop." (device_type: mobile)
  - deviceType "desktop"        → 200 "Investigation booked. INV-20260617-00003"

  The patient app (apps/patient/lib/features/investigations/screens/book_investigation_screen.dart:230)
  is a MOBILE app and stamps deviceType at Firebase login
  (apps/backend/src/controllers/auth/firebaseAuthController.js:11), so a real
  patient's JWT carries deviceType: "mobile" → the second case → blocked.
expected: |
  A patient can book a lab investigation from the patient mobile app
  (POST /api/v1/investigations/bookings/create), as documented in
  apps/patient/CLAUDE.md and implemented in book_investigation_screen.dart.
actual: |
  Every real patient (mobile, or a token with no deviceType) is rejected with a
  403 telling them to "complete clinical entries on Staff Desktop" — a message
  that makes no sense for a patient and completely blocks patient self-service
  investigation booking. Only a (non-existent for patients) desktop deviceType
  passes.
---

## Symptom

The patient smoke stage's `investigations_booking_create` check fails with
`403 "Please re-login before clinical entries can be saved."` (the persistent
31/32 patient result). Investigation shows this is **not** a smoke-env gap — it
is a real patient-facing regression that blocks all patients from booking lab
investigations from the patient app.

## Reproduction (live, countercheckable)

Against the running smoke backend, with a PATIENT JWT per device-type:

| Patient `deviceType` | Who sends it | Result |
|---|---|---|
| *(absent)* | the smoke's hand-signed token | `403 DEVICE_TYPE_MISSING` |
| `mobile` | **a real patient on the mobile app** | `403 CLINICAL_WRITE_DESKTOP_ONLY` ("complete on Staff Desktop") |
| `desktop` | the CI test client (`testClient.js:26`) | `200` — booking succeeds |

## Root cause (confirmed)

1. `apps/backend/src/middleware/rejectMobileClinicalWriteMiddleware.js` is, per
   its own header, a **Staff-app phone-mode policy**: "clinical documentation and
   workflow writes remain desktop/tablet Staff app only." It rejects a request
   whose JWT `deviceType` claim is absent (`DEVICE_TYPE_MISSING`) or `"mobile"`
   (`CLINICAL_WRITE_DESKTOP_ONLY`), with **no role check** — it gates by device
   regardless of who the actor is.
2. Commit `84d882ca` ("Add staff phone mode and profile controls", 2026-06-09)
   applied `rejectMobileClinicalWrite` broadly across clinical-write routes —
   including the **patient self-service** route
   `investigationRoutes.js:60` `['/bookings/create', rejectMobileClinicalWrite, …]`.
   Most other guarded routes (vitals, orders, notes, prescriptions, referrals,
   beds, the booking *collector* workflow) are genuinely staff-side and correctly
   gated; `/bookings/create` is the patient one caught in the blast radius.
3. The patient app is mobile and stamps `deviceType` at Firebase login
   (`firebaseAuthController.js:11` → `authenticateWithFirebase(..., { deviceType })`),
   so a real patient JWT carries `deviceType: "mobile"` → the second 403 branch.

**Why CI never caught it:** `apps/backend/src/tests/testClient.js:26` hardcodes
`deviceType: 'desktop'` on **every** test token, including patient-role tokens
(its own comment: "Desktop = full clinical access"). So the in-CI journey gate's
patient lab-booking path runs as desktop and passes — a **false green** that does
not exercise the real mobile-patient contract. This is why the milestone journey
gate is green while the live smoke (and real patients) fail here.

## Impact

Patient self-service lab-investigation booking is **completely broken on the
real patient app** (all patients are mobile). Broken since 2026-06-09. Pilot
patients would hit a nonsensical "use Staff Desktop" error. High severity:
patient-facing core feature, silently masked by the test suite.

## Recommended fix (touches auth middleware — needs approval before fix-mode)

1. **Role-scope the guard (root fix).** `rejectMobileClinicalWrite` should only
   apply to the Staff app — i.e. return `next()` for non-staff actors (PATIENT).
   One guard at the top of the middleware (`if (req.user?.role === 'PATIENT') return next();`,
   or `if (!isStaff(role)) return next();` via `roleHelpers`) fixes `/bookings/create`
   and any other patient-reachable route that inherited the guard, matching the
   middleware's stated intent. Lowest risk of leaving a sibling route broken.
2. **(Alternative, narrower)** remove `rejectMobileClinicalWrite` from the
   `/bookings/create` route line only — smaller diff, but leaves the device gate
   able to mis-fire on any future patient route and doesn't fix the root mismatch.
3. **Fix the masking test (do regardless).** Patient-role test tokens in
   `testClient.js` should default to `deviceType: 'mobile'` (or none) so the
   journey gate exercises the real patient contract; otherwise the next
   patient-route regression is equally invisible. Add a deep test asserting a
   mobile PATIENT can `POST /investigations/bookings/create`.

`rejectMobileClinicalWrite` is auth middleware, so per the QA fix-mode rules this
is not auto-fixed — awaiting user go-ahead on approach (1) + (3).

## Artifacts

- `qa-runs/2026-06-17-dbe2e998/patient/stdout.txt` — the failing stage check.
- Live repro (this session): PATIENT JWT × {none, mobile, desktop} vs
  `POST /api/v1/investigations/bookings/create` → 403 / 403 / 200.
- Guard: `apps/backend/src/middleware/rejectMobileClinicalWriteMiddleware.js:67-100`.
- Mount: `apps/backend/src/routes/investigation/investigationRoutes.js:60`.
- Mask: `apps/backend/src/tests/testClient.js:26`.
- Introduced: `84d882ca` (2026-06-09, "Add staff phone mode and profile controls").

## Fix (2026-06-17)

Branch `qa-fix/patient-investigation-booking-mobile-blocked`. Approach chosen by
the user: **root fix + unmask the test**.

- **Root fix** — `rejectMobileClinicalWriteMiddleware.js` now exempts non-staff
  actors before the device check:
  `const role = req.user?.role; if (role && !isStaff(role)) return next();`.
  The guard is a Staff-app phone-mode policy, and RBAC remains the access
  authority for each route, so a PATIENT self-service write (booking their own
  investigation) is no longer device-gated. This fixes `/bookings/create` plus
  any other patient-reachable route that inherited the guard, at the root. Staff
  routes are unaffected (`isStaff` is true for clinical/staff/admin roles).
- **Unmask the test** — `testClient.js` now defaults PATIENT tokens to
  `deviceType: 'mobile'` (staff stay `'desktop'`), so the journey gate exercises
  the real mobile-patient contract instead of hiding it behind a desktop token.
  Added a unit case to `reject-mobile-clinical-write.test.js` asserting a PATIENT
  (mobile OR no deviceType) is exempted → `next()`.

### Verification
- **Unit:** `reject-mobile-clinical-write.test.js` → 4/4. The three staff cases
  are unchanged (mobile→403, missing→403, desktop→next); the new patient-exempt
  case passes.
- **Live** (running backend, PATIENT JWT × deviceType none/mobile/desktop):
  `POST /investigations/bookings/create` → **200 / 200 / 200** (was 403 / 403 /
  200). The `mobile` case — the real patient — now books successfully.
- **Orchestrator:** patient stage **PASS**; staff **13/13** and clinical
  **18/18** unchanged (staff device-gating intact). A transient `appointments_book`
  409 on re-run was a leftover same-day appointment the reset spine does not
  clear (a minor smoke-idempotency note, not this fix) — cleared and re-ran clean.
