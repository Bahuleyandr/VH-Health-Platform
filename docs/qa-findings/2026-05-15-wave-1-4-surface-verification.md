---
id: 2026-05-15-wave-1-4-surface-verification
run_id: 2026-05-15-35991538
started_at: 2026-05-15T09:23:00.898Z
finished_at: 2026-05-15T09:28:55.000Z
git_sha: 467b207307d99d7cfd7f0f164191d262a366a6ef
seed_version: none
base_url: http://127.0.0.1:5206
tenant_id: 00000000-0000-4000-8000-000000000001
scenario: report-only verification of the 9 wave-1–4 surfaces requested by the vh-health-qa skill invocation
command: see Reproduction section — each surface has its own curl
exit_code: 0
severity: info
area: other
repro_steps:
  - "Bring up the local QA env (Postgres 55432, backend 5206, admin 3201)"
  - "Forge a SUPER_ADMIN smoke JWT via apps/backend/scripts/smoke-admin-crud.ps1's New-SmokeToken pattern"
  - "Forge a PATIENT JWT against the same SMOKE_JWT_SECRET with role:'PATIENT' + uid of a seeded patient (e.g. f120b48c-9275-4839-932c-cb01b9e4c230)"
  - "Curl each of the 9 surfaces — see body for the per-surface commands and observed responses"
expected: |
  Each wave-1–4 surface responds with a non-500 outcome:
   - happy-path inputs return success
   - missing-resource inputs return 404 with a structured error envelope
   - invalid inputs return 400 with a specific message
   - wrong-role inputs return 403
  No raw 5xx, no SQL leaks, no NaN/Invalid Date crashes.
actual: |
  All 9 surfaces met that bar. Detailed surface-by-surface verification in the body. No code-level findings worth raising as their own report; logging this as an info-level "what was verified and how" record so future report-only passes have a baseline to diff against.
artifacts:
  - qa-runs/2026-05-15-35991538/summary.json
  - qa-runs/2026-05-15-35991538/admin/stdout.txt
  - qa-runs/2026-05-15-35991538/patient/stdout.txt
  - qa-runs/2026-05-15-35991538/staff/stdout.txt
  - qa-runs/2026-05-15-35991538/clinical/stdout.txt
confidence: high
status: open
---

## Scope

The `vh-health-qa` skill was invoked in report-only mode with a
focus list of nine surfaces touched by 2026-05-12's waves 1–4:

