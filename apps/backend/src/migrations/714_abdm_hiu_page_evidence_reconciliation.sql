-- 714_abdm_hiu_page_evidence_reconciliation.sql
--
-- Forward-only repair for the published migration 707 HIU page backfill.
-- Migration 707 could under-count parts_received when an already-bound page
-- and a legacy 703 page coexisted in one session, and legacy webhook rows did
-- not persist the authenticated HIP or raw-body hash. Reconcile counters from
-- the complete durable ledger only after every completed page is proven by an
-- exact signed callback bound to tenant, environment, transaction, page, page
-- count, entry count, and the HIP named by the consent artefact.
--
-- Published-703 events can be accepted only when the authenticated callback
-- itself retained its HIP identity and every bundle on the page carries 707's
-- deterministic legacy provenance. Current tenant credentials are not
-- historical signer evidence. Mixed native/legacy parts on one page,
-- duplicate receipts, malformed protocol integers, and missing or ambiguous
-- provider identity abort the whole migration.

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.m714_consent_hip(metadata JSONB, signed_payload JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  parsed_payload JSONB;
  hip_id TEXT;
BEGIN
  hip_id := NULLIF(BTRIM(metadata->>'hip_id'), '');
  IF hip_id IS NOT NULL THEN
    RETURN hip_id;
  END IF;

  parsed_payload := signed_payload;
  IF JSONB_TYPEOF(parsed_payload->'raw') = 'string' THEN
    BEGIN
      parsed_payload := (parsed_payload->>'raw')::jsonb;
    EXCEPTION WHEN OTHERS THEN
      RETURN NULL;
    END;
  END IF;
  RETURN NULLIF(BTRIM(parsed_payload #>> '{hip,id}'), '');
END;
$$;

CREATE TEMP TABLE _m714_hiu_pages ON COMMIT DROP AS
SELECT p.id AS page_id,
       p.tenant_id,
       p.fetch_session_id,
       p.page_number,
       p.page_count,
       BTRIM(p.payload_sha256) AS payload_sha256,
       p.status AS page_status,
       s.status AS session_status,
       s.environment,
       s.transaction_id,
       s.consent_artifact_id,
       s.pages_expected,
       pg_temp.m714_consent_hip(a.metadata, a.signed_payload) AS expected_hip_id,
       bundle_stats.bundle_count,
       bundle_stats.legacy_bundle_count,
       bundle_stats.legacy_metadata_valid,
       bundle_stats.legacy_ledger_sha256
  FROM abdm_hiu_fetch_pages p
  JOIN abdm_hiu_fetch_sessions s
    ON s.tenant_id = p.tenant_id AND s.id = p.fetch_session_id
  LEFT JOIN abdm_consent_artifacts a
    ON a.id = s.consent_artifact_id
   AND a.tenant_id = s.tenant_id
   AND a.environment = s.environment
  LEFT JOIN LATERAL (
    SELECT COUNT(b.id)::integer AS bundle_count,
           COUNT(b.id) FILTER (
             WHERE b.metadata->>'page_identity_backfilled_by'
                   = '707_abdm_uhi_security_upgrade'
           )::integer AS legacy_bundle_count,
           COALESCE(BOOL_AND(
             CASE
               WHEN b.metadata->>'page_identity_backfilled_by'
                    <> '707_abdm_uhi_security_upgrade' THEN FALSE
               WHEN (b.metadata->>'legacy_global_part_number') !~ '^[0-9]+$' THEN FALSE
               ELSE (b.metadata->>'legacy_global_part_number')::numeric
                    = ((p.page_number::numeric - 1) * 1000) + b.part_number
             END
           ), FALSE) AS legacy_metadata_valid,
           ENCODE(DIGEST(
             STRING_AGG(
               b.id::text || ':'
                 || (b.metadata->>'legacy_global_part_number') || ':'
                 || BTRIM(b.bundle_sha256),
               '|' ORDER BY b.part_number, b.id
             ),
             'sha256'
           ), 'hex') AS legacy_ledger_sha256
      FROM abdm_hiu_received_bundles b
     WHERE b.tenant_id = p.tenant_id
       AND b.fetch_session_id = p.fetch_session_id
       AND b.fetch_page_id = p.id
       AND b.page_number = p.page_number
  ) bundle_stats ON TRUE
 WHERE p.status = 'completed' OR bundle_stats.bundle_count > 0;

CREATE TEMP TABLE _m714_hiu_evidence ON COMMIT DROP AS
SELECT page.*,
       event.id AS event_id,
       CASE
         WHEN JSONB_TYPEOF(event.payload->'pageNumber') = 'number'
          AND (event.payload->>'pageNumber') ~ '^[0-9]+$'
         THEN (event.payload->>'pageNumber')::numeric
       END AS evidence_page_number,
       CASE
         WHEN JSONB_TYPEOF(event.payload->'pageCount') = 'number'
          AND (event.payload->>'pageCount') ~ '^[0-9]+$'
         THEN (event.payload->>'pageCount')::numeric
       END AS evidence_page_count,
       CASE
         WHEN JSONB_TYPEOF(event.payload->'entryCount') = 'number'
          AND (event.payload->>'entryCount') ~ '^[0-9]+$'
         THEN (event.payload->>'entryCount')::numeric
       END AS evidence_entry_count,
       event.payload->>'payloadSha256' AS evidence_payload_sha256,
       NULLIF(BTRIM(event.payload->>'authenticatedHipId'), '') AS authenticated_hip_id,
       COALESCE(event.payload ? 'authenticatedHipId', FALSE) AS authenticated_hip_recorded,
       COALESCE(event.payload ? 'payloadSha256', FALSE) AS payload_sha256_recorded
  FROM _m714_hiu_pages page
  LEFT JOIN abdm_webhook_events event
    ON event.tenant_id = page.tenant_id
   AND event.environment = page.environment
   AND event.event_type = 'hiu_data_push'
   AND event.signature_verified IS TRUE
   AND event.external_event_id
       = page.transaction_id || ':page:' || page.page_number::text
   AND event.payload->>'transactionId' = page.transaction_id
   AND CASE
         WHEN JSONB_TYPEOF(event.payload->'pageNumber') = 'number'
          AND (event.payload->>'pageNumber') ~ '^[0-9]+$'
         THEN (event.payload->>'pageNumber')::numeric
       END = page.page_number;

DO $hiu_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM _m714_hiu_pages
     WHERE legacy_bundle_count > 0
       AND legacy_bundle_count <> bundle_count
  ) THEN
    RAISE EXCEPTION
      '714 preflight: native and 707-backfilled HIU parts are mixed on one page'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM _m714_hiu_pages
     WHERE bundle_count > 0 AND page_status <> 'completed'
  ) THEN
    RAISE EXCEPTION
      '714 preflight: a non-completed HIU page owns retained bundles'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM _m714_hiu_evidence
     GROUP BY page_id
    HAVING COUNT(event_id) <> 1
  ) THEN
    RAISE EXCEPTION
      '714 preflight: each completed HIU page requires exactly one authenticated callback receipt'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM _m714_hiu_evidence e
     WHERE e.event_id IS NOT NULL
       AND (
         e.evidence_page_number IS NULL
         OR e.evidence_page_number < 1
         OR e.evidence_page_number > 2147483647
         OR e.evidence_page_number <> e.page_number
         OR e.evidence_page_count IS NULL
         OR e.evidence_page_count < 1
         OR e.evidence_page_count > 2147483647
         OR e.evidence_page_number > e.evidence_page_count
         OR e.evidence_page_count <> e.page_count
         OR e.evidence_entry_count IS NULL
         OR e.evidence_entry_count < 0
         OR e.evidence_entry_count > 1000
         OR e.evidence_entry_count <> e.bundle_count
         OR e.expected_hip_id IS NULL
         OR e.authenticated_hip_id IS NULL
         OR e.authenticated_hip_id <> e.expected_hip_id
         OR NOT e.authenticated_hip_recorded
         OR (
           e.payload_sha256_recorded
           AND (
             e.evidence_payload_sha256 IS NULL
             OR e.evidence_payload_sha256 !~ '^[0-9a-f]{64}$'
             OR e.evidence_payload_sha256 <> e.payload_sha256
           )
         )
         OR (
           NOT e.payload_sha256_recorded
           AND (
             e.bundle_count = 0
             OR e.legacy_bundle_count <> e.bundle_count
             OR NOT e.legacy_metadata_valid
             OR e.legacy_ledger_sha256 <> e.payload_sha256
           )
         )
       )
  ) THEN
    RAISE EXCEPTION
      '714 preflight: HIU callback evidence is malformed, ambiguous, or not bound to its page and consent HIP'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM _m714_hiu_pages
     GROUP BY tenant_id, fetch_session_id, session_status, pages_expected
    HAVING MIN(page_number) <> 1
        OR COUNT(DISTINCT page_number) <> MAX(page_number)
        OR MIN(page_count) <> MAX(page_count)
        OR MAX(page_number) > MAX(page_count)
        OR (
          pages_expected IS NOT NULL
          AND pages_expected <> MAX(page_count)
        )
        OR (
          session_status IN ('completed', 'partial')
          AND (
            COUNT(DISTINCT page_number) <> MAX(page_count)
            OR BOOL_OR(page_status <> 'completed')
          )
        )
  ) THEN
    RAISE EXCEPTION
      '714 preflight: HIU session page ledger is non-contiguous or conflicts with its declared page count'
      USING ERRCODE = '23514';
  END IF;
