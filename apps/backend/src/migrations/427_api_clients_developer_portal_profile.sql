-- Migration 427: NL-11 S2 developer portal profile for api_clients.
--
-- Keeps the existing api_clients/api_keys spine and adds only the product
-- metadata needed for the P1 developer portal: explicit sandbox/production
-- classification and a query path for environment-aware client lists.

BEGIN;

ALTER TABLE api_clients
  ADD COLUMN IF NOT EXISTS environment VARCHAR(20) NOT NULL DEFAULT 'sandbox';

ALTER TABLE api_clients
  DROP CONSTRAINT IF EXISTS api_clients_environment_chk;

ALTER TABLE api_clients
  ADD CONSTRAINT api_clients_environment_chk
    CHECK (environment IN ('sandbox', 'production'));

CREATE INDEX IF NOT EXISTS idx_api_clients_environment_status
  ON api_clients (tenant_id, environment, status, display_name);

COMMIT;
