# Patient Account Deletion Retention Design

## Scope

The patient app needs a Play-compliant self-service account deletion flow. The endpoint is limited to the authenticated patient account, requires a fresh Firebase OTP re-authentication token, and refuses deletion while the patient has an active inpatient admission.

## Retention Position

The user account row is the identity anchor for clinical records, orders, admissions, audit events, billing references, and medical-record retention duties. Hard-deleting the row would either break foreign keys or remove the audit trail needed to prove who requested deletion and why related clinical records remain. The deletion flow therefore anonymizes the account row and keeps the stable `uid`/tenant linkage so retained clinical records remain internally consistent.

## Data Handling

On deletion, direct identity and contact fields are cleared from `users`, including phone, name, address, email, phone search hash, encrypted identity shadows, device token, guardian contact fields, ABHA/PAN identifiers, and profile image. The row is marked inactive with `is_deleted = true`, `deleted_at`, `deleted_reason`, `status = 'deleted'`, and `firebase_tokens_revoked_at`.

Clinical, billing, and audit records are not hard-deleted. This matches DPDP data minimization expectations while preserving medical-record, safety, financial, and audit obligations. A `clinical_audit_events` row records the patient request and the anonymization boundary.

## Safety Gates

Deletion is blocked with `ACTIVE_ADMISSION_BLOCKS_ACCOUNT_DELETION` when the patient has an active admission. The backend revokes all local JWT sessions, persists the revoke-all marker in `invalidated_tokens`, best-effort revokes Firebase refresh tokens, clears stored FCM tokens on patient devices, and blocks future Firebase login for tombstoned accounts.
