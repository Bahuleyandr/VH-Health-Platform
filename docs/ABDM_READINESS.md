# ABDM Certification Readiness (roadmap C1)

Status date: 2026-06-10. Preflight: `node -r dotenv/config apps/backend/scripts/abdm-preflight.mjs`

ABDM M1/M2/M3 certification is the India-market equivalent of "Epic-level
interop" (and increasingly a government-empanelment requirement). The
platform's substrate is largely built; certification is gated on owner-side
onboarding plus one engineering gap (payload encryption).

## What exists today

| Capability | State | Where |
|---|---|---|
| ABHA linking + verification flows | Built (Phase A) | `src/services/abdm/abdmService.js` |
| Consent artefacts (grant/deny/revoke/expiry) | Built | `abdm_consents` + service |
| Care-context registry | Built | `abdm_care_contexts` |
| Gateway client + token handling | Built (sandbox URLs default) | `src/services/abdm/abdmGateway.js`, `src/config/abdmConfig.js` |
| Routes (admin + patient surfaces) | Mounted; return **503 until `ABDM_CLIENT_ID`/`ABDM_CLIENT_SECRET` are set** | `src/routes/abdm/`, `src/routes/admin/abdmFullRoutes.js` |
| FHIR R4 source data for HI types | Strong after roadmap C3 (Patient/Encounter/Observation/Condition incl. problem list/DiagnosticReport/DocumentReference) | `/api/v1/fhir` |
| Audit trail for consent/PHI access | Hash-chained after roadmap C4 | `clinical_audit_events` |

## Blockers before certification

1. **Sandbox credentials (owner).** Sign up at sandbox.abdm.gov.in, obtain
   `ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET`, choose the HIP id, set
   `ABDM_CALLBACK_URL` to the Cloudflare-tunnelled callback host, then flip
   `ABDM_ENABLED=true`. All four land in the backend sealed secrets, not the
   ConfigMap.
2. **Bridge registration (owner).** Register the bridge URL + HIP/HIU
   capabilities against the sandbox gateway once credentials exist.
3. **FHIR bundle encryption (engineering — the real gap).** M2 data push
   requires ECDH (Curve25519) key agreement + AES-GCM payload encryption
   (the reference implementation is NHA's FIDELIUS). The current
   `dataPush` path builds the correct envelope but with **plaintext**
   `keyMaterial`. Schedule as the first Pillar-C follow-up before any M2
   attempt. Scope: key-pair generation per transfer, shared-secret
   derivation, AES-GCM encrypt, checksum — ~2-3 focused days against the
   sandbox HIU.
4. **Certification suites (owner + engineering together).** M1 (ABHA), M2
   (HIP data push), M3 (HIU) test suites run against the sandbox with NHA
   observers; book after 1–3 close.

## Suggested order

1. Owner completes (1) + (2) → preflight goes green on config.
2. Implement (3) against the sandbox HIU echo service.
3. Dry-run M1 + Scan & Share OPD registration on one reception desk.
4. Book M1/M2 certification; M3 (HIU) after the consent-request UX is
   piloted with one ward.

Keep this document updated per certification attempt; the preflight script
is the machine-readable version of the table above.
