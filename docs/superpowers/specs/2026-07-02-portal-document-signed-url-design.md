# Portal claim document signed URL design

**Date:** 2026-07-02  
**Status:** Approved for Batch 2 item 3 implementation  
**Surface:** patient portal TPA claim documents

## Problem

`GET /api/v1/portal/tpa/claims/:id/documents` intentionally returns only
document metadata. The R2 key or URL is not listed because the document packet
can include PHI: discharge summaries, lab reports, ID proof, consent forms, and
clinical summaries. Patients still need to download their own submitted claim
packet for transparency and reimbursement disputes, so downloads need a
separate, auditable, short-lived issuance step.

## Contract

Add:

`GET /api/v1/portal/tpa/claims/:id/documents/:docId/download-url`

The response is a JSON success envelope containing:

- `url`: a short-lived signed GET URL for the underlying R2/local object.
- `expires_in_seconds`: never greater than 300 seconds.
- `document`: patient-visible document metadata only.

The existing document-list endpoint remains metadata-only and never returns
`url`, `file_url`, R2 keys, or storage tokens.

## Authorization

The server verifies all of these before minting a signed URL:

1. The caller is an authenticated `PATIENT`.
2. The target claim belongs to the effective patient and tenant:
   `tpa_claims.id = :id AND tenant_id = req.tenantId AND patient_uid = effectivePatientUid`.
3. The target document belongs either to that claim or to the claim's linked
   `preauth_id`.
4. The document row is tenant-scoped to the same tenant.

Misses return 404 so another patient cannot distinguish a missing document from
a document they do not own. Invalid numeric ids return 400.

For E6 proxy reads, the endpoint accepts the same `for_patient` query parameter
used by lab results. It must resolve through `portal_proxy_grants` with a
document-download scope (`claim_documents`). The proxy access audit written by
`resolvePortalPatient` includes the grant id; the download issuance audit also
stores that grant id in metadata.

## Signed URL policy

Signed GET TTL is capped at 300 seconds. R2 production uses the existing S3
presigner. Local/dev uses the existing `/api/v1/storage/file/*?token=...` route,
whose HMAC token is rejected after expiry. The portal endpoint never streams
claim-document bytes itself and never lists reusable URLs; each click mints one
new short-lived URL after ownership is re-checked.

`file_url` values are normalized into storage keys server-side. Existing rows
may hold either `r2://key`, `local://key`, or an R2 HTTPS URL. Unsupported or
empty locators are treated as unavailable and return 404.

## Audit and PHI logging

Each successful issuance records both layers:

- `phiAccessLogger('TPA_CLAIM_DOCUMENT')` on the route records the HIPAA access
  trail after the 2xx response. Denied 403/404 attempts are also captured when
  patient context is available.
- `clinical_audit_events` receives an append-only row with action
  `portal.tpa_claim_document_download_url_issued`, resource table
  `tpa_claim_documents`, resource id `docId`, patient uid, tenant id, actor uid,
  request id, IP, and metadata containing `claim_id`, `doc_type`, `file_name`,
  `expires_in_seconds`, and optional `proxy_grant_id`.

The audit insert is not used as an authorization decision, but failures are
logged by the canonical audit helper and must not leak a URL before ownership
checks pass.

## Client behavior

The patient app fetches document metadata in the claim detail screen. Each row
shows file name, type, size, and uploaded date plus a download button. Tapping
the button calls the issuance endpoint, downloads the returned URL through the
existing encrypted cache helper, and opens the staged plaintext copy with the
existing document opener path. Expired URLs are not retried blindly; the user can
tap download again, causing a fresh server-side ownership check and URL issuance.
