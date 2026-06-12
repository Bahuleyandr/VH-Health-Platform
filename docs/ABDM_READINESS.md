# ABDM Certification Readiness (roadmap C1)

Status date: 2026-06-12. Preflight: `node -r dotenv/config apps/backend/scripts/abdm-preflight.mjs`

ABDM M1/M2/M3 certification is the India-market equivalent of "Epic-level
interop" (and increasingly a government-empanelment requirement). The
platform's substrate is largely built; certification is gated on owner-side
onboarding plus sandbox interop evidence.

For the wider Indian hospital go-live packet, pair this technical checklist with
[`india-deployment-readiness.md`](india-deployment-readiness.md).

## What exists today

| Capability | State | Where |
|---|---|---|
| ABHA linking + verification flows | Built (Phase A) | `src/services/abdm/abdmService.js` |
| Consent artefacts (grant/deny/revoke/expiry) | Built | `abdm_consents` + service |
| Care-context registry | Built | `abdm_care_contexts` |
| Gateway client + token handling | Built (sandbox URLs default) | `src/services/abdm/abdmGateway.js`, `src/config/abdmConfig.js` |
| Routes (admin + patient surfaces) | Mounted; return **503 until `ABDM_CLIENT_ID`/`ABDM_CLIENT_SECRET` are set** | `src/routes/abdm/`, `src/routes/admin/abdmFullRoutes.js` |
| Callback authenticity | Built; requires `ABDM_CALLBACK_SECRET` in production | `src/routes/abdm/abdmRoutes.js` |
| Callback replay protection | Built; signature timestamp + request id namespace | `src/routes/abdm/abdmRoutes.js` |
| HIP data-push URL SSRF guard | Built; unsafe `dataPushUrl` hosts are rejected before outbound POST | `src/services/abdm/abdmService.js`, `src/services/abdm/abdmGateway.js` |
| FHIR R4 source data for HI types | Strong after roadmap C3 (Patient/Encounter/Observation/Condition incl. problem list/DiagnosticReport/DocumentReference) | `/api/v1/fhir` |
| Audit trail for consent/PHI access | Hash-chained after roadmap C4 | `clinical_audit_events` |

## Blockers before certification

1. **Sandbox credentials and callback secret (owner).** Sign up at
   sandbox.abdm.gov.in, obtain `ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET`, choose
   the HIP id, set `ABDM_CALLBACK_URL` to the approved callback host, generate
   `ABDM_CALLBACK_SECRET`, then flip `ABDM_ENABLED=true`. All required values
   land in backend sealed secrets, not the ConfigMap.
2. **Bridge registration (owner).** Register the bridge URL + HIP/HIU
   capabilities against the sandbox gateway once credentials exist.
3. **FHIR bundle encryption - IMPLEMENTED (2026-06-10, roadmap C1
   follow-up).** `src/services/abdm/abdmCrypto.js` is the
   FIDELIUS-equivalent: per-transfer ephemeral X25519 key pairs + 32-byte
   nonces, HKDF-SHA256 (salt = first 20 bytes of nonce XOR, IV = last 12),
   AES-256-GCM with appended tag. The data-push path now refuses to send
   plaintext (requests without usable HIU key material are marked FAILED),
   POSTs encrypted entries to the HIU's `dataPushUrl` (captured per
   hiRequest, migration 288), embeds OUR public key material in the
   envelope, and fires the `/health-information/notify` leg best-effort.
   Unit-tested against the RFC 7748 X25519 vector + an independent
   AES-GCM re-derivation. Remaining: byte-level interop sign-off against
   the sandbox HIU during the M2 dry run (needs blockers 1-2).
4. **Certification suites (owner + engineering together).** M1 (ABHA), M2
   (HIP data push), M3 (HIU) test suites run against the sandbox with NHA
   observers; book after 1–3 close.
5. **India evidence ledger (owner + engineering).** Migration
   `300_india_deployability_controls.sql` seeds
   `ABDM_CALLBACK_AUTHENTICITY` and `ABDM_M2_ENCRYPTED_PUSH` evidence rows.
   `india-deployability-preflight.mjs` remains red until these are verified,
   accepted as formal exceptions, or marked not applicable for a non-ABDM
   deployment.

## Suggested order

1. Owner completes (1) + (2) → preflight goes green on config.
2. Implement (3) against the sandbox HIU echo service.
3. Dry-run M1 + Scan & Share OPD registration on one reception desk.
4. Book M1/M2 certification; M3 (HIU) after the consent-request UX is
   piloted with one ward.

Keep this document updated per certification attempt; the preflight script
is the machine-readable version of the table above.
