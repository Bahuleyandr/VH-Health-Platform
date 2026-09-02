BEGIN;

-- Migration 759 repaired this function's plpgsql syntax but retained rule codes
-- that are not emitted by the clinical alert delivery recovery workflow. Replace
-- the function forward with the same guard and the canonical runtime rule codes.
CREATE OR REPLACE FUNCTION public.clinical_alert_delivery_recovery_escalation_snapshot_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  recovery_case clinical_alert_delivery_recovery_cases%ROWTYPE;
  obligation_record clinical_alert_delivery_obligations%ROWTYPE;
  task_record tasks%ROWTYPE;
  old_version TEXT := OLD.metadata->>'recovery_escalation_version';
  new_version TEXT := NEW.metadata->>'recovery_escalation_version';
  recipient_count INTEGER;
  eligible_count INTEGER;
  exact_outbox_count INTEGER;
  exact_recipient_count INTEGER;
  missing_recipient_count INTEGER;
  extra_recipient_count INTEGER;
BEGIN
  IF NEW.rule_code NOT IN (
       'clinical_alert_delivery_manual_hold_review',
       'clinical_alert_delivery_recipient_coverage'
     )
     AND OLD.rule_code NOT IN (
       'clinical_alert_delivery_manual_hold_review',
       'clinical_alert_delivery_recipient_coverage'
     )
  THEN
    RETURN NULL;
  END IF;

  IF old_version = 'clinical_alert_delivery_recovery_escalation_v1' THEN
    IF NEW.escalated_at IS DISTINCT FROM OLD.escalated_at
       OR NEW.metadata->'recovery_escalation_version'
            IS DISTINCT FROM OLD.metadata->'recovery_escalation_version'
       OR NEW.metadata->'recovery_escalation_recipient_count'
            IS DISTINCT FROM OLD.metadata->'recovery_escalation_recipient_count'
       OR NEW.metadata->'recovery_escalation_outbox_ids'
            IS DISTINCT FROM OLD.metadata->'recovery_escalation_outbox_ids'
       OR NEW.metadata->'recovery_escalated_at'
            IS DISTINCT FROM OLD.metadata->'recovery_escalated_at'
    THEN
      RAISE EXCEPTION 'clinical alert recovery escalation snapshot is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;

  IF new_version IS NULL
     AND NEW.escalated_at IS NULL
     AND NEW.status IS DISTINCT FROM 'escalated'
  THEN
    RETURN NULL;
  END IF;

  SELECT recovery.*
    INTO recovery_case
    FROM clinical_alert_delivery_recovery_cases recovery
   WHERE recovery.tenant_id = NEW.tenant_id
     AND recovery.workflow_sla_instance_id = NEW.id;
  SELECT obligation.*
    INTO obligation_record
    FROM clinical_alert_delivery_obligations obligation
   WHERE obligation.tenant_id = recovery_case.tenant_id
     AND obligation.id = recovery_case.obligation_id;
  SELECT task.*
    INTO task_record
    FROM tasks task
   WHERE task.tenant_id = recovery_case.tenant_id
     AND task.id = recovery_case.task_id;

  IF recovery_case.id IS NULL
     OR obligation_record.id IS NULL
     OR task_record.id IS NULL
     OR new_version IS DISTINCT FROM
          'clinical_alert_delivery_recovery_escalation_v1'
     OR OLD.escalated_at IS NOT NULL
     OR NEW.escalated_at IS NULL
     OR NEW.status IS DISTINCT FROM 'escalated'
     OR NEW.breached_at IS NULL
     OR recovery_case.escalated_at IS NULL
     OR recovery_case.last_escalation_error_code IS NOT NULL
     OR recovery_case.escalation_attempt_count <= 0
     OR date_trunc('milliseconds', recovery_case.escalated_at)
          IS DISTINCT FROM date_trunc('milliseconds', NEW.escalated_at)
     OR date_trunc('milliseconds', recovery_case.last_escalation_attempt_at)
          IS DISTINCT FROM date_trunc('milliseconds', NEW.escalated_at)
     OR COALESCE(NEW.metadata->>'recovery_escalation_recipient_count', '')
          !~ '^[1-9][0-9]*$'
     OR jsonb_typeof(NEW.metadata->'recovery_escalation_outbox_ids')
          IS DISTINCT FROM 'array'
     OR task_record.metadata->>'task_contract'
          IS DISTINCT FROM 'clinical_alert_delivery_recovery_v1'
     OR task_record.workflow_sla_instance_id IS DISTINCT FROM NEW.id
     OR task_record.metadata->'recovery_escalation_version'
          IS DISTINCT FROM NEW.metadata->'recovery_escalation_version'
     OR task_record.metadata->'recovery_escalation_recipient_count'
          IS DISTINCT FROM NEW.metadata->'recovery_escalation_recipient_count'
     OR task_record.metadata->'recovery_escalation_outbox_ids'
          IS DISTINCT FROM NEW.metadata->'recovery_escalation_outbox_ids'
     OR task_record.metadata->'recovery_escalated_at'
          IS DISTINCT FROM NEW.metadata->'recovery_escalated_at'
     OR (CASE
          WHEN pg_input_is_valid(
            NEW.metadata->>'recovery_escalated_at',
            'timestamp with time zone'
          )
            THEN date_trunc(
                   'milliseconds',
                   (NEW.metadata->>'recovery_escalated_at')::timestamptz
                 ) IS DISTINCT FROM date_trunc('milliseconds', NEW.escalated_at)
          ELSE TRUE
        END)
  THEN
    RAISE EXCEPTION 'clinical alert recovery escalation snapshot is incomplete'
      USING ERRCODE = '23514';
  END IF;

  recipient_count := (
    NEW.metadata->>'recovery_escalation_recipient_count'
  )::integer;
  IF jsonb_array_length(NEW.metadata->'recovery_escalation_outbox_ids')
       IS DISTINCT FROM recipient_count
  THEN
    RAISE EXCEPTION 'clinical alert recovery escalation outbox set is incomplete'
      USING ERRCODE = '23514';
  END IF;

  WITH eligible AS MATERIALIZED (
    SELECT recipient.uid::text AS recipient_id,
           recipient.role,
           CASE
             WHEN LOWER(
                    SPLIT_PART(
                      REPLACE(COALESCE(recipient.preferred_language, ''), '_', '-'),
                      '-',
                      1
                    )
                  ) IN ('en', 'hi', 'ta', 'te', 'ml')
               THEN LOWER(
                      SPLIT_PART(
                        REPLACE(COALESCE(recipient.preferred_language, ''), '_', '-'),
                        '-',
                        1
                      )
                    )
             ELSE 'en'
           END AS presentation_locale
      FROM users recipient
     WHERE recipient.tenant_id = recovery_case.tenant_id
       AND recipient.role IN ('ADMIN', 'SUPER_ADMIN')
       AND recipient.is_active = TRUE
       AND COALESCE(recipient.is_deleted, FALSE) = FALSE
       AND recipient.deleted_at IS NULL
       AND LOWER(COALESCE(recipient.status, 'active')) = 'active'
     ORDER BY recipient.last_sign_in_at DESC NULLS LAST, recipient.id ASC
     LIMIT 25
  ), outbox_ids AS MATERIALIZED (
    SELECT outbox_id.value
      FROM jsonb_array_elements_text(
             NEW.metadata->'recovery_escalation_outbox_ids'
           ) outbox_id(value)
  ), actual AS MATERIALIZED (
    SELECT outbox.id::text AS outbox_id,
           outbox.recipient_id,
           outbox.payload->>'recipient_role' AS recipient_role,
           outbox.payload->>'presentation_locale' AS presentation_locale
      FROM notification_outbox outbox
      JOIN outbox_ids selected ON selected.value = outbox.id::text
     WHERE outbox.tenant_id = recovery_case.tenant_id
       AND outbox.recipient_id IS NOT NULL
       AND outbox.source_event_key =
             'clinical-alert-recovery-case:' || recovery_case.id::text
             || ':overdue:' || outbox.recipient_id
       AND outbox.type = 'clinical_alert_delivery_recovery_overdue'
       AND outbox.channel = 'push'
       AND outbox.payload->>'presentation_locale' IN (
             'en', 'hi', 'ta', 'te', 'ml'
           )
       AND outbox.title = CASE outbox.payload->>'presentation_locale'
             WHEN 'hi' THEN
               'क्लिनिकल अलर्ट डिलीवरी रिकवरी की समय-सीमा बीत गई है'
             WHEN 'ta' THEN
               'மருத்துவ எச்சரிக்கை வழங்கல் மீட்பு காலக்கெடுவை கடந்துவிட்டது'
             WHEN 'te' THEN
               'క్లినికల్ అలర్ట్ డెలివరీ పునరుద్ధరణ గడువు దాటింది'
             WHEN 'ml' THEN
               'ക്ലിനിക്കൽ അലർട്ട് ഡെലിവറി വീണ്ടെടുക്കലിന്റെ സമയപരിധി കഴിഞ്ഞു'
             ELSE
               'Clinical alert delivery recovery is overdue'
           END
       AND outbox.body = CASE outbox.payload->>'presentation_locale'
             WHEN 'hi' THEN CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'अपरिवर्तनीय रूप से रोके गए क्लिनिकल अलर्ट के लिए नियंत्रित स्रोत समीक्षा और प्रतिस्थापन आवश्यक है।'
               ELSE
                 'किसी क्लिनिकल अलर्ट के लिए अभी भी कोई सक्रिय ड्यूटी डॉक्टर या डॉक्टर-स्तर का प्राप्तकर्ता उपलब्ध नहीं है।'
             END
             WHEN 'ta' THEN CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'மாற்ற இயலாமல் நிறுத்திவைக்கப்பட்ட மருத்துவ எச்சரிக்கைக்கு நிர்வகிக்கப்பட்ட மூல ஆய்வும் மாற்றுப் பதிவும் தேவை.'
               ELSE
                 'ஒரு மருத்துவ எச்சரிக்கைக்கு இன்னும் செயலில் உள்ள பணிப்பொறுப்பு மருத்துவர் அல்லது மருத்துவர்-நிலை பெறுநர் இல்லை.'
             END
             WHEN 'te' THEN CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'మార్చలేని విధంగా హోల్డ్ చేసిన క్లినికల్ అలర్ట్‌కు నియంత్రిత మూల సమీక్ష మరియు ప్రత్యామ్నాయ నమోదు అవసరం.'
               ELSE
                 'ఒక క్లినికల్ అలర్ట్‌కు ఇప్పటికీ క్రియాశీల డ్యూటీ డాక్టర్ లేదా డాక్టర్-స్థాయి గ్రహీత లేరు.'
             END
             WHEN 'ml' THEN CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'മാറ്റാനാവാതെ ഹോൾഡ് ചെയ്തിരിക്കുന്ന ക്ലിനിക്കൽ അലർട്ടിന് നിയന്ത്രിത ഉറവിട അവലോകനവും പകരം രേഖപ്പെടുത്തലും ആവശ്യമാണ്.'
               ELSE
                 'ഒരു ക്ലിനിക്കൽ അലർട്ടിന് ഇപ്പോഴും സജീവ ഡ്യൂട്ടി ഡോക്ടറോ ഡോക്ടർ-തലത്തിലുള്ള സ്വീകർത്താവോ ഇല്ല.'
             END
             ELSE CASE recovery_case.case_kind
               WHEN 'manual_hold' THEN
                 'An immutable held clinical alert requires governed source review and supersession.'
               ELSE
                 'A clinical alert still has no active duty-doctor or doctor-tier recipient.'
             END
           END
       AND outbox.template_version =
             'clinical-alert-delivery-recovery-escalation.v1'
       AND outbox.payload->>'kind' =
             'clinical_alert_delivery_recovery_overdue'
       AND outbox.payload->>'recovery_case_id' = recovery_case.id::text
       AND outbox.payload->>'obligation_id' = recovery_case.obligation_id::text
       AND outbox.payload->>'case_kind' = recovery_case.case_kind
       AND outbox.payload->>'patient_uid'
             IS NOT DISTINCT FROM obligation_record.patient_uid::text
       AND outbox.payload->>'action_path' =
             '/api/v1/admin/clinical-alert-delivery/recovery-cases/'
             || recovery_case.id::text
       AND outbox.payload->>'route' =
             '/clinical-inbox/recovery?case_id=' || recovery_case.id::text
       AND outbox.payload->>'deep_link' =
             '/clinical-inbox/recovery?case_id=' || recovery_case.id::text
       AND outbox.payload->>'action_label_key' = 'clinical_inbox.open_workflow'
       AND outbox.payload->>'presentation_key' =
             'clinical_alert_delivery_recovery_overdue'
       AND outbox.payload->>'presentation_copy_version' =
             'clinical-alert-delivery-recovery-escalation.v1'
       AND jsonb_typeof(outbox.payload->'presentations') = 'object'
       AND outbox.payload->'presentations' ?& ARRAY[
             'en', 'hi', 'ta', 'te', 'ml'
           ]
       AND outbox.payload->>'recipient_role' IN ('ADMIN', 'SUPER_ADMIN')
       AND outbox.created_at <= NEW.escalated_at
  )
  SELECT (SELECT COUNT(*)::integer FROM eligible),
         (SELECT COUNT(DISTINCT outbox_id)::integer FROM actual),
         (SELECT COUNT(DISTINCT recipient_id)::integer FROM actual),
         (
           SELECT COUNT(*)::integer
             FROM eligible expected
            WHERE NOT EXISTS (
              SELECT 1
                FROM actual delivered
               WHERE delivered.recipient_id = expected.recipient_id
                 AND delivered.recipient_role = expected.role
                 AND delivered.presentation_locale = expected.presentation_locale
            )
         ),
         (
           SELECT COUNT(*)::integer
             FROM actual delivered
            WHERE NOT EXISTS (
              SELECT 1
                FROM eligible expected
               WHERE expected.recipient_id = delivered.recipient_id
                 AND expected.role = delivered.recipient_role
                 AND expected.presentation_locale = delivered.presentation_locale
            )
         )
    INTO eligible_count,
         exact_outbox_count,
         exact_recipient_count,
         missing_recipient_count,
         extra_recipient_count;

  IF eligible_count IS DISTINCT FROM recipient_count
     OR exact_outbox_count IS DISTINCT FROM recipient_count
     OR exact_recipient_count IS DISTINCT FROM recipient_count
     OR missing_recipient_count IS DISTINCT FROM 0
     OR extra_recipient_count IS DISTINCT FROM 0
  THEN
    RAISE EXCEPTION 'clinical alert recovery escalation must notify the exact active recipient set'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$fn$;

COMMIT;
