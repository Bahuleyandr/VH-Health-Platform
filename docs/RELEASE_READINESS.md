# Release Readiness

This checklist is the release gate for patient and staff app tags. It is meant
to answer one question before a tag is pushed: can we prove the app builds,
talks to the backend, and has the required operational guardrails?

**Current status (2026-09-02): HELD / not tag-ready.** PR #872 (`INF-006`)
remains open and draft with an explicit external-containment prerequisite. This
file describes evidence requirements; it does not authorize a tag, workflow
dispatch, publication, deployment, secret change, or ArgoCD sync. OWNER-INPUT —
release authority receipt: ______.

## Held Forgejo configuration inventory

The values below are an inventory for a possible future authorized Forgejo
release path. Do not create, rotate, or rely on them while `INF-006` remains
held. The current audit-program authority requires GitHub Actions as the sole
test/CI execution environment.

- `VH_BASE_URL` as a Forgejo Actions variable.
- `VH_API_KEY` as a Forgejo Actions secret.
- `PATIENT_ANDROID_KEYSTORE_BASE64`
- `PATIENT_ANDROID_KEY_ALIAS`
- `PATIENT_ANDROID_KEY_PASSWORD`
- `PATIENT_ANDROID_STORE_PASSWORD`
- `STAFF_ANDROID_KEYSTORE_BASE64`
- `STAFF_ANDROID_KEY_ALIAS`
- `STAFF_ANDROID_KEY_PASSWORD`
- `STAFF_ANDROID_STORE_PASSWORD`

An authorized future release path must validate these before artifact creation
and fail closed when any required value is missing.

Container and deploy workflows additionally require Forgejo secrets for GHCR
pushes (`GHCR_USERNAME`/`GHCR_TOKEN` or
`CONTAINER_REGISTRY_USERNAME`/`CONTAINER_REGISTRY_PASSWORD`), cosign signing
(`COSIGN_PRIVATE_KEY`, `COSIGN_PASSWORD`, `COSIGN_PUBLIC_KEY`), and the
Dalekdefender path (`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`,
`DALEKDEFENDER_SSH_KEY`).

## Canonical GitHub release gate

Release evidence must be attached to the exact proposed release commit from the
GitHub protected gate. An ordinary affected-path run is not the final release
boundary. After sources are frozen, the exact head requires a no-source-change
`[full-ci]` marker and successful `Merge Gate` plus `Full Merge Gate`; any later
source change invalidates that evidence.

`scripts/local-ci.mjs` and scoped local commands are developer diagnostics only;
they are not release evidence and are not substitutes for GitHub Actions.

## Pre-tag evidence gate

Before any tag, an authorized release captain must attach all of the following
to the exact candidate SHA:

- [ ] INF-006 external containment and named release authority receipt: ______.
- [ ] Exact SHA, `[full-ci]` run URL, `Merge Gate`, and `Full Merge Gate`: ______.
- [ ] Dependency, secret, and supply-chain evidence for that SHA: ______.
- [ ] Signed mobile/container artifact provenance and immutable digest evidence: ______.
- [ ] Completed operational gate in
  [`GO_LIVE_ACTIVATION_CHECKLIST.md`](GO_LIVE_ACTIVATION_CHECKLIST.md), including
  migration, G1, rollback, and owner receipts when the release affects the
  production pilot: ______.

Run the authorized GitHub `Smoke E2E` workflow on the target commit. Local live
staff desktop verification on Windows is supplemental manual evidence only and
must use owner-approved non-PHI test identities:

```powershell
$env:VH_BASE_URL='https://<host>/api/v1'
$env:VH_API_KEY='<release-smoke-api-key>'
.\scripts\smoke-staff-desktop.ps1
```

For role-by-role API workflow verification against the deployed backend, run:

```powershell
$env:VH_BASE_URL='https://<host>/api/v1'
$env:VH_API_KEY='<release-smoke-api-key>'
$env:VH_STAFF_TEST_PASSWORD='<seeded staff password>'
.\scripts\smoke-staff-role-workflows.ps1 -IncludeCreates
```

Attach a freshly generated staff role workflow sweep for the target commit,
backup evidence, and one restore drill record before approving a real
production tag. The committed `docs/STAFF_ROLE_WORKFLOW_SWEEP.md` file is a
historical evidence snapshot, not a substitute for a target-release run.

For Indian hospital production tags, also attach the completed
[`india-deployment-readiness.md`](india-deployment-readiness.md) evidence packet.
The release is not PHI-ready until the ABDM/DPDP/CERT-In, clinical UAT,
backup/DR, privacy policy, and medical-device boundary gates in that runbook are
green or formally risk-accepted.

Production database readiness is tracked in `docs/PRODUCTION_DB_HARDENING.md`.
The DB is not considered production-safe until a restore drill and alert checks
have been completed for the target environment.

## Rollout Sequencing Notes

Backend deploys (ArgoCD sync) and mobile app updates (Play Store / App
Distribution) are decoupled, so contract changes can strand in-field builds.
Known live case:

- **Patient vitals temperature unit (2026-08-18 canonical-unit wave).**
  `POST /health/patient/vitals` now treats a unitless `temperature` as
  Celsius by deliberate contract (unitless = °C; °F senders must declare
  `temperature_unit: 'F'`) and rejects values outside the 12–45 °C
  plausibility band. Patient app builds older than the 2026-08-18 fix still
  send unitless Fahrenheit (e.g. 98.6), so after the backend syncs those
  builds get a **400 for the entire vitals submission** (BP/HR/SpO2 included)
  with the message "temperature must be between 12 and 45 °C". This is the
  intended fail-closed behaviour, not a backend bug: accepting unitless °F
  again would re-corrupt the canonical column. Sequence a patient app release
  (and in-app update nudge) with or ahead of the backend sync, and brief
  support that "can't log vitals / temperature error at 98.6" from an
  un-updated app is resolved by updating the app or omitting the temperature
  field. Legacy stored raw-°F rows are corrected by backend migration
  `718_patient_vitals_legacy_fahrenheit_backfill.sql`.

## Tagging

Only the named release authority may create a tag after every gate above is
complete. The tag namespaces remain separate so authorized workflows do not
collide:

```bash
git tag staff-v1.2.0
git push origin staff-v1.2.0

git tag patient-v1.2.0
git push origin patient-v1.2.0
```

Do not tag if the app is only structurally translated but has not had clinical,
security, and financial wording reviewed for the release locale.

Do not tag while PR #872 remains held, while any production readiness row is
OPEN/STOP, or merely because repository preparation or CI is green.
