-- Migration 312: results-inbox idempotency + escalation tier seed.
--
-- Activates the dormant mig-118 tasks/escalation foundation for the
-- results-inbox safety net (design: docs/RESULTS_INBOX_ESCALATION_DESIGN.md):
--
--   1. A partial unique index on `tasks (tenant_id, related_resource_type,
--      related_resource_id)` over the still-open statuses, so the
--      results-inbox producer's `ON CONFLICT DO NOTHING` is race-safe:
--      "one OPEN task per result resource". Safe to add — nothing creates
--      `tasks` with a related_resource today, so there is no existing-data
--      conflict.
--
--   2. The default-tenant `escalation_rules` rows for the three
--      critical-result escalation tiers (T1 re-notify / T2 duty role /
--      T3 leadership), so the escalation engine has rules to act on out of
--      the box. The clinical SLA clock itself remains mig-269's pre-seeded
--      `critical_result_ack` rule (15 min) — these rows only describe the
--      ACTIONS taken on breach. Per-tenant seeding is deferred to the
--      operator playbook.
--
-- Both steps are idempotent (IF NOT EXISTS index, WHERE NOT EXISTS seed)
-- so re-applying against a populated DB is a safe no-op.

BEGIN;

-- One OPEN task per result resource → producer ON CONFLICT DO NOTHING is race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_open_per_resource
  ON tasks (tenant_id, related_resource_type, related_resource_id)
  WHERE status IN ('open', 'in_progress', 'blocked')
    AND related_resource_type IS NOT NULL
    AND related_resource_id IS NOT NULL;

-- Default-tenant escalation tiers for the critical_result_ack SLA. Idempotent.
INSERT INTO escalation_rules
  (tenant_id, display_name, description, scope, match_filter, trigger_condition,
   trigger_window_minutes, action_kind, action_payload, is_active)
SELECT '00000000-0000-4000-8000-000000000001'::uuid, v.display_name, v.description,
       'task', v.match_filter::jsonb, 'sla_breach', v.win, v.action_kind, v.action_payload::jsonb, true
FROM (VALUES
  ('Critical result T1 re-notify', 'Re-notify assignee + bump priority at SLA breach',
     '{"task_kind":"review","priority":"critical","sla_key":"critical_result_ack"}', 0,
     'escalate_priority', '{"tier":1,"also_notify":"assignee"}'),
  ('Critical result T2 duty role', 'Notify ward/unit duty/charge role',
     '{"task_kind":"review","priority":"critical","sla_key":"critical_result_ack"}', 10,
     'notify', '{"tier":2,"notify_role":"DUTY"}'),
  ('Critical result T3 leadership', 'Notify clinical leadership + security webhook',
     '{"task_kind":"review","priority":"critical","sla_key":"critical_result_ack"}', 30,
     'notify', '{"tier":3,"notify_role":"LEADERSHIP","security_webhook":true}')
) AS v(display_name, description, match_filter, win, action_kind, action_payload)
WHERE NOT EXISTS (
  SELECT 1 FROM escalation_rules e
  WHERE e.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
    AND e.display_name = v.display_name);

COMMIT;