END
$hiu_preflight$;

-- Normalize the verified legacy source so the upgraded runtime need not keep
-- reparsing it. Only artifacts whose page evidence passed the complete
-- preflight above participate in this backfill.
WITH proven_artifacts AS (
  SELECT DISTINCT tenant_id, consent_artifact_id, expected_hip_id
    FROM _m714_hiu_pages
   WHERE consent_artifact_id IS NOT NULL AND expected_hip_id IS NOT NULL
)
UPDATE abdm_consent_artifacts artifact
   SET metadata = jsonb_set(
         artifact.metadata,
         '{hip_id}',
         to_jsonb(proven.expected_hip_id),
         TRUE
       ),
       updated_at = NOW()
  FROM proven_artifacts proven
 WHERE artifact.tenant_id = proven.tenant_id
   AND artifact.id = proven.consent_artifact_id
   AND NULLIF(BTRIM(artifact.metadata->>'hip_id'), '') IS NULL;

WITH page_stats AS (
  SELECT p.id,
         COUNT(b.id)::integer AS bundle_count
    FROM abdm_hiu_fetch_pages p
    LEFT JOIN abdm_hiu_received_bundles b
      ON b.tenant_id = p.tenant_id
     AND b.fetch_session_id = p.fetch_session_id
     AND b.fetch_page_id = p.id
     AND b.page_number = p.page_number
   GROUP BY p.id
)
UPDATE abdm_hiu_fetch_pages p
   SET parts_count = stats.bundle_count,
       updated_at = NOW()
  FROM page_stats stats
 WHERE p.id = stats.id
   AND p.parts_count IS DISTINCT FROM stats.bundle_count;

