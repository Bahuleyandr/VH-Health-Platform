# VH Health Patient Play Store Submission Notes

Prepared for Google Play internal testing of the patient app.

## Build Artifact

- App: VH Health
- Package name: `com.vh.vhhealth`
- Version: `1.1.0+2`
- Internal-test bundle path: `apps/patient/build/app/outputs/bundle/release/app-release.aab`
- Build target: `https://api.vhhealth.app/api/v1`
- Upload keystore path on this workstation: `D:\Dev\Secrets\vhhealth-patient-upload-keystore.jks`
- Local signing config: `apps/patient/android/key.properties`

Keep the keystore and `key.properties` private. They are intentionally ignored by Git.

Production-mode release builds also require the owner-approved current/next
SPKI pin set and the 300-second readiness clock-skew value. The release workflow
must remain blocked until those repository variables are populated; internal
testing is not permission to ship an unpinned production client.

## Firebase Certificate Setup

Firebase Android app:

- Project: `vhhealth`
- App ID: `1:155620159512:android:6b4839756b9f099a9d136d`
- Package: `com.vh.vhhealth`

Registered certificates:

- Debug SHA-1: `95:58:FC:1A:00:31:D0:A5:81:8E:50:63:C0:80:09:6A:24:4E:67:FC`
- Debug SHA-256: `B3:A4:5A:FE:D0:BB:49:C8:0D:63:AC:3B:2C:FB:A2:43:4A:EF:22:F5:2F:90:D5:3C:AB:A9:58:6F:5F:AB:0A:21`
- Upload SHA-1: `C0:A6:C8:AA:45:10:4F:20:C1:1D:B7:BD:D7:27:52:AE:4E:A3:41:47`
- Upload SHA-256: `0E:35:12:17:72:CF:C1:BA:53:95:64:CE:6B:21:0B:6F:F2:B6:7C:9C:5D:BE:C5:E9:C8:7E:04:89:FC:70:88:CB`
- Play App Signing SHA-1: `48:E1:BC:3A:CA:07:9D:95:56:C0:5C:46:13:49:37:51:8E:EE:AF:84`
- Play App Signing SHA-256: `62:37:9D:08:4A:43:34:43:2A:96:A7:12:B9:EA:0B:0B:0F:B4:0C:41:1C:B6:2D:45:CE:82:87:69:ED:8C:15:79`

Play App Signing is enabled and both Google signing fingerprints are registered
with this Firebase app. Play-installed builds are signed by Google, not by the
local upload key.

The Firebase API key used by the Patient Android build must keep application
restrictions unset so Firebase Phone Auth's reCAPTCHA fallback works. Keep only
the required Firebase APIs on its API allowlist, then use App Check and Auth/SMS
quotas as the abuse controls.

The Play Integrity API is linked to Firebase project `vhhealth`, and the Patient
Android app is registered with the Play Integrity App Check provider. Keep
Firebase Authentication enforcement off until a Play-installed build reports
valid App Check requests; then enable enforcement after reviewing those metrics.

## Internal-track automation

The first AAB was uploaded manually because Google Play requires the package to
exist before the Android Publisher API can address it. The automation bootstrap
is now complete:

1. `github-play-patient@vhhealth.iam.gserviceaccount.com` has active access to
   only the Patient app, with read-only app metadata and testing-track release
   permission. It has no production or account-wide access.
2. `GOOGLE_PLAY_WIF_PROVIDER`, `GOOGLE_PLAY_SERVICE_ACCOUNT`, and
   `PATIENT_PLAY_INTERNAL_ENABLED=true` are repository variables.
3. Future `patient-v*` tags build one signed AAB, attach it to the GitHub
   release, authenticate to Google through Workload Identity Federation, and
   publish that same artifact to the Play internal track. No service-account
   private key is stored in GitHub.

## Store Listing Draft

Short description:

`Manage appointments, records, reports, prescriptions, and hospital care in one app.`

Full description:

`VH Health helps patients stay connected with their hospital care journey. Use the app to view appointments, prescriptions, consultations, lab orders, reports, uploaded documents, reminders, messages, and health activity in one place.`

`Patients can sign in by phone, continue as a guest for public hospital information, browse departments, upload previous records, review AI-assisted extraction drafts, track wellness and steps, and sync selected activity data through Google Health Connect where permission is granted.`

`Medical records and hospital data are shown for convenience and continuity of care. The app is not an emergency service and does not replace consultation with qualified healthcare professionals. AI-assisted outputs are labelled as drafts or support information and should be cross-checked with clinicians or original documents before relying on them.`

Suggested category:

- Medical

Suggested tags:

- Hospital
- Patient portal
- Health records
- Appointments
- Prescriptions

## First Release Notes

`Initial internal test release of the VH Health patient app with phone sign-in, guest access, hospital departments, patient profile, appointments, Your Health timeline, prescriptions, consultations, uploads, notifications, steps, wellness, and Health Connect sync.`

## Data Safety Draft

Data collected:

- Personal info: name, phone number, hospital ID, email, gender, birthday, address, emergency contact, insurance details.
- Health and fitness: health records, uploaded reports/images/documents, prescriptions, consultations, vitals, allergies, blood group, step count, walking distance, Health Connect samples where permission is granted.
- App activity: app interactions needed for patient services, reminders, notifications, and feature operation.
- Device or other IDs: Firebase installation, analytics, crash diagnostics, notification tokens.

Data use:

- App functionality.
- Account management and authentication.
- Patient care coordination with authorized hospital staff.
- Analytics and app performance.
- Crash diagnostics and service reliability.

Data sharing:

- Shared with authorized hospital staff and clinical teams involved in patient care.
- Shared with service providers required for app operation, such as Firebase authentication, analytics, crash reporting, notifications, hosting, and backend infrastructure.
- Not sold.
- Not used for advertising.

Security:

- Data is transmitted over encrypted connections.
- App uses authenticated backend sessions for protected patient data.
- User can request account/data correction or deletion through hospital administration.

## Health App Declarations

The app should be declared as a health/patient portal app.

Health-related features:

- Patient records, prescriptions, consultations, uploads, reports, appointments, reminders, hospital messages.
- Health Connect sync for steps, distance, sleep, heart rate, SpO2, weight, body temperature, and calories when user grants permission.
- AI-assisted record extraction and symptom/triage support are labelled as assistive and not diagnostic.

Important review language:

- The app is not for emergency medical assistance.
- The app does not replace direct clinician consultation.
- AI outputs are support/draft information, not autonomous diagnosis or treatment.

## Permissions To Explain In Play Console

Current patient manifest keeps:

- Camera: document/report capture and uploads.
- Photos/media/storage: report and record uploads.
- Calendar: optional appointment calendar events.
- Location: step challenge distance tracking while the user is using the feature.
- Activity recognition: steps and activity challenge support.
- Notifications, exact alarms, boot completed: medication/reminder notifications.
- Health Connect read permissions: wearable/activity/vitals sync after user grants Health Connect access.
- Biometrics: optional local authentication.

Recently removed to reduce policy friction:

- SMS read/receive.
- Background location.
- Phone state.
- Audio recording.
- Battery optimization exemption.
- Notification policy access.

## Before Production

- Publish a public privacy policy URL.
- Add the privacy policy URL in Play Console and keep the in-app Privacy link aligned.
- Upload phone, tablet, and foldable screenshots.
- Run internal testing on at least one Play-installed build and verify Firebase OTP.
- If the developer account requires it, complete the required closed test period before production access.
