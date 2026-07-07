-- NL-7 P2: cold-chain task/SLA escalation defaults.
-- MQTT remains a documented adapter seam only; MVP transport is local HTTP
-- push through the gateway or directly to the backend token-auth route.

INSERT INTO workflow_sla_rules
  (rule_code, title, trigger_event_type, target_minutes, severity, owner_role_codes, escalation_role_codes, metadata)
VALUES
  ('cold_chain_excursion_ack', 'Cold-chain excursion acknowledgement', 'cold_chain.excursion_opened', 15, 'critical',
   ARRAY['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'LAB_STAFF', 'LAB_INCHARGE', 'BLOOD_BANK_TECHNICIAN', 'NURSING_STAFF', 'NURSING_INCHARGE', 'OT_NURSE', 'OT_INCHARGE']::TEXT[],
   ARRAY['CMO', 'CNO', 'MEDICAL_SUPERINTENDENT', 'ADMIN']::TEXT[],
   '{"description":"Open cold-chain excursions must be acknowledged and reviewed by the responsible unit role"}'::jsonb)
ON CONFLICT ((COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), rule_code)
DO UPDATE SET
  title = EXCLUDED.title,
  trigger_event_type = EXCLUDED.trigger_event_type,
  target_minutes = EXCLUDED.target_minutes,
  severity = EXCLUDED.severity,
  owner_role_codes = EXCLUDED.owner_role_codes,
  escalation_role_codes = EXCLUDED.escalation_role_codes,
  metadata = EXCLUDED.metadata,
  enabled = TRUE,
  updated_at = NOW();

INSERT INTO escalation_rules
  (tenant_id, display_name, description, scope, match_filter, trigger_condition,
   trigger_window_minutes, action_kind, action_payload, is_active)
SELECT '00000000-0000-4000-8000-000000000001'::uuid, v.display_name, v.description,
       'task', v.match_filter::jsonb, 'sla_breach', v.win, v.action_kind, v.action_payload::jsonb, true
FROM (VALUES
  ('Cold-chain T1 re-notify', 'Re-notify assigned cold-chain role and bump priority at SLA breach',
     '{"task_kind":"review","sla_key":"cold_chain_excursion_ack"}', 0,
     'escalate_priority', '{"tier":1,"also_notify":"assignee"}'),
  ('Cold-chain T2 duty role', 'Notify duty role for unacknowledged cold-chain excursion',
     '{"task_kind":"review","sla_key":"cold_chain_excursion_ack"}', 10,
     'notify', '{"tier":2,"notify_role":"DUTY"}'),
  ('Cold-chain T3 leadership', 'Notify leadership for unacknowledged cold-chain excursion',
     '{"task_kind":"review","sla_key":"cold_chain_excursion_ack"}', 30,
     'notify', '{"tier":3,"notify_role":"LEADERSHIP","security_webhook":true}')
) AS v(display_name, description, match_filter, win, action_kind, action_payload)
WHERE NOT EXISTS (
  SELECT 1 FROM escalation_rules e
  WHERE e.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
    AND e.display_name = v.display_name
);
