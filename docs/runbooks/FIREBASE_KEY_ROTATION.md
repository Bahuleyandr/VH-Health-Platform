# Firebase key rotation + app registration runbook

Operator-facing procedure for the `vhhealth` Firebase project
(project number `155620159512`). Covers rotating the three committed
`AIza…` API keys, registering the missing Firebase apps, and finishing
the App Check rollout started in the Flutter clients.

Why: the original API keys are committed in
`apps/patient/lib/firebase_options.dart` and
`apps/staff/lib/firebase_options.dart` (and in git history), flagged by
audit PAT-2 / PAT-13. The release workflows now inject replacement keys
from GitHub Actions secrets at build time — this runbook provisions those
secrets and locks the new keys down.

Related docs: [`VAULT_SECRET_ROTATION_RUNBOOK.md`](../VAULT_SECRET_ROTATION_RUNBOOK.md)
(backend secret rotation), [`PENTEST_READINESS.md`](../PENTEST_READINESS.md)
(PAT-1/PAT-2 context), [`PATIENT_PLAY_STORE_SUBMISSION.md`](../PATIENT_PLAY_STORE_SUBMISSION.md).

## 1. Rotate the three API keys (Google Cloud console)

The three keys to rotate (first 8 chars): web/Windows `AIzaSyD6…`,
Android `AIzaSyDi…`, iOS/macOS `AIzaSyCw…`.

1. Open Google Cloud console → project `vhhealth` → **APIs & Services →
   Credentials**.
2. For each of the three keys, click **Create credentials → API key** to
   mint a replacement (do NOT delete the old key yet — deployed builds
   still carry it).
3. Apply **application restrictions** to each new key:
   - **Android key**: restriction type *Android apps*. Add package
     `com.vh.vhhealth` with the patient release-keystore SHA-1, and the
     staff package `com.vhhealth.staff.vhhealth_staff` + its release
     SHA-1 once the staff app is registered (step 3).
   - **iOS key**: restriction type *iOS apps*. Add bundle IDs
     `com.vh.vhhealth` (patient — target state, see step 3) and
     `com.vhhealth.staff.vhhealthStaff` (staff).
   - **Web key**: restriction type *Websites (HTTP referrers)*. Allow only
     the staff web origin (`clinical.<hospital>.local`) and
     `vhhealth.firebaseapp.com` (Firebase auth helper domain).
4. Under **API restrictions**, limit each key to the Firebase APIs the
   apps actually call (at minimum: Identity Toolkit, Firebase
   Installations, FCM Registration, Firebase App Check).

## 2. Put the new keys in GitHub Actions secrets

1. GitHub → `Bahuleyandr/VH-Health-Platform` → **Settings → Secrets and
   variables → Actions → New repository secret**. Create:
   - `VH_FIREBASE_WEB_API_KEY` (also used by Windows builds and the
     staff-web image)
   - `VH_FIREBASE_ANDROID_API_KEY`
   - `VH_FIREBASE_IOS_API_KEY`
2. Consumers (already wired): `release-patient.yml` and
   `release-staff.yml` append `--dart-define=VH_FIREBASE_..._API_KEY=…`
   only when the secret is non-empty; `release-images.yml` passes
   `VH_FIREBASE_WEB_API_KEY` into `apps/staff/Dockerfile.web`. An unset
   secret falls back to the committed (old) key, so nothing bricks
   mid-rotation — but the release logs a warning.
3. Cut fresh releases of every lane that bakes keys in: `patient-v*`,
   `staff-v*` tags and a `staff-web-v*` image, then deploy them.
4. After all deployed builds carry the new keys, go back to
   **APIs & Services → Credentials** and **delete the old keys**. The
   committed `defaultValue` fallbacks in both `firebase_options.dart`
   files are then dead credentials; optionally remove the defaults to
   make un-stamped release builds fail fast.

## 3. Register the missing Firebase apps

Firebase console → project `vhhealth` → **Project settings → Your apps**.

1. **Patient iOS**: add an iOS app with bundle ID `com.vh.vhhealth`
   (replacing the placeholder `com.example.vhhealth` registration — the
   Xcode project and `firebase_options.dart` already use the new ID).
   Remove the `com.example.vhhealth` iOS app after cutover. iOS is not a
   shipping release lane today, so this can ride with the first real iOS
   build.
2. **Staff Android**: add an Android app with package
   `com.vhhealth.staff.vhhealth_staff`. Add the staff release keystore
   **SHA-256** digest (required for Play Integrity) and the debug SHA-256
   for dev builds.
3. **Staff iOS**: add an iOS app with bundle ID
   `com.vhhealth.staff.vhhealthStaff`.
4. Regenerate both options files so they point at the new registrations:
   ```bash
   cd apps/patient && flutterfire configure --project=vhhealth
   cd apps/staff   && flutterfire configure --project=vhhealth
   ```
   Then re-apply the `String.fromEnvironment('VH_FIREBASE_…_API_KEY')`
   wrappers (flutterfire overwrites them with raw keys — diff against the
   previous version and keep the security-notice headers).
5. Until steps 2–4 are done, staff `firebase_options.dart` intentionally
   reuses the patient app registrations: FCM keeps working, but
   release-mode App Check attestation for staff will NOT mint tokens.

## 4. App Check rollout (Firebase console → App Check)

1. Under **App Check → Apps**, register each app with its attestation
   provider: patient/staff Android → **Play Integrity**, patient/staff
   iOS → **DeviceCheck**.
2. Debug builds use the debug provider — register each developer's
   printed debug token under **App Check → Apps → Manage debug tokens**.
3. **Staff web**: create a **ReCaptcha v3** site key
   (Google Cloud console → Security → reCAPTCHA, or via the App Check web
   registration flow) for the staff web origin. Store it as GitHub secret
   `VH_RECAPTCHA_SITE_KEY` — `release-images.yml` passes it into the
   staff-web image build. Without it, staff web deliberately skips App
   Check activation (`apps/staff/lib/main.dart`).
4. Leave **enforcement OFF** for all Firebase services until token
   metrics (App Check → Apps → each app's request graph) show a healthy
   ratio of verified requests across deployed app versions. Only then
   flip enforcement per-service (start with Authentication for patient
   OTP).
5. Note: the VH backend now verifies `X-Firebase-AppCheck` tokens on its
   own API too — see the next section for the staged rollout.

## 5. Backend App Check verification (`APP_CHECK_MODE`)

The backend verifies `X-Firebase-AppCheck` on app-facing routes (patient
and staff API clients only — SCIM, HL7, ABDM, NHCX, interface-engine,
cold-chain ingest and the admin portal are exempt). Rollout is staged via
`APP_CHECK_MODE` in the backend configmap:

1. **`off`** (default) — verification skipped entirely.
2. **`report`** — verifies tokens and records outcomes on the
   `app_check_requests_total{outcome,client}` metric without ever
   rejecting a request. Safe to enable at any time, even while the
   console-side app registration (step 3 above) is incomplete and no
   client build sends the header yet — missing tokens are counted, not
   blocked, and a Firebase outage fails open.
3. **`enforce`** — rejects missing/invalid tokens with 401. Flip only
   when the `verified` ratio on `app_check_requests_total` has been
   sustainably healthy across every installed app version — i.e. the
   whole fleet is on builds that attach the token header — mirroring the
   Firebase-console enforcement precondition in step 4 above.
