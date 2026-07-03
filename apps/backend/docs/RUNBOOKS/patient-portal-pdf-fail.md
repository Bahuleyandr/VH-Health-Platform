# Runbook — Patient portal PDF / clinical-notes endpoints failing

> Executed via `kubectl` on the on-prem cluster. See
> [`../../../../docs/DEPLOYMENT_GUIDE.md`](../../../../docs/DEPLOYMENT_GUIDE.md)
> for kubeconfig setup.

**Severity:** P2 (degraded patient experience — patient can't view or
download their own discharge summary / final bill / clinical notes. No
clinical-action surface — staff can still treat the patient.)

The patient-portal endpoints landed in Wave 3.4 (commits `4265c90a`
discharge summary, `d1613404` final bill PDF, `e16da020` Rx
visibility, `a5f7c0ba` clinical notes). All four routes are under
`/api/v1/portal/*` and gated by `requirePatient` — the JWT's `uid` is
the only ownership scope; no admin override.

## Symptoms

- Patient reports: "View Discharge Summary returns 'Summary not
  available' but my doctor said it was signed yesterday."
- Patient reports: "Download Bill PDF spins and never completes."
- Patient reports: "Follow-up doctor's note isn't showing up in
  Your Health → Notes."
- Patient reports: "Prescriptions tab says 'You're offline' but I have
  network."

## Mental model

Routes (`apps/backend/src/routes/portal/patientPortalRoutes.js`):

- `GET /api/v1/portal/discharge-summaries` — list signed/delivered for
  self
- `GET /api/v1/portal/discharge-summaries/:id` — detail
- `GET /api/v1/portal/discharge-summaries/admission/:admissionId` —
  latest signed summary for one admission
- `GET /api/v1/portal/bills/:id/pdf` — streams `application/pdf`,
  PHI-logged
- `GET /api/v1/portal/prescriptions/:id/pdf` — JSON with signed R2
  URL; lazily regenerates if `pdf_key` is null
- `GET /api/v1/portal/clinical-notes` — list signed outpatient
  appointment-bound consultation notes only
- `GET /api/v1/portal/clinical-notes/appointment/:appointmentId` —
  signed outpatient notes whose first-class `appointment_id` matches
  the visit

Service layer at `apps/backend/src/services/portal/patientPortalService.js`.

## Investigation steps

### 1. Establish ownership shape

Patient sees no rows? Check whether the patient is correctly linked.
For the failing endpoint, the SQL filter is `patient_uid = req.user.uid`
(or via a JOIN on the admission for discharge summaries).

```bash
# What's in the JWT (decode in shell):
echo "<PASTED_JWT>" | cut -d'.' -f2 | base64 -d 2>/dev/null | jq

# What's in the DB for that uid:
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT id, uid, phone, role, is_minor, guardian_user_id
    FROM users
    WHERE uid = '<PATIENT_UID>'::uuid;"
```

If `is_minor=true` and `guardian_user_id IS NOT NULL`, this is a
delegated-profile case — the guardian app should send
`X-Acting-As-Uid: <minor_uid>` (when delegation lands; see the
follow-up chip from `runs/manual-fix-log-2026-05-13-dependent-profile.md`).
If the header isn't being sent, the guardian's JWT resolves to the
guardian's records, not the minor's — that's the visual-only switcher
bug. Out-of-scope for portal triage; see the delegation runbook.

### 2. Discharge summary "not available" — signed_at gap

The list endpoint filters to `signed_at IS NOT NULL`. The Wave 1
batch-1 markForDischarge fix (commit `f9bbecba`) + Wave 3.4 sign-
stamping (commit `4265c90a`) together ensure
`admissions.summary_signed_at` is set when the doctor signs.
Check the actual state:

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT a.id, a.patient_uid, a.discharge_initiated_at,
           a.summary_signed_at, a.discharge_status,
           ds.id AS discharge_summary_id, ds.status, ds.signed_at, ds.signed_by
    FROM admissions a
    LEFT JOIN discharge_summaries ds ON ds.admission_id = a.id
    WHERE a.patient_uid = '<PATIENT_UID>'::uuid
    ORDER BY a.discharge_initiated_at DESC NULLS LAST
    LIMIT 5;"
```

Three diagnostic shapes:

- **`ds.signed_at IS NOT NULL` but `a.summary_signed_at IS NULL`** —
  the sign-stamping back-write didn't fire. Manually update via the
  doctor's sign endpoint (re-sign trigger), or escalate to a hotfix
  for the writer.
- **`ds.status='draft'` or `ds.signed_at IS NULL`** — the doctor
  hasn't actually signed. Tell the patient to wait + ping the floor.
- **No `discharge_summaries` row at all** — the LLM-driven summary
  generation in Phase 2 failed silently. The discharge desk can
  manually generate via the existing `/discharge-summary/generate`
  endpoint.

### 3. Bill PDF spinning forever

The PDF endpoint streams from `clinicalPdfGenerator.js`. Look for the
specific request in the backend log:

```bash
kubectl -n vhhealth logs deployment/vhhealth-backend --since=10m \
  | grep -E "/portal/bills/.*pdf|generateInvoicePdf" \
  | head -20
