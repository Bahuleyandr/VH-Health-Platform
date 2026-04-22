-- Clinical AI budget and emergency guardrails.

CREATE TABLE IF NOT EXISTS clinical_ai_guardrails (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  external_ai_enabled BOOLEAN NOT NULL DEFAULT true,
  daily_token_limit INTEGER,
  daily_cost_limit_minor INTEGER,
  request_token_limit INTEGER,
  fallback_rate_alert_pct INTEGER NOT NULL DEFAULT 50,
  max_fallbacks_per_day INTEGER,
  latency_alert_ms INTEGER NOT NULL DEFAULT 15000,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO clinical_ai_guardrails
  (id, enabled, external_ai_enabled, fallback_rate_alert_pct, latency_alert_ms)
VALUES
  (1, true, true, 50, 15000)
ON CONFLICT (id) DO NOTHING;
