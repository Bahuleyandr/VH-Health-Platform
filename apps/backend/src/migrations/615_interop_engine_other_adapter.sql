-- C6.1-E / I05 OTHER: activate exactly one additional protocol adapter.
-- Existing messages, receipts, recovery holds, and workers remain inert.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

ALTER TABLE public.interop_backend_delivery_receipts
  DROP CONSTRAINT chk_interop_backend_receipts_protocol,
  DROP CONSTRAINT chk_interop_backend_receipts_adapter_direction,
  ADD CONSTRAINT chk_interop_backend_receipts_protocol
    CHECK (protocol IN ('hl7v2', 'csv', 'json', 'fhir_json', 'other')),
  ADD CONSTRAINT chk_interop_backend_receipts_adapter_direction
    CHECK (
      (protocol = 'hl7v2' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.preview'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (protocol = 'hl7v2' AND direction = 'outbound'
        AND adapter_key = 'external.hl7v2.http'
        AND receipt_status IN ('accepted', 'send_held'))
      OR
      (protocol = 'csv' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.csv'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (protocol = 'csv' AND direction = 'outbound'
        AND adapter_key = 'external.csv.http'
        AND receipt_status IN ('accepted', 'send_held'))
      OR
      (protocol = 'json' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.json'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (protocol = 'json' AND direction = 'outbound'
        AND adapter_key = 'external.json.http'
        AND receipt_status IN ('accepted', 'send_held'))
      OR
      (protocol = 'fhir_json' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.fhir-json'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (protocol = 'fhir_json' AND direction = 'outbound'
        AND adapter_key = 'external.fhir-json.http'
        AND receipt_status IN ('accepted', 'send_held'))
      OR
      (protocol = 'other' AND direction = 'inbound'
        AND adapter_key = 'backend.interop.other-envelope'
        AND receipt_status IN ('accepted', 'pending_review'))
      OR
      (protocol = 'other' AND direction = 'outbound'
        AND adapter_key = 'external.other-envelope.http'
        AND receipt_status IN ('accepted', 'send_held'))
    );

COMMIT;