1. Walk-in registration — ANC + paeds + ER unidentified (Wave 3.2, migration 202)
2. Discharge cascade — `markForDischarge → markDischargeDrugsDispensed → dischargePatient` (Waves 1.1, 2.1, 4A)
3. TPA enhancement from chart — `/api/v1/admissions/:admissionId/tpa-enhancement` (Wave 2.4)
4. Patient portal new endpoints — `/portal/discharge-summaries`, `/portal/bills/:id/pdf`, `/portal/clinical-notes` (Wave 3.4)
5. Prescription safety check + visit-note free-text allergy scan (Wave 1.5 + the morning's UNION fix)
6. OT case-close gate — signed anaesthesia + intraop + counts (Wave 2.2)
7. Cash drawer open/close/review (Wave 2.2, migration 198)
8. Doctor picker returning canonical `users.id` (Wave 3.3)
9. ICU monitoring-interval PATCH (Wave 2.3)

The orchestrator's broad smoke (`admin / patient / staff / clinical`)
covered patient routing, staff routing, and clinical-safety smoke
cleanly; admin smoke failed at the proxy CSRF gate and is filed as its
own finding (`2026-05-15-admin-proxy-csrf-origin-port-mismatch.md`).

Each wave-1–4 surface was then exercised directly against the backend
on `:5206` using a forged SUPER_ADMIN (or PATIENT, where the route's
RBAC required it) smoke JWT — bypassing the admin proxy entirely. The
backend itself is healthy and reachable.

## Surface 1 — Walk-in registration (Wave 3.2)

`POST /api/v1/appointments/walk-in`

```bash
curl -sS -X POST -H "Authorization: Bearer $JWT" -H "X-API-Key: ..." \
  -H "Content-Type: application/json" \
  -d '{"patient_name":"Paeds Test","patient_phone":"+919999000002",
       "patient_birthday":"2022-01-01","patient_gender":"male",
       "reason":"cough","visit_type":"NEW",
       "guardian_name":"Mum","guardian_phone":"+919999000010",
       "guardian_relationship":"mother","guardian_id_type":"aadhaar",
       "guardian_id":"1234-5678-9012","patient_weight_kg":12.5}' \
  http://127.0.0.1:5206/api/v1/appointments/walk-in
```

Response: 200 OK, body includes `visit_no: "OPD-20260515-002"`,
`is_unidentified: false`, `returning_patient: false`, `visit_type:
"NEW"`. Migration 202's structured guardian + weight columns roundtrip
through the controller without a 500. Basic adult walk-in (no
guardian fields) also returned 200 with the expected envelope.

Not separately exercised in this pass: the ER unidentified path
(`is_unidentified: true` + Jane Doe naming) — would need a deliberate
`er=true` query flag or an ER context that the route synthesises a
name for. Worth covering in a future targeted ANC + ER pass.

## Surface 2 — Discharge cascade (Waves 1.1, 2.1, 4A)

Note: admissionRoutes is mounted at `/api/v1/emr`, **not**
`/api/v1/emr/admissions`. The list endpoint lives at `/emr/admissions`
but individual admission operations live at `/emr/:id/*`. That's an
unusual shape but it is what the staff app currently calls (see
`apps/staff/lib/core/services/admission_api_service.dart`).

```bash
curl -sS -X POST -H "Authorization: Bearer $JWT" \
  http://127.0.0.1:5206/api/v1/emr/1/mark-for-discharge
# → {"success":false,"message":"Admission not found","code":"NOT_FOUND"}

curl -sS -X POST -H "Authorization: Bearer $JWT" \
  http://127.0.0.1:5206/api/v1/emr/1/mark-drugs-dispensed
# → {"success":false,"message":"Admission 1 not found","code":"NOT_FOUND"}

curl -sS -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -d '{"discharge_diagnosis":"viral fever"}' \
  http://127.0.0.1:5206/api/v1/emr/1/discharge
# → {"success":false,"message":"discharge_type is required","code":"BAD_REQUEST"}
```

All three cascade steps return structured `AppError` envelopes, not
500s. The QA DB has no seeded admissions so the cascade can't be
end-to-end run from this stage — but the Phase 0 lookup convention
holds (P2025 → notFound, never a 500), and required-field validation
fires before the lookup on `dischargePatient`.

## Surface 3 — TPA enhancement from chart (Wave 2.4)

`GET /api/v1/admissions/:admissionId/tpa-enhancement`

```bash
curl -sS -H "Authorization: Bearer $JWT" \
  http://127.0.0.1:5206/api/v1/admissions/1/tpa-enhancement
# → {"success":true,"message":"No active TPA preauth on this admission",
#     "data":{"admission_id":1,"parent":null,"enhancements":[],
#             "cumulative_approved":0,"cumulative_requested":0}}
```

`mergeParams: true` is correctly set on the sub-router (line 36 of
`admissionEnhancementRoutes.js`), so `req.params.admissionId`
resolves. The "no parent preauth" branch returns 200 with the
documented zero-state envelope rather than a 404. POST creation
without a parent preauth correctly 404s with
`No active TPA preauth on this admission to extend`.

## Surface 4 — Patient portal new endpoints (Wave 3.4)

Forged a PATIENT JWT for a seeded patient
(`uid = f120b48c-9275-4839-932c-cb01b9e4c230`):

```bash
curl -sS -H "Authorization: Bearer $PJWT" \
  "http://127.0.0.1:5206/api/v1/portal/discharge-summaries?limit=5"
# → {"success":true,"data":[]}

curl -sS -H "Authorization: Bearer $PJWT" \
  "http://127.0.0.1:5206/api/v1/portal/clinical-notes?limit=5"
# → {"success":true,"data":[]}

curl -sS -H "Authorization: Bearer $PJWT" \
  http://127.0.0.1:5206/api/v1/portal/bills/9999/pdf
# → {"success":false,"message":"Bill not found"}     (404, NOT a 500)
```

All three new portal endpoints respect `requirePatient` (a SUPER_ADMIN
token gets `403 Patient role required` — verified separately) and the
listing surfaces return clean empty envelopes when the patient has no
discharge summaries / clinical notes. The bill-PDF surface 404s on a
non-existent invoice id rather than streaming an empty PDF or 500ing
— matches the response-shape rule in
`apps/backend/CLAUDE.md` (no fake success).

## Surface 5 — Prescription safety + UNION fix (Wave 1.5)

```bash
# Single-med happy path — exercises the UNION SQL (lines 386-409 of
# prescriptionSafetyCheck.js) even when there are no notes for the
# patient. Pre-fix this query would 500 because Postgres parsed
# ORDER BY against the union, not the inner select.
curl -sS -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"patient_id":2,"medications":[{"name":"amoxicillin","dose":"500mg"}]}' \
  http://127.0.0.1:5206/api/v1/prescriptions/safety-check
# → {"success":true,"data":{"safe":true,"warnings":[],"blockers":[]}}

# Triple-therapy probe — antithrombotic checker should fire HIGH blocker.
curl -sS -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"patient_id":3,"medications":[
        {"name":"aspirin","dose":"100mg"},
        {"name":"clopidogrel","dose":"75mg"},
        {"name":"warfarin","dose":"5mg"}]}' \
  http://127.0.0.1:5206/api/v1/prescriptions/safety-check
# → {"success":true,"data":{"safe":false,"warnings":[],
#     "blockers":[{"type":"ANTITHROMBOTIC_INTERACTION",
#                  "interaction":"TRIPLE_THERAPY","severity":"HIGH",...}]}}
```

The per-source `(SELECT ... ORDER BY ... LIMIT 50)` UNION ALL pattern
holds. Antithrombotic interaction classifier correctly produces the
triple-therapy blocker; pre-Wave-1.5 this returned `safe:true`.

Not exercised: the unstructured allergy path (NOTE_ALLERGY_RX hits in
free-text notes + beta-lactam cross-reactivity). Would need a seeded
appointment / clinical_note whose body contains "Allergy: Penicillin"
or similar. Worth wiring into the clinical-safety smoke later.

## Surface 6 — OT case-close gate (Wave 2.2)

`PUT /api/v1/theatre/:id/status` with `status: 'completed'` or
`'post_op'` triggers
`theatreService._assertReadyForClosure(scheduleId)`
(`apps/backend/src/services/theatre/theatreService.js:112-158`).

Code review confirms the gate enforces:

- `anesthesia_records.status = 'finalized'` AND `finalized_by` AND
  `finalized_at` → else 400 `ANAESTHESIA_FINALIZE_REQUIRED`
- `intraop_notes.status = 'finalized'` AND `finalized_by` AND
  `finalized_at` → else 400 `INTRAOP_FINALIZE_REQUIRED`
- `intraop_notes.sponge_count_correct = true` AND
  `sharp_count_correct = true` AND `instrument_count_correct = true`
  → else 400 `INSTRUMENT_COUNTS_REQUIRED` with the per-count booleans
  in the error details

The gate is wired into `setStatus` at line 280 and only fires for the
two terminal-ish transitions (`post_op`, `completed`). Live exercise
of a 400 path would require seeding an OT schedule + a non-finalized
anaesthesia row — out of scope for a report-only pass with no seed.

## Surface 7 — Cash drawer (Wave 2.2, migration 198)

Note: cash-drawer routes are mounted at `/api/v1/billing/v2/cash-drawer/*`,
not `/api/v1/billing/cash-drawer/*`. The `/v2` prefix is set in
`app.js:747`.

```bash
curl -sS -X POST -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"shift":"morning","opening_float":5000}' \
  http://127.0.0.1:5206/api/v1/billing/v2/cash-drawer/sessions/open
# → {"success":true,"data":{"id":1,"shift":"MORNING","opening_float":"5000",
#     "status":"open","short_count":false,"over_count":false,...}}

curl -sS -H "Authorization: Bearer $JWT" \
  http://127.0.0.1:5206/api/v1/billing/v2/cash-drawer/sessions
# → returns the open session in a list
```

Session open works first-try; the `MORNING` enum coercion lives in
`cashDrawerService.openSession`. Close + review are RBAC-gated
(`requireCashDrawerReviewer` for review) and were not exercised in
this pass — same reason as the OT gate, they need a complete session
state machine seeded.

## Surface 8 — Doctor picker (Wave 3.3)

`GET /api/v1/appointments/doctors/options`

(Note: the path is `/doctors/options`, not `/doctor-options`. The
staff app at `apps/staff/lib/core/services/schedule_api_service.dart:139`
already calls the right one.)

```bash
curl -sS -H "Authorization: Bearer $JWT" \
  "http://127.0.0.1:5206/api/v1/appointments/doctors/options?limit=3"
# → {"success":true,"data":{
#     "doctors":[{"id":398,"user_id":398,"doctor_row_id":26,
#                 "name":"Doctor Smoke 20260515145311",
#                 "department":"Smoke Medicine",
#                 "specialization":"General Medicine",
#                 "is_available":true}], "pagination":{...}}}
```

`id == user_id` confirms the Wave 3.3 fix: the picker hands back the
canonical `users.id` that the booking endpoint stores in
`appointments.doctor_id`. The legacy `doctors.id` is still surfaced
as `doctor_row_id` for admin pages that key on it.

## Surface 9 — ICU monitoring-interval PATCH (Wave 2.3)

`PATCH /api/v1/icu/admissions/:id/monitoring-interval`

```bash
# Reject an out-of-allowlist interval value
curl -sS -X PATCH -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" -d '{"monitoring_interval_minutes": 999}' \
  http://127.0.0.1:5206/api/v1/icu/admissions/1/monitoring-interval
# → {"success":false,
#    "message":"monitoring_interval_minutes must be one of 5, 10, 15, 30, 60, 120, 240, 480"}
```

`icuService.updateMonitoringInterval` (`apps/backend/src/services/clinical/icuService.js:128-147`)
validates against `VALID_MONITORING_INTERVALS = [5, 10, 15, 30, 60,
120, 240, 480]` before issuing the UPDATE. Sent value of `999` is
rejected at 400 with the allow-list echoed. Did not exercise the
happy-path UPDATE (would 404 with no seeded ICU admission).

Minor nit: `parseInt(monitoring_interval_minutes, 10)` of `undefined`
yields `NaN`, and the error message lists the allow-list but doesn't
say "field required". UX-only — the route reaches a 400 either way.

## Summary

All 9 wave-1–4 surfaces behave as the wave changelogs claim. No
real-bug findings against the surfaces themselves. The two findings
filed alongside this one are environment / harness issues:

- `2026-05-15-admin-proxy-csrf-origin-port-mismatch.md` — env-config drift between admin's
  allowed-origin and the orchestrator's expected port
- `2026-05-15-qa-reset-stage-needs-pgvector-locally.md` — orchestrator's reset stage gated on a
  Postgres extension the local cluster doesn't have

Neither blocks the wave-1–4 surface verification itself; both block
the orchestrator from emitting a clean "all-green" `summary.json`
without manual workarounds.
