-- Migration 093: batch-56 — add clinical_protocols table.
--
-- cdsEngine.js declares 3 functions against this table (listProtocols,
-- createProtocol, getProtocolReminders) and they're routed at
-- routes/emr/cdsRoutes.js:113/133/157. Pre-batch-56 the table didn't
-- exist, so every call to these endpoints failed at runtime ("relation
-- 'clinical_protocols' does not exist"). The Clinical Decision Support
-- module silently returned empty alerts whenever the protocol-reminder
-- pass was hit.
--
-- The schema is inferred from the cdsEngine writers:
--   - name (text), category (text), trigger_conditions (jsonb),
--     recommendations (jsonb), priority (text), is_active (bool)
-- See cdsEngine.evaluateProtocolTrigger / evaluateUnmetRecommendations
-- for the trigger / recommendations payload shape.
--
-- The table is empty after migration; protocol seeding (e.g. sepsis,
-- VTE prophylaxis) is a separate product step.

BEGIN;

CREATE TABLE IF NOT EXISTS clinical_protocols (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(255)    NOT NULL,
  category            VARCHAR(100)    NOT NULL,
  trigger_conditions  JSONB           NOT NULL DEFAULT '{}'::jsonb,
  recommendations     JSONB           NOT NULL DEFAULT '{}'::jsonb,
  priority            VARCHAR(20)     NOT NULL DEFAULT 'medium',
  is_active           BOOLEAN         NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinical_protocols_category ON clinical_protocols(category);
CREATE INDEX IF NOT EXISTS idx_clinical_protocols_active ON clinical_protocols(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_clinical_protocols_priority ON clinical_protocols(priority);

COMMIT;