WITH session_stats AS (
  SELECT s.tenant_id,
         s.id AS fetch_session_id,
         COUNT(b.id)::integer AS bundle_count,
         MAX(p.page_count)::integer AS page_count,
         COALESCE(
           MIN(p.page_number) FILTER (WHERE p.status <> 'completed'),
           MAX(p.page_number) + 1
         )::integer AS next_page_number
    FROM abdm_hiu_fetch_sessions s
    JOIN abdm_hiu_fetch_pages p
      ON p.tenant_id = s.tenant_id AND p.fetch_session_id = s.id
    LEFT JOIN abdm_hiu_received_bundles b
      ON b.tenant_id = s.tenant_id
     AND b.fetch_session_id = s.id
     AND b.fetch_page_id = p.id
     AND b.page_number = p.page_number
   GROUP BY s.tenant_id, s.id
)
UPDATE abdm_hiu_fetch_sessions s
   SET parts_received = stats.bundle_count,
       pages_expected = stats.page_count,
       next_page_number = stats.next_page_number,
       updated_at = NOW()
  FROM session_stats stats
 WHERE s.tenant_id = stats.tenant_id
   AND s.id = stats.fetch_session_id
   AND (
     s.parts_received IS DISTINCT FROM stats.bundle_count
     OR s.pages_expected IS DISTINCT FROM stats.page_count
     OR s.next_page_number IS DISTINCT FROM stats.next_page_number
   );

COMMENT ON TABLE abdm_hiu_fetch_pages IS
  'Durable exact-payload page claims. Native pages bind the authenticated HIP and raw-body SHA-256; migration-707 pages require retained callback signer evidence and deterministic bundle-ledger provenance. Bundle and session counts are reconciled by migration 714.';

COMMIT;