```

Common causes:

- **R2 timeout** — the generator uploads the rendered PDF to R2 and
  streams the signed URL back. R2 has a 30s timeout + 2 retries; if
  it's truly down the request hangs until the upstream timeout fires.
  Check R2 health via `/health/metrics` endpoint.
- **Empty invoice** — `billing_invoice_items` for the invoice id is
  empty. The generator should refuse, not hang — file a finding if it
  hangs.
- **PDFKit OOM on a 200+ line invoice** — IPD invoices for long stays
  can blow the heap. Mitigation: bump the dev pod's memory ceiling.

### 4. Prescription "You're offline" false-positive

Wave 3.4 commit `e16da020` swapped the prescriptions tab from
`ApiClient.cachedGet` to plain `ApiClient.get` — this fixed a stale-
cache bug where the tab thought it was offline if the cache had a
non-200 entry. If a patient still sees "You're offline":

- Confirm the patient app version is post-`e16da020` (release tag
  `patient-v*` after 2026-05-12).
- If on the latest version, check `getAppointmentDocuments` —
  Wave 3.4 added synthesised entries from `e_prescriptions`. Bug:
  if `e_prescriptions.patient_uid` is NULL the row won't surface.

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT id, patient_id, patient_uid, doctor_id, doctor_uid,
           status, follow_up_date, created_at
    FROM e_prescriptions
    WHERE patient_id = (
            SELECT id FROM users WHERE uid = '<PATIENT_UID>'::uuid)
       OR patient_uid = '<PATIENT_UID>'::uuid
    ORDER BY created_at DESC
    LIMIT 10;"
```

If rows exist but `patient_uid IS NULL`, that's the Wave-4B-3 backfill
case (migration 205). Re-run the backfill OR file a hotfix to make
the read tolerate NULL `patient_uid` by falling back to a join on
`patient_id`.

### 5. Clinical notes not visible to patient

The patient portal read is deliberately narrow: it shows signed
outpatient notes only when `clinical_notes.appointment_id` is present
and matches the appointment being viewed. In-hospital, ward, procedure,
case-sheet, discharge-source, and legacy JSON/time-window-linked notes
must stay out of the patient portal; discharge content is served through
`/api/v1/portal/discharge-summaries`.

If a patient says the note "exists but isn't visible":

```bash
kubectl -n vhhealth-platform exec -it vhhealth-pg-1 -c postgres -- \
  psql -U vhhealth -d vhhealth -c "
    SELECT cn.id, cn.patient_uid, cn.note_type, cn.status,
           cn.signed_at, cn.signed_by, cn.created_at,
           cn.appointment_id
    FROM clinical_notes cn
    WHERE cn.patient_uid = '<PATIENT_UID>'::uuid
      AND cn.created_at > NOW() - INTERVAL '7 days'
    ORDER BY cn.created_at DESC
    LIMIT 20;"
```

Three shapes:

- `signed_at IS NULL` — doctor hasn't signed; not surfaced by design.
- `signed_at NOT NULL` + `appointment_id IS NULL` — in-hospital or
  legacy unlinked note; not surfaced by design.
- `signed_at NOT NULL` + `status = 'current'` but still hidden — the
  first-class `appointment_id` or `note_type` is outside the portal
  vocabulary; fix the OP writer linkage instead of adding a date-window
  fallback.

## Action

- Discharge `summary_signed_at` gap → escalate to the discharge desk
  to re-sign (re-fires the back-write); hotfix the writer if it
  recurs.
- R2 timeout → check R2 health, escalate to ops; the PDF endpoint
  should fail-loud not hang — file the finding.
- Prescription NULL `patient_uid` → re-run migration 205 backfill OR
  hotfix the read.
- Note visibility → confirm `signed_at NOT NULL`, `appointment_id`
  matches the OP appointment, and `note_type` is portal-visible.

## Post-incident

- [ ] Add a row to `docs/incidents/patient-portal-$(year).md`: patient
      id (anonymized), endpoint, root cause, remediation.
- [ ] If the cause was a backfill miss → audit `e_prescriptions` for
      other NULL UIDs and queue a one-off backfill via the existing
      migration runner.
- [ ] If the cause was the LLM-driven summary failing silently in
      Phase 2 → file a `clinical-safety`-adjacent ticket to surface
      Phase 2 failures (currently fire-and-forget).
- [ ] NEVER directly INSERT into `discharge_summaries` or
      `clinical_notes` to "make it appear" — patient-facing reads must
      have a real signed authorial event.
