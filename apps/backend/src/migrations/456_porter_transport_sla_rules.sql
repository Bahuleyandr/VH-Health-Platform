-- NL-8 P3: global workflow SLA defaults for porter / patient transport.
-- Per-tenant transport settings can tighten task due_at at creation time; these
-- rules keep workflow_sla_instances sourceable and reviewable.

INSERT INTO workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, enabled, metadata, created_at, updated_at)
SELECT NULL::uuid, rule_code, title, trigger_event_type, target_minutes, severity,
       owner_role_codes, escalation_role_codes, TRUE, metadata, NOW(), NOW()
  FROM (
    VALUES
      (
        'porter_transport_general',
        'Porter transport - general movement',
        'porter_transport.requested',
        30,
        'medium',
        ARRAY['DRIVER','DELIVERY_STAFF','AMBULANCE_COORDINATOR']::text[],
        ARRAY['RECEPTION_INCHARGE','IP_INCHARGE','MEDICAL_SUPERINTENDENT']::text[],
        '{"source":"nl8_p3_porter_transport"}'::jsonb
      ),
      (
        'porter_transport_discharge',
        'Porter transport - discharge movement',
        'porter_transport.discharge_requested',
        20,
        'high',
        ARRAY['DRIVER','DELIVERY_STAFF','AMBULANCE_COORDINATOR']::text[],
        ARRAY['RECEPTION_INCHARGE','IP_INCHARGE','MEDICAL_SUPERINTENDENT']::text[],
        '{"source":"nl8_p3_porter_transport","source_type":"discharge"}'::jsonb
      ),
      (
        'porter_transport_transfer',
        'Porter transport - bed or ward transfer',
        'porter_transport.transfer_requested',
        15,
        'high',
        ARRAY['DRIVER','DELIVERY_STAFF','AMBULANCE_COORDINATOR']::text[],
        ARRAY['IP_INCHARGE','NURSING_INCHARGE','MEDICAL_SUPERINTENDENT']::text[],
        '{"source":"nl8_p3_porter_transport","source_type":"transfer"}'::jsonb
      ),
      (
        'porter_transport_sample',
        'Porter transport - diagnostic sample movement',
        'porter_transport.sample_requested',
        20,
        'medium',
        ARRAY['DRIVER','DELIVERY_STAFF','LAB_STAFF','AMBULANCE_COORDINATOR']::text[],
        ARRAY['LAB_INCHARGE','RECEPTION_INCHARGE','MEDICAL_SUPERINTENDENT']::text[],
        '{"source":"nl8_p3_porter_transport","source_type":"sample"}'::jsonb
      ),
      (
        'porter_transport_equipment',
        'Porter transport - equipment movement',
        'porter_transport.equipment_requested',
        45,
        'medium',
        ARRAY['DRIVER','DELIVERY_STAFF','MAINTENANCE','BIOMEDICAL_STAFF']::text[],
        ARRAY['STORES_PURCHASE_INCHARGE','MEDICAL_SUPERINTENDENT']::text[],
        '{"source":"nl8_p3_porter_transport","source_type":"equipment"}'::jsonb
      )
  ) AS seed(rule_code, title, trigger_event_type, target_minutes, severity,
            owner_role_codes, escalation_role_codes, metadata)
 WHERE NOT EXISTS (
   SELECT 1
     FROM workflow_sla_rules existing
    WHERE existing.tenant_id IS NULL
      AND existing.rule_code = seed.rule_code
 );
