-- NL8-P5: predictive census/LOS command-centre settings.
-- Stores the per-tenant governance owner and locks stale forecast hiding on by default.

UPDATE tenants
SET settings = jsonb_set(
      COALESCE(settings, '{}'::jsonb),
      '{nl8_census_los}',
      jsonb_build_object(
        'governance_owner_role', 'BED_MANAGER',
        'freshness_threshold_minutes', 120,
        'decision_support_only', true,
        'review_required', true
      )
      || COALESCE(settings->'nl8_census_los', '{}'::jsonb)
      || jsonb_build_object(
        'hide_stale_forecasts', true,
        'stale_forecasts_hidden_locked', true,
        'settings_version', 'nl8-p5-2026-07-07'
      ),
      true
    ),
    updated_at = NOW();
