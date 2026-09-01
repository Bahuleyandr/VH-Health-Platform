-- Migration 758: land the pharmacy advance/funding authority superset.
--
-- Migration 753 shipped a deliberately reduced subset of this lane so the
-- committed tree could stand on its own. 753 is now published, and migrations
-- are forward-only -- re-amending that file would never re-execute anywhere it
-- has already run -- so the remainder lands here instead.
--
-- Every statement below was emitted by pg_catalog itself (pg_get_functiondef,
-- pg_get_triggerdef, pg_get_constraintdef, pg_indexes, pg_policies) from a
-- database built with the full lane, then diffed against a database built from
-- the published chain. Nothing is hand-transcribed, and nothing is dropped: the
-- delta is purely additive, 0 objects removed.
--
-- ONE DELIBERATE DIVERGENCE from the source lane: four composite foreign keys
-- containing patient_uid are declared DEFERRABLE INITIALLY IMMEDIATE here,
-- where the lane leaves them non-deferrable. Migration 634 requires it and
-- patient-merge-execution.deep.test.js gates on it: the merge sweep re-points
-- parent and child in separate statements, so a non-deferrable composite key
-- spanning patient_uid makes a merge impossible. INITIALLY IMMEDIATE keeps the
-- per-statement check, so nothing changes operationally. Affected:
--   fk_pharmacy_funding_command_patient_753
--   fk_pharmacy_funding_command_approval_receipt_753
--   fk_pharmacy_funding_command_consumption_receipt_753
--   fk_billing_advance_ipd_source_753
--
-- Scope: 1 table, 18 columns, 91 functions (52 new + 39 replaced), 59
-- constraints, 41 triggers, 31 policies, 58 indexes.

-- Functions precede the table: the table's triggers call them, and some of
-- them read the table in return. Body checking is relaxed so that cycle can
-- resolve, exactly as pg_dump does for the same reason.
SET check_function_bodies = false;

-- ---- functions: 52 new, 39 replaced in place ----
CREATE OR REPLACE FUNCTION public.append_pharmacy_authority_recovery_event_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  event_kind TEXT;
  event_actor UUID;
  event_request TEXT;
  command_hash TEXT;
  request_hash TEXT;
BEGIN
  event_kind := CASE
    WHEN TG_OP='INSERT' THEN 'CREATED'
    WHEN OLD.status='RESOLVED' AND NEW.status='OPEN' THEN 'REOPENED'
    WHEN OLD.status='OPEN' AND NEW.status='RESOLVED' THEN 'RESOLVED'
    ELSE 'REFRESHED'
  END;
  event_actor := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN COALESCE(
    NEW.resolved_by,
    NULLIF(current_setting('app.pharmacy_recovery_actor_uid', TRUE), '')::uuid
  ) ELSE NULL END;
  event_request := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN
    NULLIF(current_setting('app.pharmacy_recovery_request_id', TRUE), '')
  ELSE NULL END;
  command_hash := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN NULLIF(
    current_setting('app.pharmacy_recovery_command_key_sha256', TRUE), ''
  ) ELSE NULL END;
  request_hash := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN
    NULLIF(current_setting('app.pharmacy_recovery_request_sha256', TRUE), '')
  ELSE NULL END;
  INSERT INTO pharmacy_inventory_authority_recovery_events (
    tenant_id, recovery_id, event_type, reason_code, actor_uid, request_id,
    command_key_sha256, request_sha256, request_payload, resolution_payload,
    target_identity, target_before, target_after, contract_version,
    before_authority, after_authority
  ) VALUES (
    NEW.tenant_id, NEW.id, event_kind, NEW.reason_code, event_actor, event_request,
    command_hash, request_hash,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_request_payload', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_resolution_payload', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_target_identity', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_target_before', TRUE), '')::jsonb END,
    CASE
      WHEN event_kind='REOPENED' THEN to_jsonb(NEW)
      WHEN command_hash IS NULL THEN NULL
      ELSE NULLIF(current_setting('app.pharmacy_recovery_target_after', TRUE), '')::jsonb
    END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE 1 END,
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    to_jsonb(NEW)
  );
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.append_ward_alloc_recovery_event_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  event_kind TEXT;
  event_actor UUID;
  command_hash TEXT;
  request_hash TEXT;
BEGIN
  event_kind := CASE
    WHEN TG_OP='INSERT' THEN 'CREATED'
    WHEN OLD.status='RESOLVED' AND NEW.status='OPEN' THEN 'REOPENED'
    WHEN OLD.status='OPEN' AND NEW.status='RESOLVED' THEN 'RESOLVED'
    ELSE 'REFRESHED'
  END;
  event_actor := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN COALESCE(
    NEW.resolved_by,
    NULLIF(current_setting('app.pharmacy_recovery_actor_uid', TRUE), '')::uuid
  ) ELSE NULL END;
  command_hash := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN NULLIF(
    current_setting('app.pharmacy_recovery_command_key_sha256', TRUE), ''
  ) ELSE NULL END;
  request_hash := CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN
    NULLIF(current_setting('app.pharmacy_recovery_request_sha256', TRUE), '')
  ELSE NULL END;
  INSERT INTO pharmacy_ward_allocation_authority_recovery_events (
    tenant_id, recovery_id, event_type, actor_uid, request_id,
    command_key_sha256, request_sha256, request_payload, resolution_payload,
    target_identity, target_before, target_after, contract_version,
    before_authority, after_authority
  ) VALUES (
    NEW.tenant_id, NEW.id, event_kind, event_actor,
    CASE WHEN event_kind IN ('REOPENED', 'RESOLVED') THEN
      NULLIF(current_setting('app.pharmacy_recovery_request_id', TRUE), '')
    ELSE NULL END,
    command_hash, request_hash,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_request_payload', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_resolution_payload', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_target_identity', TRUE), '')::jsonb END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE
      NULLIF(current_setting('app.pharmacy_recovery_target_before', TRUE), '')::jsonb END,
    CASE
      WHEN event_kind='REOPENED' THEN to_jsonb(NEW)
      WHEN command_hash IS NULL THEN NULL
      ELSE NULLIF(current_setting('app.pharmacy_recovery_target_after', TRUE), '')::jsonb
    END,
    CASE WHEN command_hash IS NULL THEN NULL ELSE 1 END,
    CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    to_jsonb(NEW)
  );
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.assert_billing_advance_settlement_lineage_753(target_tenant_id uuid, target_advance_id integer, target_invoice_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  invoice_patient_uid UUID;
  invoice_terminal_uid UUID;
  invoice_admission_id INTEGER;
  advance_patient_uid UUID;
  advance_terminal_uid UUID;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  SELECT invoice.patient_uid,invoice.admission_id
    INTO invoice_patient_uid,invoice_admission_id
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=target_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing advance settlement lacks its same-tenant invoice'
      USING ERRCODE='23503';
  END IF;
  SELECT advance.patient_uid
    INTO advance_patient_uid
    FROM billing_advances advance
   WHERE advance.tenant_id=target_tenant_id
     AND advance.id=target_advance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Billing advance settlement lacks its same-tenant advance'
      USING ERRCODE='23503';
  END IF;
  invoice_terminal_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,invoice_patient_uid
  );
  advance_terminal_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,advance_patient_uid
  );
  IF advance_terminal_uid IS DISTINCT FROM invoice_terminal_uid THEN
    RAISE EXCEPTION 'Billing advance settlement patient lineages do not converge'
      USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || target_tenant_id::text || ':'
      || invoice_terminal_uid::text,
    753
  ));
  SELECT invoice.patient_uid,invoice.admission_id
    INTO invoice_patient_uid,invoice_admission_id
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=target_invoice_id
   FOR UPDATE;
  IF NOT FOUND OR public.resolve_billing_patient_terminal_753(
       target_tenant_id,invoice_patient_uid
     ) IS DISTINCT FROM invoice_terminal_uid THEN
    RAISE EXCEPTION 'Billing advance settlement invoice changed before lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM public.assert_pharmacy_advance_patient_scope_753(
    target_tenant_id,target_advance_id,invoice_patient_uid,
    invoice_admission_id
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.assert_pharmacy_advance_capacity_753(target_tenant_id uuid, target_advance_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  advance_amount NUMERIC(12,2);
  advance_balance NUMERIC(12,2);
  settlement_total NUMERIC(14,2);
  refund_total NUMERIC(14,2);
  allocation_total NUMERIC(14,2);
BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(
       'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
       0
     )) THEN
    RAISE EXCEPTION 'Patient merge is concurrently changing advance capacity authority'
      USING ERRCODE='40001';
  END IF;
  SELECT advance.amount,advance.balance
    INTO advance_amount,advance_balance
    FROM billing_advances advance
   WHERE advance.tenant_id=target_tenant_id
     AND advance.id=target_advance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF advance_amount<=0 OR advance_balance<0 OR advance_balance>advance_amount THEN
    RAISE EXCEPTION
      'Advance % has invalid amount/balance evidence: amount %, balance %',
      target_advance_id,advance_amount,advance_balance
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_balance_reservations_753';
  END IF;

  SELECT COALESCE(SUM(settlement.amount),0)
    INTO settlement_total
    FROM billing_advance_settlements settlement
   WHERE settlement.tenant_id=target_tenant_id
     AND settlement.advance_id=target_advance_id;

  SELECT COALESCE(SUM(refund.amount),0)
    INTO refund_total
    FROM billing_refunds refund
   WHERE refund.tenant_id=target_tenant_id
     AND refund.advance_id=target_advance_id
     AND refund.approval_status<>'REJECTED';

  SELECT COALESCE(SUM(net_allocation.net_amount),0)
    INTO allocation_total
    FROM (
      SELECT allocation.id,
             allocation.allocated_amount-COALESCE(SUM(reversal.reversed_amount),0)
               AS net_amount
        FROM pharmacy_advance_allocations allocation
        LEFT JOIN pharmacy_advance_allocation_reversals reversal
          ON reversal.tenant_id=allocation.tenant_id
         AND reversal.allocation_id=allocation.id
       WHERE allocation.tenant_id=target_tenant_id
         AND allocation.billing_advance_id=target_advance_id
       GROUP BY allocation.id,allocation.allocated_amount
     ) net_allocation;

  IF allocation_total>advance_balance THEN
    RAISE EXCEPTION
      'Advance % pharmacy reservations % exceed current balance %',
      target_advance_id,allocation_total,advance_balance
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_balance_reservations_753';
  END IF;

  IF settlement_total+refund_total+allocation_total>advance_amount THEN
    RAISE EXCEPTION
      'Advance % capacity exceeded: settlements %, non-rejected refunds %, net pharmacy allocations %, amount %',
      target_advance_id,settlement_total,refund_total,allocation_total,advance_amount
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_capacity_conservation_753';
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.assert_pharmacy_advance_consumption_receipt_753(target_tenant_id uuid, target_consumption_receipt_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  target_approval_receipt_id BIGINT;
  approval_receipt pharmacy_funding_commands%ROWTYPE;
  consumption_receipt pharmacy_funding_commands%ROWTYPE;
  response JSONB;
  expected_allocations JSONB;
  expected_allocation_ids JSONB;
  allocation_count BIGINT;
  link_count BIGINT;
  invalid_links BIGINT;
  discovered_patient_uid UUID;
  terminal_patient_uid UUID;
  mutation_command_sha256 TEXT;
  mutation_evidence_sha256 TEXT;
  response_consumed_at TIMESTAMPTZ;
  finance_task_id NUMERIC;
  finance_task tasks%ROWTYPE;
  mutation_receipt pharmacy_order_command_receipts%ROWTYPE;
  order_patient_id INTEGER;
  order_patient_uid UUID;
  order_lineage_uid UUID;
  order_facility_id INTEGER;
  order_admission_id INTEGER;
  order_authority_version INTEGER;
  order_total NUMERIC;
  order_items JSONB;
  order_items_sha256 CHAR(64);
  invoice_patient_uid UUID;
  invoice_terminal_uid UUID;
  invoice_admission_id INTEGER;
  invoice_status VARCHAR(20);
  invoice_number VARCHAR(100);
  invoice_subtotal NUMERIC(12,2);
  invoice_cgst NUMERIC(12,2);
  invoice_sgst NUMERIC(12,2);
  invoice_igst NUMERIC(12,2);
  invoice_discount NUMERIC(12,2);
  invoice_total NUMERIC(12,2);
  invoice_paid NUMERIC(12,2);
  invoice_due NUMERIC(12,2);
  invoice_credit_note NUMERIC(12,2);
  invoice_issued_at TIMESTAMPTZ;
  invoice_voided_at TIMESTAMPTZ;
  item_authority_version INTEGER;
  item_authority_sha256 CHAR(64);
  item_quantity NUMERIC(10,2);
  item_unit_price NUMERIC(12,2);
  item_gst_rate NUMERIC(5,2);
  item_line_subtotal NUMERIC(12,2);
  item_cgst NUMERIC(12,2);
  item_sgst NUMERIC(12,2);
  item_igst NUMERIC(12,2);
  item_line_total NUMERIC(12,2);
  aggregate_subtotal NUMERIC(14,2);
  aggregate_cgst NUMERIC(14,2);
  aggregate_sgst NUMERIC(14,2);
  aggregate_igst NUMERIC(14,2);
  live_invoice_items JSONB;
  live_invoice_items_sha256 CHAR(64);
  live_target_item JSONB;
  live_billing JSONB;
  advance_id_to_check INTEGER;
  checked_advance billing_advances%ROWTYPE;
  consumer_role TEXT;
  consumer_grant_id BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  SELECT command.*
    INTO consumption_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_consumption_receipt_id
     AND command.command_type='SUBSTITUTION_FUNDING_CONSUMPTION';
  IF NOT FOUND OR consumption_receipt.approval_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance consumption receipt has no approval identity'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_receipt_complete_753';
  END IF;
  target_approval_receipt_id:=consumption_receipt.approval_receipt_id;

  SELECT receipt.patient_uid
    INTO discovered_patient_uid
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=target_tenant_id
     AND receipt.id=target_approval_receipt_id
     AND receipt.command_type='SUBSTITUTION_FUNDING_APPROVAL';
  IF discovered_patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance consumption receipt lacks approval patient lineage'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_receipt_complete_753';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,discovered_patient_uid
  );
  PERFORM public.resolve_billing_patient_family_753(
    target_tenant_id,terminal_patient_uid
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || target_tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || target_tenant_id::text || ':'
      || consumption_receipt.pharmacy_order_id::text,
    753
  ));

  SELECT receipt.*
    INTO approval_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=target_tenant_id
     AND receipt.id=target_approval_receipt_id
   FOR UPDATE;
  IF NOT FOUND
     OR approval_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
     OR approval_receipt.status<>'COMPLETE'
     OR approval_receipt.response_body IS NULL
     OR approval_receipt.completed_at IS NULL
     OR approval_receipt.approved_patient_amount IS NULL
     OR approval_receipt.patient_uid IS DISTINCT FROM discovered_patient_uid
     OR approval_receipt.response_body #>> '{base,patient_uid}'
        IS DISTINCT FROM terminal_patient_uid::text THEN
    RAISE EXCEPTION 'Pharmacy advance consumption receipt lacks its completed approval authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_receipt_complete_753';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || target_tenant_id::text || ':'
      || target_approval_receipt_id::text,
    0
  ));
  SELECT command.*
    INTO consumption_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_consumption_receipt_id
     AND command.approval_receipt_id=target_approval_receipt_id
   FOR UPDATE;
  IF NOT FOUND
     OR consumption_receipt.command_type<>'SUBSTITUTION_FUNDING_CONSUMPTION'
     OR consumption_receipt.status<>'COMPLETE'
     OR consumption_receipt.response_body IS NULL
     OR consumption_receipt.completed_at IS NULL
     OR consumption_receipt.approval_receipt_id<>target_approval_receipt_id
     OR consumption_receipt.task_id<>approval_receipt.task_id
     OR consumption_receipt.pharmacy_order_id<>approval_receipt.pharmacy_order_id
     OR consumption_receipt.invoice_item_id<>approval_receipt.invoice_item_id
     OR consumption_receipt.created_by IS DISTINCT FROM
          approval_receipt.proposer_uid
     OR consumption_receipt.created_by=approval_receipt.created_by THEN
    RAISE EXCEPTION 'Pharmacy advance consumption link requires a completed exact receipt at commit'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_receipt_complete_753';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pharmacy_advance_allocations allocation
      JOIN pharmacy_advance_allocation_reversals reversal
        ON reversal.tenant_id=allocation.tenant_id
       AND reversal.allocation_id=allocation.id
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.funding_approval_receipt_id=target_approval_receipt_id
  ) THEN
    RAISE EXCEPTION 'A reversed pharmacy advance approval cannot be consumed'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_coverage_753';
  END IF;

  FOR advance_id_to_check IN
    SELECT DISTINCT allocation.billing_advance_id
      FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.funding_approval_receipt_id=target_approval_receipt_id
     ORDER BY allocation.billing_advance_id
  LOOP
    PERFORM public.assert_pharmacy_advance_patient_scope_753(
      target_tenant_id,advance_id_to_check,
      terminal_patient_uid,
      NULLIF(approval_receipt.response_body #>> '{base,admission_id}','')::INTEGER
    );
    SELECT advance.*
      INTO checked_advance
      FROM billing_advances advance
     WHERE advance.tenant_id=target_tenant_id
       AND advance.id=advance_id_to_check
     FOR UPDATE;
    IF NOT FOUND
       OR checked_advance.status<>'ACTIVE'
       OR checked_advance.amount<=0
       OR checked_advance.balance<0
       OR UPPER(BTRIM(checked_advance.mode)) NOT IN (
         'CASH','CARD','UPI','NETBANKING','CHEQUE','DD','WALLET',
         'ONLINE','BANK_TRANSFER'
       )
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(approval_receipt.reservation_plan #>
             '{funding,source_evidence,advances}') source_advance
          WHERE (source_advance->>'billing_advance_id')::INTEGER=
                advance_id_to_check
            AND source_advance->>'stored_patient_uid'=
                checked_advance.patient_uid::text
            AND (
              (checked_advance.admission_id IS NULL
                AND source_advance->'admission_id'='null'::JSONB)
              OR source_advance->>'admission_id'=
                 checked_advance.admission_id::text
            )
            AND checked_advance.collected_at IS NOT NULL
            AND source_advance->>'collected_at'=to_char(
              DATE_TRUNC('milliseconds',checked_advance.collected_at)
                AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
       ) THEN
      RAISE EXCEPTION 'Pharmacy advance consumption funding source drifted after approval'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_consumption_advance_authority_753';
    END IF;
    PERFORM public.assert_pharmacy_advance_capacity_753(
      target_tenant_id,advance_id_to_check
    );
  END LOOP;

  response:=consumption_receipt.response_body;
  IF jsonb_typeof(response) IS DISTINCT FROM 'object'
     OR response->>'contract'<>'pharmacy_substitution_funding_consumption_v1'
     OR jsonb_typeof(response->'approval_id') IS DISTINCT FROM 'number'
     OR jsonb_typeof(response->'approval_receipt_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(response->'consumption_receipt_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(response->'task_id') IS DISTINCT FROM 'number'
     OR jsonb_typeof(response->'pharmacy_order_id') IS DISTINCT FROM 'number'
     OR jsonb_typeof(response->'invoice_id') IS DISTINCT FROM 'number'
     OR jsonb_typeof(response->'invoice_item_id') IS DISTINCT FROM 'number'
     OR jsonb_typeof(response->'proposal_sha256') IS DISTINCT FROM 'string'
     OR jsonb_typeof(response->'approved_patient_amount') IS DISTINCT FROM 'string'
     OR jsonb_typeof(response->'base') IS DISTINCT FROM 'object'
      OR jsonb_typeof(response #> '{base,order_version}') IS DISTINCT FROM 'number'
      OR jsonb_typeof(response #> '{base,order_items_sha256}') IS DISTINCT FROM 'string'
      OR jsonb_typeof(response #> '{base,items_list}') IS DISTINCT FROM 'array'
      OR jsonb_typeof(response->'prospective') IS DISTINCT FROM 'object'
      OR jsonb_typeof(response #> '{prospective,order_version}') IS DISTINCT FROM 'number'
      OR jsonb_typeof(response #> '{prospective,order_items_sha256}') IS DISTINCT FROM 'string'
      OR jsonb_typeof(response #> '{prospective,authoritative_amount}') IS DISTINCT FROM 'string'
      OR jsonb_typeof(response #> '{prospective,items_list}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(response->'allocations') IS DISTINCT FROM 'array'
     OR jsonb_typeof(response->'allocation_ids') IS DISTINCT FROM 'array'
     OR jsonb_typeof(response->'mutation') IS DISTINCT FROM 'object'
     OR jsonb_typeof(response #> '{mutation,receipt_id}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(response #> '{mutation,command_sha256}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(response #> '{mutation,evidence_sha256}') IS DISTINCT FROM 'string'
      OR jsonb_typeof(response->'consumed_by') IS DISTINCT FROM 'string'
      OR jsonb_typeof(response->'consumed_at') IS DISTINCT FROM 'string'
      OR jsonb_typeof(response->'settlement') IS DISTINCT FROM 'object'
      OR (
        approval_receipt.approved_patient_amount>0
        AND (
          response #>> '{settlement,status}'<>'awaiting_finance_settlement'
          OR jsonb_typeof(response #> '{settlement,task_id}')
             IS DISTINCT FROM 'number'
        )
      )
      OR (
        approval_receipt.approved_patient_amount=0
        AND response->'settlement' IS DISTINCT FROM
            jsonb_build_object('status','no_advance_settlement_required')
      )
     OR jsonb_typeof(approval_receipt.response_body->'approval_id')
          IS DISTINCT FROM 'number'
     OR jsonb_typeof(approval_receipt.response_body->'proposal_sha256')
          IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Pharmacy advance consumption receipt is not canonical typed evidence'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_receipt_complete_753';
  END IF;

  mutation_command_sha256:=response #>> '{mutation,command_sha256}';
  mutation_evidence_sha256:=response #>> '{mutation,evidence_sha256}';
  IF response->>'proposal_sha256' !~ '^[0-9a-f]{64}$'
     OR response->>'approved_patient_amount'
          !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$'
     OR response #>> '{base,order_items_sha256}' !~ '^[0-9a-f]{64}$'
     OR response #>> '{prospective,order_items_sha256}' !~ '^[0-9a-f]{64}$'
     OR response #>> '{prospective,authoritative_amount}'
          !~ '^(0|[1-9][0-9]{0,7})\.[0-9]{2}$'
     OR mutation_command_sha256 !~ '^[0-9a-f]{64}$'
     OR mutation_evidence_sha256 !~ '^[0-9a-f]{64}$'
     OR response->>'consumed_by'
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR response->>'consumed_at'
          !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' THEN
    RAISE EXCEPTION 'Pharmacy advance consumption receipt has noncanonical hashes, money, actor, or time'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_receipt_complete_753';
  END IF;

  SELECT receipt.*
    INTO mutation_receipt
    FROM pharmacy_order_command_receipts receipt
   WHERE receipt.tenant_id=target_tenant_id
     AND receipt.id=consumption_receipt.order_mutation_receipt_id
     AND receipt.pharmacy_order_id=consumption_receipt.pharmacy_order_id
     AND receipt.action=consumption_receipt.order_mutation_action
     AND receipt.command_key_sha256=
         consumption_receipt.order_mutation_command_sha256
     AND receipt.request_sha256=
         consumption_receipt.order_mutation_request_sha256
     AND receipt.response_evidence_sha256=
         consumption_receipt.order_mutation_evidence_sha256
   FOR UPDATE;
  IF NOT FOUND
     OR mutation_receipt.action<>'dispense_substitution'
     OR mutation_receipt.authority_transaction_id IS DISTINCT FROM
          consumption_receipt.completed_transaction_id
     OR mutation_receipt.created_at IS DISTINCT FROM
          consumption_receipt.completed_at
     OR response #>> '{mutation,receipt_id}' IS DISTINCT FROM
          mutation_receipt.id::text
     OR mutation_command_sha256 IS DISTINCT FROM
          mutation_receipt.command_key_sha256
     OR mutation_evidence_sha256 IS DISTINCT FROM
          mutation_receipt.response_evidence_sha256
     OR mutation_receipt.response_payload->>'contract'<>
          'pharmacy_substitution_funding_order_mutation_v1'
     OR mutation_receipt.response_payload->>'approval_id' IS DISTINCT FROM
          approval_receipt.governance_approval_id::text
     OR mutation_receipt.response_payload->>'approval_receipt_id'
          IS DISTINCT FROM target_approval_receipt_id::text
     OR mutation_receipt.response_payload->>'proposal_sha256' IS DISTINCT FROM
          approval_receipt.proposal_sha256
     OR mutation_receipt.response_payload->>'task_id' IS DISTINCT FROM
          approval_receipt.task_id::text
     OR mutation_receipt.response_payload->>'pharmacy_order_id' IS DISTINCT FROM
          approval_receipt.pharmacy_order_id::text
     OR mutation_receipt.response_payload->>'invoice_id' IS DISTINCT FROM
          approval_receipt.response_body->>'invoice_id'
     OR mutation_receipt.response_payload->>'invoice_item_id' IS DISTINCT FROM
          approval_receipt.invoice_item_id::text
     OR mutation_receipt.response_payload->>'actor_uid' IS DISTINCT FROM
          approval_receipt.proposer_uid::text
     OR mutation_receipt.response_payload->>'command_sha256' IS DISTINCT FROM
          mutation_receipt.command_key_sha256
     OR mutation_receipt.response_payload->>'request_sha256' IS DISTINCT FROM
          mutation_receipt.request_sha256
     OR mutation_receipt.response_payload->'base' IS DISTINCT FROM
          approval_receipt.response_body->'base'
     OR mutation_receipt.response_payload->'prospective' IS DISTINCT FROM
          approval_receipt.response_body->'prospective' THEN
    RAISE EXCEPTION 'Pharmacy advance consumption lacks its exact immutable order mutation receipt'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_mutation_receipt_753';
  END IF;

  BEGIN
    response_consumed_at:=(response->>'consumed_at')::TIMESTAMPTZ;
    finance_task_id:=CASE
      WHEN approval_receipt.approved_patient_amount>0
      THEN (response #>> '{settlement,task_id}')::NUMERIC
      ELSE NULL
    END;
  EXCEPTION
    WHEN invalid_text_representation OR datetime_field_overflow
         OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pharmacy advance consumption receipt has invalid time or task identity'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_consumption_receipt_complete_753';
  END;
  IF (approval_receipt.approved_patient_amount>0 AND (
       finance_task_id<=0
       OR finance_task_id<>TRUNC(finance_task_id)
       OR finance_task_id>2147483647
     ))
     OR (approval_receipt.approved_patient_amount=0
       AND finance_task_id IS NOT NULL)
     OR response_consumed_at IS DISTINCT FROM consumption_receipt.completed_at
     OR response->>'consumed_by' IS DISTINCT FROM consumption_receipt.created_by::text
     OR (response->>'approved_patient_amount')::NUMERIC(12,2)
          IS DISTINCT FROM approval_receipt.approved_patient_amount THEN
    RAISE EXCEPTION 'Pharmacy advance consumption receipt identity or completion evidence is not exact'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_receipt_complete_753';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'allocation_id',allocation.id::text,
           'billing_advance_id',allocation.billing_advance_id,
           'allocated_amount',allocation.allocated_amount::text,
           'allocation_evidence_sha256',allocation.evidence_sha256
         ) ORDER BY allocation.id),'[]'::jsonb),
         COALESCE(jsonb_agg(to_jsonb(allocation.id::text)
           ORDER BY allocation.id),'[]'::jsonb),
         COUNT(*),
         COUNT(*) FILTER (WHERE consumption.id IS NULL
           OR consumption.consumption_command_sha256 IS DISTINCT FROM
              consumption_receipt.command_key_sha256
           OR consumption.consumed_by IS DISTINCT FROM
              consumption_receipt.created_by
           OR consumption.consumed_at IS DISTINCT FROM response_consumed_at
           OR consumption.evidence IS DISTINCT FROM jsonb_build_object(
             'contract','pharmacy_advance_allocation_consumption_v1',
             'approval_receipt_id',target_approval_receipt_id::text,
             'consumption_receipt_id',target_consumption_receipt_id::text,
             'allocation_id',allocation.id::text,
             'billing_advance_id',allocation.billing_advance_id,
             'allocated_amount',allocation.allocated_amount::text,
             'allocation_evidence_sha256',allocation.evidence_sha256,
             'consumption_command_sha256',
                consumption_receipt.command_key_sha256,
             'mutation_receipt_id',mutation_receipt.id::text,
             'mutation_command_sha256',mutation_command_sha256,
             'mutation_evidence_sha256',mutation_evidence_sha256,
             'base',jsonb_build_object(
               'order_version',approval_receipt.response_body #>
                 '{base,order_version}',
               'order_items_sha256',approval_receipt.response_body #>>
                 '{base,order_items_sha256}'
             ),
             'prospective',jsonb_build_object(
               'order_version',approval_receipt.response_body #>
                 '{prospective,order_version}',
               'order_items_sha256',approval_receipt.response_body #>>
                 '{prospective,order_items_sha256}',
               'authoritative_amount',approval_receipt.response_body #>>
                 '{prospective,authoritative_amount}'
             ),
             'consumed_by',consumption_receipt.created_by::text
           ))
    INTO expected_allocations,expected_allocation_ids,
         allocation_count,invalid_links
    FROM pharmacy_advance_allocations allocation
    LEFT JOIN pharmacy_advance_allocation_consumptions consumption
      ON consumption.tenant_id=allocation.tenant_id
     AND consumption.allocation_id=allocation.id
     AND consumption.funding_consumption_receipt_id=
         target_consumption_receipt_id
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.funding_approval_receipt_id=target_approval_receipt_id;

  SELECT COUNT(*)
    INTO link_count
    FROM pharmacy_advance_allocation_consumptions consumption
   WHERE consumption.tenant_id=target_tenant_id
     AND consumption.funding_consumption_receipt_id=
         target_consumption_receipt_id;
  IF invalid_links<>0 OR link_count<>allocation_count THEN
    RAISE EXCEPTION 'Pharmacy advance consumption receipt lacks exact immutable allocation links'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_coverage_753';
  END IF;

  IF response IS DISTINCT FROM (
     jsonb_build_object(
       'contract','pharmacy_substitution_funding_consumption_v1',
       'approval_id',approval_receipt.response_body->'approval_id',
       'approval_receipt_id',target_approval_receipt_id::text,
       'consumption_receipt_id',target_consumption_receipt_id::text,
       'task_id',consumption_receipt.task_id,
       'pharmacy_order_id',consumption_receipt.pharmacy_order_id,
       'invoice_id',approval_receipt.response_body->'invoice_id',
       'invoice_item_id',consumption_receipt.invoice_item_id,
       'proposal_sha256',approval_receipt.response_body->>'proposal_sha256',
       'approved_patient_amount',approval_receipt.approved_patient_amount::text,
       'base',jsonb_build_object(
         'order_version',approval_receipt.response_body #>
           '{base,order_version}',
         'order_items_sha256',approval_receipt.response_body #>>
           '{base,order_items_sha256}',
         'items_list',approval_receipt.response_body #> '{base,items_list}'
       ),
       'prospective',jsonb_build_object(
         'order_version',approval_receipt.response_body #>
           '{prospective,order_version}',
         'order_items_sha256',approval_receipt.response_body #>>
           '{prospective,order_items_sha256}',
         'authoritative_amount',approval_receipt.response_body #>>
           '{prospective,authoritative_amount}',
         'items_list',approval_receipt.response_body #> '{prospective,items_list}'
       ),
       'allocations',expected_allocations,
       'allocation_ids',expected_allocation_ids,
       'mutation',jsonb_build_object(
         'receipt_id',mutation_receipt.id::text,
         'command_sha256',mutation_command_sha256,
         'evidence_sha256',mutation_evidence_sha256
       ),
       'consumed_by',consumption_receipt.created_by::text,
       'consumed_at',response->>'consumed_at',
       'settlement',jsonb_build_object(
         'status',CASE
           WHEN approval_receipt.approved_patient_amount>0
           THEN 'awaiting_finance_settlement'
           ELSE 'no_advance_settlement_required'
         END
       )
     ) || CASE
         WHEN approval_receipt.approved_patient_amount>0
         THEN jsonb_build_object(
           'settlement',jsonb_build_object(
             'status','awaiting_finance_settlement',
             'task_id',finance_task_id::INTEGER
           )
         )
         ELSE '{}'::jsonb
       END
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance consumption response does not exactly bind approval, mutation, and allocations'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_receipt_complete_753';
  END IF;

  SELECT pharmacy_order.patient_id,pharmacy_order.uid,pharmacy_order.facility_id,
         pharmacy_order.funding_admission_id,
         pharmacy_order.inventory_authority_version,
         pharmacy_order.total_amount,pharmacy_order.items_list,
         pharmacy_order.clinical_verification_items_sha256
    INTO order_patient_id,order_lineage_uid,order_facility_id,order_admission_id,
         order_authority_version,order_total,order_items,order_items_sha256
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=consumption_receipt.pharmacy_order_id
   FOR UPDATE;
  SELECT patient.uid
    INTO order_patient_uid
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.id=order_patient_id
     AND patient.role='PATIENT'
   FOR UPDATE;
  IF order_patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance consumption order lacks patient lineage'
      USING ERRCODE='23514';
  END IF;
  order_patient_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,order_patient_uid
  );
  PERFORM 1
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.uid=order_patient_uid
     AND patient.role='PATIENT'
     AND patient.is_active=TRUE
     AND patient.status='active'
     AND COALESCE(patient.is_deleted,FALSE)=FALSE
     AND patient.merged_into_uid IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance consumption terminal patient authority is inactive'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_final_authority_753';
  END IF;
  PERFORM 1
    FROM facilities facility
   WHERE facility.tenant_id=target_tenant_id
     AND facility.id=order_facility_id
     AND facility.status='active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance consumption facility authority is inactive'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_final_authority_753';
  END IF;
  IF order_patient_uid IS DISTINCT FROM terminal_patient_uid
     OR (order_lineage_uid IS NOT NULL AND (
       public.resolve_billing_patient_terminal_753(
         target_tenant_id,order_lineage_uid
       ) IS DISTINCT FROM terminal_patient_uid
       OR NOT order_lineage_uid=ANY(
         public.resolve_billing_patient_family_753(
           target_tenant_id,terminal_patient_uid
         )
       )
     ))
     OR order_facility_id IS DISTINCT FROM consumption_receipt.facility_id
     OR approval_receipt.response_body #>> '{base,facility_id}'
        IS DISTINCT FROM order_facility_id::text
     OR order_authority_version IS DISTINCT FROM
        (approval_receipt.response_body #>>
          '{prospective,order_version}')::INTEGER
     OR order_total IS DISTINCT FROM
        (approval_receipt.response_body #>>
          '{prospective,authoritative_amount}')::NUMERIC
     OR order_items IS DISTINCT FROM
        approval_receipt.response_body #> '{prospective,items_list}'
     OR mutation_receipt.response_payload #> '{prospective,items_list}'
        IS DISTINCT FROM order_items
     OR mutation_receipt.response_payload #> '{base,items_list}'
        IS DISTINCT FROM approval_receipt.response_body #> '{base,items_list}'
     OR order_items_sha256 IS DISTINCT FROM
        approval_receipt.response_body #>>
          '{prospective,order_items_sha256}'
     OR mutation_receipt.response_payload #>>
          '{prospective,order_items_sha256}' IS DISTINCT FROM
        order_items_sha256 THEN
    RAISE EXCEPTION 'Pharmacy advance consumption did not atomically apply prospective order authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_final_authority_753';
  END IF;
  BEGIN
    consumer_grant_id:=(approval_receipt.response_body #>>
      '{base,facility_grant_id}')::BIGINT;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pharmacy advance consumption facility grant identity is malformed'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_consumption_actor_authority_753';
  END;
  SELECT consumer.role
    INTO consumer_role
    FROM users consumer
   WHERE consumer.tenant_id=target_tenant_id
     AND consumer.uid=consumption_receipt.created_by
     AND consumer.role IN ('PHARMACY_STAFF','PHARMACY_INCHARGE')
     AND consumer.is_active=TRUE
     AND consumer.status='active'
     AND COALESCE(consumer.is_deleted,FALSE)=FALSE
     AND consumer.merged_into_uid IS NULL
   FOR UPDATE;
  IF consumer_role IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance consumption actor lacks live pharmacy role authority'
      USING ERRCODE='42501',
            CONSTRAINT='chk_pharmacy_advance_consumption_actor_authority_753';
  END IF;
  PERFORM 1
    FROM staff staff_identity
   WHERE staff_identity.tenant_id=target_tenant_id
     AND staff_identity.user_id=consumption_receipt.created_by
     AND staff_identity.is_active=TRUE
     AND staff_identity.archived=FALSE
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance consumption actor lacks active staff authority'
      USING ERRCODE='42501',
            CONSTRAINT='chk_pharmacy_advance_consumption_actor_authority_753';
  END IF;
  PERFORM 1
    FROM pharmacy_staff_facility_grants facility_grant
   WHERE facility_grant.tenant_id=target_tenant_id
     AND facility_grant.id=consumer_grant_id
     AND facility_grant.staff_uid=consumption_receipt.created_by
     AND facility_grant.facility_id=order_facility_id
     AND facility_grant.status='active'
     AND facility_grant.revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance consumption actor lacks exact live facility authority'
      USING ERRCODE='42501',
            CONSTRAINT='chk_pharmacy_advance_consumption_actor_authority_753';
  END IF;

  SELECT invoice.patient_uid,invoice.admission_id,invoice.status,invoice.invoice_number,
         invoice.subtotal,invoice.cgst_amount,invoice.sgst_amount,
         invoice.igst_amount,invoice.discount_amount,invoice.total_amount,
         invoice.amount_paid,invoice.amount_due,invoice.credit_note_amount,
         invoice.issued_at,invoice.voided_at
    INTO invoice_patient_uid,invoice_admission_id,invoice_status,invoice_number,
         invoice_subtotal,invoice_cgst,invoice_sgst,invoice_igst,
         invoice_discount,invoice_total,invoice_paid,invoice_due,
         invoice_credit_note,invoice_issued_at,invoice_voided_at
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=(approval_receipt.response_body->>'invoice_id')::INTEGER
   FOR UPDATE;
  PERFORM 1
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=(approval_receipt.response_body->>'invoice_id')::INTEGER
   ORDER BY item.id
   FOR UPDATE;
  SELECT item.source_authority_version,item.source_authority_sha256,
         item.quantity,item.unit_price,item.gst_rate,item.line_subtotal,item.cgst_amount,
         item.sgst_amount,item.igst_amount,item.line_total
    INTO
         item_authority_version,item_authority_sha256,item_quantity,
         item_unit_price,item_gst_rate,item_line_subtotal,item_cgst,item_sgst,item_igst,
         item_line_total
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=(approval_receipt.response_body->>'invoice_id')::INTEGER
     AND item.id=consumption_receipt.invoice_item_id
     AND item.source_ref_type='pharmacy_order'
     AND item.source_ref_id=consumption_receipt.pharmacy_order_id::BIGINT
     AND item.source_ref_active=TRUE
   FOR UPDATE;
  SELECT COALESCE(jsonb_agg(
           public.pharmacy_substitution_invoice_item_projection_753(item)
           ORDER BY item.id
         ),'[]'::JSONB)
    INTO live_invoice_items
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=(approval_receipt.response_body->>'invoice_id')::INTEGER
     AND item.source_ref_active=TRUE;
  live_invoice_items_sha256:=encode(
    public.digest(live_invoice_items::TEXT,'sha256'),'hex'
  );
  live_target_item:=jsonb_build_object(
    'quantity',item_quantity::NUMERIC(10,2)::TEXT,
    'unit_price',item_unit_price::NUMERIC(12,2)::TEXT,
    'gst_rate',item_gst_rate::NUMERIC(5,2)::TEXT,
    'line_subtotal',item_line_subtotal::NUMERIC(12,2)::TEXT,
    'cgst_amount',COALESCE(item_cgst,0)::NUMERIC(12,2)::TEXT,
    'sgst_amount',COALESCE(item_sgst,0)::NUMERIC(12,2)::TEXT,
    'igst_amount',COALESCE(item_igst,0)::NUMERIC(12,2)::TEXT,
    'tax_amount',(COALESCE(item_cgst,0)+COALESCE(item_sgst,0)
      +COALESCE(item_igst,0))::NUMERIC(12,2)::TEXT,
    'line_total',item_line_total::NUMERIC(12,2)::TEXT,
    'source_ref_type','pharmacy_order',
    'source_ref_id',consumption_receipt.pharmacy_order_id::TEXT,
    'source_ref_active',TRUE,
    'source_authority_version',item_authority_version,
    'source_authority_sha256',item_authority_sha256
  );
  live_billing:=jsonb_build_object(
    'invoice',jsonb_build_object(
      'status',invoice_status,'invoice_number',invoice_number,
      'issued_at',invoice_issued_at,'voided_at',invoice_voided_at,
      'subtotal',invoice_subtotal::NUMERIC(12,2)::TEXT,
      'cgst_amount',COALESCE(invoice_cgst,0)::NUMERIC(12,2)::TEXT,
      'sgst_amount',COALESCE(invoice_sgst,0)::NUMERIC(12,2)::TEXT,
      'igst_amount',COALESCE(invoice_igst,0)::NUMERIC(12,2)::TEXT,
      'tax_amount',(COALESCE(invoice_cgst,0)+COALESCE(invoice_sgst,0)
        +COALESCE(invoice_igst,0))::NUMERIC(12,2)::TEXT,
      'discount_amount',COALESCE(invoice_discount,0)::NUMERIC(12,2)::TEXT,
      'credit_note_amount',COALESCE(invoice_credit_note,0)::NUMERIC(12,2)::TEXT,
      'total_amount',invoice_total::NUMERIC(12,2)::TEXT,
      'amount_paid',COALESCE(invoice_paid,0)::NUMERIC(12,2)::TEXT,
      'amount_due',invoice_due::NUMERIC(12,2)::TEXT
    ),
    'item',live_target_item,
    'items',live_invoice_items,
    'items_generation_sha256',live_invoice_items_sha256
  );
  IF invoice_patient_uid IS NOT NULL THEN
    invoice_terminal_uid:=public.resolve_billing_patient_terminal_753(
      target_tenant_id,invoice_patient_uid
    );
  END IF;
  IF invoice_patient_uid IS NULL
     OR invoice_terminal_uid IS DISTINCT FROM order_patient_uid
     OR order_admission_id IS DISTINCT FROM invoice_admission_id
     OR invoice_status<>'DRAFT'
     OR invoice_number IS NOT NULL
     OR invoice_issued_at IS NOT NULL
     OR invoice_voided_at IS NOT NULL
     OR invoice_paid<>0
     OR invoice_credit_note<>0
     OR invoice_due IS DISTINCT FROM invoice_total
     OR item_authority_version IS DISTINCT FROM
        (approval_receipt.response_body #>>
          '{prospective,order_version}')::INTEGER
     OR item_authority_sha256 IS DISTINCT FROM
        approval_receipt.response_body #>>
          '{prospective,order_items_sha256}'
     OR item_quantity<>1
     OR item_unit_price IS DISTINCT FROM order_total
     OR item_line_subtotal IS DISTINCT FROM order_total
     OR item_cgst<>0 OR item_sgst<>0 OR item_igst<>0
     OR item_line_total IS DISTINCT FROM order_total
     OR live_billing IS DISTINCT FROM
        approval_receipt.response_body #> '{billing,prospective}' THEN
    RAISE EXCEPTION 'Pharmacy advance consumption did not atomically apply prospective invoice authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_final_authority_753';
  END IF;

  SELECT COALESCE(SUM(item.line_subtotal),0),
         COALESCE(SUM(item.cgst_amount),0),
         COALESCE(SUM(item.sgst_amount),0),
         COALESCE(SUM(item.igst_amount),0)
    INTO aggregate_subtotal,aggregate_cgst,aggregate_sgst,aggregate_igst
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=(approval_receipt.response_body->>'invoice_id')::INTEGER
     AND item.source_ref_active=TRUE;
  IF invoice_subtotal IS DISTINCT FROM aggregate_subtotal
     OR invoice_cgst IS DISTINCT FROM aggregate_cgst
     OR invoice_sgst IS DISTINCT FROM aggregate_sgst
     OR invoice_igst IS DISTINCT FROM aggregate_igst
     OR invoice_total IS DISTINCT FROM ROUND(
          aggregate_subtotal+aggregate_cgst+aggregate_sgst+aggregate_igst
            - invoice_discount,
          2
        )
     OR EXISTS (
       SELECT 1 FROM billing_payments payment
        WHERE payment.tenant_id=target_tenant_id
          AND payment.invoice_id=(approval_receipt.response_body->>'invoice_id')::INTEGER
     )
     OR EXISTS (
       SELECT 1 FROM billing_refunds refund
        WHERE refund.tenant_id=target_tenant_id
          AND refund.invoice_id=(approval_receipt.response_body->>'invoice_id')::INTEGER
     )
     OR EXISTS (
       SELECT 1 FROM billing_advance_settlements settlement
        WHERE settlement.tenant_id=target_tenant_id
          AND settlement.invoice_id=(approval_receipt.response_body->>'invoice_id')::INTEGER
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance consumption invoice has financial lifecycle movement'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_final_finance_753';
  END IF;

  IF approval_receipt.approved_patient_amount=0 THEN
    IF EXISTS (
      SELECT 1 FROM tasks task
       WHERE task.tenant_id=target_tenant_id
         AND task.related_resource_type='pharmacy_advance_settlement'
         AND task.related_resource_id=target_consumption_receipt_id::text
    ) OR EXISTS (
      SELECT 1 FROM pharmacy_funding_commands command
       WHERE command.tenant_id=target_tenant_id
         AND command.command_type='PHARMACY_ADVANCE_SETTLEMENT'
         AND command.consumption_receipt_id=target_consumption_receipt_id
    ) THEN
      RAISE EXCEPTION 'Zero patient funding cannot create advance settlement authority'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_consumption_finance_task_753';
    END IF;
    RETURN;
  END IF;

  SELECT task.*
    INTO finance_task
    FROM tasks task
   WHERE task.tenant_id=target_tenant_id
     AND task.id=finance_task_id::INTEGER
   FOR UPDATE;
  IF NOT FOUND
     OR finance_task.task_kind<>'review'
     OR finance_task.related_resource_type<>'pharmacy_advance_settlement'
     OR finance_task.related_resource_id<>
        target_consumption_receipt_id::text
     OR finance_task.assigned_to_role<>'FINANCE_INCHARGE'
     OR finance_task.status<>'open'
     OR finance_task.priority<>'high'
     OR finance_task.patient_uid IS DISTINCT FROM order_patient_uid
     OR finance_task.metadata IS DISTINCT FROM jsonb_build_object(
       'contract','pharmacy_advance_settlement_task_v1',
       'stage','awaiting_finance_settlement',
       'approval_id',approval_receipt.response_body->'approval_id',
       'approval_receipt_id',target_approval_receipt_id::text,
       'consumption_receipt_id',target_consumption_receipt_id::text,
       'funding_task_id',approval_receipt.task_id,
       'pharmacy_order_id',approval_receipt.pharmacy_order_id,
       'invoice_id',approval_receipt.response_body->'invoice_id',
       'invoice_item_id',approval_receipt.invoice_item_id,
       'patient_uid',order_patient_uid::text,
       'allocation_ids',expected_allocation_ids,
       'mutation_command_sha256',mutation_command_sha256,
       'mutation_evidence_sha256',mutation_evidence_sha256,
       'permitted_roles',jsonb_build_array(
         'FINANCE_INCHARGE','BILLING_INCHARGE'
       )
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance consumption lacks its exact finance settlement task'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_consumption_finance_task_753';
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.assert_pharmacy_advance_patient_scope_753(target_tenant_id uuid, target_advance_id integer, target_patient_uid uuid, target_admission_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  target_terminal_uid UUID;
  admission_patient_uid UUID;
  admission_terminal_uid UUID;
  admission_started_at TIMESTAMPTZ;
  advance_patient_uid UUID;
  advance_terminal_uid UUID;
  advance_admission_id INTEGER;
  advance_collected_at TIMESTAMPTZ;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  target_terminal_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,target_patient_uid
  );
  IF target_admission_id IS NOT NULL THEN
    SELECT admission.patient_uid,
           COALESCE(admission.admitted_at,admission.created_at)
      INTO admission_patient_uid,admission_started_at
      FROM admissions admission
     WHERE admission.tenant_id=target_tenant_id
       AND admission.id=target_admission_id
     FOR UPDATE;
    IF NOT FOUND OR admission_started_at IS NULL THEN
      RAISE EXCEPTION 'Patient advance target admission authority is missing'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_patient_scope_753';
    END IF;
    admission_terminal_uid:=public.resolve_billing_patient_terminal_753(
      target_tenant_id,admission_patient_uid
    );
    IF admission_terminal_uid IS DISTINCT FROM target_terminal_uid THEN
      RAISE EXCEPTION 'Patient advance target admission belongs to another patient'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_patient_scope_753';
    END IF;
  END IF;
  SELECT advance.patient_uid,advance.admission_id,advance.collected_at
    INTO advance_patient_uid,advance_admission_id,advance_collected_at
    FROM billing_advances advance
   WHERE advance.tenant_id=target_tenant_id
     AND advance.id=target_advance_id
   FOR UPDATE;
  IF NOT FOUND OR advance_collected_at IS NULL THEN
    RAISE EXCEPTION 'Patient advance source authority is missing'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_patient_scope_753';
  END IF;
  advance_terminal_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,advance_patient_uid
  );
  IF advance_terminal_uid IS DISTINCT FROM target_terminal_uid
     OR (target_admission_id IS NULL AND advance_admission_id IS NOT NULL)
     OR (
       target_admission_id IS NOT NULL
       AND advance_admission_id IS DISTINCT FROM target_admission_id
       AND NOT (
         advance_admission_id IS NULL
         AND advance_collected_at<=admission_started_at
       )
     ) THEN
    RAISE EXCEPTION 'Patient advance source is outside the governed patient/admission scope'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_patient_scope_753';
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.assert_pharmacy_advance_release_receipt_753(target_tenant_id uuid, target_release_receipt_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  release_receipt pharmacy_funding_commands%ROWTYPE;
  approval_receipt pharmacy_funding_commands%ROWTYPE;
  allocation_count BIGINT;
  reversal_count BIGINT;
  invalid_count BIGINT;
  released_amount NUMERIC(14,2);
  expected_reversals JSONB;
  expected_allocation_ids JSONB;
  discovered_patient_uid UUID;
  terminal_patient_uid UUID;
  release_order pharmacy_orders%ROWTYPE;
  release_order_patient_uid UUID;
  release_invoice billing_invoices%ROWTYPE;
  release_item billing_invoice_items%ROWTYPE;
  release_invoice_items JSONB;
  release_billing JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  SELECT receipt.*
    INTO release_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=target_tenant_id
     AND receipt.id=target_release_receipt_id;
  IF NOT FOUND OR release_receipt.approval_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance release has no approval identity'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_release_complete_753';
  END IF;
  SELECT receipt.patient_uid
    INTO discovered_patient_uid
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=target_tenant_id
     AND receipt.id=release_receipt.approval_receipt_id
     AND receipt.command_type='SUBSTITUTION_FUNDING_APPROVAL';
  IF discovered_patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance release lacks approval patient lineage'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_release_complete_753';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,discovered_patient_uid
  );
  PERFORM public.resolve_billing_patient_family_753(
    target_tenant_id,terminal_patient_uid
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || target_tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || target_tenant_id::text || ':'
      || release_receipt.pharmacy_order_id::text,
    753
  ));
  SELECT receipt.*
    INTO approval_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=target_tenant_id
     AND receipt.id=release_receipt.approval_receipt_id
     AND receipt.command_type='SUBSTITUTION_FUNDING_APPROVAL'
     AND receipt.status='COMPLETE'
   FOR UPDATE;
  IF NOT FOUND
     OR approval_receipt.approved_patient_amount<=0
     OR approval_receipt.patient_uid IS DISTINCT FROM discovered_patient_uid
     OR approval_receipt.response_body #>> '{base,patient_uid}'
        IS DISTINCT FROM terminal_patient_uid::text THEN
    RAISE EXCEPTION 'Pharmacy advance release lacks its exact positive approval'
      USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || target_tenant_id::text || ':'
      || approval_receipt.id::text,
    0
  ));
  SELECT receipt.*
    INTO release_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=target_tenant_id
     AND receipt.id=target_release_receipt_id
     AND receipt.approval_receipt_id=approval_receipt.id
   FOR UPDATE;
  IF NOT FOUND
     OR release_receipt.command_type<>'PHARMACY_ADVANCE_RELEASE'
     OR release_receipt.status<>'COMPLETE'
     OR release_receipt.release_reason NOT IN (
       'AUTHORITY_SUPERSEDED','AUTHORITY_EXPIRED'
     )
     OR release_receipt.completed_at IS NULL
     OR release_receipt.completed_transaction_id IS NULL
     OR release_receipt.response_body IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance release receipt is not durably complete'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_release_complete_753';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pharmacy_funding_commands consumption
     WHERE consumption.tenant_id=target_tenant_id
       AND consumption.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
       AND consumption.approval_receipt_id=approval_receipt.id
       AND (
         consumption.status<>'ABANDONED'
         OR consumption.completed_at IS DISTINCT FROM
            release_receipt.completed_at
         OR consumption.completed_transaction_id IS DISTINCT FROM
            release_receipt.completed_transaction_id
         OR consumption.order_mutation_receipt_id IS NOT NULL
         OR consumption.response_body IS DISTINCT FROM jsonb_build_object(
           'contract','pharmacy_substitution_funding_consumption_abandoned_v1',
           'status','abandoned',
           'approval_receipt_id',approval_receipt.id::TEXT,
           'consumption_receipt_id',consumption.id::TEXT,
           'release_receipt_id',release_receipt.id::TEXT,
           'release_reason',release_receipt.release_reason,
           'pharmacy_order_id',release_receipt.pharmacy_order_id::TEXT,
           'invoice_id',release_receipt.invoice_id::TEXT,
           'invoice_item_id',release_receipt.invoice_item_id::TEXT,
           'patient_uid',terminal_patient_uid::TEXT,
           'abandoned_by',release_receipt.created_by::TEXT,
           'abandoned_at',to_char(
             release_receipt.completed_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )
         )
         OR EXISTS (
           SELECT 1 FROM pharmacy_advance_allocation_consumptions link
            WHERE link.tenant_id=consumption.tenant_id
              AND link.funding_consumption_receipt_id=consumption.id
         )
         OR EXISTS (
           SELECT 1 FROM tasks finance_task
            WHERE finance_task.tenant_id=consumption.tenant_id
              AND finance_task.related_resource_type=
                  'pharmacy_advance_settlement'
              AND finance_task.related_resource_id=consumption.id::TEXT
         )
       )
  ) THEN
    RAISE EXCEPTION 'Release did not canonically abandon its empty consumption claim'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pharmacy_order_command_receipts order_receipt
     WHERE order_receipt.tenant_id=target_tenant_id
       AND order_receipt.action='dispense_substitution'
       AND order_receipt.pharmacy_order_id=approval_receipt.pharmacy_order_id
  ) THEN
    RAISE EXCEPTION 'Any substitution mutation receipt permanently forbids release'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_release_complete_753';
  END IF;
  SELECT pharmacy_order.*
    INTO release_order
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=approval_receipt.pharmacy_order_id
   FOR UPDATE;
  SELECT patient.uid
    INTO release_order_patient_uid
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.id=release_order.patient_id
     AND patient.role='PATIENT'
   FOR UPDATE;
  SELECT invoice.*
    INTO release_invoice
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=approval_receipt.invoice_id
   FOR UPDATE;
  PERFORM 1
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=approval_receipt.invoice_id
   ORDER BY item.id
   FOR UPDATE;
  SELECT item.*
    INTO release_item
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=approval_receipt.invoice_id
     AND item.id=approval_receipt.invoice_item_id;
  SELECT COALESCE(jsonb_agg(
           public.pharmacy_substitution_invoice_item_projection_753(item)
           ORDER BY item.id
         ),'[]'::JSONB)
    INTO release_invoice_items
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=approval_receipt.invoice_id
     AND item.source_ref_active=TRUE;
  release_billing:=jsonb_build_object(
    'invoice',jsonb_build_object(
      'status',release_invoice.status,
      'invoice_number',release_invoice.invoice_number,
      'issued_at',release_invoice.issued_at,
      'voided_at',release_invoice.voided_at,
      'subtotal',release_invoice.subtotal::NUMERIC(12,2)::TEXT,
      'cgst_amount',COALESCE(release_invoice.cgst_amount,0)::NUMERIC(12,2)::TEXT,
      'sgst_amount',COALESCE(release_invoice.sgst_amount,0)::NUMERIC(12,2)::TEXT,
      'igst_amount',COALESCE(release_invoice.igst_amount,0)::NUMERIC(12,2)::TEXT,
      'tax_amount',(COALESCE(release_invoice.cgst_amount,0)
        +COALESCE(release_invoice.sgst_amount,0)
        +COALESCE(release_invoice.igst_amount,0))::NUMERIC(12,2)::TEXT,
      'discount_amount',COALESCE(release_invoice.discount_amount,0)::NUMERIC(12,2)::TEXT,
      'credit_note_amount',COALESCE(release_invoice.credit_note_amount,0)::NUMERIC(12,2)::TEXT,
      'total_amount',release_invoice.total_amount::NUMERIC(12,2)::TEXT,
      'amount_paid',COALESCE(release_invoice.amount_paid,0)::NUMERIC(12,2)::TEXT,
      'amount_due',release_invoice.amount_due::NUMERIC(12,2)::TEXT
    ),
    'item',jsonb_build_object(
      'quantity',release_item.quantity::NUMERIC(10,2)::TEXT,
      'unit_price',release_item.unit_price::NUMERIC(12,2)::TEXT,
      'gst_rate',release_item.gst_rate::NUMERIC(5,2)::TEXT,
      'line_subtotal',release_item.line_subtotal::NUMERIC(12,2)::TEXT,
      'cgst_amount',COALESCE(release_item.cgst_amount,0)::NUMERIC(12,2)::TEXT,
      'sgst_amount',COALESCE(release_item.sgst_amount,0)::NUMERIC(12,2)::TEXT,
      'igst_amount',COALESCE(release_item.igst_amount,0)::NUMERIC(12,2)::TEXT,
      'tax_amount',(COALESCE(release_item.cgst_amount,0)
        +COALESCE(release_item.sgst_amount,0)
        +COALESCE(release_item.igst_amount,0))::NUMERIC(12,2)::TEXT,
      'line_total',release_item.line_total::NUMERIC(12,2)::TEXT,
      'source_ref_type',release_item.source_ref_type,
      'source_ref_id',release_item.source_ref_id::TEXT,
      'source_ref_active',release_item.source_ref_active,
      'source_authority_version',release_item.source_authority_version,
      'source_authority_sha256',release_item.source_authority_sha256
    ),
    'items',release_invoice_items,
    'items_generation_sha256',encode(public.digest(
      release_invoice_items::TEXT,'sha256'
    ),'hex')
  );
  IF release_order.id IS NULL OR release_invoice.id IS NULL
     OR release_item.id IS NULL
     OR public.resolve_billing_patient_terminal_753(
          target_tenant_id,release_order_patient_uid
        ) IS DISTINCT FROM terminal_patient_uid
     OR release_order.facility_id IS DISTINCT FROM approval_receipt.facility_id
     OR release_order.funding_admission_id IS DISTINCT FROM
        release_invoice.admission_id
     OR release_order.inventory_authority_version IS DISTINCT FROM
        (approval_receipt.reservation_authority #>>
          '{base,order_version}')::INTEGER
     OR release_order.items_list IS DISTINCT FROM
        approval_receipt.reservation_authority #> '{base,items_list}'
     OR release_order.clinical_verification_items_sha256 IS DISTINCT FROM
        approval_receipt.reservation_authority #>> '{base,order_items_sha256}'
     OR release_order.total_amount IS DISTINCT FROM
        (approval_receipt.reservation_authority #>>
          '{base,authoritative_amount}')::NUMERIC(10,2)
     OR release_billing IS DISTINCT FROM
        approval_receipt.reservation_authority #> '{billing,base}'
     OR EXISTS (
       SELECT 1 FROM billing_payments payment
        WHERE payment.tenant_id=target_tenant_id
          AND payment.invoice_id=approval_receipt.invoice_id
     )
     OR EXISTS (
       SELECT 1 FROM billing_refunds refund
        WHERE refund.tenant_id=target_tenant_id
          AND refund.invoice_id=approval_receipt.invoice_id
     )
     OR EXISTS (
       SELECT 1 FROM billing_advance_settlements settlement
        WHERE settlement.tenant_id=target_tenant_id
          AND settlement.invoice_id=approval_receipt.invoice_id
     ) THEN
    RAISE EXCEPTION 'Release requires exact unchanged BASE order and billing authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_release_base_state_753';
  END IF;
  SELECT COUNT(*),
         COUNT(reversal.id),
         COUNT(*) FILTER (WHERE reversal.id IS NULL
           OR reversal.reason IS DISTINCT FROM release_receipt.release_reason
           OR reversal.reversal_command_sha256 IS DISTINCT FROM
              release_receipt.command_key_sha256
           OR reversal.reversed_amount IS DISTINCT FROM allocation.allocated_amount
           OR reversal.reversed_by IS DISTINCT FROM release_receipt.created_by
           OR reversal.reversed_at IS DISTINCT FROM release_receipt.completed_at
           OR reversal.evidence IS DISTINCT FROM jsonb_build_object(
             'contract','pharmacy_advance_release_reversal_v1',
             'release_receipt_id',release_receipt.id::text,
             'approval_receipt_id',approval_receipt.id::text,
             'source_approval_id',release_receipt.release_source_approval_id,
             'allocation_id',allocation.id::text,
             'billing_advance_id',allocation.billing_advance_id,
             'allocated_amount',allocation.allocated_amount::text,
             'allocation_evidence_sha256',allocation.evidence_sha256,
             'reason',release_receipt.release_reason,
             'reversal_command_sha256',reversal.reversal_command_sha256,
             'released_by',release_receipt.created_by::text
           )),
         COALESCE(SUM(reversal.reversed_amount),0),
         COALESCE(jsonb_agg(jsonb_build_object(
           'allocation_id',allocation.id::text,
           'billing_advance_id',allocation.billing_advance_id,
           'allocated_amount',allocation.allocated_amount::text,
           'allocation_evidence_sha256',allocation.evidence_sha256,
           'reversal_id',reversal.id::text,
           'reversal_command_sha256',reversal.reversal_command_sha256,
           'reversal_evidence_sha256',reversal.evidence_sha256
         ) ORDER BY allocation.id),'[]'::jsonb),
         COALESCE(jsonb_agg(to_jsonb(allocation.id::text)
           ORDER BY allocation.id),'[]'::jsonb)
    INTO allocation_count,reversal_count,invalid_count,released_amount,
         expected_reversals,expected_allocation_ids
    FROM pharmacy_advance_allocations allocation
    LEFT JOIN pharmacy_advance_allocation_reversals reversal
      ON reversal.tenant_id=allocation.tenant_id
     AND reversal.allocation_id=allocation.id
     AND reversal.funding_release_receipt_id=release_receipt.id
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.funding_approval_receipt_id=approval_receipt.id;
  IF allocation_count=0
     OR reversal_count<>allocation_count
     OR invalid_count<>0
     OR released_amount IS DISTINCT FROM approval_receipt.approved_patient_amount
     OR EXISTS (
       SELECT 1
         FROM pharmacy_advance_allocation_reversals reversal
         JOIN pharmacy_advance_allocations allocation
           ON allocation.tenant_id=reversal.tenant_id
          AND allocation.id=reversal.allocation_id
        WHERE allocation.tenant_id=target_tenant_id
          AND allocation.funding_approval_receipt_id=approval_receipt.id
          AND reversal.funding_release_receipt_id IS DISTINCT FROM release_receipt.id
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance release must atomically release every approval allocation'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_release_full_set_753';
  END IF;
  IF release_receipt.response_body IS DISTINCT FROM jsonb_build_object(
       'contract','pharmacy_advance_release_v1',
       'status','released',
       'release_reason',release_receipt.release_reason,
       'release_task_id',release_receipt.task_id,
       'approval_id',approval_receipt.governance_approval_id,
       'approval_receipt_id',approval_receipt.id::text,
       'source_approval_id',release_receipt.release_source_approval_id,
       'pharmacy_order_id',approval_receipt.pharmacy_order_id,
       'invoice_id',approval_receipt.invoice_id,
       'invoice_item_id',approval_receipt.invoice_item_id,
       'patient_uid',approval_receipt.response_body #>> '{base,patient_uid}',
       'released_amount',released_amount::NUMERIC(12,2)::text,
       'released_by',release_receipt.created_by::text,
       'allocation_ids',expected_allocation_ids,
       'reversals',expected_reversals,
       'released_at',to_char(
         release_receipt.completed_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance release response is not exact canonical evidence'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_release_complete_753';
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.assert_pharmacy_advance_settlement_receipt_753(target_tenant_id uuid, target_settlement_receipt_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  settlement_receipt pharmacy_funding_commands%ROWTYPE;
  approval_receipt pharmacy_funding_commands%ROWTYPE;
  consumption_receipt pharmacy_funding_commands%ROWTYPE;
  finance_task tasks%ROWTYPE;
  order_row pharmacy_orders%ROWTYPE;
  invoice_row billing_invoices%ROWTYPE;
  admission_row admissions%ROWTYPE;
  invoice_issue_entry ledger_entries%ROWTYPE;
  allocation_to_lock RECORD;
  allocation_count BIGINT;
  reversal_count BIGINT;
  settlement_count BIGINT;
  invalid_count BIGINT;
  settled_amount NUMERIC(14,2);
  expected_allocations JSONB;
  invoice_projection JSONB;
  expected_invoice_projection JSONB;
  discovered_patient_uid UUID;
  terminal_patient_uid UUID;
  order_patient_uid UUID;
  invoice_terminal_uid UUID;
  expected_due NUMERIC(12,2);
  expected_status VARCHAR(20);
  total_paise BIGINT;
  tax_paise BIGINT;
  revenue_paise BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  SELECT command.*
    INTO settlement_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_settlement_receipt_id
     AND command.command_type='PHARMACY_ADVANCE_SETTLEMENT';
  IF NOT FOUND OR settlement_receipt.approval_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance settlement has no approval identity'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_complete_753';
  END IF;
  SELECT command.patient_uid
    INTO discovered_patient_uid
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=settlement_receipt.approval_receipt_id
     AND command.command_type='SUBSTITUTION_FUNDING_APPROVAL';
  IF discovered_patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance settlement lacks approval patient lineage'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_complete_753';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,discovered_patient_uid
  );
  PERFORM public.resolve_billing_patient_family_753(
    target_tenant_id,terminal_patient_uid
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || target_tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || target_tenant_id::text || ':'
      || settlement_receipt.pharmacy_order_id::text,
    753
  ));
  SELECT command.*
    INTO approval_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=settlement_receipt.approval_receipt_id
   FOR UPDATE;
  IF NOT FOUND
     OR approval_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
     OR approval_receipt.status<>'COMPLETE'
     OR approval_receipt.approved_patient_amount<=0
     OR approval_receipt.patient_uid IS DISTINCT FROM discovered_patient_uid
     OR approval_receipt.response_body #>> '{base,patient_uid}'
        IS DISTINCT FROM terminal_patient_uid::text THEN
    RAISE EXCEPTION 'Pharmacy advance settlement lacks its completed positive approval'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_complete_753';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || target_tenant_id::text || ':'
      || approval_receipt.id::text,
    0
  ));
  SELECT command.*
    INTO settlement_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_settlement_receipt_id
     AND command.approval_receipt_id=approval_receipt.id
   FOR UPDATE;
  IF NOT FOUND
     OR settlement_receipt.command_type<>'PHARMACY_ADVANCE_SETTLEMENT'
     OR settlement_receipt.status<>'COMPLETE'
     OR settlement_receipt.completed_at IS NULL
     OR settlement_receipt.completed_transaction_id IS NULL
     OR settlement_receipt.response_body IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance settlement receipt is not durably complete'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_complete_753';
  END IF;
  SELECT command.*
    INTO consumption_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=settlement_receipt.consumption_receipt_id
     AND command.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
     AND command.status='COMPLETE'
     AND command.approval_receipt_id=approval_receipt.id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance settlement lacks completed consumption evidence'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_complete_753';
  END IF;
  SELECT task.*
    INTO finance_task
    FROM tasks task
   WHERE task.tenant_id=target_tenant_id
     AND task.id=settlement_receipt.task_id
     AND task.related_resource_type='pharmacy_advance_settlement'
     AND task.related_resource_id=consumption_receipt.id::TEXT
   FOR UPDATE;
  IF NOT FOUND OR finance_task.status<>'completed'
     OR finance_task.completed_at IS DISTINCT FROM settlement_receipt.completed_at
     OR finance_task.assigned_to_role<>'FINANCE_INCHARGE'
     OR finance_task.patient_uid IS DISTINCT FROM settlement_receipt.patient_uid THEN
    RAISE EXCEPTION 'Pharmacy advance settlement finance task is not canonically complete'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_complete_753';
  END IF;

  SELECT pharmacy_order.*
    INTO order_row
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=settlement_receipt.pharmacy_order_id
   FOR UPDATE;
  SELECT patient.uid
    INTO order_patient_uid
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.id=order_row.patient_id
     AND patient.role='PATIENT'
   FOR UPDATE;
  IF order_row.id IS NULL OR order_patient_uid IS NULL
     OR public.resolve_billing_patient_terminal_753(
          target_tenant_id,order_patient_uid
        ) IS DISTINCT FROM terminal_patient_uid
     OR order_row.facility_id IS DISTINCT FROM settlement_receipt.facility_id
     OR order_row.inventory_authority_version IS DISTINCT FROM
          (approval_receipt.reservation_authority #>>
            '{prospective,order_version}')::INTEGER
     OR order_row.items_list IS DISTINCT FROM
          approval_receipt.reservation_authority #> '{prospective,items_list}'
     OR order_row.clinical_verification_items_sha256 IS DISTINCT FROM
          approval_receipt.reservation_authority #>>
            '{prospective,order_items_sha256}'
     OR order_row.total_amount IS DISTINCT FROM
          (approval_receipt.reservation_authority #>>
            '{prospective,authoritative_amount}')::NUMERIC THEN
    RAISE EXCEPTION 'Pharmacy advance settlement order differs from consumed prospective authority'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1
    FROM facilities facility
   WHERE facility.tenant_id=target_tenant_id
     AND facility.id=order_row.facility_id
     AND facility.status='active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance settlement facility is inactive'
      USING ERRCODE='23514';
  END IF;
  SELECT invoice.*
    INTO invoice_row
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=settlement_receipt.invoice_id
   FOR UPDATE;
  PERFORM 1
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=settlement_receipt.invoice_id
   ORDER BY item.id
   FOR UPDATE;
  IF invoice_row.id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance settlement invoice is unavailable'
      USING ERRCODE='23514';
  END IF;
  invoice_terminal_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,invoice_row.patient_uid
  );
  IF invoice_terminal_uid IS DISTINCT FROM terminal_patient_uid
     OR invoice_row.admission_id IS DISTINCT FROM order_row.funding_admission_id THEN
    RAISE EXCEPTION 'Pharmacy advance settlement invoice lineage is stale'
      USING ERRCODE='23514';
  END IF;
  IF invoice_row.admission_id IS NOT NULL THEN
    SELECT admission.*
      INTO admission_row
      FROM admissions admission
     WHERE admission.tenant_id=target_tenant_id
       AND admission.id=invoice_row.admission_id
     FOR UPDATE;
    IF NOT FOUND OR admission_row.billing_closed_at IS NOT NULL
       OR public.resolve_billing_patient_terminal_753(
            target_tenant_id,admission_row.patient_uid
          ) IS DISTINCT FROM terminal_patient_uid THEN
      RAISE EXCEPTION 'Pharmacy advance settlement admission is closed or stale'
        USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM 1 FROM billing_payments payment
   WHERE payment.tenant_id=target_tenant_id
     AND payment.invoice_id=invoice_row.id
   ORDER BY payment.id FOR UPDATE;
  PERFORM 1 FROM billing_refunds refund
   WHERE refund.tenant_id=target_tenant_id
     AND refund.invoice_id=invoice_row.id
   ORDER BY refund.id FOR UPDATE;
  PERFORM 1 FROM billing_advance_settlements settlement
   WHERE settlement.tenant_id=target_tenant_id
     AND settlement.invoice_id=invoice_row.id
   ORDER BY settlement.id FOR UPDATE;
  PERFORM 1 FROM billing_credit_notes credit_note
   WHERE credit_note.tenant_id=target_tenant_id
     AND credit_note.invoice_id=invoice_row.id
   ORDER BY credit_note.id FOR UPDATE;
  IF EXISTS (
       SELECT 1 FROM billing_payments payment
        WHERE payment.tenant_id=target_tenant_id
          AND payment.invoice_id=invoice_row.id
     ) OR EXISTS (
       SELECT 1 FROM billing_refunds refund
        WHERE refund.tenant_id=target_tenant_id
          AND refund.invoice_id=invoice_row.id
     ) OR EXISTS (
       SELECT 1 FROM billing_credit_notes credit_note
        WHERE credit_note.tenant_id=target_tenant_id
          AND credit_note.invoice_id=invoice_row.id
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance settlement invoice has forbidden finance history'
      USING ERRCODE='23514';
  END IF;
  expected_due:=GREATEST(
    0,invoice_row.total_amount-COALESCE(invoice_row.credit_note_amount,0)
      -approval_receipt.approved_patient_amount
  )::NUMERIC(12,2);
  expected_status:=CASE WHEN expected_due<=0.005 THEN 'PAID' ELSE 'PARTIAL' END;
  expected_invoice_projection:=
    (approval_receipt.reservation_authority #> '{billing,prospective}')
    || jsonb_build_object(
      'invoice',(
        approval_receipt.reservation_authority #>
          '{billing,prospective,invoice}'
      ) || jsonb_build_object(
        'status',expected_status,
        'invoice_number',invoice_row.invoice_number,
        'issued_at',invoice_row.issued_at,
        'amount_paid',approval_receipt.approved_patient_amount::NUMERIC(12,2)::TEXT,
        'amount_due',expected_due::TEXT
      )
    );
  invoice_projection:=public.pharmacy_advance_invoice_projection_753(
    target_tenant_id,invoice_row.id,settlement_receipt.invoice_item_id
  );
  IF invoice_row.invoice_number IS NULL
     OR invoice_row.issued_at IS DISTINCT FROM settlement_receipt.completed_at
     OR invoice_row.status<>expected_status
     OR invoice_row.amount_paid IS DISTINCT FROM
          approval_receipt.approved_patient_amount
     OR invoice_row.amount_due IS DISTINCT FROM expected_due
     OR invoice_projection IS DISTINCT FROM expected_invoice_projection THEN
    RAISE EXCEPTION 'Pharmacy advance settlement invoice transition is not canonical'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_invoice_753';
  END IF;
  SELECT entry.*
    INTO invoice_issue_entry
    FROM ledger_entries entry
   WHERE entry.tenant_id=target_tenant_id
     AND entry.idempotency_key='issue-inv-' || invoice_row.id::TEXT;
  total_paise:=ROUND(invoice_row.total_amount*100)::BIGINT;
  tax_paise:=ROUND((
    COALESCE(invoice_row.cgst_amount,0)+COALESCE(invoice_row.sgst_amount,0)
    +COALESCE(invoice_row.igst_amount,0)
  )*100)::BIGINT;
  revenue_paise:=total_paise-tax_paise;
  IF invoice_issue_entry.id IS NULL
     OR invoice_issue_entry.entry_type<>'INVOICE_ISSUE'
     OR invoice_issue_entry.occurred_at IS DISTINCT FROM
          settlement_receipt.completed_at
     OR invoice_issue_entry.created_by IS DISTINCT FROM
          settlement_receipt.created_by
     OR invoice_issue_entry.metadata IS DISTINCT FROM jsonb_build_object(
       'contract','pharmacy_advance_conversion_invoice_issue_v1',
       'settlement_receipt_id',settlement_receipt.id::TEXT,
       'invoice_id',invoice_row.id
     )
     OR (SELECT COUNT(*) FROM ledger_postings posting
          WHERE posting.tenant_id=target_tenant_id
            AND posting.entry_id=invoice_issue_entry.id)<>
        (CASE WHEN tax_paise>0 THEN 3 ELSE 2 END)
     OR NOT EXISTS (
       SELECT 1 FROM ledger_postings posting
       JOIN ledger_accounts account
         ON account.tenant_id=posting.tenant_id
        AND account.id=posting.account_id
      WHERE posting.tenant_id=target_tenant_id
        AND posting.entry_id=invoice_issue_entry.id
        AND account.code='PATIENT_AR'
        AND posting.amount_paise=total_paise
        AND posting.patient_uid=invoice_row.patient_uid
        AND posting.invoice_id=invoice_row.id
     ) OR NOT EXISTS (
       SELECT 1 FROM ledger_postings posting
       JOIN ledger_accounts account
         ON account.tenant_id=posting.tenant_id
        AND account.id=posting.account_id
      WHERE posting.tenant_id=target_tenant_id
        AND posting.entry_id=invoice_issue_entry.id
        AND account.code='REVENUE'
        AND posting.amount_paise=-revenue_paise
     ) OR (tax_paise>0 AND NOT EXISTS (
       SELECT 1 FROM ledger_postings posting
       JOIN ledger_accounts account
         ON account.tenant_id=posting.tenant_id
        AND account.id=posting.account_id
      WHERE posting.tenant_id=target_tenant_id
        AND posting.entry_id=invoice_issue_entry.id
        AND account.code='TAX_PAYABLE'
        AND posting.amount_paise=-tax_paise
     )) THEN
    RAISE EXCEPTION 'Pharmacy advance settlement invoice ledger entry is not canonical'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_ledger_753';
  END IF;
  FOR allocation_to_lock IN
    SELECT allocation.id,allocation.billing_advance_id
      FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.funding_approval_receipt_id=approval_receipt.id
     ORDER BY allocation.billing_advance_id,allocation.id
  LOOP
    PERFORM 1 FROM billing_advances advance
     WHERE advance.tenant_id=target_tenant_id
       AND advance.id=allocation_to_lock.billing_advance_id
     FOR UPDATE;
    PERFORM 1 FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.id=allocation_to_lock.id
     FOR UPDATE;
  END LOOP;

  SELECT COUNT(*),COUNT(reversal.id),COUNT(settlement.id),
         COUNT(*) FILTER (WHERE consumption.id IS NULL
           OR reversal.id IS NULL OR settlement.id IS NULL
           OR advance.id IS NULL OR settlement_ledger.id IS NULL
           OR reversal.reason<>'SETTLED_TO_INVOICE'
           OR reversal.reversed_amount IS DISTINCT FROM allocation.allocated_amount
           OR reversal.reversal_command_sha256 IS DISTINCT FROM
              settlement_receipt.command_key_sha256
           OR reversal.reversed_by IS DISTINCT FROM settlement_receipt.created_by
           OR reversal.reversed_at IS DISTINCT FROM settlement_receipt.completed_at
           OR reversal.evidence IS DISTINCT FROM jsonb_build_object(
             'contract','pharmacy_advance_settlement_reversal_v1',
             'settlement_receipt_id',settlement_receipt.id::text,
             'approval_receipt_id',approval_receipt.id::text,
             'consumption_receipt_id',consumption_receipt.id::text,
             'allocation_id',allocation.id::text,
             'billing_advance_id',allocation.billing_advance_id,
             'allocated_amount',allocation.allocated_amount::text,
             'allocation_evidence_sha256',allocation.evidence_sha256,
             'settlement_id',settlement.id,
             'command_sha256',settlement_receipt.command_key_sha256,
             'settled_by',settlement_receipt.created_by::text
           )
           OR settlement.advance_id IS DISTINCT FROM allocation.billing_advance_id
           OR settlement.invoice_id IS DISTINCT FROM allocation.invoice_id
           OR settlement.amount IS DISTINCT FROM allocation.allocated_amount
           OR settlement.settled_by IS DISTINCT FROM settlement_receipt.created_by
           OR settlement.settled_at IS DISTINCT FROM settlement_receipt.completed_at
           OR settlement.pharmacy_advance_allocation_evidence_sha256 IS DISTINCT FROM
              allocation.evidence_sha256
           OR settlement.pharmacy_advance_conversion_command_sha256 IS DISTINCT FROM
              settlement_receipt.command_key_sha256
           OR settlement.pharmacy_advance_conversion_evidence_sha256 IS DISTINCT FROM
              reversal.evidence_sha256
           OR settlement_ledger.entry_type<>'ADVANCE_SETTLE'
           OR settlement_ledger.occurred_at IS DISTINCT FROM
              settlement_receipt.completed_at
           OR settlement_ledger.created_by IS DISTINCT FROM
              settlement_receipt.created_by
           OR settlement_ledger.metadata IS DISTINCT FROM jsonb_build_object(
             'contract','pharmacy_advance_conversion_settlement_v1',
             'settlement_receipt_id',settlement_receipt.id::TEXT,
             'settlement_id',settlement.id,
             'allocation_id',allocation.id::TEXT
           )
           OR (SELECT COUNT(*) FROM ledger_postings posting
                WHERE posting.tenant_id=target_tenant_id
                  AND posting.entry_id=settlement_ledger.id)<>2
           OR NOT EXISTS (
             SELECT 1 FROM ledger_postings posting
             JOIN ledger_accounts account
               ON account.tenant_id=posting.tenant_id
              AND account.id=posting.account_id
            WHERE posting.tenant_id=target_tenant_id
              AND posting.entry_id=settlement_ledger.id
              AND account.code='PATIENT_ADVANCE'
              AND posting.amount_paise=ROUND(settlement.amount*100)::BIGINT
              AND posting.patient_uid=advance.patient_uid
              AND posting.advance_id=advance.id
           )
           OR NOT EXISTS (
             SELECT 1 FROM ledger_postings posting
             JOIN ledger_accounts account
               ON account.tenant_id=posting.tenant_id
              AND account.id=posting.account_id
            WHERE posting.tenant_id=target_tenant_id
              AND posting.entry_id=settlement_ledger.id
              AND account.code='PATIENT_AR'
              AND posting.amount_paise=-ROUND(settlement.amount*100)::BIGINT
              AND posting.patient_uid=invoice_row.patient_uid
              AND posting.invoice_id=invoice_row.id
           )
           OR ROUND(advance.balance*100)::BIGINT IS DISTINCT FROM (
             SELECT COALESCE(SUM(balance.balance_paise),0)::BIGINT
               FROM ledger_balances balance
               JOIN ledger_accounts account
                 ON account.tenant_id=balance.tenant_id
                AND account.id=balance.account_id
                AND account.code='PATIENT_ADVANCE'
              WHERE balance.tenant_id=target_tenant_id
                AND balance.advance_id=advance.id
           )),
         COALESCE(SUM(settlement.amount),0),
         COALESCE(jsonb_agg(jsonb_build_object(
           'allocation_id',allocation.id::text,
           'billing_advance_id',allocation.billing_advance_id,
           'allocation_evidence_sha256',allocation.evidence_sha256,
           'allocated_amount',allocation.allocated_amount::text,
           'settlement_id',settlement.id,
           'reversal_id',reversal.id::text,
           'reversal_command_sha256',reversal.reversal_command_sha256,
           'settlement_command_sha256',
              settlement.pharmacy_advance_conversion_command_sha256,
           'settlement_ledger_entry_id',settlement_ledger.id::TEXT
         ) ORDER BY allocation.id),'[]'::jsonb)
    INTO allocation_count,reversal_count,settlement_count,invalid_count,
         settled_amount,expected_allocations
    FROM pharmacy_advance_allocations allocation
    LEFT JOIN pharmacy_advance_allocation_consumptions consumption
      ON consumption.tenant_id=allocation.tenant_id
     AND consumption.allocation_id=allocation.id
     AND consumption.funding_consumption_receipt_id=consumption_receipt.id
    LEFT JOIN pharmacy_advance_allocation_reversals reversal
      ON reversal.tenant_id=allocation.tenant_id
     AND reversal.allocation_id=allocation.id
     AND reversal.funding_settlement_receipt_id=settlement_receipt.id
    LEFT JOIN billing_advance_settlements settlement
      ON settlement.tenant_id=allocation.tenant_id
     AND settlement.pharmacy_advance_allocation_id=allocation.id
     AND settlement.pharmacy_advance_settlement_receipt_id=settlement_receipt.id
    LEFT JOIN billing_advances advance
      ON advance.tenant_id=allocation.tenant_id
     AND advance.id=allocation.billing_advance_id
    LEFT JOIN ledger_entries settlement_ledger
      ON settlement_ledger.tenant_id=settlement.tenant_id
     AND settlement_ledger.idempotency_key=
         'advance-settle-' || settlement.id::TEXT
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.funding_approval_receipt_id=approval_receipt.id;

  IF allocation_count=0
     OR reversal_count<>allocation_count
     OR settlement_count<>allocation_count
     OR invalid_count<>0
     OR settled_amount IS DISTINCT FROM approval_receipt.approved_patient_amount
     OR EXISTS (
       SELECT 1
         FROM billing_advance_settlements settlement
         LEFT JOIN pharmacy_advance_allocations allocation
           ON allocation.tenant_id=settlement.tenant_id
          AND allocation.id=settlement.pharmacy_advance_allocation_id
        WHERE settlement.tenant_id=target_tenant_id
          AND settlement.pharmacy_advance_settlement_receipt_id=
              settlement_receipt.id
          AND (
            allocation.id IS NULL
            OR allocation.funding_approval_receipt_id<>approval_receipt.id
          )
     )
     OR EXISTS (
       SELECT 1
         FROM pharmacy_advance_allocation_reversals reversal
         LEFT JOIN pharmacy_advance_allocations allocation
           ON allocation.tenant_id=reversal.tenant_id
          AND allocation.id=reversal.allocation_id
        WHERE reversal.tenant_id=target_tenant_id
          AND reversal.funding_settlement_receipt_id=settlement_receipt.id
          AND (
            allocation.id IS NULL
            OR allocation.funding_approval_receipt_id<>approval_receipt.id
          )
     )
     OR EXISTS (
       SELECT 1 FROM billing_advance_settlements settlement
        WHERE settlement.tenant_id=target_tenant_id
          AND settlement.invoice_id=settlement_receipt.invoice_id
          AND settlement.pharmacy_advance_settlement_receipt_id
              IS DISTINCT FROM settlement_receipt.id
     )
     OR EXISTS (
       SELECT 1
         FROM pharmacy_advance_allocation_reversals reversal
         JOIN pharmacy_advance_allocations allocation
           ON allocation.tenant_id=reversal.tenant_id
          AND allocation.id=reversal.allocation_id
        WHERE allocation.tenant_id=target_tenant_id
          AND allocation.funding_approval_receipt_id=approval_receipt.id
          AND reversal.funding_settlement_receipt_id
              IS DISTINCT FROM settlement_receipt.id
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance settlement must atomically convert every consumed allocation'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_full_set_753';
  END IF;
  IF settlement_receipt.response_body IS DISTINCT FROM jsonb_build_object(
       'contract','pharmacy_advance_settlement_v1',
       'status','settled_to_invoice',
       'finance_task_id',settlement_receipt.task_id,
       'approval_receipt_id',approval_receipt.id::text,
       'consumption_receipt_id',consumption_receipt.id::text,
       'pharmacy_order_id',approval_receipt.pharmacy_order_id,
       'invoice_id',approval_receipt.invoice_id,
       'invoice_item_id',approval_receipt.invoice_item_id,
       'patient_uid',approval_receipt.response_body #>> '{base,patient_uid}',
       'settled_amount',settled_amount::NUMERIC(12,2)::text,
       'tpa_receivable_amount','0.00',
       'settled_by',settlement_receipt.created_by::text,
       'invoice',jsonb_build_object(
         'invoice_number',invoice_row.invoice_number,
         'status',invoice_row.status,
         'issued_at',to_char(
           invoice_row.issued_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         ),
         'total_amount',invoice_row.total_amount::NUMERIC(12,2)::TEXT,
         'credit_note_amount',COALESCE(
           invoice_row.credit_note_amount,0
         )::NUMERIC(12,2)::TEXT,
         'amount_paid',invoice_row.amount_paid::NUMERIC(12,2)::TEXT,
         'amount_due',invoice_row.amount_due::NUMERIC(12,2)::TEXT
       ),
       'invoice_issue_ledger_entry_id',invoice_issue_entry.id::TEXT,
       'allocations',expected_allocations,
       'settled_at',to_char(
         settlement_receipt.completed_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance settlement response is not exact canonical evidence'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_complete_753';
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.build_pharmacy_advance_reservation_plan_753(target_tenant_id uuid, target_terminal_patient_uid uuid, target_patient_uid_family uuid[], target_pharmacy_order_id integer, target_invoice_id integer, target_invoice_item_id integer, target_tpa_claim_id integer, target_prospective_amount numeric, target_excluded_approval_receipt_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  order_patient_id INTEGER;
  order_facility_id INTEGER;
  order_patient_uid UUID;
  order_lineage_uid UUID;
  funding_patient_uid UUID;
  funding_patient_family UUID[];
  target_admission_id INTEGER;
  admission_patient_uid UUID;
  admission_started_at TIMESTAMPTZ;
  base_order_version INTEGER;
  base_order_sha256 CHAR(64);
  base_order_total NUMERIC(10,2);
  funding_event_id BIGINT;
  funding_event_facility_id INTEGER;
  funding_event_admission_id INTEGER;
  funding_event_tpa_claim_id INTEGER;
  funding_event_amount NUMERIC(12,2);
  funding_event_evidence JSONB;
  materialized_funding_source TEXT;
  materialized_funding_reference TEXT;
  funding_source TEXT;
  funding_reference TEXT;
  invoice_patient_uid UUID;
  invoice_admission_id INTEGER;
  item_order_version INTEGER;
  item_order_sha256 CHAR(64);
  tpa_claim_patient_uid UUID;
  tpa_claim_approved_amount NUMERIC(14,2):=0;
  tpa_decision_id INTEGER;
  tpa_decision_amount NUMERIC(12,2):=0;
  tpa_exact_decision_count INTEGER:=0;
  tpa_decision_total NUMERIC(14,2):=0;
  tpa_used_amount NUMERIC(12,2):=0;
  patient_required_amount NUMERIC(12,2):=0;
  eligible_advance_ids INTEGER[]:='{}'::INTEGER[];
  eligible_allocation_ids BIGINT[]:='{}'::BIGINT[];
  invalid_capacity_count INTEGER:=0;
  selected_total NUMERIC(14,2):=0;
  source_evidence JSONB;
  source_evidence_sha256 CHAR(64);
  funding_evidence JSONB;
  funding_evidence_sha256 CHAR(64);
  reservation_rows JSONB;
  original_total NUMERIC(14,2):=0;
  balance_total NUMERIC(14,2):=0;
  settlement_total NUMERIC(14,2):=0;
  refund_total NUMERIC(14,2):=0;
  other_allocation_total NUMERIC(14,2):=0;
  available_total NUMERIC(14,2):=0;
BEGIN
  IF target_tenant_id IS NULL
     OR target_terminal_patient_uid IS NULL
     OR target_patient_uid_family IS NULL
     OR CARDINALITY(target_patient_uid_family)=0
     OR target_patient_uid_family[1] IS DISTINCT FROM
        target_terminal_patient_uid
     OR target_pharmacy_order_id IS NULL OR target_pharmacy_order_id<=0
     OR target_invoice_id IS NULL OR target_invoice_id<=0
     OR target_invoice_item_id IS NULL OR target_invoice_item_id<=0
     OR target_prospective_amount IS NULL OR target_prospective_amount<=0
     OR target_prospective_amount>=100000000
     OR target_prospective_amount<>ROUND(target_prospective_amount,2) THEN
    RAISE EXCEPTION 'Pharmacy advance reservation preview has invalid target authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_preview_753';
  END IF;
  funding_patient_uid:=target_terminal_patient_uid;
  funding_patient_family:=target_patient_uid_family;

  SELECT pharmacy_order.patient_id,pharmacy_order.uid,
         pharmacy_order.funding_admission_id,
         pharmacy_order.inventory_authority_version,
         pharmacy_order.clinical_verification_items_sha256,
         pharmacy_order.total_amount
    INTO order_patient_id,order_lineage_uid,target_admission_id,base_order_version,
         base_order_sha256,base_order_total
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=target_pharmacy_order_id;
  IF NOT FOUND OR base_order_version<=0
     OR base_order_sha256 !~ '^[0-9a-f]{64}$'
     OR base_order_total<0 THEN
    RAISE EXCEPTION 'Pharmacy advance reservation order generation is unavailable'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_preview_753';
  END IF;
  SELECT patient.uid
    INTO order_patient_uid
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.id=order_patient_id
     AND patient.role='PATIENT';
  IF order_patient_uid IS NULL
     OR NOT order_patient_uid=ANY(funding_patient_family)
     OR public.resolve_billing_patient_terminal_753(
          target_tenant_id,order_patient_uid
        ) IS DISTINCT FROM funding_patient_uid THEN
    RAISE EXCEPTION 'Pharmacy advance reservation patient changed before lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM 1
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.uid=funding_patient_uid
     AND patient.role='PATIENT'
     AND patient.is_active=TRUE
     AND patient.status='active'
     AND COALESCE(patient.is_deleted,FALSE)=FALSE
     AND patient.merged_into_uid IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation terminal patient is unavailable'
      USING ERRCODE='40001';
  END IF;
  SELECT invoice.patient_uid,invoice.admission_id
    INTO invoice_patient_uid,invoice_admission_id
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=target_invoice_id
     AND invoice.status='DRAFT'
     AND invoice.issued_at IS NULL
     AND invoice.voided_at IS NULL
     AND COALESCE(invoice.amount_paid,0)=0
     AND COALESCE(invoice.credit_note_amount,0)=0
     AND invoice.amount_due IS NOT DISTINCT FROM invoice.total_amount;
  IF NOT FOUND
     OR NOT invoice_patient_uid=ANY(funding_patient_family)
     OR invoice_admission_id IS DISTINCT FROM target_admission_id THEN
    RAISE EXCEPTION 'Pharmacy advance reservation invoice authority is stale'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_preview_753';
  END IF;
  IF order_lineage_uid IS NOT NULL
     AND (
       NOT order_lineage_uid=ANY(funding_patient_family)
       OR public.resolve_billing_patient_terminal_753(
            target_tenant_id,order_lineage_uid
          ) IS DISTINCT FROM funding_patient_uid
       OR NOT EXISTS (
         SELECT 1
           FROM users lineage_patient
          WHERE lineage_patient.tenant_id=target_tenant_id
            AND lineage_patient.uid=order_lineage_uid
            AND lineage_patient.role='PATIENT'
       )
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance reservation order UUID lineage is stale'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_preview_753';
  END IF;
  SELECT item.source_authority_version,item.source_authority_sha256
    INTO item_order_version,item_order_sha256
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.id=target_invoice_item_id
     AND item.invoice_id=target_invoice_id
     AND item.source_ref_type='pharmacy_order'
     AND item.source_ref_id=target_pharmacy_order_id::BIGINT
     AND item.source_ref_active=TRUE;
  IF NOT FOUND OR item_order_version IS DISTINCT FROM base_order_version
     OR item_order_sha256 IS DISTINCT FROM base_order_sha256 THEN
    RAISE EXCEPTION 'Pharmacy advance reservation invoice item authority is stale'
      USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_reservation_preview_753';
  END IF;

  SELECT event.id,event.facility_id,event.admission_id,event.tpa_claim_id,
         event.amount,event.evidence
    INTO funding_event_id,funding_event_facility_id,funding_event_admission_id,
         funding_event_tpa_claim_id,funding_event_amount,funding_event_evidence
    FROM pharmacy_funding_decision_events event
   WHERE event.tenant_id=target_tenant_id
     AND event.pharmacy_order_id=target_pharmacy_order_id
     AND event.invoice_id=target_invoice_id
     AND event.invoice_item_id=target_invoice_item_id
     AND event.event_type='LINE_MATERIALIZED'
     AND event.source_authority_version=base_order_version
     AND event.source_authority_sha256=base_order_sha256
   ORDER BY event.id
   LIMIT 2;
  IF NOT FOUND
     OR funding_event_facility_id IS DISTINCT FROM (
       SELECT pharmacy_order.facility_id
         FROM pharmacy_orders pharmacy_order
        WHERE pharmacy_order.tenant_id=target_tenant_id
          AND pharmacy_order.id=target_pharmacy_order_id
     )
     OR funding_event_admission_id IS DISTINCT FROM target_admission_id
     OR jsonb_typeof(funding_event_evidence) IS DISTINCT FROM 'object'
     OR jsonb_typeof(funding_event_evidence->'authority_changed')
          IS DISTINCT FROM 'boolean'
     OR funding_event_evidence-'authority_changed'<>'{}'::JSONB
     OR funding_event_tpa_claim_id IS DISTINCT FROM target_tpa_claim_id
     OR funding_event_amount IS DISTINCT FROM base_order_total::NUMERIC(12,2)
     OR EXISTS (
       SELECT 1
         FROM pharmacy_funding_decision_events competing
        WHERE competing.tenant_id=target_tenant_id
          AND competing.pharmacy_order_id=target_pharmacy_order_id
          AND competing.invoice_id=target_invoice_id
          AND competing.invoice_item_id=target_invoice_item_id
          AND competing.event_type='LINE_MATERIALIZED'
          AND competing.source_authority_version=base_order_version
          AND competing.source_authority_sha256=base_order_sha256
          AND competing.id<>funding_event_id
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance reservation lacks one exact materialized funding event'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_funding_event_753';
  END IF;
  materialized_funding_source:='line_materialized';
  materialized_funding_reference:='line-event:' || funding_event_id::TEXT;

  IF target_admission_id IS NOT NULL THEN
    SELECT admission.patient_uid,
           COALESCE(admission.admitted_at,admission.created_at)
      INTO admission_patient_uid,admission_started_at
     FROM admissions admission
     WHERE admission.tenant_id=target_tenant_id
       AND admission.id=target_admission_id;
    IF NOT FOUND OR admission_started_at IS NULL
       OR NOT admission_patient_uid=ANY(funding_patient_family) THEN
      RAISE EXCEPTION 'Pharmacy advance reservation admission authority is stale'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_reservation_preview_753';
    END IF;
  END IF;
  PERFORM 1 FROM billing_payments payment
   WHERE payment.tenant_id=target_tenant_id
     AND payment.invoice_id=target_invoice_id;
  IF FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation invoice already has payment history'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_invoice_lifecycle_753';
  END IF;
  PERFORM 1 FROM billing_refunds refund
   WHERE refund.tenant_id=target_tenant_id
     AND refund.invoice_id=target_invoice_id;
  IF FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation invoice already has refund history'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_invoice_lifecycle_753';
  END IF;
  PERFORM 1 FROM billing_advance_settlements settlement
   WHERE settlement.tenant_id=target_tenant_id
     AND settlement.invoice_id=target_invoice_id;
  IF FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation invoice already has settlement history'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_invoice_lifecycle_753';
  END IF;

  IF target_tpa_claim_id IS NOT NULL THEN
    SELECT claim.patient_uid,claim.approved_amount
      INTO tpa_claim_patient_uid,tpa_claim_approved_amount
      FROM tpa_claims claim
     WHERE claim.tenant_id=target_tenant_id
       AND claim.id=target_tpa_claim_id
       AND claim.invoice_id=target_invoice_id
       AND claim.admission_id IS NOT DISTINCT FROM target_admission_id
       AND claim.patient_uid=ANY(funding_patient_family)
       AND claim.status IN ('approved','partially_approved','paid');
    IF NOT FOUND OR tpa_claim_approved_amount<0 THEN
      RAISE EXCEPTION 'Pharmacy advance reservation TPA claim authority is stale'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_reservation_preview_753';
    END IF;
    SELECT COUNT(*) FILTER (
             WHERE decision.invoice_item_id=target_invoice_item_id
               AND decision.source_authority_version=base_order_version
               AND decision.source_authority_sha256=base_order_sha256
           ),
           MAX(decision.id) FILTER (
             WHERE decision.invoice_item_id=target_invoice_item_id
               AND decision.source_authority_version=base_order_version
               AND decision.source_authority_sha256=base_order_sha256
           ),
           MAX(decision.approved_amount) FILTER (
             WHERE decision.invoice_item_id=target_invoice_item_id
               AND decision.source_authority_version=base_order_version
               AND decision.source_authority_sha256=base_order_sha256
           ),
           COALESCE(SUM(decision.approved_amount),0)
      INTO tpa_exact_decision_count,tpa_decision_id,tpa_decision_amount,
           tpa_decision_total
      FROM tpa_claim_line_decisions decision
     WHERE decision.tenant_id=target_tenant_id
       AND decision.claim_id=target_tpa_claim_id
       AND decision.invalidated_at IS NULL;
    IF tpa_exact_decision_count<>1 OR tpa_decision_amount<0
       OR tpa_decision_total>tpa_claim_approved_amount THEN
      RAISE EXCEPTION 'Pharmacy advance reservation TPA line authority is stale'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_reservation_preview_753';
    END IF;
    tpa_used_amount:=LEAST(
      tpa_decision_amount::NUMERIC(12,2),
      target_prospective_amount::NUMERIC(12,2)
    );
  END IF;
  patient_required_amount:=
    target_prospective_amount::NUMERIC(12,2)-tpa_used_amount;

  IF tpa_used_amount>0 AND patient_required_amount>0 THEN
    RAISE EXCEPTION 'Mixed TPA and patient-advance substitution funding is not atomically settleable'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_mixed_funding_753';
  END IF;

  IF patient_required_amount>0 THEN
    SELECT COALESCE(ARRAY_AGG(advance.id ORDER BY advance.id),'{}'::INTEGER[])
      INTO eligible_advance_ids
      FROM billing_advances advance
     WHERE advance.tenant_id=target_tenant_id
       AND advance.patient_uid=ANY(funding_patient_family)
       AND advance.status='ACTIVE'
       AND advance.collected_at IS NOT NULL
       AND UPPER(BTRIM(advance.mode)) IN (
         'CASH','CARD','UPI','NETBANKING','CHEQUE','DD','WALLET',
         'ONLINE','BANK_TRANSFER'
       )
       AND (
         (target_admission_id IS NULL AND advance.admission_id IS NULL)
         OR
         (target_admission_id IS NOT NULL AND (
           advance.admission_id=target_admission_id
           OR (advance.admission_id IS NULL
             AND advance.collected_at IS NOT NULL
             AND advance.collected_at<=admission_started_at)
         ))
       );
  END IF;

  IF CARDINALITY(eligible_advance_ids)>0 THEN
    SELECT COALESCE(ARRAY_AGG(allocation.id ORDER BY allocation.id),'{}'::BIGINT[])
      INTO eligible_allocation_ids
      FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.billing_advance_id=ANY(eligible_advance_ids);
  END IF;

  WITH settlement_totals AS (
    SELECT settlement.advance_id,SUM(settlement.amount)::NUMERIC(14,2) AS amount
      FROM billing_advance_settlements settlement
     WHERE settlement.tenant_id=target_tenant_id
       AND settlement.advance_id=ANY(eligible_advance_ids)
     GROUP BY settlement.advance_id
  ), refund_totals AS (
    SELECT refund.advance_id,SUM(refund.amount)::NUMERIC(14,2) AS amount
      FROM billing_refunds refund
     WHERE refund.tenant_id=target_tenant_id
       AND refund.advance_id=ANY(eligible_advance_ids)
       AND refund.approval_status<>'REJECTED'
     GROUP BY refund.advance_id
  ), reversal_totals AS (
    SELECT reversal.allocation_id,SUM(reversal.reversed_amount)::NUMERIC(14,2) AS amount
      FROM pharmacy_advance_allocation_reversals reversal
     WHERE reversal.tenant_id=target_tenant_id
       AND reversal.allocation_id=ANY(eligible_allocation_ids)
     GROUP BY reversal.allocation_id
  ), allocation_lines AS (
    SELECT allocation.id,allocation.billing_advance_id,
           allocation.funding_approval_receipt_id,
           allocation.allocated_amount
             -COALESCE(reversal_totals.amount,0) AS net_amount
      FROM pharmacy_advance_allocations allocation
      LEFT JOIN reversal_totals ON reversal_totals.allocation_id=allocation.id
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.billing_advance_id=ANY(eligible_advance_ids)
  ), allocation_totals AS (
    SELECT line.billing_advance_id,
           SUM(line.net_amount)::NUMERIC(14,2) AS all_live,
           SUM(line.net_amount) FILTER (
             WHERE target_excluded_approval_receipt_id IS NULL
                OR line.funding_approval_receipt_id<>
                   target_excluded_approval_receipt_id
           )::NUMERIC(14,2) AS other_live
      FROM allocation_lines line
     GROUP BY line.billing_advance_id
  ), advance_plan AS (
    SELECT advance.id,advance.patient_uid,advance.admission_id,
           advance.amount::NUMERIC(12,2) AS amount,
           advance.balance::NUMERIC(12,2) AS balance,
           UPPER(BTRIM(advance.mode)) AS mode,advance.reference,
           advance.collected_at,
           COALESCE(settlement_totals.amount,0)::NUMERIC(12,2) AS settled,
           COALESCE(refund_totals.amount,0)::NUMERIC(12,2) AS refunded,
           COALESCE(allocation_totals.all_live,0)::NUMERIC(12,2) AS all_live,
           COALESCE(allocation_totals.other_live,0)::NUMERIC(12,2) AS other_live,
           LEAST(
             advance.balance,
             advance.amount-COALESCE(settlement_totals.amount,0)
               -COALESCE(refund_totals.amount,0)
           )-COALESCE(allocation_totals.other_live,0) AS available
      FROM billing_advances advance
      LEFT JOIN settlement_totals ON settlement_totals.advance_id=advance.id
      LEFT JOIN refund_totals ON refund_totals.advance_id=advance.id
      LEFT JOIN allocation_totals ON allocation_totals.billing_advance_id=advance.id
     WHERE advance.tenant_id=target_tenant_id
       AND advance.id=ANY(eligible_advance_ids)
  ), ordered_plan AS (
    SELECT plan.*,
           COALESCE(SUM(plan.available) OVER (
             ORDER BY plan.collected_at ASC NULLS LAST,plan.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ),0)::NUMERIC(14,2) AS prior_available
      FROM advance_plan plan
  ), selected_plan AS (
    SELECT plan.*,
           GREATEST(0,LEAST(
             plan.available,
             patient_required_amount-plan.prior_available
           ))::NUMERIC(12,2) AS selected
      FROM ordered_plan plan
  )
  SELECT COUNT(*) FILTER (
           WHERE plan.amount<=0 OR plan.balance<0 OR plan.balance>plan.amount
              OR plan.settled<0 OR plan.refunded<0 OR plan.all_live<0
              OR plan.settled+plan.refunded>plan.amount
              OR plan.all_live>plan.balance
              OR plan.settled+plan.refunded+plan.all_live>plan.amount
              OR plan.available<0
         ),
         COALESCE(SUM(plan.selected),0),
         COALESCE(SUM(plan.amount),0),COALESCE(SUM(plan.balance),0),
         COALESCE(SUM(plan.settled),0),COALESCE(SUM(plan.refunded),0),
         COALESCE(SUM(plan.other_live),0),COALESCE(SUM(plan.available),0),
         COALESCE(jsonb_agg(jsonb_build_object(
           'billing_advance_id',plan.id,
           'stored_patient_uid',plan.patient_uid::text,
           'allocated_amount',plan.selected::NUMERIC(12,2)::text
         ) ORDER BY plan.id) FILTER (WHERE plan.selected>0),'[]'::JSONB)
    INTO invalid_capacity_count,selected_total,original_total,balance_total,
         settlement_total,refund_total,other_allocation_total,available_total,
         reservation_rows
    FROM selected_plan plan;
  IF invalid_capacity_count<>0 OR selected_total<>patient_required_amount THEN
    RAISE EXCEPTION 'Live patient advances do not exactly cover the governed reservation'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_capacity_753';
  END IF;

  WITH settlement_totals AS (
    SELECT settlement.advance_id,SUM(settlement.amount)::NUMERIC(14,2) AS amount
      FROM billing_advance_settlements settlement
     WHERE settlement.tenant_id=target_tenant_id
       AND settlement.advance_id=ANY(eligible_advance_ids)
     GROUP BY settlement.advance_id
  ), refund_totals AS (
    SELECT refund.advance_id,SUM(refund.amount)::NUMERIC(14,2) AS amount
      FROM billing_refunds refund
     WHERE refund.tenant_id=target_tenant_id
       AND refund.advance_id=ANY(eligible_advance_ids)
       AND refund.approval_status<>'REJECTED'
     GROUP BY refund.advance_id
  ), reversal_totals AS (
    SELECT reversal.allocation_id,SUM(reversal.reversed_amount)::NUMERIC(14,2) AS amount
      FROM pharmacy_advance_allocation_reversals reversal
     WHERE reversal.tenant_id=target_tenant_id
       AND reversal.allocation_id=ANY(eligible_allocation_ids)
     GROUP BY reversal.allocation_id
  ), allocation_lines AS (
    SELECT allocation.id,allocation.billing_advance_id,
           allocation.funding_approval_receipt_id,
           allocation.allocated_amount,
           allocation.allocated_amount-COALESCE(reversal_totals.amount,0) AS net_amount
      FROM pharmacy_advance_allocations allocation
      LEFT JOIN reversal_totals ON reversal_totals.allocation_id=allocation.id
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.billing_advance_id=ANY(eligible_advance_ids)
  ), allocation_totals AS (
    SELECT line.billing_advance_id,
           SUM(line.net_amount) FILTER (
             WHERE target_excluded_approval_receipt_id IS NULL
                OR line.funding_approval_receipt_id<>
                   target_excluded_approval_receipt_id
           )::NUMERIC(14,2) AS other_live
      FROM allocation_lines line GROUP BY line.billing_advance_id
  ), advance_plan AS (
    SELECT advance.id,advance.patient_uid,advance.admission_id,advance.amount,
           advance.balance,UPPER(BTRIM(advance.mode)) AS mode,advance.reference,
           advance.collected_at,
           COALESCE(settlement_totals.amount,0)::NUMERIC(12,2) AS settled,
           COALESCE(refund_totals.amount,0)::NUMERIC(12,2) AS refunded,
           COALESCE(allocation_totals.other_live,0)::NUMERIC(12,2) AS other_live,
           LEAST(advance.balance,
             advance.amount-COALESCE(settlement_totals.amount,0)
               -COALESCE(refund_totals.amount,0))
             -COALESCE(allocation_totals.other_live,0) AS available
      FROM billing_advances advance
      LEFT JOIN settlement_totals ON settlement_totals.advance_id=advance.id
      LEFT JOIN refund_totals ON refund_totals.advance_id=advance.id
      LEFT JOIN allocation_totals ON allocation_totals.billing_advance_id=advance.id
     WHERE advance.tenant_id=target_tenant_id
       AND advance.id=ANY(eligible_advance_ids)
  ), ordered_plan AS (
    SELECT plan.*,COALESCE(SUM(plan.available) OVER (
             ORDER BY plan.collected_at ASC NULLS LAST,plan.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ),0)::NUMERIC(14,2) AS prior_available
      FROM advance_plan plan
  ), selected_plan AS (
    SELECT plan.*,GREATEST(0,LEAST(plan.available,
             patient_required_amount-plan.prior_available))::NUMERIC(12,2) AS selected
      FROM ordered_plan plan
  )
  SELECT jsonb_build_object(
    'contract','pharmacy_substitution_advance_sources_v1',
    'funding_patient_uid',funding_patient_uid::text,
    'patient_uid_family',to_jsonb(funding_patient_family),
    'funding_admission_id',target_admission_id,
    'funding_admission_patient_uid',admission_patient_uid::text,
    'funding_admission_started_at',CASE WHEN admission_started_at IS NULL THEN NULL
      ELSE to_char(DATE_TRUNC('milliseconds',admission_started_at)
        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'tpa_claim_id',target_tpa_claim_id,
    'tpa_claim_patient_uid',tpa_claim_patient_uid::text,
    'tpa_decision_id',tpa_decision_id,
    'tpa_decision_ids',COALESCE((SELECT jsonb_agg(decision.id ORDER BY decision.id)
      FROM tpa_claim_line_decisions decision
     WHERE decision.tenant_id=target_tenant_id
       AND decision.claim_id=target_tpa_claim_id
       AND decision.invalidated_at IS NULL),'[]'::JSONB),
    'advance_ids',COALESCE((SELECT jsonb_agg(plan.id ORDER BY plan.id)
      FROM selected_plan plan),'[]'::JSONB),
    'selected_advance_ids',COALESCE((SELECT jsonb_agg(plan.id ORDER BY plan.id)
      FROM selected_plan plan WHERE plan.selected>0),'[]'::JSONB),
    'settlement_ids',COALESCE((SELECT jsonb_agg(settlement.id
      ORDER BY settlement.advance_id,settlement.id)
      FROM billing_advance_settlements settlement
     WHERE settlement.tenant_id=target_tenant_id
       AND settlement.advance_id=ANY(eligible_advance_ids)),'[]'::JSONB),
    'refund_ids',COALESCE((SELECT jsonb_agg(refund.id
      ORDER BY refund.advance_id,refund.id)
      FROM billing_refunds refund
     WHERE refund.tenant_id=target_tenant_id
       AND refund.advance_id=ANY(eligible_advance_ids)
       AND refund.approval_status<>'REJECTED'),'[]'::JSONB),
    'allocation_ids',COALESCE((SELECT jsonb_agg(allocation.id::text
      ORDER BY allocation.billing_advance_id,allocation.id)
      FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.billing_advance_id=ANY(eligible_advance_ids)
       AND (target_excluded_approval_receipt_id IS NULL OR
            allocation.funding_approval_receipt_id<>
              target_excluded_approval_receipt_id)),'[]'::JSONB),
    'reversal_ids',COALESCE((SELECT jsonb_agg(reversal.id::text
      ORDER BY reversal.allocation_id,reversal.id)
      FROM pharmacy_advance_allocation_reversals reversal
      JOIN pharmacy_advance_allocations allocation
        ON allocation.tenant_id=reversal.tenant_id
       AND allocation.id=reversal.allocation_id
     WHERE reversal.tenant_id=target_tenant_id
       AND allocation.billing_advance_id=ANY(eligible_advance_ids)
       AND (target_excluded_approval_receipt_id IS NULL OR
            allocation.funding_approval_receipt_id<>
              target_excluded_approval_receipt_id)),'[]'::JSONB),
    'advances',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'billing_advance_id',plan.id,'stored_patient_uid',plan.patient_uid::text,
      'admission_id',plan.admission_id,
      'amount',plan.amount::NUMERIC(12,2)::text,
      'balance',plan.balance::NUMERIC(12,2)::text,'mode',plan.mode,
      'reference',plan.reference,
      'collected_at',CASE WHEN plan.collected_at IS NULL THEN NULL ELSE
        to_char(DATE_TRUNC('milliseconds',plan.collected_at) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'settled_amount',plan.settled::NUMERIC(12,2)::text,
      'active_refund_reservation_amount',plan.refunded::NUMERIC(12,2)::text,
      'live_allocation_amount',plan.other_live::NUMERIC(12,2)::text,
      'available_amount',plan.available::NUMERIC(12,2)::text,
      'selected_reservation_amount',plan.selected::NUMERIC(12,2)::text
    ) ORDER BY plan.id) FROM selected_plan plan),'[]'::JSONB),
    'settlements',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'settlement_id',settlement.id,
      'billing_advance_id',settlement.advance_id,
      'invoice_id',settlement.invoice_id,
      'amount',settlement.amount::NUMERIC(12,2)::text,
      'settled_by',settlement.settled_by::text,
      'settled_at',CASE WHEN settlement.settled_at IS NULL THEN NULL ELSE
        to_char(DATE_TRUNC('milliseconds',settlement.settled_at) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'pharmacy_advance_allocation_id',settlement.pharmacy_advance_allocation_id::text,
      'pharmacy_advance_allocation_evidence_sha256',
        settlement.pharmacy_advance_allocation_evidence_sha256,
      'pharmacy_advance_conversion_command_sha256',
        settlement.pharmacy_advance_conversion_command_sha256,
      'pharmacy_advance_conversion_evidence_sha256',
        settlement.pharmacy_advance_conversion_evidence_sha256
    ) ORDER BY settlement.advance_id,settlement.id)
      FROM billing_advance_settlements settlement
     WHERE settlement.tenant_id=target_tenant_id
       AND settlement.advance_id=ANY(eligible_advance_ids)),'[]'::JSONB),
    'refunds',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'refund_id',refund.id,'billing_advance_id',refund.advance_id,
      'amount',refund.amount::NUMERIC(12,2)::text,'mode',UPPER(refund.mode),
      'reference',refund.reference,'approval_status',refund.approval_status,
      'raised_at',to_char(DATE_TRUNC('milliseconds',refund.raised_at)
        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'approved_at',CASE WHEN refund.approved_at IS NULL THEN NULL ELSE
        to_char(DATE_TRUNC('milliseconds',refund.approved_at) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
      'paid_at',CASE WHEN refund.paid_at IS NULL THEN NULL ELSE
        to_char(DATE_TRUNC('milliseconds',refund.paid_at) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
    ) ORDER BY refund.advance_id,refund.id)
      FROM billing_refunds refund
     WHERE refund.tenant_id=target_tenant_id
       AND refund.advance_id=ANY(eligible_advance_ids)
       AND refund.approval_status<>'REJECTED'),'[]'::JSONB),
    'allocations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'allocation_id',allocation.id::text,
      'billing_advance_id',allocation.billing_advance_id,
      'pharmacy_order_id',allocation.pharmacy_order_id,
      'invoice_id',allocation.invoice_id,'invoice_item_id',allocation.invoice_item_id,
      'source_authority_version',allocation.source_authority_version,
      'source_authority_sha256',allocation.source_authority_sha256,
      'allocated_amount',allocation.allocated_amount::NUMERIC(12,2)::text,
      'reversed_amount',COALESCE(reversal_totals.amount,0)::NUMERIC(12,2)::text,
      'net_amount',(allocation.allocated_amount
        -COALESCE(reversal_totals.amount,0))::NUMERIC(12,2)::text,
      'allocation_command_sha256',allocation.allocation_command_sha256,
      'funding_task_id',allocation.funding_task_id,
      'funding_approval_receipt_id',allocation.funding_approval_receipt_id::text,
      'evidence_sha256',allocation.evidence_sha256,
      'allocated_by',allocation.allocated_by::text,
      'allocated_at',to_char(DATE_TRUNC('milliseconds',allocation.allocated_at)
        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) ORDER BY allocation.billing_advance_id,allocation.id)
      FROM pharmacy_advance_allocations allocation
      LEFT JOIN reversal_totals ON reversal_totals.allocation_id=allocation.id
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.billing_advance_id=ANY(eligible_advance_ids)
       AND (target_excluded_approval_receipt_id IS NULL OR
            allocation.funding_approval_receipt_id<>
              target_excluded_approval_receipt_id)),'[]'::JSONB),
    'reversals',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'reversal_id',reversal.id::text,'allocation_id',reversal.allocation_id::text,
      'reversed_amount',reversal.reversed_amount::NUMERIC(12,2)::text,
      'reversal_command_sha256',reversal.reversal_command_sha256,
      'reason',reversal.reason,
      'billing_advance_settlement_id',reversal.billing_advance_settlement_id,
      'evidence_sha256',reversal.evidence_sha256,
      'reversed_by',reversal.reversed_by::text,
      'reversed_at',to_char(DATE_TRUNC('milliseconds',reversal.reversed_at)
        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) ORDER BY reversal.allocation_id,reversal.id)
      FROM pharmacy_advance_allocation_reversals reversal
      JOIN pharmacy_advance_allocations allocation
        ON allocation.tenant_id=reversal.tenant_id
       AND allocation.id=reversal.allocation_id
     WHERE reversal.tenant_id=target_tenant_id
       AND allocation.billing_advance_id=ANY(eligible_advance_ids)
       AND (target_excluded_approval_receipt_id IS NULL OR
            allocation.funding_approval_receipt_id<>
              target_excluded_approval_receipt_id)),'[]'::JSONB),
    'tpa_decisions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'tpa_decision_id',decision.id,'invoice_item_id',decision.invoice_item_id,
      'approved_amount',decision.approved_amount::NUMERIC(12,2)::text,
      'non_payable_amount',decision.non_payable_amount::NUMERIC(12,2)::text,
      'reason_code',COALESCE(decision.reason_code,''),
      'reason_text',decision.reason_text,'recorded_by',decision.recorded_by::text,
      'recorded_at',to_char(DATE_TRUNC('milliseconds',decision.recorded_at)
        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'source_authority_version',decision.source_authority_version,
      'source_authority_sha256',decision.source_authority_sha256
    ) ORDER BY decision.id)
      FROM tpa_claim_line_decisions decision
     WHERE decision.tenant_id=target_tenant_id
       AND decision.claim_id=target_tpa_claim_id
       AND decision.invalidated_at IS NULL),'[]'::JSONB)
  ) INTO source_evidence;

  source_evidence_sha256:=encode(
    public.digest(source_evidence::text,'sha256'),'hex'
  );
  funding_source:=CASE
    WHEN tpa_used_amount>0 AND patient_required_amount>0 THEN 'mixed'
    WHEN tpa_used_amount>0 THEN 'tpa_claim'
    ELSE 'patient_advance'
  END;
  funding_reference:=CONCAT_WS(';',
    CASE WHEN tpa_used_amount>0 THEN
      'tpa:' || target_tpa_claim_id::text || ':decision:' || tpa_decision_id::text END,
    CASE WHEN patient_required_amount>0 THEN 'patient-advances:' ||
      ARRAY_TO_STRING(ARRAY(
        SELECT (reservation->>'billing_advance_id')::INTEGER
          FROM jsonb_array_elements(reservation_rows) reservation
         ORDER BY (reservation->>'billing_advance_id')::INTEGER
      ),',') END
  );
  funding_evidence:=jsonb_build_object(
    'contract','pharmacy_substitution_advance_capacity_v1',
    'funding_source',funding_source,
    'funding_reference',funding_reference,
    'materialized_funding_source',materialized_funding_source,
    'materialized_funding_reference',materialized_funding_reference,
    'invoice_id',target_invoice_id,'invoice_item_id',target_invoice_item_id,
    'funding_event_id',funding_event_id,
    'tpa_claim_id',target_tpa_claim_id,
    'tpa_decision_id',tpa_decision_id,
    'locked_approved_tpa_amount',tpa_decision_amount::NUMERIC(12,2)::text,
    'tpa_used_amount',tpa_used_amount::NUMERIC(12,2)::text,
    'patient_payment_required_amount',patient_required_amount::NUMERIC(12,2)::text,
    'patient_advance_original_amount',original_total::NUMERIC(12,2)::text,
    'patient_advance_balance_amount',balance_total::NUMERIC(12,2)::text,
    'advance_settlement_amount',settlement_total::NUMERIC(12,2)::text,
    'active_refund_reservation_amount',refund_total::NUMERIC(12,2)::text,
    'live_advance_allocation_amount',other_allocation_total::NUMERIC(12,2)::text,
    'available_patient_advance_amount',available_total::NUMERIC(12,2)::text,
    'combined_authority_amount',(
      tpa_used_amount+available_total
    )::NUMERIC(12,2)::text,
    'headroom_amount',(
      tpa_used_amount+available_total-target_prospective_amount
    )::NUMERIC(12,2)::text,
    'reservation_required_amount',patient_required_amount::NUMERIC(12,2)::text,
    'source_evidence',source_evidence,
    'source_evidence_sha256',source_evidence_sha256
  );
  funding_evidence_sha256:=encode(
    public.digest(funding_evidence::text,'sha256'),'hex'
  );
  funding_evidence:=funding_evidence || jsonb_build_object(
    'evidence_sha256',funding_evidence_sha256
  );
  RETURN jsonb_build_object(
    'contract','pharmacy_advance_reservation_plan_v1',
    'pharmacy_order_id',target_pharmacy_order_id,
    'invoice_id',target_invoice_id,'invoice_item_id',target_invoice_item_id,
    'base_order_version',base_order_version,
    'base_order_items_sha256',base_order_sha256,
    'prospective_authoritative_amount',target_prospective_amount::NUMERIC(10,2)::text,
    'funding',funding_evidence,
    'reservations',reservation_rows
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.build_pharmacy_substitution_authority_753(target_tenant_id uuid, target_terminal_patient_uid uuid, target_patient_uid_family uuid[], target_pharmacy_order_id integer, target_invoice_id integer, target_invoice_item_id integer, target_selector jsonb, target_facility_grant_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  selector_order_line_index INTEGER;
  selector_final_catalog_id INTEGER;
  selector_inventory_item_id INTEGER;
  selector_inventory_batch_id INTEGER;
  selector_quantity NUMERIC(14,4);
  order_row pharmacy_orders%ROWTYPE;
  order_patient_uid UUID;
  order_items JSONB;
  order_line JSONB;
  prescription_row e_prescriptions%ROWTYPE;
  prescription_count INTEGER;
  prescription_line_index INTEGER;
  prescription_line JSONB;
  original_catalog_id INTEGER;
  original_catalog RECORD;
  final_catalog RECORD;
  original_ingredients TEXT[];
  original_components JSONB;
  final_components JSONB;
  ordered_quantity NUMERIC(14,4);
  dispensed_quantity NUMERIC(14,4);
  remaining_quantity NUMERIC(14,4);
  prescription_remaining NUMERIC(14,4);
  prior_billable NUMERIC(12,2);
  unit_price NUMERIC(12,2);
  billable_subtotal NUMERIC(12,2);
  cumulative_total NUMERIC(12,2);
  remaining_after NUMERIC(14,4);
  resulting_dispensed NUMERIC(14,4);
  inventory_item RECORD;
  inventory_batch RECORD;
  projected_line JSONB;
  prospective_items JSONB;
  base_items_db_sha256 CHAR(64);
  prospective_items_db_sha256 CHAR(64);
  prospective_amount NUMERIC(10,2):=0;
  candidate_line JSONB;
  candidate_index INTEGER:=0;
  payment_mode TEXT;
  invoice_row billing_invoices%ROWTYPE;
  target_item billing_invoice_items%ROWTYPE;
  active_invoice_items JSONB;
  prospective_invoice_items JSONB;
  base_invoice_items_sha256 CHAR(64);
  prospective_invoice_items_sha256 CHAR(64);
  base_billing JSONB;
  prospective_billing JSONB;
  prospective_invoice_subtotal NUMERIC(12,2);
  prospective_invoice_total NUMERIC(12,2);
  prospective_invoice_due NUMERIC(12,2);
  base_tuple JSONB;
  prospective_tuple JSONB;
BEGIN
  IF target_tenant_id IS NULL
     OR target_terminal_patient_uid IS NULL
     OR target_patient_uid_family IS NULL
     OR CARDINALITY(target_patient_uid_family)=0
     OR target_patient_uid_family[1] IS DISTINCT FROM target_terminal_patient_uid
     OR target_pharmacy_order_id IS NULL OR target_pharmacy_order_id<=0
     OR target_invoice_id IS NULL OR target_invoice_id<=0
     OR target_invoice_item_id IS NULL OR target_invoice_item_id<=0
     OR target_facility_grant_id IS NULL OR target_facility_grant_id<=0
     OR jsonb_typeof(target_selector) IS DISTINCT FROM 'object'
     OR NOT target_selector ?& ARRAY[
       'order_line_index','final_catalog_id','inventory_item_id',
       'inventory_batch_id','quantity'
     ]
     OR target_selector - ARRAY[
       'order_line_index','final_catalog_id','inventory_item_id',
       'inventory_batch_id','quantity'
     ] <> '{}'::JSONB
     OR jsonb_typeof(target_selector->'order_line_index') IS DISTINCT FROM 'number'
     OR jsonb_typeof(target_selector->'final_catalog_id') IS DISTINCT FROM 'number'
     OR jsonb_typeof(target_selector->'inventory_item_id') IS DISTINCT FROM 'number'
     OR jsonb_typeof(target_selector->'inventory_batch_id') IS DISTINCT FROM 'number'
     OR jsonb_typeof(target_selector->'quantity') IS DISTINCT FROM 'string'
     OR target_selector->>'quantity' !~
       '^(0|[1-9][0-9]{0,9})\.[0-9]{4}$' THEN
    RAISE EXCEPTION 'Substitution selector is not canonical DB authority input'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_substitution_selector_753';
  END IF;
  BEGIN
    selector_order_line_index:=(target_selector->>'order_line_index')::INTEGER;
    selector_final_catalog_id:=(target_selector->>'final_catalog_id')::INTEGER;
    selector_inventory_item_id:=(target_selector->>'inventory_item_id')::INTEGER;
    selector_inventory_batch_id:=(target_selector->>'inventory_batch_id')::INTEGER;
    selector_quantity:=(target_selector->>'quantity')::NUMERIC(14,4);
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Substitution selector exceeds database authority bounds'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_substitution_selector_753';
  END;
  IF selector_order_line_index<0 OR selector_final_catalog_id<=0
     OR selector_inventory_item_id<=0 OR selector_inventory_batch_id<=0
     OR selector_quantity<=0
     OR selector_quantity::TEXT IS DISTINCT FROM target_selector->>'quantity' THEN
    RAISE EXCEPTION 'Substitution selector is not canonical fixed-scale authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_substitution_selector_753';
  END IF;

  SELECT pharmacy_order.*
    INTO order_row
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=target_pharmacy_order_id;
  IF NOT FOUND OR order_row.facility_id IS NULL
     OR order_row.status NOT IN (
       'PENDING','CONFIRMED','PREPARING','PARTIALLY_DISPENSED'
     )
     OR order_row.inventory_authority_version IS NULL
     OR order_row.inventory_authority_version<=0
     OR order_row.clinical_verification_items_sha256 !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(order_row.items_list) IS DISTINCT FROM 'array'
     OR order_row.total_amount IS NULL OR order_row.total_amount<0 THEN
    RAISE EXCEPTION 'Substitution order lacks one exact dispensable authority generation'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_substitution_order_authority_753';
  END IF;
  PERFORM 1
    FROM facilities facility
   WHERE facility.tenant_id=target_tenant_id
     AND facility.id=order_row.facility_id
     AND facility.status='active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Substitution order facility authority is inactive or missing'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_substitution_order_authority_753';
  END IF;
  SELECT patient.uid
    INTO order_patient_uid
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.id=order_row.patient_id
     AND patient.role='PATIENT';
  IF order_patient_uid IS NULL
     OR NOT order_patient_uid=ANY(target_patient_uid_family)
     OR public.resolve_billing_patient_terminal_753(
          target_tenant_id,order_patient_uid
        ) IS DISTINCT FROM target_terminal_patient_uid THEN
    RAISE EXCEPTION 'Substitution order patient lineage is stale'
      USING ERRCODE='23514';
  END IF;
  IF order_row.uid IS NOT NULL
     AND (
       NOT order_row.uid=ANY(target_patient_uid_family)
       OR public.resolve_billing_patient_terminal_753(
            target_tenant_id,order_row.uid
          ) IS DISTINCT FROM target_terminal_patient_uid
       OR NOT EXISTS (
         SELECT 1
           FROM users lineage_patient
          WHERE lineage_patient.tenant_id=target_tenant_id
            AND lineage_patient.uid=order_row.uid
            AND lineage_patient.role='PATIENT'
       )
     ) THEN
    RAISE EXCEPTION 'Substitution order UUID lineage is stale'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_substitution_order_authority_753';
  END IF;
  order_items:=order_row.items_list;
  order_line:=order_items->selector_order_line_index;
  IF jsonb_typeof(order_line) IS DISTINCT FROM 'object'
     OR jsonb_typeof(order_line->'order_line_index') IS DISTINCT FROM 'number'
     OR (order_line->>'order_line_index')::INTEGER<>selector_order_line_index THEN
    RAISE EXCEPTION 'Substitution selector does not identify an authoritative order line'
      USING ERRCODE='23514';
  END IF;
  BEGIN
    prescription_line_index:=(order_line->>'prescription_line_index')::INTEGER;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Substitution order line lacks a prescription line identity'
        USING ERRCODE='23514';
  END;
  IF prescription_line_index<0 THEN
    RAISE EXCEPTION 'Substitution prescription line identity is invalid'
      USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*),MAX(prescription.id)
    INTO prescription_count,prescription_row.id
    FROM e_prescriptions prescription
    JOIN users prescriber
      ON prescriber.tenant_id=prescription.tenant_id
     AND prescriber.uid=prescription.doctor_uid
     AND prescriber.role='DOCTOR'
     AND prescriber.is_active=TRUE
     AND prescriber.status='active'
     AND COALESCE(prescriber.is_deleted,FALSE)=FALSE
     AND prescriber.merged_into_uid IS NULL
   WHERE prescription.tenant_id=target_tenant_id
     AND prescription.pharmacy_order_id=target_pharmacy_order_id
     AND prescription.patient_id=order_row.patient_id
     AND prescription.patient_uid=ANY(target_patient_uid_family)
     AND LOWER(COALESCE(prescription.status,'')) IN ('active','pharmacy_linked')
     AND LOWER(COALESCE(prescription.lifecycle_status,'draft'))='signed'
     AND prescription.signed_at IS NOT NULL
     AND prescription.locked_at IS NOT NULL;
  IF prescription_count<>1 THEN
    RAISE EXCEPTION 'One active signed prescription must own the substitution order'
      USING ERRCODE='23514';
  END IF;
  SELECT prescription.*
    INTO prescription_row
    FROM e_prescriptions prescription
   WHERE prescription.tenant_id=target_tenant_id
     AND prescription.id=prescription_row.id;
  prescription_line:=prescription_row.medications->prescription_line_index;
  IF jsonb_typeof(prescription_line) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Substitution prescription line is unavailable'
      USING ERRCODE='23514';
  END IF;
  BEGIN
    original_catalog_id:=(prescription_line->>'catalog_id')::INTEGER;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Substitution prescription catalog identity is invalid'
        USING ERRCODE='23514';
  END;
  IF original_catalog_id<=0 OR selector_final_catalog_id=original_catalog_id
     OR NOT (
       order_line->>'catalog_id'=original_catalog_id::TEXT
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(CASE
             WHEN jsonb_typeof(order_line->'substitution_history')='array'
             THEN order_line->'substitution_history' ELSE '[]'::JSONB END
           ) history
          WHERE history->>'original_catalog_id'=original_catalog_id::TEXT
       )
     ) THEN
    RAISE EXCEPTION 'Substitution order and prescription catalog lineages differ'
      USING ERRCODE='23514';
  END IF;

  BEGIN
    ordered_quantity:=COALESCE(
      NULLIF(order_line->>'ordered_qty',''),
      NULLIF(order_line->>'quantity',''),
      NULLIF(order_line->>'qty','')
    )::NUMERIC(14,4);
    dispensed_quantity:=COALESCE(
      NULLIF(order_line->>'inventory_dispensed_quantity',''),
      NULLIF(order_line->>'dispensed_qty',''),
      '0'
    )::NUMERIC(14,4);
    remaining_quantity:=COALESCE(
      NULLIF(order_line->>'inventory_remaining_quantity',''),
      NULLIF(order_line->>'remaining_qty',''),
      (ordered_quantity-dispensed_quantity)::TEXT
    )::NUMERIC(14,4);
    prescription_remaining:=COALESCE(
      NULLIF(prescription_line->>'remaining_quantity',''),
      (
        COALESCE(NULLIF(prescription_line->>'quantity',''),
                 NULLIF(prescription_line->>'qty',''),
                 NULLIF(prescription_line->>'ordered_quantity',''))::NUMERIC(14,4)
        -COALESCE(NULLIF(prescription_line->>'dispensed_quantity',''),'0')
          ::NUMERIC(14,4)
      )::TEXT
    )::NUMERIC(14,4);
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Substitution quantities are malformed'
        USING ERRCODE='23514';
  END;
  IF ordered_quantity<=0 OR dispensed_quantity<0 OR remaining_quantity<0
     OR dispensed_quantity+remaining_quantity<>ordered_quantity
     OR prescription_remaining<selector_quantity
     OR remaining_quantity<selector_quantity THEN
    RAISE EXCEPTION 'Substitution quantity exceeds exact order or prescription remainder'
      USING ERRCODE='23514';
  END IF;

  SELECT catalog.*
    INTO original_catalog
    FROM pharmacy_catalog catalog
   WHERE catalog.tenant_id=target_tenant_id
     AND catalog.id=original_catalog_id AND catalog.is_active=TRUE;
  SELECT catalog.*
    INTO final_catalog
    FROM pharmacy_catalog catalog
   WHERE catalog.tenant_id=target_tenant_id
     AND catalog.id=selector_final_catalog_id AND catalog.is_active=TRUE;
  IF original_catalog.id IS NULL OR final_catalog.id IS NULL
     OR original_catalog.composition_id IS NULL
     OR original_catalog.composition_id IS DISTINCT FROM final_catalog.composition_id
     OR original_catalog.composition_confidence<>'high'
     OR final_catalog.composition_confidence<>'high'
     OR NULLIF(original_catalog.strength_key,'') IS NULL
     OR original_catalog.strength_key IS DISTINCT FROM final_catalog.strength_key
     OR NULLIF(original_catalog.form_key,'') IS NULL
     OR original_catalog.form_key IS DISTINCT FROM final_catalog.form_key
     OR LOWER(COALESCE(NULLIF(BTRIM(original_catalog.release_key),''),'ir'))
        IS DISTINCT FROM
        LOWER(COALESCE(NULLIF(BTRIM(final_catalog.release_key),''),'ir'))
     OR LOWER(COALESCE(BTRIM(original_catalog.route),''))
        IS DISTINCT FROM LOWER(COALESCE(BTRIM(final_catalog.route),'')) THEN
    RAISE EXCEPTION 'Substitute catalog is not exact composition authority'
      USING ERRCODE='23514';
  END IF;
  SELECT composition.active_ingredients
    INTO original_ingredients
    FROM drug_compositions composition
   WHERE composition.id=original_catalog.composition_id;
  IF CARDINALITY(COALESCE(original_ingredients,'{}'::TEXT[]))>=2
     OR (
       jsonb_typeof(original_catalog.strength_components)='array'
       AND jsonb_array_length(original_catalog.strength_components)>=2
     ) THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'ingredient',LOWER(BTRIM(component->>'ingredient')),
             'amount',BTRIM(component->>'amount'),
             'unit',LOWER(BTRIM(component->>'unit'))
           ) ORDER BY LOWER(BTRIM(component->>'ingredient')),
                      BTRIM(component->>'amount'),
                      LOWER(BTRIM(component->>'unit'))),'[]'::JSONB)
      INTO original_components
      FROM jsonb_array_elements(COALESCE(
        original_catalog.strength_components,'[]'::JSONB
      )) component;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'ingredient',LOWER(BTRIM(component->>'ingredient')),
             'amount',BTRIM(component->>'amount'),
             'unit',LOWER(BTRIM(component->>'unit'))
           ) ORDER BY LOWER(BTRIM(component->>'ingredient')),
                      BTRIM(component->>'amount'),
                      LOWER(BTRIM(component->>'unit'))),'[]'::JSONB)
      INTO final_components
      FROM jsonb_array_elements(COALESCE(
        final_catalog.strength_components,'[]'::JSONB
      )) component;
    IF original_components IS DISTINCT FROM final_components THEN
      RAISE EXCEPTION 'Combination substitute strength components differ'
        USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT item.id,item.catalog_id,item.facility_id,item.schedule_class,
         item.is_narcotic,item.status
    INTO inventory_item
    FROM pharmacy_inventory_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.id=selector_inventory_item_id
     AND item.catalog_id=selector_final_catalog_id
     AND item.facility_id=order_row.facility_id;
  SELECT batch.id,batch.batch_number,batch.lot_number,batch.expiry_date,
         batch.remaining_quantity,batch.status
    INTO inventory_batch
    FROM pharmacy_inventory_batches batch
   WHERE batch.tenant_id=target_tenant_id
     AND batch.id=selector_inventory_batch_id
     AND batch.inventory_item_id=selector_inventory_item_id
     AND batch.facility_id=order_row.facility_id;
  IF inventory_item.id IS NULL OR inventory_item.status<>'active'
     OR inventory_batch.id IS NULL OR inventory_batch.status<>'in_stock'
     OR inventory_batch.expiry_date IS NULL
     OR inventory_batch.expiry_date<(clock_timestamp()
          AT TIME ZONE 'Asia/Kolkata')::DATE
     OR inventory_batch.remaining_quantity IS NULL
     OR inventory_batch.remaining_quantity<selector_quantity THEN
    RAISE EXCEPTION 'Substitute inventory batch is not usable authority'
      USING ERRCODE='23514';
  END IF;
  unit_price:=final_catalog.unit_price::NUMERIC(12,2);
  IF unit_price<=0 THEN
    RAISE EXCEPTION 'Substitute catalog price is not positive authority'
      USING ERRCODE='23514';
  END IF;
  prior_billable:=public.pharmacy_substitution_line_total_753(order_line);
  billable_subtotal:=ROUND(selector_quantity*unit_price,2)::NUMERIC(12,2);
  cumulative_total:=(prior_billable+billable_subtotal)::NUMERIC(12,2);
  remaining_after:=(remaining_quantity-selector_quantity)::NUMERIC(14,4);
  resulting_dispensed:=(dispensed_quantity+selector_quantity)::NUMERIC(14,4);
  projected_line:=order_line || jsonb_build_object(
    'order_line_index',selector_order_line_index,
    'prescription_line_index',prescription_line_index,
    'catalog_id',selector_final_catalog_id,
    'inventory_item_id',selector_inventory_item_id,
    'name',final_catalog.name,
    'medication_name',final_catalog.name,
    'ordered_qty',ordered_quantity::TEXT,
    'dispensed_qty',resulting_dispensed::TEXT,
    'remaining_qty',remaining_after::TEXT,
    'inventory_dispensed_quantity',resulting_dispensed::TEXT,
    'inventory_remaining_quantity',remaining_after::TEXT,
    'substitution_billable_total',cumulative_total::TEXT,
    'inventory_billable_total',cumulative_total::TEXT,
    'price',unit_price::TEXT,
    'line_total',cumulative_total::TEXT,
    'substitution_history',(
      CASE WHEN jsonb_typeof(order_line->'substitution_history')='array'
        THEN order_line->'substitution_history' ELSE '[]'::JSONB END
      || jsonb_build_array(jsonb_build_object(
        'original_catalog_id',original_catalog_id,
        'original_name',original_catalog.name,
        'final_catalog_id',selector_final_catalog_id,
        'quantity',selector_quantity::TEXT,
        'unit_price',unit_price::TEXT,
        'billable_subtotal',billable_subtotal::TEXT,
        'line_total',cumulative_total::TEXT
      ))
    )
  );
  prospective_items:=jsonb_set(
    order_items,ARRAY[selector_order_line_index::TEXT],projected_line,FALSE
  );
  FOR candidate_line IN
    SELECT value FROM jsonb_array_elements(prospective_items) value
  LOOP
    IF candidate_index=selector_order_line_index THEN
      prospective_amount:=prospective_amount+cumulative_total;
    ELSE
      prospective_amount:=prospective_amount+
        public.pharmacy_substitution_line_total_753(candidate_line);
    END IF;
    candidate_index:=candidate_index+1;
  END LOOP;
  IF prospective_amount<0 OR prospective_amount>=100000000 THEN
    RAISE EXCEPTION 'Prospective order amount exceeds NUMERIC(10,2) authority'
      USING ERRCODE='23514';
  END IF;
  base_items_db_sha256:=encode(public.digest(order_items::TEXT,'sha256'),'hex');
  prospective_items_db_sha256:=encode(
    public.digest(prospective_items::TEXT,'sha256'),'hex'
  );
  payment_mode:=LOWER(BTRIM(COALESCE(
    NULLIF(order_row.payment_mode,''),
    NULLIF(order_row.payment_metadata->>'payment_mode','')
  )));
  IF payment_mode IS NULL OR payment_mode='' THEN
    RAISE EXCEPTION 'Substitution order lacks DB payment-mode authority'
      USING ERRCODE='23514';
  END IF;

  SELECT invoice.*
    INTO invoice_row
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id AND invoice.id=target_invoice_id;
  SELECT item.*
    INTO target_item
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.id=target_invoice_item_id AND item.invoice_id=target_invoice_id;
  IF invoice_row.id IS NULL OR target_item.id IS NULL
     OR invoice_row.status<>'DRAFT' OR invoice_row.invoice_number IS NOT NULL
     OR invoice_row.issued_at IS NOT NULL OR invoice_row.voided_at IS NOT NULL
     OR COALESCE(invoice_row.amount_paid,0)<>0
     OR COALESCE(invoice_row.credit_note_amount,0)<>0
     OR invoice_row.amount_due IS DISTINCT FROM invoice_row.total_amount
     OR NOT invoice_row.patient_uid=ANY(target_patient_uid_family)
     OR invoice_row.admission_id IS DISTINCT FROM order_row.funding_admission_id
     OR target_item.source_ref_type<>'pharmacy_order'
     OR target_item.source_ref_id IS DISTINCT FROM target_pharmacy_order_id::BIGINT
     OR target_item.source_ref_active IS DISTINCT FROM TRUE
     OR target_item.source_authority_version IS DISTINCT FROM
          order_row.inventory_authority_version
     OR target_item.source_authority_sha256 IS DISTINCT FROM
          order_row.clinical_verification_items_sha256
     OR target_item.quantity IS DISTINCT FROM 1::NUMERIC
     OR target_item.unit_price IS DISTINCT FROM order_row.total_amount
     OR target_item.gst_rate IS DISTINCT FROM 0::NUMERIC
     OR target_item.line_subtotal IS DISTINCT FROM order_row.total_amount
     OR COALESCE(target_item.cgst_amount,0)<>0
     OR COALESCE(target_item.sgst_amount,0)<>0
     OR COALESCE(target_item.igst_amount,0)<>0
     OR target_item.line_total IS DISTINCT FROM order_row.total_amount THEN
    RAISE EXCEPTION 'Substitution billing target is not the exact draft BASE tuple'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_substitution_billing_authority_753';
  END IF;
  SELECT COALESCE(jsonb_agg(
           public.pharmacy_substitution_invoice_item_projection_753(item)
           ORDER BY item.id
         ),'[]'::JSONB)
    INTO active_invoice_items
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id AND item.invoice_id=target_invoice_id
     AND item.source_ref_active=TRUE;
  SELECT COALESCE(jsonb_agg(
           CASE WHEN item.id=target_invoice_item_id THEN
             public.pharmacy_substitution_invoice_item_projection_753(item)
             || jsonb_build_object(
               'quantity',1::NUMERIC(10,2)::TEXT,
               'unit_price',prospective_amount::NUMERIC(12,2)::TEXT,
               'gst_rate',0::NUMERIC(5,2)::TEXT,
               'line_subtotal',prospective_amount::NUMERIC(12,2)::TEXT,
               'cgst_amount',0::NUMERIC(12,2)::TEXT,
               'sgst_amount',0::NUMERIC(12,2)::TEXT,
               'igst_amount',0::NUMERIC(12,2)::TEXT,
               'line_total',prospective_amount::NUMERIC(12,2)::TEXT,
               'source_authority_version',order_row.inventory_authority_version+1,
               'source_authority_sha256',prospective_items_db_sha256
             )
           ELSE public.pharmacy_substitution_invoice_item_projection_753(item)
           END
           ORDER BY item.id),'[]'::JSONB)
    INTO prospective_invoice_items
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id AND item.invoice_id=target_invoice_id
     AND item.source_ref_active=TRUE;
  base_invoice_items_sha256:=encode(
    public.digest(active_invoice_items::TEXT,'sha256'),'hex'
  );
  prospective_invoice_items_sha256:=encode(
    public.digest(prospective_invoice_items::TEXT,'sha256'),'hex'
  );
  prospective_invoice_subtotal:=(invoice_row.subtotal-target_item.line_subtotal
    +prospective_amount)::NUMERIC(12,2);
  prospective_invoice_total:=(prospective_invoice_subtotal
    +COALESCE(invoice_row.cgst_amount,0)+COALESCE(invoice_row.sgst_amount,0)
    +COALESCE(invoice_row.igst_amount,0)-COALESCE(invoice_row.discount_amount,0)
  )::NUMERIC(12,2);
  prospective_invoice_due:=GREATEST(0,prospective_invoice_total
    -COALESCE(invoice_row.credit_note_amount,0)
    -COALESCE(invoice_row.amount_paid,0))::NUMERIC(12,2);
  base_billing:=jsonb_build_object(
    'invoice',jsonb_build_object(
      'status',invoice_row.status,'invoice_number',invoice_row.invoice_number,
      'issued_at',invoice_row.issued_at,'voided_at',invoice_row.voided_at,
      'subtotal',invoice_row.subtotal::NUMERIC(12,2)::TEXT,
      'cgst_amount',COALESCE(invoice_row.cgst_amount,0)::NUMERIC(12,2)::TEXT,
      'sgst_amount',COALESCE(invoice_row.sgst_amount,0)::NUMERIC(12,2)::TEXT,
      'igst_amount',COALESCE(invoice_row.igst_amount,0)::NUMERIC(12,2)::TEXT,
      'tax_amount',(COALESCE(invoice_row.cgst_amount,0)
        +COALESCE(invoice_row.sgst_amount,0)
        +COALESCE(invoice_row.igst_amount,0))::NUMERIC(12,2)::TEXT,
      'discount_amount',COALESCE(invoice_row.discount_amount,0)::NUMERIC(12,2)::TEXT,
      'credit_note_amount',COALESCE(invoice_row.credit_note_amount,0)::NUMERIC(12,2)::TEXT,
      'total_amount',invoice_row.total_amount::NUMERIC(12,2)::TEXT,
      'amount_paid',COALESCE(invoice_row.amount_paid,0)::NUMERIC(12,2)::TEXT,
      'amount_due',invoice_row.amount_due::NUMERIC(12,2)::TEXT
    ),
    'item',jsonb_build_object(
      'quantity',target_item.quantity::NUMERIC(10,2)::TEXT,
      'unit_price',target_item.unit_price::NUMERIC(12,2)::TEXT,
      'gst_rate',target_item.gst_rate::NUMERIC(5,2)::TEXT,
      'line_subtotal',target_item.line_subtotal::NUMERIC(12,2)::TEXT,
      'cgst_amount',COALESCE(target_item.cgst_amount,0)::NUMERIC(12,2)::TEXT,
      'sgst_amount',COALESCE(target_item.sgst_amount,0)::NUMERIC(12,2)::TEXT,
      'igst_amount',COALESCE(target_item.igst_amount,0)::NUMERIC(12,2)::TEXT,
      'tax_amount',(COALESCE(target_item.cgst_amount,0)
        +COALESCE(target_item.sgst_amount,0)
        +COALESCE(target_item.igst_amount,0))::NUMERIC(12,2)::TEXT,
      'line_total',target_item.line_total::NUMERIC(12,2)::TEXT,
      'source_ref_type',target_item.source_ref_type,
      'source_ref_id',target_item.source_ref_id::TEXT,
      'source_ref_active',target_item.source_ref_active,
      'source_authority_version',target_item.source_authority_version,
      'source_authority_sha256',target_item.source_authority_sha256
    ),
    'items',active_invoice_items,
    'items_generation_sha256',base_invoice_items_sha256
  );
  prospective_billing:=jsonb_build_object(
    'invoice',(base_billing->'invoice') || jsonb_build_object(
      'subtotal',prospective_invoice_subtotal::TEXT,
      'total_amount',prospective_invoice_total::TEXT,
      'amount_due',prospective_invoice_due::TEXT
    ),
    'item',(base_billing->'item') || jsonb_build_object(
      'unit_price',prospective_amount::NUMERIC(12,2)::TEXT,
      'line_subtotal',prospective_amount::NUMERIC(12,2)::TEXT,
      'line_total',prospective_amount::NUMERIC(12,2)::TEXT,
      'source_authority_version',order_row.inventory_authority_version+1,
      'source_authority_sha256',prospective_items_db_sha256
    ),
    'items',prospective_invoice_items,
    'items_generation_sha256',prospective_invoice_items_sha256
  );
  base_tuple:=jsonb_build_object(
    'pharmacy_order_id',target_pharmacy_order_id,
    'patient_id',order_row.patient_id,
    'patient_uid',target_terminal_patient_uid::TEXT,
    'stored_order_patient_uid',order_patient_uid::TEXT,
    'facility_id',order_row.facility_id,
    'facility_grant_id',target_facility_grant_id::TEXT,
    'order_status',order_row.status,
    'order_version',order_row.inventory_authority_version,
    'items_list',order_items,
    'items_list_db_sha256',base_items_db_sha256,
    'order_items_sha256',order_row.clinical_verification_items_sha256,
    'authoritative_amount',order_row.total_amount::NUMERIC(10,2)::TEXT,
    'payment_mode',payment_mode,
    'admission_id',order_row.funding_admission_id,
    'prescription_id',prescription_row.id,
    'prescription_revision',COALESCE(prescription_row.revision,1),
    'prescription_status',LOWER(prescription_row.status),
    'prescription_line_index',prescription_line_index,
    'original_catalog_id',original_catalog_id
  );
  prospective_tuple:=jsonb_build_object(
    'order_version',order_row.inventory_authority_version+1,
    'items_list',prospective_items,
    'items_list_db_sha256',prospective_items_db_sha256,
    'order_items_sha256',prospective_items_db_sha256,
    'authoritative_amount',prospective_amount::NUMERIC(10,2)::TEXT,
    'payment_mode',payment_mode,
    'order_line_index',selector_order_line_index,
    'prescription_line_index',prescription_line_index,
    'original_catalog_id',original_catalog_id,
    'final_catalog_id',selector_final_catalog_id,
    'inventory_item_id',selector_inventory_item_id,
    'inventory_batch_id',selector_inventory_batch_id,
    'quantity',selector_quantity::TEXT,
    'unit_price',unit_price::TEXT,
    'billable_subtotal',billable_subtotal::TEXT,
    'cumulative_line_total',cumulative_total::TEXT,
    'remaining_quantity',remaining_after::TEXT,
    'batch_number',inventory_batch.batch_number,
    'lot_number',inventory_batch.lot_number,
    'expiry_date',inventory_batch.expiry_date::TEXT,
    'batch_remaining_quantity',inventory_batch.remaining_quantity::NUMERIC(14,4)::TEXT,
    'schedule_class',inventory_item.schedule_class,
    'is_narcotic',COALESCE(inventory_item.is_narcotic,FALSE)
  );
  prospective_tuple:=prospective_tuple || jsonb_build_object(
    'prospective_fingerprint',encode(public.digest(
      prospective_tuple::TEXT,'sha256'
    ),'hex')
  );
  RETURN jsonb_build_object(
    'contract','pharmacy_substitution_db_authority_v1',
    'selector',target_selector,
    'base',base_tuple,
    'prospective',prospective_tuple,
    'billing',jsonb_build_object(
      'contract','pharmacy_substitution_funding_billing_v1',
      'invoice_id',target_invoice_id,
      'invoice_item_id',target_invoice_item_id,
      'base',base_billing,
      'prospective',prospective_billing
    )
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.bump_pharmacy_clinical_knowledge_revision_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE pharmacy_clinical_knowledge_revision
     SET version = version + 1,
         updated_at = NOW()
   WHERE singleton = TRUE;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.bump_pharmacy_patient_safety_version_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  payload JSONB;
  prior_payload JSONB;
  resolved_tenant UUID;
  resolved_patient INTEGER;
  candidate_tenant TEXT;
  candidate_patient TEXT;
  candidate_uid TEXT;
  identity_payload JSONB;
  identity_key TEXT;
  seen_identities TEXT[] := ARRAY[]::TEXT[];
  prior_tenant_context TEXT := current_setting('app.current_tenant_id', TRUE);
BEGIN
  payload := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  prior_payload := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;

  IF TG_OP = 'UPDATE'
     AND prior_payload->>'tenant_id' IS NOT DISTINCT FROM payload->>'tenant_id'
     AND (
       CASE WHEN TG_TABLE_NAME = 'users' THEN prior_payload->>'id'
            ELSE prior_payload->>'patient_id' END
     ) IS NOT DISTINCT FROM (
       CASE WHEN TG_TABLE_NAME = 'users' THEN payload->>'id'
            ELSE payload->>'patient_id' END
     )
     AND (
       CASE WHEN TG_TABLE_NAME = 'users' THEN prior_payload->>'uid'
            ELSE prior_payload->>'patient_uid' END
     ) IS NOT DISTINCT FROM (
       CASE WHEN TG_TABLE_NAME = 'users' THEN payload->>'uid'
            ELSE payload->>'patient_uid' END
     )
     AND public.pharmacy_patient_safety_projection_753(TG_TABLE_NAME, prior_payload)
         IS NOT DISTINCT FROM public.pharmacy_patient_safety_projection_753(TG_TABLE_NAME, payload) THEN
    RETURN NEW;
  END IF;

  FOR identity_payload IN
    SELECT value
      FROM jsonb_array_elements(
        CASE WHEN TG_OP = 'UPDATE'
          THEN jsonb_build_array(prior_payload, payload)
          ELSE jsonb_build_array(payload)
        END
      )
  LOOP
    candidate_tenant := NULLIF(identity_payload->>'tenant_id', '');
    candidate_patient := CASE
      WHEN TG_TABLE_NAME = 'users' THEN NULLIF(identity_payload->>'id', '')
      ELSE NULLIF(identity_payload->>'patient_id', '')
    END;
    candidate_uid := CASE
      WHEN TG_TABLE_NAME = 'users' THEN NULLIF(identity_payload->>'uid', '')
      ELSE NULLIF(identity_payload->>'patient_uid', '')
    END;

    -- Child therapy tables do not carry patient identity. Resolve it only
    -- through their same-tenant canonical parent before incrementing the
    -- patient safety fence; a missing/ambiguous parent produces no authority.
    IF candidate_uid IS NULL AND candidate_tenant IS NOT NULL THEN
      CASE TG_TABLE_NAME
        WHEN 'medication_reconciliation_items' THEN
          SELECT reconciliation.patient_uid::text, reconciliation.patient_id::text
            INTO candidate_uid, candidate_patient
            FROM medication_reconciliations reconciliation
           WHERE reconciliation.tenant_id=candidate_tenant::uuid
             AND reconciliation.id=(identity_payload->>'reconciliation_id')::uuid
           LIMIT 1;
        WHEN 'pharmacy_counter_sale_lines' THEN
          SELECT sale.patient_uid::text
            INTO candidate_uid
            FROM pharmacy_counter_sales sale
           WHERE sale.tenant_id=candidate_tenant::uuid
             AND sale.id=(identity_payload->>'counter_sale_id')::bigint
           LIMIT 1;
        WHEN 'chemo_cycles' THEN
          SELECT plan.patient_uid::text
            INTO candidate_uid
            FROM chemo_treatment_plans plan
           WHERE plan.tenant_id=candidate_tenant::uuid
             AND plan.id=(identity_payload->>'plan_id')::integer
           LIMIT 1;
        WHEN 'chemo_administrations' THEN
          SELECT plan.patient_uid::text
            INTO candidate_uid
            FROM chemo_cycles cycle
            JOIN chemo_treatment_plans plan
              ON plan.tenant_id=cycle.tenant_id AND plan.id=cycle.plan_id
           WHERE cycle.tenant_id=candidate_tenant::uuid
             AND cycle.id=(identity_payload->>'cycle_id')::integer
           LIMIT 1;
        WHEN 'dialysis_prescriptions' THEN
          SELECT patient.patient_uid::text
            INTO candidate_uid
            FROM dialysis_patients patient
           WHERE patient.tenant_id=candidate_tenant::uuid
             AND patient.id=(identity_payload->>'dialysis_patient_id')::integer
           LIMIT 1;
        WHEN 'maternity_supplements' THEN
          SELECT pregnancy.patient_uid::text
            INTO candidate_uid
            FROM maternity_pregnancies pregnancy
           WHERE pregnancy.tenant_id=candidate_tenant::uuid
             AND pregnancy.id=(identity_payload->>'pregnancy_id')::integer
           LIMIT 1;
        ELSE NULL;
      END CASE;
    END IF;

    resolved_tenant := NULL;
    resolved_patient := NULL;
    SELECT u.tenant_id, u.id
      INTO resolved_tenant, resolved_patient
      FROM users u
     WHERE (candidate_tenant IS NULL OR u.tenant_id = candidate_tenant::uuid)
       AND (
         (candidate_patient ~ '^[0-9]+$' AND u.id = candidate_patient::integer)
         OR
         (candidate_uid ~* '^[0-9a-f-]{36}$' AND u.uid = candidate_uid::uuid)
       )
     ORDER BY CASE
       WHEN candidate_patient ~ '^[0-9]+$' AND u.id=candidate_patient::integer THEN 0
       ELSE 1
     END, u.id
     LIMIT 1;

    identity_key := COALESCE(resolved_tenant::text, '') || ':' || COALESCE(resolved_patient::text, '');
    IF resolved_tenant IS NOT NULL AND resolved_patient IS NOT NULL
       AND NOT (identity_key = ANY(seen_identities)) THEN
      seen_identities := array_append(seen_identities, identity_key);
      PERFORM set_config('app.current_tenant_id', resolved_tenant::text, TRUE);
      INSERT INTO pharmacy_patient_safety_versions (tenant_id, patient_id, version, updated_at)
      VALUES (resolved_tenant, resolved_patient, 2, NOW())
      ON CONFLICT (tenant_id, patient_id) DO UPDATE
        SET version = pharmacy_patient_safety_versions.version + 1,
            updated_at = NOW();
    END IF;
  END LOOP;

  PERFORM set_config('app.current_tenant_id', COALESCE(prior_tenant_context, ''), TRUE);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
CREATE OR REPLACE FUNCTION public.cath_authority_identity_guard_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  command_sha TEXT := current_setting(
    'app.pharmacy_recovery_command_key_sha256', TRUE
  );
  recovery_open BOOLEAN := FALSE;
  recovery_required BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'cath_lab_cases' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath case authority identity is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
    THEN
      RAISE EXCEPTION 'Cath case clinical identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.facility_id IS DISTINCT FROM OLD.facility_id THEN
      recovery_required := TRUE;
      SELECT EXISTS (
        SELECT 1
          FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         WHERE recovery.tenant_id=OLD.tenant_id
           AND recovery.entity_type='cath_lab_case'
           AND recovery.entity_id=OLD.id
           AND recovery.status='OPEN'
      ) INTO recovery_open;
    END IF;
  ELSIF TG_TABLE_NAME = 'cath_consumable_catalog' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath consumable catalog authority identity is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
    THEN
      RAISE EXCEPTION 'Cath consumable catalog identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.facility_id IS DISTINCT FROM OLD.facility_id
       OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
    THEN
      recovery_required := TRUE;
      SELECT EXISTS (
        SELECT 1
          FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         WHERE recovery.tenant_id=OLD.tenant_id
           AND recovery.entity_type='cath_consumable_catalog'
           AND recovery.entity_id=OLD.id
           AND recovery.status='OPEN'
      ) INTO recovery_open;
    END IF;
  ELSIF TG_TABLE_NAME = 'cath_case_consumable_usage' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath consumable clinical history is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.case_id IS DISTINCT FROM OLD.case_id
       OR NEW.procedure_log_id IS DISTINCT FROM OLD.procedure_log_id
       OR NEW.catalog_item_id IS DISTINCT FROM OLD.catalog_item_id
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.quantity IS DISTINCT FROM OLD.quantity
       OR NEW.batch_tracked IS DISTINCT FROM OLD.batch_tracked
       OR NEW.is_implant IS DISTINCT FROM OLD.is_implant
       OR NEW.serial_number IS DISTINCT FROM OLD.serial_number
       OR NEW.used_by IS DISTINCT FROM OLD.used_by
       OR NEW.used_at IS DISTINCT FROM OLD.used_at
       OR NEW.wasted IS DISTINCT FROM OLD.wasted
       OR NEW.waste_reason IS DISTINCT FROM OLD.waste_reason
       OR (OLD.timeline_event_id IS NOT NULL
           AND NEW.timeline_event_id IS DISTINCT FROM OLD.timeline_event_id)
       OR (OLD.audit_event_id IS NOT NULL
           AND NEW.audit_event_id IS DISTINCT FROM OLD.audit_event_id)
    THEN
      RAISE EXCEPTION 'Cath consumable clinical and canonical-event identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.facility_id IS DISTINCT FROM OLD.facility_id
       OR NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id
       OR NEW.inventory_batch_id IS DISTINCT FROM OLD.inventory_batch_id
       OR NEW.batch_number IS DISTINCT FROM OLD.batch_number
       OR NEW.lot_number IS DISTINCT FROM OLD.lot_number
       OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date
    THEN
      recovery_required := TRUE;
      SELECT EXISTS (
        SELECT 1
          FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         WHERE recovery.tenant_id=OLD.tenant_id
           AND recovery.entity_type='cath_consumable_usage'
           AND recovery.entity_id=OLD.id
           AND recovery.status='OPEN'
      ) INTO recovery_open;
    END IF;
  ELSIF TG_TABLE_NAME = 'tasks' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath inventory worklist identity is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.related_resource_type IS DISTINCT FROM OLD.related_resource_type
       OR NEW.related_resource_id IS DISTINCT FROM OLD.related_resource_id
       OR NEW.workflow_sla_instance_id IS DISTINCT FROM OLD.workflow_sla_instance_id
       OR NEW.stage_occurrence_key IS DISTINCT FROM OLD.stage_occurrence_key
       OR NEW.metadata->>'task_contract' IS DISTINCT FROM OLD.metadata->>'task_contract'
       OR NEW.metadata->>'cath_consumable_usage_id'
            IS DISTINCT FROM OLD.metadata->>'cath_consumable_usage_id'
       OR NEW.metadata->>'cath_case_id' IS DISTINCT FROM OLD.metadata->>'cath_case_id'
       OR NEW.metadata->>'facility_id' IS DISTINCT FROM OLD.metadata->>'facility_id'
       OR NEW.metadata->>'inventory_item_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_item_id'
       OR NEW.metadata->>'inventory_batch_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_batch_id'
    THEN
      RAISE EXCEPTION 'Cath inventory worklist source authority is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'workflow_sla_instances' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath inventory SLA identity is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.rule_id IS DISTINCT FROM OLD.rule_id
       OR NEW.rule_code IS DISTINCT FROM OLD.rule_code
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id
       OR NEW.source_table IS DISTINCT FROM OLD.source_table
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.metadata->>'task_contract' IS DISTINCT FROM OLD.metadata->>'task_contract'
       OR NEW.metadata->>'cath_consumable_usage_id'
            IS DISTINCT FROM OLD.metadata->>'cath_consumable_usage_id'
       OR NEW.metadata->>'cath_case_id' IS DISTINCT FROM OLD.metadata->>'cath_case_id'
       OR NEW.metadata->>'inventory_facility_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_facility_id'
       OR NEW.metadata->>'inventory_item_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_item_id'
       OR NEW.metadata->>'inventory_batch_id'
            IS DISTINCT FROM OLD.metadata->>'inventory_batch_id'
    THEN
      RAISE EXCEPTION 'Cath inventory SLA source authority is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'notification_outbox' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cath inventory notification intent is append-only'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
       OR NEW.channel IS DISTINCT FROM OLD.channel
       OR NEW.source_event_key IS DISTINCT FROM OLD.source_event_key
       OR NEW.recipient_key IS DISTINCT FROM OLD.recipient_key
       OR NEW.template_version IS DISTINCT FROM OLD.template_version
       OR NEW.rendered_intent_hash IS DISTINCT FROM OLD.rendered_intent_hash
       OR NEW.payload->>'cath_consumable_usage_id'
            IS DISTINCT FROM OLD.payload->>'cath_consumable_usage_id'
       OR NEW.payload->>'cath_case_id' IS DISTINCT FROM OLD.payload->>'cath_case_id'
       OR NEW.payload->>'facility_id' IS DISTINCT FROM OLD.payload->>'facility_id'
       OR NEW.payload->>'inventory_item_id'
            IS DISTINCT FROM OLD.payload->>'inventory_item_id'
       OR NEW.payload->>'inventory_batch_id'
            IS DISTINCT FROM OLD.payload->>'inventory_batch_id'
       OR NEW.payload->>'recipient_uid' IS DISTINCT FROM OLD.payload->>'recipient_uid'
       OR NEW.payload->>'recipient_facility_grant_id'
            IS DISTINCT FROM OLD.payload->>'recipient_facility_grant_id'
    THEN
      RAISE EXCEPTION 'Cath inventory notification authority identity is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'pharmacy_stock_movements' THEN
    RAISE EXCEPTION 'Cath inventory stock movement evidence is append-only'
      USING ERRCODE = '23514';
  ELSE
    RAISE EXCEPTION 'Unsupported Cath authority identity source'
      USING ERRCODE = '23514';
  END IF;

  IF recovery_required AND NOT recovery_open THEN
    RAISE EXCEPTION 'Cath inventory authority identity may only change through governed recovery'
      USING ERRCODE = '23514';
  END IF;
  IF recovery_required
     AND (command_sha IS NULL OR command_sha !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'Cath authority repair requires a durable recovery command receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.cath_authority_recovery_receipt_constraint_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  entity_type_value TEXT;
  recovery_id_text TEXT;
  recovery_actor_text TEXT;
  old_inventory_item_text TEXT;
  new_inventory_item_text TEXT;
  facility_changed BOOLEAN := FALSE;
  inventory_item_changed BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME='cath_lab_cases' THEN
    entity_type_value := 'cath_lab_case';
    facility_changed := NEW.facility_id IS DISTINCT FROM OLD.facility_id;
  ELSIF TG_TABLE_NAME='cath_consumable_catalog' THEN
    entity_type_value := 'cath_consumable_catalog';
    facility_changed := NEW.facility_id IS DISTINCT FROM OLD.facility_id;
    inventory_item_changed := NEW.inventory_item_id IS DISTINCT FROM OLD.inventory_item_id;
    old_inventory_item_text := OLD.inventory_item_id::text;
    new_inventory_item_text := NEW.inventory_item_id::text;
  ELSE
    RAISE EXCEPTION 'Unsupported Cath recovery receipt target'
      USING ERRCODE='23514';
  END IF;
  IF NOT facility_changed AND NOT inventory_item_changed THEN RETURN NULL; END IF;

  recovery_id_text := NEW.metadata->'authority_recovery'->>'recovery_id';
  recovery_actor_text := NEW.metadata->'authority_recovery'->>'actor_uid';
  IF NEW.metadata->'authority_recovery'->>'action' IS DISTINCT FROM 'REATTACH'
     OR recovery_id_text !~ '^[1-9][0-9]*$'
     OR recovery_actor_text
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR NOT EXISTS (
       SELECT 1
         FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         JOIN public.pharmacy_inventory_authority_recovery_events event
           ON event.tenant_id=recovery.tenant_id AND event.recovery_id=recovery.id
        WHERE recovery.tenant_id=NEW.tenant_id
          AND recovery.id::text=recovery_id_text
          AND recovery.entity_type=entity_type_value
          AND recovery.entity_id=NEW.id
          AND recovery.status='RESOLVED'
          AND recovery.resolved_by::text=recovery_actor_text
          AND event.event_type='RESOLVED'
          AND event.actor_uid=recovery.resolved_by
          AND event.command_key_sha256 ~ '^[0-9a-f]{64}$'
          AND event.request_sha256 ~ '^[0-9a-f]{64}$'
          AND event.target_identity->>'entity_type'=entity_type_value
          AND event.target_identity->>'entity_id'=NEW.id::text
          AND event.target_identity->>'governing_facility_id'=NEW.facility_id::text
          AND event.target_before->>'facility_id' IS NOT DISTINCT FROM OLD.facility_id::text
          AND event.target_after->>'facility_id' IS NOT DISTINCT FROM NEW.facility_id::text
          AND (
            entity_type_value<>'cath_consumable_catalog'
            OR (
              event.target_before->>'inventory_item_id'
                IS NOT DISTINCT FROM old_inventory_item_text
              AND event.target_after->>'inventory_item_id'
                IS NOT DISTINCT FROM new_inventory_item_text
              AND event.target_identity->>'inventory_item_id'
                IS NOT DISTINCT FROM new_inventory_item_text
            )
          )
     )
  THEN
    RAISE EXCEPTION 'Cath authority identity repair lacks its exact governed recovery receipt'
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.cath_inventory_authority_assert_contract_753(target_tenant_id uuid, target_usage_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  usage_record public.cath_case_consumable_usage%ROWTYPE;
  case_record public.cath_lab_cases%ROWTYPE;
  catalog_record public.cath_consumable_catalog%ROWTYPE;
  task_record public.tasks%ROWTYPE;
  sla_record public.workflow_sla_instances%ROWTYPE;
  outbox_record public.notification_outbox%ROWTYPE;
  movement_record public.pharmacy_stock_movements%ROWTYPE;
  movement_total NUMERIC := 0;
  final_movement_id INTEGER;
BEGIN
  SELECT usage.* INTO usage_record
    FROM public.cath_case_consumable_usage usage
   WHERE usage.tenant_id=target_tenant_id AND usage.id=target_usage_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cath inventory authority references a missing clinical usage'
      USING ERRCODE='23514';
  END IF;

  IF usage_record.inventory_decrement_status='not_applicable'
     AND usage_record.metadata->'authority_recovery'->>'action' IN ('PRESERVE','CANCEL')
  THEN
    IF usage_record.facility_id IS NOT NULL
       OR usage_record.inventory_item_id IS NOT NULL
       OR usage_record.inventory_batch_id IS NOT NULL
       OR usage_record.inventory_movement_id IS NOT NULL
       OR usage_record.metadata->'authority_recovery'->>'recovery_id' !~ '^[1-9][0-9]*$'
       OR usage_record.metadata->'authority_recovery'->>'actor_uid'
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR EXISTS (
         SELECT 1
           FROM public.pharmacy_stock_movements movement
          WHERE movement.tenant_id=usage_record.tenant_id
            AND (
              (movement.reference_type='cath_consumable_usage'
               AND movement.reference_id=usage_record.id::text)
              OR (movement.reference_type='cath_consumable_reconciliation'
               AND movement.metadata->>'cath_consumable_usage_id'=usage_record.id::text)
            )
       )
       OR NOT EXISTS (
         SELECT 1
          FROM public.pharmacy_inventory_authority_recovery_worklist recovery
           JOIN public.pharmacy_inventory_authority_recovery_events event
             ON event.tenant_id=recovery.tenant_id AND event.recovery_id=recovery.id
          WHERE recovery.tenant_id=usage_record.tenant_id
            AND recovery.id::text=usage_record.metadata->'authority_recovery'->>'recovery_id'
            AND recovery.entity_type='cath_consumable_usage'
            AND recovery.entity_id=usage_record.id
            AND recovery.status='RESOLVED'
            AND recovery.resolved_by::text=
                  usage_record.metadata->'authority_recovery'->>'actor_uid'
            AND event.event_type='RESOLVED'
            AND event.actor_uid=recovery.resolved_by
            AND event.command_key_sha256 ~ '^[0-9a-f]{64}$'
            AND event.request_sha256 ~ '^[0-9a-f]{64}$'
            AND event.target_identity->>'entity_type'='cath_consumable_usage'
            AND event.target_identity->>'entity_id'=usage_record.id::text
            AND event.target_after->>'inventory_decrement_status'='not_applicable'
            AND event.target_after->>'facility_id' IS NULL
            AND event.target_after->>'inventory_item_id' IS NULL
            AND event.target_after->>'inventory_batch_id' IS NULL
            AND event.target_after->'metadata'->'authority_recovery'->>'action'=
                  usage_record.metadata->'authority_recovery'->>'action'
       )
    THEN
      RAISE EXCEPTION 'Terminal Cath usage preservation lacks its governed recovery receipt'
        USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;

  SELECT cath_case.* INTO case_record
    FROM public.cath_lab_cases cath_case
   WHERE cath_case.tenant_id=usage_record.tenant_id
     AND cath_case.id=usage_record.case_id
     AND cath_case.patient_uid=usage_record.patient_uid
     AND cath_case.facility_id=usage_record.facility_id;
  SELECT catalog.* INTO catalog_record
    FROM public.cath_consumable_catalog catalog
   WHERE catalog.tenant_id=usage_record.tenant_id
     AND catalog.id=usage_record.catalog_item_id
     AND catalog.facility_id=usage_record.facility_id
     AND catalog.inventory_item_id=usage_record.inventory_item_id;
  IF case_record.id IS NULL OR catalog_record.id IS NULL
     OR usage_record.facility_id IS NULL
     OR usage_record.inventory_item_id IS NULL
     OR usage_record.inventory_batch_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.pharmacy_inventory_batches batch
        WHERE batch.tenant_id=usage_record.tenant_id
          AND batch.facility_id=usage_record.facility_id
          AND batch.id=usage_record.inventory_batch_id
          AND batch.inventory_item_id=usage_record.inventory_item_id
          AND batch.batch_number IS NOT DISTINCT FROM usage_record.batch_number
          AND batch.lot_number IS NOT DISTINCT FROM usage_record.lot_number
          AND batch.expiry_date IS NOT DISTINCT FROM usage_record.expiry_date
     )
  THEN
    RAISE EXCEPTION 'Cath usage is not bound to one exact case/catalog/batch facility authority'
      USING ERRCODE='23514';
  END IF;

  IF usage_record.timeline_event_id IS NULL
     OR usage_record.audit_event_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.clinical_timeline_events timeline
        WHERE timeline.tenant_id=usage_record.tenant_id
          AND timeline.id=usage_record.timeline_event_id
          AND timeline.patient_uid=usage_record.patient_uid
          AND timeline.encounter_id IS NOT DISTINCT FROM case_record.encounter_id
          AND timeline.source_table='cath_case_consumable_usage'
          AND timeline.source_id=usage_record.id::text
          AND timeline.resource_type='cath_case_consumable_usage'
          AND timeline.resource_id=usage_record.id::text
          AND timeline.actor_uid IS NOT DISTINCT FROM usage_record.used_by
          AND timeline.event_type=CASE WHEN usage_record.wasted
            THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
          AND timeline.payload->>'facility_id'=usage_record.facility_id::text
          AND timeline.payload->>'inventory_item_id'=usage_record.inventory_item_id::text
          AND timeline.payload->>'inventory_batch_id'=usage_record.inventory_batch_id::text
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.clinical_audit_events audit
        WHERE audit.tenant_id=usage_record.tenant_id
          AND audit.id=usage_record.audit_event_id
          AND audit.patient_uid IS NOT DISTINCT FROM usage_record.patient_uid
          AND audit.encounter_id IS NOT DISTINCT FROM case_record.encounter_id
          AND audit.resource_table='cath_case_consumable_usage'
          AND audit.resource_id=usage_record.id::text
          AND audit.actor_uid IS NOT DISTINCT FROM usage_record.used_by
          AND audit.action=CASE WHEN usage_record.wasted
            THEN 'cath_lab.consumable_wasted' ELSE 'cath_lab.consumable_used' END
     )
  THEN
    RAISE EXCEPTION 'Cath usage lacks exact immutable canonical clinical-event provenance'
      USING ERRCODE='23514';
  END IF;

  IF usage_record.metadata->'authority_recovery'->>'action'='REATTACH'
     AND NOT EXISTS (
       SELECT 1
         FROM public.pharmacy_inventory_authority_recovery_worklist recovery
         JOIN public.pharmacy_inventory_authority_recovery_events event
           ON event.tenant_id=recovery.tenant_id AND event.recovery_id=recovery.id
        WHERE recovery.tenant_id=usage_record.tenant_id
          AND recovery.id::text=usage_record.metadata->'authority_recovery'->>'recovery_id'
          AND recovery.entity_type='cath_consumable_usage'
          AND recovery.entity_id=usage_record.id
          AND recovery.status='RESOLVED'
          AND recovery.resolved_by::text=
                usage_record.metadata->'authority_recovery'->>'actor_uid'
          AND event.event_type='RESOLVED'
          AND event.actor_uid=recovery.resolved_by
          AND event.target_identity->>'entity_type'='cath_consumable_usage'
          AND event.target_identity->>'entity_id'=usage_record.id::text
          AND event.target_identity->>'governing_facility_id'=
                usage_record.facility_id::text
          AND event.target_identity->>'inventory_item_id'=
                usage_record.inventory_item_id::text
          AND event.target_identity->>'inventory_batch_id'=
                usage_record.inventory_batch_id::text
          AND event.target_after->>'facility_id'=usage_record.facility_id::text
          AND event.target_after->>'inventory_item_id'=usage_record.inventory_item_id::text
          AND event.target_after->>'inventory_batch_id'=usage_record.inventory_batch_id::text
     )
  THEN
    RAISE EXCEPTION 'Reattached Cath usage lacks its exact governed recovery receipt'
      USING ERRCODE='23514';
  END IF;

  SELECT task.* INTO task_record
    FROM public.tasks task
   WHERE task.tenant_id=usage_record.tenant_id
     AND task.related_resource_type='cath_case_consumable_usage'
     AND task.related_resource_id=usage_record.id::text
     AND task.metadata->>'task_contract'='cath_inventory_shortfall_v1';
  SELECT sla.* INTO sla_record
    FROM public.workflow_sla_instances sla
   WHERE sla.tenant_id=usage_record.tenant_id
     AND sla.rule_code='cath_consumable_inventory_reconciliation'
     AND sla.source_table='cath_case_consumable_usage'
     AND sla.source_id=usage_record.id::text;
  SELECT outbox.* INTO outbox_record
    FROM public.notification_outbox outbox
   WHERE outbox.tenant_id=usage_record.tenant_id
     AND outbox.type='cath_inventory_shortfall'
     AND outbox.source_event_key='cath-inventory-shortfall:' || usage_record.id::text;
  IF task_record.id IS NULL OR sla_record.id IS NULL OR outbox_record.id IS NULL
     OR task_record.patient_uid IS DISTINCT FROM usage_record.patient_uid
     OR task_record.workflow_sla_instance_id IS DISTINCT FROM sla_record.id
     OR task_record.metadata->>'cath_case_id' IS DISTINCT FROM usage_record.case_id::text
     OR task_record.metadata->>'facility_id' IS DISTINCT FROM usage_record.facility_id::text
     OR task_record.metadata->>'inventory_item_id'
          IS DISTINCT FROM usage_record.inventory_item_id::text
     OR task_record.metadata->>'inventory_batch_id'
          IS DISTINCT FROM usage_record.inventory_batch_id::text
     OR sla_record.patient_uid IS DISTINCT FROM usage_record.patient_uid
     OR sla_record.encounter_id IS DISTINCT FROM case_record.encounter_id
     OR sla_record.metadata->>'cath_case_id' IS DISTINCT FROM usage_record.case_id::text
     OR sla_record.metadata->>'inventory_facility_id'
          IS DISTINCT FROM usage_record.facility_id::text
     OR sla_record.metadata->>'inventory_item_id'
          IS DISTINCT FROM usage_record.inventory_item_id::text
     OR sla_record.metadata->>'inventory_batch_id'
          IS DISTINCT FROM usage_record.inventory_batch_id::text
     OR outbox_record.payload->>'cath_case_id' IS DISTINCT FROM usage_record.case_id::text
     OR outbox_record.payload->>'cath_consumable_usage_id'
          IS DISTINCT FROM usage_record.id::text
     OR outbox_record.payload->>'facility_id' IS DISTINCT FROM usage_record.facility_id::text
     OR outbox_record.payload->>'inventory_item_id'
          IS DISTINCT FROM usage_record.inventory_item_id::text
     OR outbox_record.payload->>'inventory_batch_id'
          IS DISTINCT FROM usage_record.inventory_batch_id::text
  THEN
    RAISE EXCEPTION 'Cath clinical usage and durable pharmacy worklist identities diverged'
      USING ERRCODE='23514';
  END IF;

  IF outbox_record.payload->>'delivery_coverage'='direct' AND (
    outbox_record.payload->>'recipient_facility_grant_id' !~ '^[1-9][0-9]*$'
    OR NOT EXISTS (
      SELECT 1
        FROM public.pharmacy_staff_facility_grants facility_grant
        JOIN public.users recipient
          ON recipient.tenant_id=facility_grant.tenant_id
         AND recipient.uid=facility_grant.staff_uid
        JOIN public.staff recipient_staff
          ON recipient_staff.tenant_id=recipient.tenant_id
         AND recipient_staff.user_id=recipient.uid
       WHERE facility_grant.tenant_id=usage_record.tenant_id
         AND facility_grant.id::text=outbox_record.payload->>'recipient_facility_grant_id'
         AND facility_grant.facility_id=usage_record.facility_id
         AND facility_grant.staff_uid::text=outbox_record.payload->>'recipient_uid'
         AND recipient.id::text=outbox_record.recipient_id
         AND outbox_record.payload->>'recipient_status_snapshot'='active'
         AND outbox_record.payload->>'recipient_not_deleted_snapshot'='true'
         AND facility_grant.granted_at <= outbox_record.created_at
         AND (facility_grant.revoked_at IS NULL
              OR facility_grant.revoked_at >= outbox_record.created_at)
    )
  ) THEN
    RAISE EXCEPTION 'Cath inventory notification lacks exact facility-grant provenance'
      USING ERRCODE='23514';
  END IF;

  FOR movement_record IN
    SELECT movement.* FROM public.pharmacy_stock_movements movement
     WHERE movement.tenant_id=usage_record.tenant_id
       AND (
         (movement.reference_type='cath_consumable_usage'
          AND movement.reference_id=usage_record.id::text)
         OR (movement.reference_type='cath_consumable_reconciliation'
          AND movement.metadata->>'cath_consumable_usage_id'=usage_record.id::text)
       )
  LOOP
    IF movement_record.inventory_item_id IS DISTINCT FROM usage_record.inventory_item_id
       OR movement_record.inventory_batch_id IS DISTINCT FROM usage_record.inventory_batch_id
       OR movement_record.movement_kind IS DISTINCT FROM
            (CASE WHEN usage_record.wasted THEN 'dispose' ELSE 'issue' END)
       OR movement_record.quantity_delta >= 0
       OR movement_record.performed_by::text
            IS DISTINCT FROM movement_record.metadata->>'canonical_actor_uid'
       OR movement_record.metadata->>'facility_id' IS DISTINCT FROM usage_record.facility_id::text
       OR movement_record.metadata->>'actor_facility_grant_id' !~ '^[1-9][0-9]*$'
       OR NOT EXISTS (
         SELECT 1
           FROM public.pharmacy_staff_facility_grants facility_grant
          WHERE facility_grant.tenant_id=movement_record.tenant_id
            AND facility_grant.id::text=movement_record.metadata->>'actor_facility_grant_id'
            AND facility_grant.staff_uid=movement_record.performed_by
            AND facility_grant.facility_id=usage_record.facility_id
            AND facility_grant.granted_at <= movement_record.created_at
            AND (facility_grant.revoked_at IS NULL
                 OR facility_grant.revoked_at >= movement_record.created_at)
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.pharmacy_inventory_batches batch
          WHERE batch.tenant_id=movement_record.tenant_id
            AND batch.facility_id=usage_record.facility_id
            AND batch.id=movement_record.inventory_batch_id
            AND batch.inventory_item_id=movement_record.inventory_item_id
       )
    THEN
      RAISE EXCEPTION 'Cath stock movement lacks exact batch/facility/grant provenance'
        USING ERRCODE='23514';
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(-movement.quantity_delta), 0::numeric),
         (ARRAY_AGG(movement.id ORDER BY movement.created_at DESC, movement.id DESC)
           FILTER (WHERE movement.id IS NOT NULL))[1]
    INTO movement_total, final_movement_id
    FROM public.pharmacy_stock_movements movement
   WHERE movement.tenant_id=usage_record.tenant_id
     AND (
       (movement.reference_type='cath_consumable_usage'
        AND movement.reference_id=usage_record.id::text)
       OR (movement.reference_type='cath_consumable_reconciliation'
        AND movement.metadata->>'cath_consumable_usage_id'=usage_record.id::text)
     );
  IF movement_total > usage_record.quantity
     OR usage_record.inventory_movement_id IS DISTINCT FROM final_movement_id
     OR (
       usage_record.inventory_decrement_status='decremented'
       AND movement_total IS DISTINCT FROM usage_record.quantity
     )
     OR (
       usage_record.inventory_decrement_status<>'decremented'
       AND movement_total >= usage_record.quantity
     )
  THEN
    RAISE EXCEPTION 'Cath usage inventory outcome diverges from append-only movement evidence'
      USING ERRCODE='23514';
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.cath_inventory_authority_constraint_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  tenant_value UUID;
  usage_id_text TEXT;
  relevant BOOLEAN := FALSE;
BEGIN
  tenant_value := COALESCE(NEW.tenant_id, OLD.tenant_id);
  IF TG_TABLE_NAME='cath_case_consumable_usage' THEN
    relevant := TRUE;
    usage_id_text := COALESCE(NEW.id, OLD.id)::text;
  ELSIF TG_TABLE_NAME='tasks' THEN
    relevant := COALESCE(NEW.metadata->>'task_contract','')='cath_inventory_shortfall_v1'
      OR COALESCE(OLD.metadata->>'task_contract','')='cath_inventory_shortfall_v1';
    usage_id_text := COALESCE(
      NEW.metadata->>'cath_consumable_usage_id',
      OLD.metadata->>'cath_consumable_usage_id'
    );
  ELSIF TG_TABLE_NAME='workflow_sla_instances' THEN
    relevant := COALESCE(NEW.rule_code,'')='cath_consumable_inventory_reconciliation'
      OR COALESCE(OLD.rule_code,'')='cath_consumable_inventory_reconciliation';
    usage_id_text := COALESCE(NEW.source_id, OLD.source_id);
  ELSIF TG_TABLE_NAME='notification_outbox' THEN
    relevant := COALESCE(NEW.type,'')='cath_inventory_shortfall'
      OR COALESCE(OLD.type,'')='cath_inventory_shortfall';
    usage_id_text := COALESCE(
      NEW.payload->>'cath_consumable_usage_id',
      OLD.payload->>'cath_consumable_usage_id'
    );
  ELSE
    relevant := COALESCE(NEW.reference_type,'') IN (
      'cath_consumable_usage','cath_consumable_reconciliation'
    ) OR COALESCE(OLD.reference_type,'') IN (
      'cath_consumable_usage','cath_consumable_reconciliation'
    );
    usage_id_text := COALESCE(
      CASE WHEN NEW.reference_type='cath_consumable_usage' THEN NEW.reference_id
           ELSE NEW.metadata->>'cath_consumable_usage_id' END,
      CASE WHEN OLD.reference_type='cath_consumable_usage' THEN OLD.reference_id
           ELSE OLD.metadata->>'cath_consumable_usage_id' END
    );
  END IF;
  IF relevant IS NOT TRUE THEN RETURN NULL; END IF;
  IF usage_id_text !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Cath authority evidence has an invalid usage identity'
      USING ERRCODE='23514';
  END IF;
  PERFORM public.cath_inventory_authority_assert_contract_753(
    tenant_value, usage_id_text::bigint
  );
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.complete_pharmacy_funding_command_753(target_tenant_id uuid, target_command_id bigint, target_actor_uid uuid, target_response_body jsonb)
 RETURNS TABLE(id bigint, status character varying, response_body jsonb, approved_patient_amount numeric, completed_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  receipt pharmacy_funding_commands%ROWTYPE;
  approval_receipt pharmacy_funding_commands%ROWTYPE;
  terminal_patient_uid UUID;
  patient_uid_family UUID[];
  expected_advance_reservations JSONB;
  public_reservation_plan JSONB;
  mutation_receipt pharmacy_order_command_receipts%ROWTYPE;
  mutation_receipt_id BIGINT;
  abandoned_consumption pharmacy_funding_commands%ROWTYPE;
  abandoned_count INTEGER;
  governance_approval approvals%ROWTYPE;
  governance_task tasks%ROWTYPE;
  proposer_role TEXT;
  approver_role TEXT;
  proposer_grant_id BIGINT;
  proposer_grant_found BOOLEAN;
  approver_role_permitted BOOLEAN;
  canonical_response_body JSONB;
BEGIN
  IF current_setting('app.current_tenant_id',TRUE) IS NULL
     OR current_setting('app.current_tenant_id',TRUE) IN ('','bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM target_tenant_id
     OR target_actor_uid IS NULL
     OR jsonb_typeof(target_response_body) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Pharmacy funding completion requires exact tenant, actor, and response context'
      USING ERRCODE='42501';
  END IF;
  canonical_response_body:=target_response_body;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  SELECT command.*
    INTO receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_command_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy funding command not found'
      USING ERRCODE='P0002';
  END IF;
  IF receipt.patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy funding command lacks immutable patient lineage'
      USING ERRCODE='23514';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,receipt.patient_uid
  );
  patient_uid_family:=public.resolve_billing_patient_family_753(
    target_tenant_id,terminal_patient_uid
  );
  IF NOT receipt.patient_uid=ANY(patient_uid_family) THEN
    RAISE EXCEPTION 'Pharmacy funding command patient lineage is stale'
      USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || target_tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || target_tenant_id::text || ':'
      || receipt.pharmacy_order_id::text,
    753
  ));
  IF receipt.command_type='SUBSTITUTION_FUNDING_APPROVAL' THEN
    SELECT command.*
      INTO receipt
      FROM pharmacy_funding_commands command
     WHERE command.tenant_id=target_tenant_id
       AND command.id=target_command_id
       AND command.patient_uid=receipt.patient_uid
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy funding approval changed before its canonical lock'
        USING ERRCODE='40001';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'vh:pharmacy_advance_approval:' || target_tenant_id::text || ':'
        || target_command_id::text,
      0
    ));
  ELSE
    IF receipt.command_type NOT IN (
         'SUBSTITUTION_FUNDING_CONSUMPTION','PHARMACY_ADVANCE_SETTLEMENT',
         'PHARMACY_ADVANCE_RELEASE'
       ) THEN
      RAISE EXCEPTION 'This pharmacy funding command type has no governed completion path'
        USING ERRCODE='23514';
    END IF;
    SELECT command.*
      INTO approval_receipt
      FROM pharmacy_funding_commands command
     WHERE command.tenant_id=target_tenant_id
       AND command.id=receipt.approval_receipt_id
       AND command.patient_uid=receipt.patient_uid
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy funding completion lacks its exact approval receipt'
        USING ERRCODE='23503';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'vh:pharmacy_advance_approval:' || target_tenant_id::text || ':'
        || receipt.approval_receipt_id::text,
      0
    ));
    SELECT command.*
      INTO receipt
      FROM pharmacy_funding_commands command
     WHERE command.tenant_id=target_tenant_id
       AND command.id=target_command_id
       AND command.approval_receipt_id=approval_receipt.id
       AND command.patient_uid=approval_receipt.patient_uid
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy funding command changed before its canonical lock'
        USING ERRCODE='40001';
    END IF;
    IF receipt.command_type='PHARMACY_ADVANCE_SETTLEMENT' THEN
      PERFORM 1
        FROM pharmacy_funding_commands command
       WHERE command.tenant_id=target_tenant_id
         AND command.id=receipt.consumption_receipt_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Pharmacy advance settlement completion lacks its consumption receipt'
          USING ERRCODE='23503';
      END IF;
    END IF;
  END IF;
  IF receipt.command_type='PHARMACY_ADVANCE_SETTLEMENT' THEN
    RAISE EXCEPTION 'Pharmacy advance settlement requires the governed atomic conversion entrypoint'
      USING ERRCODE='42501';
  END IF;
  IF receipt.status='COMPLETE' THEN
    IF receipt.created_by IS DISTINCT FROM target_actor_uid
       OR (CASE receipt.command_type
            WHEN 'SUBSTITUTION_FUNDING_CONSUMPTION' THEN
              receipt.response_body-'consumed_at' IS DISTINCT FROM
                target_response_body-'consumed_at'
            WHEN 'PHARMACY_ADVANCE_RELEASE' THEN
              receipt.response_body-'released_at' IS DISTINCT FROM
                target_response_body-'released_at'
            WHEN 'PHARMACY_ADVANCE_SETTLEMENT' THEN
              receipt.response_body-'settled_at' IS DISTINCT FROM
                target_response_body-'settled_at'
            WHEN 'SUBSTITUTION_FUNDING_APPROVAL' THEN FALSE
            ELSE receipt.response_body IS DISTINCT FROM target_response_body
          END) THEN
      RAISE EXCEPTION 'Pharmacy funding completion replay changed immutable evidence'
        USING ERRCODE='23514';
    END IF;
    RETURN QUERY SELECT receipt.id,receipt.status,receipt.response_body,
                        receipt.approved_patient_amount,receipt.completed_at;
    RETURN;
  END IF;
  IF receipt.status='ABANDONED' THEN
    IF receipt.command_type<>'SUBSTITUTION_FUNDING_CONSUMPTION'
       OR receipt.created_by IS DISTINCT FROM target_actor_uid
       OR target_response_body IS DISTINCT FROM jsonb_build_object(
         'contract','pharmacy_substitution_funding_consumption_replay_v1',
         'approval_receipt_id',receipt.approval_receipt_id::TEXT,
         'consumption_receipt_id',receipt.id::TEXT,
         'pharmacy_order_id',receipt.pharmacy_order_id::TEXT
       ) THEN
      RAISE EXCEPTION 'Abandoned consumption replay changed immutable request identity'
        USING ERRCODE='23514';
    END IF;
    RETURN QUERY SELECT receipt.id,receipt.status,receipt.response_body,
                        receipt.approved_patient_amount,receipt.completed_at;
    RETURN;
  END IF;
  IF receipt.command_type='SUBSTITUTION_FUNDING_APPROVAL' THEN
    SELECT approval.*
      INTO governance_approval
      FROM approvals approval
     WHERE approval.tenant_id=target_tenant_id
       AND approval.id=receipt.governance_approval_id
     FOR UPDATE;
    SELECT task.*
      INTO governance_task
      FROM tasks task
     WHERE task.tenant_id=target_tenant_id
       AND task.id=receipt.task_id
     FOR UPDATE;
    BEGIN
      proposer_grant_id:=(receipt.reservation_authority #>>
        '{base,facility_grant_id}')::BIGINT;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Approval completion facility grant identity is malformed'
          USING ERRCODE='23514';
    END;
    SELECT proposer.role
      INTO proposer_role
      FROM users proposer
     WHERE proposer.tenant_id=target_tenant_id
       AND proposer.uid=receipt.proposer_uid
       AND proposer.role IN ('PHARMACY_STAFF','PHARMACY_INCHARGE')
       AND proposer.is_active=TRUE
       AND proposer.status='active'
       AND COALESCE(proposer.is_deleted,FALSE)=FALSE
       AND proposer.merged_into_uid IS NULL
     FOR UPDATE;
    SELECT approver.role
      INTO approver_role
      FROM users approver
     WHERE approver.tenant_id=target_tenant_id
       AND approver.uid=target_actor_uid
       AND approver.is_active=TRUE
       AND approver.status='active'
       AND COALESCE(approver.is_deleted,FALSE)=FALSE
       AND approver.merged_into_uid IS NULL
     FOR UPDATE;
    PERFORM 1
      FROM staff proposer_staff
     WHERE proposer_staff.tenant_id=target_tenant_id
       AND proposer_staff.user_id=receipt.proposer_uid
       AND proposer_staff.is_active=TRUE
       AND proposer_staff.archived=FALSE
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Approval completion proposer staff authority is stale'
        USING ERRCODE='42501';
    END IF;
    PERFORM 1
      FROM staff approver_staff
     WHERE approver_staff.tenant_id=target_tenant_id
       AND approver_staff.user_id=target_actor_uid
       AND approver_staff.is_active=TRUE
       AND approver_staff.archived=FALSE
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Approval completion approver staff authority is stale'
        USING ERRCODE='42501';
    END IF;
    PERFORM 1
      FROM pharmacy_staff_facility_grants facility_grant
     WHERE facility_grant.tenant_id=target_tenant_id
       AND facility_grant.id=proposer_grant_id
       AND facility_grant.staff_uid=receipt.proposer_uid
       AND facility_grant.facility_id=receipt.facility_id
     AND facility_grant.status='active'
     AND facility_grant.revoked_at IS NULL
   FOR UPDATE;
    proposer_grant_found:=FOUND;
    IF jsonb_typeof(
         governance_approval.metadata->'permitted_approver_roles'
       )='array' THEN
      SELECT EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(
            governance_approval.metadata->'permitted_approver_roles'
          ) permitted_role(role)
         WHERE permitted_role.role=approver_role
      ) INTO approver_role_permitted;
    ELSE
      approver_role_permitted:=FALSE;
    END IF;
    IF governance_approval.id IS NULL
       OR governance_task.id IS NULL
       OR governance_approval.status<>'approved'
       OR governance_approval.decided_by IS DISTINCT FROM target_actor_uid
       OR governance_approval.decided_at IS NULL
       OR governance_approval.decided_at>clock_timestamp()
       OR governance_approval.expires_at IS NULL
       OR governance_approval.decided_at>=governance_approval.expires_at
       OR clock_timestamp()>=governance_approval.expires_at
       OR governance_approval.task_id IS DISTINCT FROM receipt.task_id
       OR governance_approval.subject_resource_id IS DISTINCT FROM
          receipt.proposal_sha256
       OR governance_task.status<>'completed'
       OR governance_task.completed_at IS NULL
       OR governance_task.related_resource_type IS DISTINCT FROM
          receipt.task_resource_type
       OR governance_task.related_resource_id IS DISTINCT FROM
          receipt.pharmacy_order_id::TEXT
       OR proposer_role IS NULL
       OR approver_role IS NULL
       OR NOT proposer_grant_found
       OR NOT approver_role_permitted
       OR target_actor_uid=receipt.proposer_uid
       THEN
      RAISE EXCEPTION 'Approval completion authority is stale or incomplete'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_funding_command_governance_source_753';
    END IF;
    public_reservation_plan:=
      public.pharmacy_advance_reservation_public_plan_753(
        receipt.reservation_plan
      );
    expected_advance_reservations:=jsonb_build_object(
      'required_amount',receipt.reservation_plan #>>
        '{funding,reservation_required_amount}',
      'reservation_count',public_reservation_plan #>
        '{funding,reservation_count}',
      'source_evidence_sha256',receipt.reservation_plan #>>
        '{funding,source_evidence_sha256}',
      'source_plan_sha256',public_reservation_plan #>>
        '{funding,source_plan_sha256}'
    );
    IF jsonb_typeof(receipt.reservation_authority) IS DISTINCT FROM 'object'
       OR jsonb_typeof(receipt.reservation_plan) IS DISTINCT FROM 'object'
       OR receipt.reservation_authority_sha256 IS DISTINCT FROM encode(
            public.digest(receipt.reservation_authority::TEXT,'sha256'),'hex'
          )
       OR receipt.reservation_plan_sha256 IS DISTINCT FROM encode(
            public.digest(receipt.reservation_plan::TEXT,'sha256'),'hex'
          )
       OR receipt.reservation_authority->'selector' IS NULL THEN
      RAISE EXCEPTION 'Approval completion differs from its DB-authored reservation receipt'
      USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_substitution_reservation_receipt_753';
    END IF;
    canonical_response_body:=jsonb_build_object(
      'contract','pharmacy_substitution_funding_reauthorisation_v1',
      'approval_id',governance_approval.id,
      'approval_status',governance_approval.status,
      'task_id',governance_task.id,
      'task_status',governance_task.status,
      'receipt_id',receipt.id::TEXT,
      'proposal_sha256',receipt.proposal_sha256,
      'expires_at',to_char(
        DATE_TRUNC('milliseconds',governance_approval.expires_at)
          AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'selector',receipt.reservation_authority->'selector',
      'proposer',jsonb_build_object(
        'uid',receipt.proposer_uid::TEXT,
        'role',proposer_role,
        'facility_grant_id',proposer_grant_id::TEXT
      ),
      'approver_uid',target_actor_uid::TEXT,
      'approver_role',approver_role,
      'approved_at',to_char(
        DATE_TRUNC('milliseconds',governance_approval.decided_at)
          AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'task_resource_type',receipt.task_resource_type,
      'invoice_id',receipt.invoice_id,
      'invoice_item_id',receipt.invoice_item_id,
      'tpa_claim_id',receipt.tpa_claim_id,
      'base',receipt.reservation_authority->'base',
      'prospective',receipt.reservation_authority->'prospective',
      'billing',receipt.reservation_authority->'billing',
      'funding',public_reservation_plan->'funding',
      'advance_reservations',expected_advance_reservations
    );
  ELSIF receipt.command_type='SUBSTITUTION_FUNDING_CONSUMPTION' THEN
    IF receipt.order_mutation_receipt_id IS NOT NULL
       OR jsonb_typeof(target_response_body #> '{mutation,receipt_id}')
          IS DISTINCT FROM 'string'
       OR jsonb_typeof(target_response_body #> '{mutation,command_sha256}')
          IS DISTINCT FROM 'string'
       OR jsonb_typeof(target_response_body #> '{mutation,evidence_sha256}')
          IS DISTINCT FROM 'string'
       OR target_response_body #>> '{mutation,receipt_id}' !~ '^[1-9][0-9]*$'
       OR target_response_body #>> '{mutation,command_sha256}'
          !~ '^[0-9a-f]{64}$'
       OR target_response_body #>> '{mutation,evidence_sha256}'
          !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Consumption completion lacks one canonical mutation receipt identity'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_consumption_mutation_receipt_753';
    END IF;
    BEGIN
      mutation_receipt_id:=(target_response_body #>>
        '{mutation,receipt_id}')::BIGINT;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Consumption mutation receipt identity exceeds bigint bounds'
          USING ERRCODE='23514';
    END;
    SELECT order_receipt.*
      INTO mutation_receipt
      FROM pharmacy_order_command_receipts order_receipt
     WHERE order_receipt.tenant_id=target_tenant_id
       AND order_receipt.id=mutation_receipt_id
       AND order_receipt.pharmacy_order_id=receipt.pharmacy_order_id
       AND order_receipt.action='dispense_substitution'
       AND order_receipt.command_key_sha256=
          target_response_body #>> '{mutation,command_sha256}'
       AND order_receipt.response_evidence_sha256=
          target_response_body #>> '{mutation,evidence_sha256}'
     FOR UPDATE;
    IF NOT FOUND
       OR mutation_receipt.authority_transaction_id IS DISTINCT FROM
          txid_current()
       OR mutation_receipt.created_at IS DISTINCT FROM
          DATE_TRUNC('milliseconds',transaction_timestamp()) THEN
      RAISE EXCEPTION 'Consumption mutation receipt is not DB-authored in this transaction'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_consumption_mutation_receipt_753';
    END IF;
  ELSIF receipt.command_type='PHARMACY_ADVANCE_RELEASE' THEN
    SELECT consumption.*
      INTO abandoned_consumption
      FROM pharmacy_funding_commands consumption
     WHERE consumption.tenant_id=target_tenant_id
       AND consumption.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
       AND consumption.approval_receipt_id=receipt.approval_receipt_id
     FOR UPDATE;
    IF FOUND THEN
      IF abandoned_consumption.status<>'IN_PROGRESS'
         OR abandoned_consumption.response_body IS NOT NULL
         OR abandoned_consumption.order_mutation_receipt_id IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM pharmacy_advance_allocation_consumptions link
            WHERE link.tenant_id=target_tenant_id
              AND link.funding_consumption_receipt_id=abandoned_consumption.id
         )
         OR EXISTS (
           SELECT 1 FROM tasks finance_task
            WHERE finance_task.tenant_id=target_tenant_id
              AND finance_task.related_resource_type=
                  'pharmacy_advance_settlement'
              AND finance_task.related_resource_id=abandoned_consumption.id::TEXT
         )
         OR EXISTS (
           SELECT 1 FROM pharmacy_order_command_receipts order_receipt
            WHERE order_receipt.tenant_id=target_tenant_id
              AND order_receipt.action='dispense_substitution'
              AND order_receipt.pharmacy_order_id=receipt.pharmacy_order_id
              AND order_receipt.response_payload->>'approval_receipt_id'=
                  receipt.approval_receipt_id::TEXT
         ) THEN
        RAISE EXCEPTION 'Release cannot abandon a consumption with mutation, link, or finance evidence'
          USING ERRCODE='23514',
                CONSTRAINT='chk_pharmacy_advance_release_complete_753';
      END IF;
      PERFORM set_config(
        'app.pharmacy_consumption_abandonment',
        abandoned_consumption.id::TEXT,TRUE
      );
      UPDATE pharmacy_funding_commands consumption
         SET status='ABANDONED',response_body=jsonb_build_object(
           'contract','pharmacy_substitution_funding_consumption_abandoned_v1',
           'status','abandoned',
           'approval_receipt_id',receipt.approval_receipt_id::TEXT,
           'consumption_receipt_id',abandoned_consumption.id::TEXT,
           'release_receipt_id',receipt.id::TEXT,
           'release_reason',receipt.release_reason,
           'pharmacy_order_id',receipt.pharmacy_order_id::TEXT,
           'invoice_id',receipt.invoice_id::TEXT,
           'invoice_item_id',receipt.invoice_item_id::TEXT,
           'patient_uid',terminal_patient_uid::TEXT,
           'abandoned_by',receipt.created_by::TEXT
         )
       WHERE consumption.tenant_id=target_tenant_id
         AND consumption.id=abandoned_consumption.id
         AND consumption.status='IN_PROGRESS';
      GET DIAGNOSTICS abandoned_count=ROW_COUNT;
      IF abandoned_count<>1 THEN
        RAISE EXCEPTION 'Consumption claim changed before governed abandonment'
          USING ERRCODE='40001';
      END IF;
    END IF;
  END IF;
  IF receipt.status<>'IN_PROGRESS'
     OR receipt.created_by IS DISTINCT FROM target_actor_uid THEN
    RAISE EXCEPTION 'Pharmacy funding command cannot be completed by this actor or state'
      USING ERRCODE='23514';
  END IF;
  IF receipt.command_type='SUBSTITUTION_FUNDING_CONSUMPTION' THEN
    PERFORM set_config(
      'app.pharmacy_consumption_mutation_binding',target_command_id::TEXT,TRUE
    );
    RETURN QUERY
      UPDATE pharmacy_funding_commands command
         SET status='COMPLETE',response_body=target_response_body,
             order_mutation_receipt_id=mutation_receipt.id,
             order_mutation_action=mutation_receipt.action,
             order_mutation_command_sha256=mutation_receipt.command_key_sha256,
             order_mutation_request_sha256=mutation_receipt.request_sha256,
             order_mutation_evidence_sha256=
               mutation_receipt.response_evidence_sha256
       WHERE command.tenant_id=target_tenant_id
         AND command.id=target_command_id
         AND command.status='IN_PROGRESS'
         AND command.order_mutation_receipt_id IS NULL
      RETURNING command.id,command.status,command.response_body,
                command.approved_patient_amount,command.completed_at;
  ELSE
    RETURN QUERY
      UPDATE pharmacy_funding_commands command
         SET status='COMPLETE',response_body=canonical_response_body
       WHERE command.tenant_id=target_tenant_id
         AND command.id=target_command_id
         AND command.status='IN_PROGRESS'
      RETURNING command.id,command.status,command.response_body,
                command.approved_patient_amount,command.completed_at;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy funding command changed before completion'
      USING ERRCODE='40001';
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.convert_pharmacy_advance_settlement_753(target_tenant_id uuid, target_settlement_receipt_id bigint, target_actor_uid uuid)
 RETURNS TABLE(id bigint, status character varying, response_body jsonb, completed_at timestamp with time zone, invoice_id integer, invoice_number character varying, invoice_status character varying, amount_paid numeric, amount_due numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  discovered_receipt pharmacy_funding_commands%ROWTYPE;
  settlement_receipt pharmacy_funding_commands%ROWTYPE;
  approval_receipt pharmacy_funding_commands%ROWTYPE;
  consumption_receipt pharmacy_funding_commands%ROWTYPE;
  finance_task tasks%ROWTYPE;
  mutation_receipt pharmacy_order_command_receipts%ROWTYPE;
  order_row pharmacy_orders%ROWTYPE;
  terminal_patient users%ROWTYPE;
  invoice_row billing_invoices%ROWTYPE;
  admission_row admissions%ROWTYPE;
  allocation_row RECORD;
  settlement_row RECORD;
  advance_row billing_advances%ROWTYPE;
  terminal_patient_uid UUID;
  invoice_terminal_uid UUID;
  patient_uid_family UUID[];
  order_patient_uid UUID;
  invoice_projection JSONB;
  expected_invoice_projection JSONB;
  response_allocations JSONB;
  response JSONB;
  conversion_time TIMESTAMPTZ:=DATE_TRUNC(
    'milliseconds',transaction_timestamp()
  );
  allocation_count BIGINT;
  settlement_amount NUMERIC(14,2);
  expected_due NUMERIC(12,2);
  expected_status VARCHAR(20);
  fiscal_year INTEGER;
  next_invoice_value INTEGER;
  issued_number VARCHAR(50);
  settlement_id_value BIGINT;
  settlement_id_integer INTEGER;
  reversal_id BIGINT;
  reversal_evidence JSONB;
  reversal_evidence_sha256 CHAR(64);
  invoice_issue_entry_id BIGINT;
  settlement_entry_id BIGINT;
  patient_ar_account_id BIGINT;
  patient_advance_account_id BIGINT;
  revenue_account_id BIGINT;
  tax_account_id BIGINT;
  account_count INTEGER;
  total_paise BIGINT;
  tax_paise BIGINT;
  revenue_paise BIGINT;
  settlement_paise BIGINT;
  ledger_balance_paise BIGINT;
  expected_advance_balance NUMERIC(12,2);
  affected_count INTEGER;
  ledger_mode_type TEXT;
  ledger_mode TEXT;
BEGIN
  IF current_setting('app.current_tenant_id',TRUE) IS NULL
     OR current_setting('app.current_tenant_id',TRUE) IN ('','bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM target_tenant_id
     OR target_actor_uid IS NULL
     OR target_settlement_receipt_id IS NULL
     OR target_settlement_receipt_id<=0 THEN
    RAISE EXCEPTION 'Pharmacy advance conversion requires exact tenant, receipt, and actor context'
      USING ERRCODE='42501';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::TEXT,0
  ));
  SELECT jsonb_typeof(tenant.settings->'ledger_authoritative_mode'),
         lower(btrim(tenant.settings->>'ledger_authoritative_mode'))
    INTO ledger_mode_type,ledger_mode
    FROM tenants tenant
   WHERE tenant.id=target_tenant_id
   FOR UPDATE;
  IF NOT FOUND
     OR ledger_mode_type IS DISTINCT FROM 'string'
     OR ledger_mode IS DISTINCT FROM 'enforce' THEN
    RAISE EXCEPTION 'Pharmacy advance conversion requires explicit tenant ledger enforce mode'
      USING ERRCODE='42501',
            CONSTRAINT='chk_pharmacy_advance_conversion_ledger_mode_753';
  END IF;
  SELECT command.*
    INTO discovered_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_settlement_receipt_id
     AND command.command_type='PHARMACY_ADVANCE_SETTLEMENT';
  IF NOT FOUND OR discovered_receipt.patient_uid IS NULL
     OR discovered_receipt.approval_receipt_id IS NULL
     OR discovered_receipt.consumption_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance conversion receipt is unavailable'
      USING ERRCODE='P0002';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,discovered_receipt.patient_uid
  );
  patient_uid_family:=public.resolve_billing_patient_family_753(
    target_tenant_id,terminal_patient_uid
  );
  IF NOT discovered_receipt.patient_uid=ANY(patient_uid_family) THEN
    RAISE EXCEPTION 'Pharmacy advance conversion patient lineage is stale'
      USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || target_tenant_id::TEXT || ':'
      || terminal_patient_uid::TEXT,753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || target_tenant_id::TEXT || ':'
      || discovered_receipt.pharmacy_order_id::TEXT,753
  ));

  SELECT command.*
    INTO approval_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=discovered_receipt.approval_receipt_id
     AND command.command_type='SUBSTITUTION_FUNDING_APPROVAL'
     AND command.status='COMPLETE'
   FOR UPDATE;
  IF NOT FOUND
     OR approval_receipt.patient_uid IS DISTINCT FROM
          discovered_receipt.patient_uid
     OR approval_receipt.approved_patient_amount IS NULL
     OR approval_receipt.approved_patient_amount<=0
     OR approval_receipt.response_body #>> '{base,patient_uid}'
        IS DISTINCT FROM terminal_patient_uid::TEXT
     OR jsonb_typeof(approval_receipt.reservation_authority)
        IS DISTINCT FROM 'object'
     OR jsonb_typeof(approval_receipt.reservation_plan)
        IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Pharmacy advance conversion lacks its exact positive approval'
      USING ERRCODE='23514';
  END IF;
  IF (approval_receipt.reservation_plan #>>
        '{funding,tpa_used_amount}')::NUMERIC<>0 THEN
    RAISE EXCEPTION 'Mixed TPA and patient-advance authority has no governed atomic conversion'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_conversion_mixed_funding_753';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || target_tenant_id::TEXT || ':'
      || approval_receipt.id::TEXT,0
  ));

  SELECT command.*
    INTO settlement_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_settlement_receipt_id
     AND command.approval_receipt_id=approval_receipt.id
     AND command.patient_uid=approval_receipt.patient_uid
   FOR UPDATE;
  IF NOT FOUND
     OR settlement_receipt.command_type<>'PHARMACY_ADVANCE_SETTLEMENT'
     OR settlement_receipt.created_by IS DISTINCT FROM target_actor_uid
     OR settlement_receipt.pharmacy_order_id IS DISTINCT FROM
          approval_receipt.pharmacy_order_id
     OR settlement_receipt.invoice_id IS DISTINCT FROM approval_receipt.invoice_id
     OR settlement_receipt.invoice_item_id IS DISTINCT FROM
          approval_receipt.invoice_item_id THEN
    RAISE EXCEPTION 'Pharmacy advance conversion receipt changed before lock'
      USING ERRCODE='40001';
  END IF;
  SELECT command.*
    INTO consumption_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=settlement_receipt.consumption_receipt_id
     AND command.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
     AND command.status='COMPLETE'
     AND command.approval_receipt_id=approval_receipt.id
   FOR UPDATE;
  IF NOT FOUND OR consumption_receipt.order_mutation_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance conversion lacks completed dispense evidence'
      USING ERRCODE='23514';
  END IF;
  SELECT receipt.*
    INTO mutation_receipt
    FROM pharmacy_order_command_receipts receipt
   WHERE receipt.tenant_id=target_tenant_id
     AND receipt.id=consumption_receipt.order_mutation_receipt_id
     AND receipt.pharmacy_order_id=settlement_receipt.pharmacy_order_id
     AND receipt.action='dispense_substitution'
   FOR UPDATE;
  IF NOT FOUND
     OR mutation_receipt.command_key_sha256 IS DISTINCT FROM
          consumption_receipt.order_mutation_command_sha256
     OR mutation_receipt.request_sha256 IS DISTINCT FROM
          consumption_receipt.order_mutation_request_sha256
     OR mutation_receipt.response_evidence_sha256 IS DISTINCT FROM
          consumption_receipt.order_mutation_evidence_sha256 THEN
    RAISE EXCEPTION 'Pharmacy advance conversion mutation receipt is stale'
      USING ERRCODE='23514';
  END IF;
  IF settlement_receipt.status='COMPLETE' THEN
    IF settlement_receipt.created_by IS DISTINCT FROM target_actor_uid THEN
      RAISE EXCEPTION 'Pharmacy advance conversion replay changed its actor identity'
        USING ERRCODE='23514';
    END IF;
    PERFORM public.assert_pharmacy_advance_settlement_receipt_753(
      target_tenant_id,settlement_receipt.id
    );
    SELECT invoice.*
      INTO invoice_row
      FROM billing_invoices invoice
     WHERE invoice.tenant_id=target_tenant_id
       AND invoice.id=settlement_receipt.invoice_id;
    RETURN QUERY SELECT settlement_receipt.id,settlement_receipt.status,
                        settlement_receipt.response_body,
                        settlement_receipt.completed_at,invoice_row.id,
                        invoice_row.invoice_number,invoice_row.status,
                        invoice_row.amount_paid,invoice_row.amount_due;
    RETURN;
  END IF;
  IF settlement_receipt.status<>'IN_PROGRESS' THEN
    RAISE EXCEPTION 'Pharmacy advance conversion receipt is not claimable'
      USING ERRCODE='23514';
  END IF;

  SELECT actor.*
    INTO terminal_patient
    FROM users actor
   WHERE actor.tenant_id=target_tenant_id
     AND actor.uid=target_actor_uid
     AND actor.role IN ('FINANCE_INCHARGE','BILLING_INCHARGE')
     AND actor.is_active=TRUE
     AND actor.status='active'
     AND COALESCE(actor.is_deleted,FALSE)=FALSE
     AND actor.merged_into_uid IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance conversion actor lacks live finance authority'
      USING ERRCODE='42501';
  END IF;
  PERFORM 1
    FROM staff staff_identity
   WHERE staff_identity.tenant_id=target_tenant_id
     AND staff_identity.user_id=target_actor_uid
     AND staff_identity.is_active=TRUE
     AND staff_identity.archived=FALSE
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance conversion actor lacks active staff authority'
      USING ERRCODE='42501';
  END IF;
  SELECT task.*
    INTO finance_task
    FROM tasks task
   WHERE task.tenant_id=target_tenant_id
     AND task.id=settlement_receipt.task_id
     AND task.related_resource_type='pharmacy_advance_settlement'
     AND task.related_resource_id=consumption_receipt.id::TEXT
   FOR UPDATE;
  IF NOT FOUND OR finance_task.status<>'open'
     OR finance_task.assigned_to_role<>'FINANCE_INCHARGE'
     OR finance_task.patient_uid IS DISTINCT FROM settlement_receipt.patient_uid THEN
    RAISE EXCEPTION 'Pharmacy advance conversion finance task is not open authority'
      USING ERRCODE='23514';
  END IF;

  SELECT pharmacy_order.*
    INTO order_row
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=settlement_receipt.pharmacy_order_id
   FOR UPDATE;
  SELECT patient.uid
    INTO order_patient_uid
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.id=order_row.patient_id
     AND patient.role='PATIENT'
   FOR UPDATE;
  SELECT patient.*
    INTO terminal_patient
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.uid=terminal_patient_uid
     AND patient.role='PATIENT'
     AND patient.is_active=TRUE
     AND patient.status='active'
     AND COALESCE(patient.is_deleted,FALSE)=FALSE
     AND patient.merged_into_uid IS NULL
   FOR UPDATE;
  IF order_row.id IS NULL OR order_patient_uid IS NULL
     OR terminal_patient.id IS NULL
     OR public.resolve_billing_patient_terminal_753(
          target_tenant_id,order_patient_uid
        ) IS DISTINCT FROM terminal_patient_uid
     OR (order_row.uid IS NOT NULL AND (
       NOT order_row.uid=ANY(patient_uid_family)
       OR public.resolve_billing_patient_terminal_753(
            target_tenant_id,order_row.uid
          ) IS DISTINCT FROM terminal_patient_uid
     ))
     OR order_row.facility_id IS DISTINCT FROM settlement_receipt.facility_id
     OR order_row.inventory_authority_version IS DISTINCT FROM
          (approval_receipt.reservation_authority #>>
            '{prospective,order_version}')::INTEGER
     OR order_row.items_list IS DISTINCT FROM
          approval_receipt.reservation_authority #> '{prospective,items_list}'
     OR order_row.clinical_verification_items_sha256 IS DISTINCT FROM
          approval_receipt.reservation_authority #>>
            '{prospective,order_items_sha256}'
     OR order_row.total_amount IS DISTINCT FROM
          (approval_receipt.reservation_authority #>>
            '{prospective,authoritative_amount}')::NUMERIC THEN
    RAISE EXCEPTION 'Pharmacy advance conversion order differs from consumed prospective authority'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1
    FROM facilities facility
   WHERE facility.tenant_id=target_tenant_id
     AND facility.id=order_row.facility_id
     AND facility.status='active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance conversion facility is inactive'
      USING ERRCODE='23514';
  END IF;

  SELECT invoice.*
    INTO invoice_row
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=settlement_receipt.invoice_id
   FOR UPDATE;
  PERFORM 1
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=settlement_receipt.invoice_id
   ORDER BY item.id
   FOR UPDATE;
  IF invoice_row.id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance conversion invoice is unavailable'
      USING ERRCODE='23514';
  END IF;
  invoice_terminal_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,invoice_row.patient_uid
  );
  IF invoice_terminal_uid IS DISTINCT FROM terminal_patient_uid
     OR invoice_row.admission_id IS DISTINCT FROM order_row.funding_admission_id THEN
    RAISE EXCEPTION 'Pharmacy advance conversion invoice lineage is stale'
      USING ERRCODE='23514';
  END IF;
  IF invoice_row.admission_id IS NOT NULL THEN
    SELECT admission.*
      INTO admission_row
      FROM admissions admission
     WHERE admission.tenant_id=target_tenant_id
       AND admission.id=invoice_row.admission_id
     FOR UPDATE;
    IF NOT FOUND OR admission_row.billing_closed_at IS NOT NULL
       OR public.resolve_billing_patient_terminal_753(
            target_tenant_id,admission_row.patient_uid
          ) IS DISTINCT FROM terminal_patient_uid THEN
      RAISE EXCEPTION 'Pharmacy advance conversion admission is closed or stale'
        USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM 1 FROM billing_payments payment
   WHERE payment.tenant_id=target_tenant_id
     AND payment.invoice_id=invoice_row.id
   ORDER BY payment.id FOR UPDATE;
  PERFORM 1 FROM billing_refunds refund
   WHERE refund.tenant_id=target_tenant_id
     AND refund.invoice_id=invoice_row.id
   ORDER BY refund.id FOR UPDATE;
  PERFORM 1 FROM billing_advance_settlements prior_settlement
   WHERE prior_settlement.tenant_id=target_tenant_id
     AND prior_settlement.invoice_id=invoice_row.id
   ORDER BY prior_settlement.id FOR UPDATE;
  PERFORM 1 FROM billing_credit_notes credit_note
   WHERE credit_note.tenant_id=target_tenant_id
     AND credit_note.invoice_id=invoice_row.id
   ORDER BY credit_note.id FOR UPDATE;
  IF EXISTS (
       SELECT 1 FROM billing_payments payment
        WHERE payment.tenant_id=target_tenant_id
          AND payment.invoice_id=invoice_row.id
     ) OR EXISTS (
       SELECT 1 FROM billing_refunds refund
        WHERE refund.tenant_id=target_tenant_id
          AND refund.invoice_id=invoice_row.id
     ) OR EXISTS (
       SELECT 1 FROM billing_advance_settlements prior_settlement
        WHERE prior_settlement.tenant_id=target_tenant_id
          AND prior_settlement.invoice_id=invoice_row.id
     ) OR EXISTS (
       SELECT 1 FROM billing_credit_notes credit_note
        WHERE credit_note.tenant_id=target_tenant_id
          AND credit_note.invoice_id=invoice_row.id
     ) OR EXISTS (
       SELECT 1
         FROM ledger_postings posting
        WHERE posting.tenant_id=target_tenant_id
          AND posting.invoice_id=invoice_row.id
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance conversion invoice has intervening finance history'
      USING ERRCODE='23514';
  END IF;
  invoice_projection:=public.pharmacy_advance_invoice_projection_753(
    target_tenant_id,invoice_row.id,settlement_receipt.invoice_item_id
  );
  IF invoice_projection IS DISTINCT FROM
       approval_receipt.reservation_authority #> '{billing,prospective}' THEN
    RAISE EXCEPTION 'Pharmacy advance conversion invoice differs from consumed prospective authority'
      USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*),COALESCE(SUM(allocation.allocated_amount),0)
    INTO allocation_count,settlement_amount
    FROM pharmacy_advance_allocations allocation
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.funding_approval_receipt_id=approval_receipt.id;
  IF allocation_count=0
     OR settlement_amount IS DISTINCT FROM
          approval_receipt.approved_patient_amount THEN
    RAISE EXCEPTION 'Pharmacy advance conversion allocation set is incomplete'
      USING ERRCODE='23514';
  END IF;
  FOR allocation_row IN
    SELECT allocation.*
      FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.funding_approval_receipt_id=approval_receipt.id
     ORDER BY allocation.billing_advance_id,allocation.id
  LOOP
    SELECT advance.*
      INTO advance_row
      FROM billing_advances advance
     WHERE advance.tenant_id=target_tenant_id
       AND advance.id=allocation_row.billing_advance_id
     FOR UPDATE;
    PERFORM 1 FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.id=allocation_row.id
     FOR UPDATE;
    IF advance_row.id IS NULL OR advance_row.status<>'ACTIVE'
       OR advance_row.balance<allocation_row.allocated_amount
       OR EXISTS (
         SELECT 1 FROM pharmacy_advance_allocation_reversals reversal
          WHERE reversal.tenant_id=target_tenant_id
            AND reversal.allocation_id=allocation_row.id
       ) OR NOT EXISTS (
         SELECT 1 FROM pharmacy_advance_allocation_consumptions consumption
          WHERE consumption.tenant_id=target_tenant_id
            AND consumption.allocation_id=allocation_row.id
            AND consumption.funding_consumption_receipt_id=consumption_receipt.id
       ) THEN
      RAISE EXCEPTION 'Pharmacy advance conversion allocation source is stale'
        USING ERRCODE='23514';
    END IF;
    PERFORM public.assert_pharmacy_advance_patient_scope_753(
      target_tenant_id,advance_row.id,invoice_row.patient_uid,
      invoice_row.admission_id
    );
    SELECT COALESCE(SUM(balance.balance_paise),0)::BIGINT
      INTO ledger_balance_paise
      FROM ledger_balances balance
      JOIN ledger_accounts account
        ON account.tenant_id=balance.tenant_id
       AND account.id=balance.account_id
       AND account.code='PATIENT_ADVANCE'
     WHERE balance.tenant_id=target_tenant_id
       AND balance.advance_id=advance_row.id;
    IF ledger_balance_paise IS DISTINCT FROM
       ROUND(advance_row.balance*100)::BIGINT THEN
      RAISE EXCEPTION 'Pharmacy advance conversion requires ledger-backed advance balance'
        USING ERRCODE='23514';
    END IF;
  END LOOP;

  PERFORM 1 FROM ledger_accounts account
   WHERE account.tenant_id=target_tenant_id
     AND account.code IN (
       'PATIENT_AR','PATIENT_ADVANCE','REVENUE','TAX_PAYABLE'
     )
   ORDER BY account.code
   FOR KEY SHARE;
  SELECT MAX(account.id) FILTER (WHERE account.code='PATIENT_AR'),
         MAX(account.id) FILTER (WHERE account.code='PATIENT_ADVANCE'),
         MAX(account.id) FILTER (WHERE account.code='REVENUE'),
         MAX(account.id) FILTER (WHERE account.code='TAX_PAYABLE'),
         COUNT(DISTINCT account.code)
    INTO patient_ar_account_id,patient_advance_account_id,
         revenue_account_id,tax_account_id,account_count
    FROM ledger_accounts account
   WHERE account.tenant_id=target_tenant_id
     AND account.code IN (
       'PATIENT_AR','PATIENT_ADVANCE','REVENUE','TAX_PAYABLE'
     );
  IF account_count<>4 THEN
    RAISE EXCEPTION 'Pharmacy advance conversion ledger chart is incomplete'
      USING ERRCODE='23514';
  END IF;

  FOR allocation_row IN
    SELECT allocation.*
      FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.funding_approval_receipt_id=approval_receipt.id
     ORDER BY allocation.billing_advance_id,allocation.id
  LOOP
    settlement_id_value:=nextval(pg_get_serial_sequence(
      'public.billing_advance_settlements','id'
    ));
    IF settlement_id_value>2147483647 THEN
      RAISE EXCEPTION 'Pharmacy advance settlement identity exceeds integer bounds'
        USING ERRCODE='22003';
    END IF;
    settlement_id_integer:=settlement_id_value::INTEGER;
    reversal_evidence:=jsonb_build_object(
      'contract','pharmacy_advance_settlement_reversal_v1',
      'settlement_receipt_id',settlement_receipt.id::TEXT,
      'approval_receipt_id',approval_receipt.id::TEXT,
      'consumption_receipt_id',consumption_receipt.id::TEXT,
      'allocation_id',allocation_row.id::TEXT,
      'billing_advance_id',allocation_row.billing_advance_id,
      'allocated_amount',allocation_row.allocated_amount::TEXT,
      'allocation_evidence_sha256',allocation_row.evidence_sha256,
      'settlement_id',settlement_id_integer,
      'command_sha256',settlement_receipt.command_key_sha256,
      'settled_by',target_actor_uid::TEXT
    );
    INSERT INTO pharmacy_advance_allocation_reversals (
      tenant_id,allocation_id,pharmacy_order_id,invoice_id,invoice_item_id,
      billing_advance_id,source_authority_version,source_authority_sha256,
      funding_task_id,funding_approval_receipt_id,
      allocation_evidence_sha256,reversed_amount,reversal_command_sha256,
      reason,billing_advance_settlement_id,funding_settlement_receipt_id,
      reversed_by,evidence
    ) VALUES (
      target_tenant_id,allocation_row.id,allocation_row.pharmacy_order_id,
      allocation_row.invoice_id,allocation_row.invoice_item_id,
      allocation_row.billing_advance_id,allocation_row.source_authority_version,
      allocation_row.source_authority_sha256,allocation_row.funding_task_id,
      allocation_row.funding_approval_receipt_id,allocation_row.evidence_sha256,
      allocation_row.allocated_amount,settlement_receipt.command_key_sha256,
      'SETTLED_TO_INVOICE',settlement_id_integer,settlement_receipt.id,
      target_actor_uid,reversal_evidence
    ) RETURNING pharmacy_advance_allocation_reversals.id,
                pharmacy_advance_allocation_reversals.evidence_sha256
      INTO reversal_id,reversal_evidence_sha256;
    INSERT INTO billing_advance_settlements (
      id,tenant_id,advance_id,invoice_id,amount,settled_by,
      pharmacy_advance_allocation_id,pharmacy_advance_settlement_receipt_id,
      pharmacy_advance_allocation_evidence_sha256,
      pharmacy_advance_conversion_command_sha256,
      pharmacy_advance_conversion_evidence_sha256
    ) VALUES (
      settlement_id_integer,target_tenant_id,allocation_row.billing_advance_id,
      allocation_row.invoice_id,allocation_row.allocated_amount,target_actor_uid,
      allocation_row.id,settlement_receipt.id,allocation_row.evidence_sha256,
      settlement_receipt.command_key_sha256,reversal_evidence_sha256
    );
  END LOOP;

  fiscal_year:=CASE
    WHEN EXTRACT(MONTH FROM conversion_time AT TIME ZONE 'UTC')>=4
      THEN EXTRACT(YEAR FROM conversion_time AT TIME ZONE 'UTC')::INTEGER
    ELSE EXTRACT(YEAR FROM conversion_time AT TIME ZONE 'UTC')::INTEGER-1
  END;
  INSERT INTO billing_invoice_counter (tenant_id,fiscal_year,next_value)
  VALUES (target_tenant_id,fiscal_year,2)
  ON CONFLICT (tenant_id,fiscal_year)
  DO UPDATE SET next_value=billing_invoice_counter.next_value+1
  RETURNING billing_invoice_counter.next_value INTO next_invoice_value;
  issued_number:='INV-' || fiscal_year::TEXT || '-'
    || LPAD((next_invoice_value-1)::TEXT,6,'0');
  expected_due:=GREATEST(
    0,invoice_row.total_amount-COALESCE(invoice_row.credit_note_amount,0)
      -settlement_amount
  )::NUMERIC(12,2);
  expected_status:=CASE WHEN expected_due<=0.005 THEN 'PAID' ELSE 'PARTIAL' END;
  UPDATE billing_invoices invoice
     SET invoice_number=issued_number,
         status=expected_status,
         issued_at=conversion_time,
         amount_paid=settlement_amount,
         amount_due=expected_due,
         patient_name=COALESCE(invoice.patient_name,terminal_patient.name),
         patient_phone=COALESCE(invoice.patient_phone,terminal_patient.phone),
         doctor_uid=COALESCE(
           invoice.doctor_uid,admission_row.attending_doctor,
           admission_row.admitting_doctor
         ),
         department=COALESCE(invoice.department,admission_row.department),
         updated_at=conversion_time
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=invoice_row.id
     AND invoice.status='DRAFT'
     AND invoice.invoice_number IS NULL
     AND invoice.issued_at IS NULL
     AND invoice.voided_at IS NULL
     AND invoice.amount_paid=0
     AND invoice.credit_note_amount=0;
  GET DIAGNOSTICS affected_count=ROW_COUNT;
  IF affected_count<>1 THEN
    RAISE EXCEPTION 'Pharmacy advance conversion invoice changed before issue'
      USING ERRCODE='40001';
  END IF;

  total_paise:=ROUND(invoice_row.total_amount*100)::BIGINT;
  tax_paise:=ROUND((
    COALESCE(invoice_row.cgst_amount,0)+COALESCE(invoice_row.sgst_amount,0)
    +COALESCE(invoice_row.igst_amount,0)
  )*100)::BIGINT;
  revenue_paise:=total_paise-tax_paise;
  IF total_paise<=0 OR tax_paise<0 OR revenue_paise<=0 THEN
    RAISE EXCEPTION 'Pharmacy advance conversion invoice ledger amount is invalid'
      USING ERRCODE='23514';
  END IF;
  INSERT INTO ledger_entries (
    tenant_id,entry_type,occurred_at,created_by,idempotency_key,metadata
  ) VALUES (
    target_tenant_id,'INVOICE_ISSUE',conversion_time,target_actor_uid,
    'issue-inv-' || invoice_row.id::TEXT,
    jsonb_build_object(
      'contract','pharmacy_advance_conversion_invoice_issue_v1',
      'settlement_receipt_id',settlement_receipt.id::TEXT,
      'invoice_id',invoice_row.id
    )
  ) RETURNING ledger_entries.id INTO invoice_issue_entry_id;
  INSERT INTO ledger_postings (
    tenant_id,entry_id,account_id,amount_paise,patient_uid,invoice_id
  ) VALUES (
    target_tenant_id,invoice_issue_entry_id,patient_ar_account_id,total_paise,
    invoice_row.patient_uid,invoice_row.id
  );
  INSERT INTO ledger_postings (
    tenant_id,entry_id,account_id,amount_paise
  ) VALUES (
    target_tenant_id,invoice_issue_entry_id,revenue_account_id,-revenue_paise
  );
  IF tax_paise>0 THEN
    INSERT INTO ledger_postings (
      tenant_id,entry_id,account_id,amount_paise
    ) VALUES (
      target_tenant_id,invoice_issue_entry_id,tax_account_id,-tax_paise
    );
  END IF;

  FOR settlement_row IN
    SELECT settlement.*,advance.patient_uid AS advance_patient_uid,
           advance.balance AS advance_balance
      FROM billing_advance_settlements settlement
      JOIN billing_advances advance
        ON advance.tenant_id=settlement.tenant_id
       AND advance.id=settlement.advance_id
     WHERE settlement.tenant_id=target_tenant_id
       AND settlement.pharmacy_advance_settlement_receipt_id=
           settlement_receipt.id
     ORDER BY settlement.advance_id,settlement.id
  LOOP
    settlement_paise:=ROUND(settlement_row.amount*100)::BIGINT;
    INSERT INTO ledger_entries (
      tenant_id,entry_type,occurred_at,created_by,idempotency_key,metadata
    ) VALUES (
      target_tenant_id,'ADVANCE_SETTLE',conversion_time,target_actor_uid,
      'advance-settle-' || settlement_row.id::TEXT,
      jsonb_build_object(
        'contract','pharmacy_advance_conversion_settlement_v1',
        'settlement_receipt_id',settlement_receipt.id::TEXT,
        'settlement_id',settlement_row.id,
        'allocation_id',settlement_row.pharmacy_advance_allocation_id::TEXT
      )
    ) RETURNING ledger_entries.id INTO settlement_entry_id;
    INSERT INTO ledger_postings (
      tenant_id,entry_id,account_id,amount_paise,patient_uid,advance_id
    ) VALUES (
      target_tenant_id,settlement_entry_id,patient_advance_account_id,
      settlement_paise,settlement_row.advance_patient_uid,
      settlement_row.advance_id
    );
    INSERT INTO ledger_postings (
      tenant_id,entry_id,account_id,amount_paise,patient_uid,invoice_id
    ) VALUES (
      target_tenant_id,settlement_entry_id,patient_ar_account_id,
      -settlement_paise,invoice_row.patient_uid,invoice_row.id
    );
    expected_advance_balance:=(
      settlement_row.advance_balance-settlement_row.amount
    )::NUMERIC(12,2);
    SELECT COALESCE(SUM(balance.balance_paise),0)::BIGINT
      INTO ledger_balance_paise
      FROM ledger_balances balance
      JOIN ledger_accounts account
        ON account.tenant_id=balance.tenant_id
       AND account.id=balance.account_id
       AND account.code='PATIENT_ADVANCE'
     WHERE balance.tenant_id=target_tenant_id
       AND balance.advance_id=settlement_row.advance_id;
    IF ledger_balance_paise IS DISTINCT FROM
       ROUND(expected_advance_balance*100)::BIGINT THEN
      RAISE EXCEPTION 'Pharmacy advance conversion ledger balance changed unexpectedly'
        USING ERRCODE='23514';
    END IF;
    UPDATE billing_advances advance
       SET balance=expected_advance_balance,
           status=CASE WHEN expected_advance_balance<=0.005
             THEN 'EXHAUSTED' ELSE 'ACTIVE' END,
           updated_at=conversion_time
     WHERE advance.tenant_id=target_tenant_id
       AND advance.id=settlement_row.advance_id
       AND advance.balance=settlement_row.advance_balance;
    GET DIAGNOSTICS affected_count=ROW_COUNT;
    IF affected_count<>1 THEN
      RAISE EXCEPTION 'Pharmacy advance conversion balance changed concurrently'
        USING ERRCODE='40001';
    END IF;
  END LOOP;

  SELECT COALESCE(SUM(balance.balance_paise),0)::BIGINT
    INTO ledger_balance_paise
    FROM ledger_balances balance
    JOIN ledger_accounts account
      ON account.tenant_id=balance.tenant_id
     AND account.id=balance.account_id
     AND account.code IN ('PATIENT_AR','INSURANCE_AR')
   WHERE balance.tenant_id=target_tenant_id
     AND balance.invoice_id=invoice_row.id;
  IF ledger_balance_paise IS DISTINCT FROM ROUND(expected_due*100)::BIGINT THEN
    RAISE EXCEPTION 'Pharmacy advance conversion invoice ledger state is inconsistent'
      USING ERRCODE='23514';
  END IF;
  expected_invoice_projection:=
    (approval_receipt.reservation_authority #> '{billing,prospective}')
    || jsonb_build_object(
      'invoice',(
        approval_receipt.reservation_authority #>
          '{billing,prospective,invoice}'
      ) || jsonb_build_object(
        'status',expected_status,
        'invoice_number',issued_number,
        'issued_at',conversion_time,
        'amount_paid',settlement_amount::NUMERIC(12,2)::TEXT,
        'amount_due',expected_due::TEXT
      )
    );
  IF public.pharmacy_advance_invoice_projection_753(
       target_tenant_id,invoice_row.id,settlement_receipt.invoice_item_id
     ) IS DISTINCT FROM expected_invoice_projection THEN
    RAISE EXCEPTION 'Pharmacy advance conversion final invoice projection is not canonical'
      USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'allocation_id',allocation.id::TEXT,
           'billing_advance_id',allocation.billing_advance_id,
           'allocation_evidence_sha256',allocation.evidence_sha256,
           'allocated_amount',allocation.allocated_amount::TEXT,
           'settlement_id',settlement.id,
           'reversal_id',reversal.id::TEXT,
           'reversal_command_sha256',reversal.reversal_command_sha256,
           'settlement_command_sha256',
             settlement.pharmacy_advance_conversion_command_sha256,
           'settlement_ledger_entry_id',ledger_entry.id::TEXT
         ) ORDER BY allocation.id),'[]'::JSONB)
    INTO response_allocations
    FROM pharmacy_advance_allocations allocation
    JOIN pharmacy_advance_allocation_reversals reversal
      ON reversal.tenant_id=allocation.tenant_id
     AND reversal.allocation_id=allocation.id
     AND reversal.funding_settlement_receipt_id=settlement_receipt.id
    JOIN billing_advance_settlements settlement
      ON settlement.tenant_id=allocation.tenant_id
     AND settlement.pharmacy_advance_allocation_id=allocation.id
     AND settlement.pharmacy_advance_settlement_receipt_id=settlement_receipt.id
    JOIN ledger_entries ledger_entry
      ON ledger_entry.tenant_id=settlement.tenant_id
     AND ledger_entry.idempotency_key=
         'advance-settle-' || settlement.id::TEXT
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.funding_approval_receipt_id=approval_receipt.id;
  response:=jsonb_build_object(
    'contract','pharmacy_advance_settlement_v1',
    'status','settled_to_invoice',
    'finance_task_id',settlement_receipt.task_id,
    'approval_receipt_id',approval_receipt.id::TEXT,
    'consumption_receipt_id',consumption_receipt.id::TEXT,
    'pharmacy_order_id',approval_receipt.pharmacy_order_id,
    'invoice_id',approval_receipt.invoice_id,
    'invoice_item_id',approval_receipt.invoice_item_id,
    'patient_uid',terminal_patient_uid::TEXT,
    'settled_amount',settlement_amount::NUMERIC(12,2)::TEXT,
    'tpa_receivable_amount','0.00',
    'settled_by',target_actor_uid::TEXT,
    'invoice',jsonb_build_object(
      'invoice_number',issued_number,
      'status',expected_status,
      'issued_at',to_char(
        conversion_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'total_amount',invoice_row.total_amount::NUMERIC(12,2)::TEXT,
      'credit_note_amount',COALESCE(
        invoice_row.credit_note_amount,0
      )::NUMERIC(12,2)::TEXT,
      'amount_paid',settlement_amount::NUMERIC(12,2)::TEXT,
      'amount_due',expected_due::TEXT
    ),
    'invoice_issue_ledger_entry_id',invoice_issue_entry_id::TEXT,
    'allocations',response_allocations
  );
  UPDATE tasks task
     SET status='completed',completed_at=conversion_time,
         updated_at=conversion_time
   WHERE task.tenant_id=target_tenant_id
     AND task.id=finance_task.id
     AND task.status='open';
  GET DIAGNOSTICS affected_count=ROW_COUNT;
  IF affected_count<>1 THEN
    RAISE EXCEPTION 'Pharmacy advance conversion finance task changed concurrently'
      USING ERRCODE='40001';
  END IF;
  UPDATE pharmacy_funding_commands command
     SET status='COMPLETE',response_body=response
   WHERE command.tenant_id=target_tenant_id
     AND command.id=settlement_receipt.id
     AND command.status='IN_PROGRESS'
  RETURNING command.* INTO settlement_receipt;
  IF NOT FOUND
     OR settlement_receipt.completed_at IS DISTINCT FROM conversion_time
     OR settlement_receipt.completed_transaction_id IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'Pharmacy advance conversion receipt changed before completion'
      USING ERRCODE='40001';
  END IF;
  PERFORM public.assert_pharmacy_advance_settlement_receipt_753(
    target_tenant_id,settlement_receipt.id
  );
  RETURN QUERY SELECT settlement_receipt.id,settlement_receipt.status,
                      settlement_receipt.response_body,
                      settlement_receipt.completed_at,invoice_row.id,
                      issued_number,expected_status,settlement_amount::NUMERIC(12,2),
                      expected_due;
END;
$function$;
CREATE OR REPLACE FUNCTION public.derive_pharmacy_advance_allocation_time_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.allocated_at:=DATE_TRUNC('milliseconds',transaction_timestamp());
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.derive_pharmacy_advance_consumption_time_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.consumed_at:=DATE_TRUNC('milliseconds',transaction_timestamp());
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.derive_pharmacy_advance_reversal_time_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.reversed_at:=DATE_TRUNC('milliseconds',transaction_timestamp());
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.derive_pharmacy_advance_settlement_time_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.pharmacy_advance_allocation_id IS NOT NULL THEN
    NEW.settled_at:=DATE_TRUNC('milliseconds',transaction_timestamp());
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.derive_pharmacy_order_command_receipt_time_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.action='dispense_substitution' THEN
    NEW.created_at:=DATE_TRUNC('milliseconds',transaction_timestamp());
    NEW.authority_transaction_id:=txid_current();
  ELSE
    NEW.authority_transaction_id:=NULL;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_admission_chronology_lock_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF NEW.tenant_id IS NULL
     OR NOT public.patient_merge_lock_held_753(NEW.tenant_id,TRUE) THEN
    RAISE EXCEPTION 'Admission chronology changes require the tenant exclusive merge lock before the admission row'
      USING ERRCODE='42501',
            CONSTRAINT='chk_admission_chronology_lock_753';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_admission_patient_merge_path_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF NEW.tenant_id IS NULL
     OR current_setting('app.patient_merge_execution',TRUE)
          IS DISTINCT FROM 'on'
     OR current_setting('app.patient_merge_tenant_id',TRUE)
          IS DISTINCT FROM NEW.tenant_id::TEXT
     OR current_setting('app.patient_merge_to_uid',TRUE)
          IS DISTINCT FROM NEW.patient_uid::TEXT
     OR current_setting('app.patient_merge_from_uid',TRUE)
          IS DISTINCT FROM OLD.patient_uid::TEXT
     OR NOT public.patient_merge_lock_held_753(NEW.tenant_id,TRUE) THEN
    RAISE EXCEPTION 'Admission patient identity may change only inside the exclusive governed merge path'
      USING ERRCODE='42501',
            CONSTRAINT='chk_admission_patient_merge_path_753';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_billing_advance_ipd_source_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  deposit advance_deposits%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.ipd_advance_deposit_id IS NOT NULL THEN
      RAISE EXCEPTION 'An IPD-backed billing advance source is immutable'
        USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP='UPDATE' THEN
    IF OLD.ipd_advance_deposit_id IS NULL
       AND NEW.ipd_advance_deposit_id IS NOT NULL THEN
      RAISE EXCEPTION 'A billing advance cannot acquire IPD source identity later'
        USING ERRCODE='23514';
    END IF;
    IF OLD.ipd_advance_deposit_id IS NOT NULL AND (
         NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
         OR NEW.ipd_advance_deposit_id IS DISTINCT FROM
            OLD.ipd_advance_deposit_id
         OR NEW.ipd_advance_deposit_payment_method IS DISTINCT FROM
            OLD.ipd_advance_deposit_payment_method
         OR NEW.ipd_advance_deposit_collected_at IS DISTINCT FROM
            OLD.ipd_advance_deposit_collected_at
         OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
         OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
         OR NEW.amount IS DISTINCT FROM OLD.amount
         OR NEW.mode IS DISTINCT FROM OLD.mode
         OR NEW.reference IS DISTINCT FROM OLD.reference
         OR NEW.collected_by IS DISTINCT FROM OLD.collected_by
         OR NEW.collected_at IS DISTINCT FROM OLD.collected_at
       ) THEN
      RAISE EXCEPTION 'An IPD-backed billing advance source is immutable'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.ipd_advance_deposit_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1
    FROM admissions admission
   WHERE admission.tenant_id=NEW.tenant_id
     AND admission.id=NEW.admission_id
     AND admission.patient_uid=NEW.patient_uid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IPD billing advance source lacks exact admission patient authority'
      USING ERRCODE='23514';
  END IF;
  SELECT source.*
    INTO deposit
    FROM advance_deposits source
   WHERE source.tenant_id=NEW.tenant_id
     AND source.id=NEW.ipd_advance_deposit_id
   FOR UPDATE;
  IF NOT FOUND
     OR deposit.is_refund IS DISTINCT FROM FALSE
     OR deposit.parent_deposit_id IS NOT NULL
     OR deposit.amount<=0
     OR LOWER(BTRIM(deposit.payment_method)) NOT IN (
       'cash','card','upi','cheque','online','bank_transfer'
     )
     OR NEW.ipd_advance_deposit_payment_method IS DISTINCT FROM
        deposit.payment_method
     OR UPPER(BTRIM(NEW.mode)) IS DISTINCT FROM
        UPPER(BTRIM(deposit.payment_method))
     OR NEW.collected_at IS DISTINCT FROM deposit.collected_at
     OR NEW.reference IS DISTINCT FROM 'IPD/' || deposit.receipt_number
     OR (
       LOWER(BTRIM(deposit.payment_method)) IN (
         'card','upi','cheque','online','bank_transfer'
       )
       AND NULLIF(BTRIM(deposit.payment_reference),'') IS NULL
     ) THEN
    RAISE EXCEPTION 'Billing advance lacks an exact eligible IPD deposit source'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_billing_advance_settlement_lineage_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  PERFORM public.assert_billing_advance_settlement_lineage_753(
    NEW.tenant_id,NEW.advance_id,NEW.invoice_id
  );
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_insurance_preauth_authority_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  parent_admission_id INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
    OR NEW.request_type IS DISTINCT FROM OLD.request_type
    OR NEW.parent_preauth_id IS DISTINCT FROM OLD.parent_preauth_id
    OR NEW.expected_cost IS DISTINCT FROM OLD.expected_cost
    OR NEW.cost_breakdown IS DISTINCT FROM OLD.cost_breakdown
  ) THEN
    RAISE EXCEPTION 'insurance pre-auth authority identity and requested amount are immutable'
      USING ERRCODE='55000';
  END IF;
  IF NEW.parent_preauth_id IS NOT NULL THEN
    SELECT admission_id INTO parent_admission_id
      FROM insurance_preauth
     WHERE tenant_id=NEW.tenant_id
       AND id=NEW.parent_preauth_id
       AND patient_uid=NEW.patient_uid
       AND policy_id=NEW.policy_id;
    IF NOT FOUND OR parent_admission_id IS DISTINCT FROM NEW.admission_id THEN
      RAISE EXCEPTION 'parent pre-auth is not bound to the exact patient policy and admission'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_invoice_patient_merge_path_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF NEW.tenant_id IS NULL
     OR current_setting('app.patient_merge_execution',TRUE)
          IS DISTINCT FROM 'on'
     OR current_setting('app.patient_merge_tenant_id',TRUE)
          IS DISTINCT FROM NEW.tenant_id::TEXT
     OR current_setting('app.patient_merge_from_uid',TRUE)
          IS DISTINCT FROM OLD.patient_uid::TEXT
     OR current_setting('app.patient_merge_to_uid',TRUE)
          IS DISTINCT FROM NEW.patient_uid::TEXT
     OR NOT public.patient_merge_lock_held_753(NEW.tenant_id,TRUE) THEN
    RAISE EXCEPTION 'Invoice patient identity may change only inside the exclusive governed merge path'
      USING ERRCODE='42501',
            CONSTRAINT='chk_billing_invoice_patient_merge_path_753';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_nhcx_projection_command_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'NHCX projection command receipts cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM nhcx_messages message
        JOIN tasks task
          ON task.tenant_id=message.tenant_id
         AND task.id=NEW.task_id
         AND task.related_resource_type='nhcx_gateway_projection'
         AND task.related_resource_id=message.id::text
         AND task.assigned_to_role='INSURANCE_COORDINATOR'
         AND task.status IN ('open','in_progress','blocked','overdue')
         AND task.metadata->>'transport_response_sha256'=btrim(message.transport_response_sha256)
        JOIN users actor
          ON actor.tenant_id=message.tenant_id
         AND actor.uid=NEW.actor_uid
         AND actor.is_active=TRUE
         AND actor.status='active'
         AND actor.is_deleted=FALSE
         AND actor.merged_into_uid IS NULL
         AND UPPER(actor.role)=NEW.actor_role
       WHERE message.tenant_id=NEW.tenant_id
         AND message.id=NEW.nhcx_message_id
         AND message.status='accepted'
         AND message.transport_accepted_at IS NOT NULL
         AND message.projection_status='reconciliation_required'
         AND message.projection_task_id=NEW.task_id
         AND message.transport_response_sha256=NEW.transport_response_sha256
    ) THEN
      RAISE EXCEPTION 'NHCX projection command is not bound to the exact accepted receipt and task'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.nhcx_message_id IS DISTINCT FROM OLD.nhcx_message_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.actor_uid IS DISTINCT FROM OLD.actor_uid
     OR NEW.actor_role IS DISTINCT FROM OLD.actor_role
     OR NEW.command_key_sha256 IS DISTINCT FROM OLD.command_key_sha256
     OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
     OR NEW.transport_response_sha256 IS DISTINCT FROM OLD.transport_response_sha256
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.status='COMPLETE'
     OR NOT (OLD.status='IN_PROGRESS' AND NEW.status='COMPLETE') THEN
    RAISE EXCEPTION 'NHCX projection command identity and completed response are immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_nhcx_projection_task_binding_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.projection_status='reconciliation_required' AND NOT EXISTS (
    SELECT 1 FROM tasks task
     WHERE task.tenant_id=NEW.tenant_id
       AND task.id=NEW.projection_task_id
       AND task.related_resource_type='nhcx_gateway_projection'
       AND task.related_resource_id=NEW.id::text
       AND task.assigned_to_role='INSURANCE_COORDINATOR'
       AND task.status IN ('open','in_progress','blocked','overdue')
       AND task.metadata->>'transport_response_sha256'=btrim(NEW.transport_response_sha256)
  ) THEN
    RAISE EXCEPTION 'NHCX reconciliation must bind the exact active insurance projection task'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_allocation_authority_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  approval_receipt    pharmacy_funding_commands%ROWTYPE;
  discovered_patient_uid UUID;
  terminal_patient_uid UUID;
  order_patient_id    INTEGER;
  order_patient_uid   UUID;
  order_terminal_uid  UUID;
  order_admission_id  INTEGER;
  order_authority_version INTEGER;
  invoice_patient_uid UUID;
  invoice_terminal_uid UUID;
  invoice_admission_id INTEGER;
  admission_patient_uid UUID;
  admission_terminal_uid UUID;
  invoice_status      VARCHAR(20);
  item_source_type    VARCHAR(40);
  item_source_id      BIGINT;
  item_source_active  BOOLEAN;
  item_authority_version INTEGER;
  item_authority_sha256 CHAR(64);
  advance_row         billing_advances%ROWTYPE;
  prior_allocation    pharmacy_advance_allocations%ROWTYPE;
  completed_consumption_id BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || NEW.tenant_id::text,
    0
  ));
  SELECT receipt.patient_uid
    INTO discovered_patient_uid
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.funding_approval_receipt_id
     AND receipt.command_type='SUBSTITUTION_FUNDING_APPROVAL';
  IF discovered_patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance allocation lacks its approval patient lineage'
      USING ERRCODE='23514';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    NEW.tenant_id,discovered_patient_uid
  );
  PERFORM public.resolve_billing_patient_family_753(
    NEW.tenant_id,terminal_patient_uid
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || NEW.tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || NEW.tenant_id::text || ':'
      || NEW.pharmacy_order_id::text,
    753
  ));
  SELECT receipt.*
    INTO approval_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.funding_approval_receipt_id
   FOR UPDATE;

  IF NOT FOUND
     OR approval_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
     OR approval_receipt.status<>'IN_PROGRESS'
     OR approval_receipt.task_id<>NEW.funding_task_id
     OR approval_receipt.pharmacy_order_id<>NEW.pharmacy_order_id
     OR approval_receipt.invoice_item_id<>NEW.invoice_item_id
     OR approval_receipt.patient_uid IS DISTINCT FROM discovered_patient_uid
     OR NEW.allocated_by<>approval_receipt.created_by THEN
    RAISE EXCEPTION 'Pharmacy advance allocation lacks its exact approval receipt'
      USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || NEW.tenant_id::text || ':'
      || NEW.funding_approval_receipt_id::text,
    0
  ));

  SELECT pharmacy_order.patient_id,pharmacy_order.funding_admission_id,
         pharmacy_order.inventory_authority_version
    INTO order_patient_id,order_admission_id,order_authority_version
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=NEW.tenant_id
     AND pharmacy_order.id=NEW.pharmacy_order_id
   FOR UPDATE;
  SELECT patient.uid
    INTO order_patient_uid
    FROM users patient
   WHERE patient.tenant_id=NEW.tenant_id
     AND patient.id=order_patient_id
     AND patient.role='PATIENT'
   FOR UPDATE;
  IF order_patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance allocation order lacks patient lineage'
      USING ERRCODE='23514';
  END IF;
  order_terminal_uid:=public.resolve_billing_patient_terminal_753(
    NEW.tenant_id,order_patient_uid
  );
  PERFORM 1
    FROM users patient
   WHERE patient.tenant_id=NEW.tenant_id
     AND patient.uid=order_terminal_uid
     AND patient.role='PATIENT'
     AND patient.is_active=TRUE
     AND patient.status='active'
     AND COALESCE(patient.is_deleted,FALSE)=FALSE
     AND patient.merged_into_uid IS NULL
   FOR UPDATE;
  IF NOT FOUND
     OR order_terminal_uid IS DISTINCT FROM terminal_patient_uid
     OR order_authority_version IS DISTINCT FROM NEW.source_authority_version THEN
    RAISE EXCEPTION 'Pharmacy advance allocation order authority generation is stale'
      USING ERRCODE='23514';
  END IF;

  SELECT invoice.patient_uid,invoice.admission_id,invoice.status
    INTO invoice_patient_uid,invoice_admission_id,invoice_status
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=NEW.tenant_id
     AND invoice.id=NEW.invoice_id
   FOR UPDATE;
  SELECT item.source_ref_type,item.source_ref_id,item.source_ref_active,
         item.source_authority_version,item.source_authority_sha256
    INTO item_source_type,item_source_id,item_source_active,
         item_authority_version,item_authority_sha256
    FROM billing_invoice_items item
   WHERE item.tenant_id=NEW.tenant_id
     AND item.invoice_id=NEW.invoice_id
     AND item.id=NEW.invoice_item_id
   FOR UPDATE;
  IF invoice_patient_uid IS NOT NULL THEN
    invoice_terminal_uid:=public.resolve_billing_patient_terminal_753(
      NEW.tenant_id,invoice_patient_uid
    );
  END IF;
  IF invoice_patient_uid IS NULL
     OR invoice_terminal_uid IS DISTINCT FROM order_terminal_uid
     OR invoice_status<>'DRAFT'
     OR item_source_type IS DISTINCT FROM 'pharmacy_order'
     OR item_source_id IS DISTINCT FROM NEW.pharmacy_order_id::BIGINT
     OR item_source_active IS DISTINCT FROM TRUE
     OR item_authority_version IS DISTINCT FROM NEW.source_authority_version
     OR item_authority_sha256 IS DISTINCT FROM NEW.source_authority_sha256
     OR order_admission_id IS DISTINCT FROM invoice_admission_id THEN
    RAISE EXCEPTION 'Pharmacy advance allocation invoice/item authority is not exact'
      USING ERRCODE='23514';
  END IF;

  IF invoice_admission_id IS NOT NULL THEN
    SELECT admission.patient_uid
      INTO admission_patient_uid
      FROM admissions admission
     WHERE admission.tenant_id=NEW.tenant_id
       AND admission.id=invoice_admission_id
     FOR UPDATE;
    IF NOT FOUND
       THEN
      RAISE EXCEPTION 'Pharmacy advance allocation admission does not belong to the invoice patient'
        USING ERRCODE='23514';
    END IF;
    admission_terminal_uid:=public.resolve_billing_patient_terminal_753(
      NEW.tenant_id,admission_patient_uid
    );
    IF admission_terminal_uid IS DISTINCT FROM order_terminal_uid THEN
      RAISE EXCEPTION 'Pharmacy advance allocation admission does not belong to the invoice patient'
        USING ERRCODE='23514';
    END IF;
  END IF;

  PERFORM public.assert_pharmacy_advance_patient_scope_753(
    NEW.tenant_id,NEW.billing_advance_id,order_terminal_uid,
    invoice_admission_id
  );
  SELECT advance.*
    INTO advance_row
    FROM billing_advances advance
   WHERE advance.tenant_id=NEW.tenant_id
     AND advance.id=NEW.billing_advance_id
   FOR UPDATE;
  IF NOT FOUND
     OR advance_row.status<>'ACTIVE'
     OR UPPER(BTRIM(advance_row.mode)) NOT IN (
       'CASH','CARD','UPI','NETBANKING','CHEQUE','DD','WALLET',
       'ONLINE','BANK_TRANSFER'
     )
     OR advance_row.amount<=0 THEN
    RAISE EXCEPTION 'Pharmacy advance allocation requires an exact active patient-funded advance'
      USING ERRCODE='23514';
  END IF;
  SELECT allocation.*
    INTO prior_allocation
    FROM pharmacy_advance_allocations allocation
   WHERE allocation.tenant_id=NEW.tenant_id
     AND allocation.funding_approval_receipt_id=
         NEW.funding_approval_receipt_id
   ORDER BY allocation.billing_advance_id,allocation.id
   LIMIT 1
   FOR UPDATE;
  IF FOUND AND (
       prior_allocation.pharmacy_order_id<>NEW.pharmacy_order_id
       OR prior_allocation.invoice_id<>NEW.invoice_id
       OR prior_allocation.invoice_item_id<>NEW.invoice_item_id
       OR prior_allocation.funding_task_id<>NEW.funding_task_id
       OR prior_allocation.source_authority_version<>
          NEW.source_authority_version
       OR prior_allocation.source_authority_sha256<>
          NEW.source_authority_sha256
     ) THEN
    RAISE EXCEPTION
      'One approval receipt cannot span pharmacy authority generations'
      USING ERRCODE='23514';
  END IF;
  SELECT receipt.id
    INTO completed_consumption_id
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
     AND receipt.approval_receipt_id=NEW.funding_approval_receipt_id
     AND receipt.status='COMPLETE'
   FOR KEY SHARE;
  IF FOUND THEN
    RAISE EXCEPTION 'Completed substitution funding consumption forbids a later advance allocation'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_approval_amount_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  target_tenant_id UUID;
  target_receipt_id BIGINT;
  receipt pharmacy_funding_commands%ROWTYPE;
  reservation_required NUMERIC;
  patient_required NUMERIC;
  tpa_used NUMERIC;
  base_authoritative_amount NUMERIC;
  authoritative_amount NUMERIC;
  response_invoice_id NUMERIC;
  response_invoice_item_id NUMERIC;
  response_order_id NUMERIC;
  base_order_version NUMERIC;
  base_order_sha256 TEXT;
  prospective_order_version NUMERIC;
  prospective_order_sha256 TEXT;
  proposer_role TEXT;
  proposer_facility_id NUMERIC;
  proposer_grant_id NUMERIC;
  invoice_patient_uid UUID;
  invoice_terminal_uid UUID;
  invoice_admission_id INTEGER;
  admission_patient_uid UUID;
  admission_terminal_uid UUID;
  admission_started_at TIMESTAMPTZ;
  order_patient_id INTEGER;
  order_patient_uid UUID;
  order_lineage_uid UUID;
  order_facility_id INTEGER;
  order_admission_id INTEGER;
  base_order_total NUMERIC(10,2);
  order_row JSONB;
  invoice_row JSONB;
  item_row JSONB;
  actual_base_billing JSONB;
  expected_prospective_billing JSONB;
  prospective_invoice_subtotal NUMERIC(12,2);
  prospective_invoice_total NUMERIC(12,2);
  prospective_invoice_due NUMERIC(12,2);
  allocation_total NUMERIC(14,2);
  invalid_allocations INTEGER;
  reversal_count BIGINT;
  expected_reservations JSONB;
  expected_source_plan JSONB;
  actual_source_plan JSONB;
  expected_patient_family JSONB;
  terminal_patient_uid UUID;
  patient_uid_family UUID[];
  locked_authority JSONB;
  selector JSONB;
  public_reservation_plan JSONB;
  source_plan_count BIGINT;
  source_plan_distinct_count BIGINT;
  allocation_to_check RECORD;
BEGIN
  IF TG_TABLE_NAME='pharmacy_funding_commands' THEN
    IF NEW.command_type<>'SUBSTITUTION_FUNDING_APPROVAL' THEN
      RETURN NULL;
    END IF;
    target_tenant_id:=NEW.tenant_id;
    target_receipt_id:=NEW.id;
  ELSE
    target_tenant_id:=NEW.tenant_id;
    target_receipt_id:=NEW.funding_approval_receipt_id;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));

  SELECT command.*
    INTO receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance allocation lacks its approval header'
      USING ERRCODE='23503',
            CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,receipt.patient_uid
  );
  patient_uid_family:=public.resolve_billing_patient_family_753(
    target_tenant_id,terminal_patient_uid
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || target_tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || target_tenant_id::text || ':'
      || receipt.pharmacy_order_id::text,
    753
  ));
  SELECT command.*
    INTO receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_receipt_id
     AND command.patient_uid=ANY(patient_uid_family)
     AND command.pharmacy_order_id=receipt.pharmacy_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance approval changed before canonical lock'
      USING ERRCODE='40001';
  END IF;
  IF receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
     OR receipt.status<>'COMPLETE' THEN
    RETURN NULL;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || target_tenant_id::text || ':'
      || target_receipt_id::text,
    0
  ));

  selector:=receipt.reservation_authority->'selector';
  PERFORM public.lock_pharmacy_substitution_sources_753(
    target_tenant_id,terminal_patient_uid,receipt.pharmacy_order_id,
    receipt.invoice_id,receipt.invoice_item_id,selector
  );
  locked_authority:=public.build_pharmacy_substitution_authority_753(
    target_tenant_id,terminal_patient_uid,patient_uid_family,
    receipt.pharmacy_order_id,receipt.invoice_id,receipt.invoice_item_id,
    selector,
    NULLIF(receipt.reservation_authority #>>
      '{base,facility_grant_id}','')::BIGINT
  );
  IF receipt.reservation_authority IS DISTINCT FROM locked_authority
     OR receipt.reservation_authority_sha256 IS DISTINCT FROM encode(
       public.digest(locked_authority::TEXT,'sha256'),'hex'
     )
     OR receipt.response_body->'base' IS DISTINCT FROM locked_authority->'base'
     OR receipt.response_body->'prospective' IS DISTINCT FROM
        locked_authority->'prospective'
     OR receipt.response_body->'billing' IS DISTINCT FROM
        locked_authority->'billing' THEN
    RAISE EXCEPTION 'Pharmacy advance approval differs from DB-authored clinical and billing authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_substitution_reservation_receipt_753';
  END IF;
  public_reservation_plan:=
    public.pharmacy_advance_reservation_public_plan_753(
      receipt.reservation_plan
    );

  IF jsonb_typeof(receipt.response_body) IS DISTINCT FROM 'object'
     OR jsonb_typeof(receipt.response_body #>
          '{funding,reservation_required_amount}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body #>
          '{funding,patient_payment_required_amount}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body #>
          '{funding,tpa_used_amount}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body #>
          '{prospective,authoritative_amount}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body #>
          '{base,authoritative_amount}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body->'invoice_id')
          IS DISTINCT FROM 'number'
     OR jsonb_typeof(receipt.response_body->'invoice_item_id')
          IS DISTINCT FROM 'number'
     OR jsonb_typeof(receipt.response_body #>
          '{base,pharmacy_order_id}') IS DISTINCT FROM 'number'
     OR jsonb_typeof(receipt.response_body #>
          '{base,order_version}') IS DISTINCT FROM 'number'
      OR jsonb_typeof(receipt.response_body #>
           '{base,order_items_sha256}') IS DISTINCT FROM 'string'
      OR jsonb_typeof(receipt.response_body #>
           '{base,items_list}') IS DISTINCT FROM 'array'
      OR jsonb_typeof(receipt.response_body #>
           '{prospective,order_version}') IS DISTINCT FROM 'number'
      OR jsonb_typeof(receipt.response_body #>
           '{prospective,order_items_sha256}') IS DISTINCT FROM 'string'
      OR jsonb_typeof(receipt.response_body #>
           '{prospective,items_list}') IS DISTINCT FROM 'array'
      OR jsonb_typeof(receipt.response_body->'billing') IS DISTINCT FROM 'object'
      OR receipt.response_body #>> '{billing,contract}'<>
           'pharmacy_substitution_funding_billing_v1'
      OR receipt.response_body->'funding' IS DISTINCT FROM
           public_reservation_plan->'funding'
     OR jsonb_typeof(receipt.response_body->'advance_reservations')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(receipt.response_body #>
          '{advance_reservations,required_amount}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body #>
          '{advance_reservations,reservation_count}') IS DISTINCT FROM 'number'
     OR jsonb_typeof(receipt.response_body #>
          '{advance_reservations,source_evidence_sha256}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body #>
          '{advance_reservations,source_plan_sha256}') IS DISTINCT FROM 'string'
      OR receipt.response_body #>>
           '{advance_reservations,source_evidence_sha256}' IS DISTINCT FROM
           receipt.response_body #>> '{funding,source_evidence_sha256}'
      OR receipt.response_body #>>
           '{advance_reservations,source_plan_sha256}' IS DISTINCT FROM
           receipt.response_body #>> '{funding,source_plan_sha256}'
      OR receipt.response_body #>> '{funding,source_evidence_sha256}'
           !~ '^[0-9a-f]{64}$'
      OR receipt.response_body #>> '{funding,source_plan_sha256}'
           !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Pharmacy advance approval header is missing exact typed funding authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
  END IF;

  IF jsonb_typeof(receipt.response_body->'proposer') IS DISTINCT FROM 'object'
     OR jsonb_typeof(receipt.response_body #> '{proposer,uid}')
          IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body #> '{proposer,role}')
          IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body #> '{proposer,facility_grant_id}')
          IS DISTINCT FROM 'string'
     OR jsonb_typeof(receipt.response_body #> '{base,facility_id}')
          IS DISTINCT FROM 'number'
     OR receipt.response_body #>> '{proposer,uid}' IS DISTINCT FROM
          receipt.proposer_uid::text
     OR receipt.response_body->>'approval_id' IS DISTINCT FROM
          receipt.governance_approval_id::text
     OR receipt.response_body->>'proposal_sha256' IS DISTINCT FROM
          receipt.proposal_sha256
     OR receipt.response_body->>'approver_uid' IS DISTINCT FROM
          receipt.created_by::text
     OR receipt.created_by=receipt.proposer_uid THEN
    RAISE EXCEPTION 'Pharmacy advance approval header lacks exact proposer/approver separation'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_actor_753';
  END IF;

  IF (receipt.response_body #>>
        '{funding,reservation_required_amount}')
        !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$'
     OR (receipt.response_body #>>
        '{funding,patient_payment_required_amount}')
        !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$'
     OR (receipt.response_body #>>'{funding,tpa_used_amount}')
        !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$'
     OR (receipt.response_body #>>'{prospective,authoritative_amount}')
        !~ '^(0|[1-9][0-9]{0,7})\.[0-9]{2}$'
     OR (receipt.response_body #>>'{base,authoritative_amount}')
        !~ '^(0|[1-9][0-9]{0,7})\.[0-9]{2}$' THEN
    RAISE EXCEPTION 'Pharmacy advance approval header money is not canonical fixed-scale evidence'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
  END IF;

  BEGIN
    reservation_required:=(receipt.response_body #>>
      '{funding,reservation_required_amount}')::NUMERIC;
    patient_required:=(receipt.response_body #>>
      '{funding,patient_payment_required_amount}')::NUMERIC;
    tpa_used:=(receipt.response_body #>>
      '{funding,tpa_used_amount}')::NUMERIC;
    base_authoritative_amount:=(receipt.response_body #>>
      '{base,authoritative_amount}')::NUMERIC;
    authoritative_amount:=(receipt.response_body #>>
      '{prospective,authoritative_amount}')::NUMERIC;
    response_invoice_id:=(receipt.response_body->>'invoice_id')::NUMERIC;
    response_invoice_item_id:=(receipt.response_body->>'invoice_item_id')::NUMERIC;
    response_order_id:=(receipt.response_body #>>
      '{base,pharmacy_order_id}')::NUMERIC;
    base_order_version:=(receipt.response_body #>>
      '{base,order_version}')::NUMERIC;
    base_order_sha256:=receipt.response_body #>>
      '{base,order_items_sha256}';
    prospective_order_version:=(receipt.response_body #>>
      '{prospective,order_version}')::NUMERIC;
    prospective_order_sha256:=receipt.response_body #>>
      '{prospective,order_items_sha256}';
    proposer_role:=UPPER(receipt.response_body #>> '{proposer,role}');
    proposer_facility_id:=(receipt.response_body #>>
      '{base,facility_id}')::NUMERIC;
    proposer_grant_id:=(receipt.response_body #>>
      '{proposer,facility_grant_id}')::NUMERIC;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pharmacy advance approval header has invalid numeric authority'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
  END;

  IF reservation_required<0
     OR reservation_required<>ROUND(reservation_required,2)
     OR reservation_required>=10000000000
     OR patient_required IS DISTINCT FROM reservation_required
     OR receipt.approved_patient_amount IS DISTINCT FROM reservation_required
     OR tpa_used<0
     OR tpa_used<>ROUND(tpa_used,2)
     OR tpa_used>=10000000000
     OR base_authoritative_amount<0
     OR base_authoritative_amount<>ROUND(base_authoritative_amount,2)
     OR base_authoritative_amount>=100000000
     OR authoritative_amount<0
     OR authoritative_amount<>ROUND(authoritative_amount,2)
     OR authoritative_amount>=100000000
     OR authoritative_amount-tpa_used IS DISTINCT FROM reservation_required
     OR response_invoice_id<=0
     OR response_invoice_id<>TRUNC(response_invoice_id)
     OR response_invoice_id>2147483647
      OR response_invoice_item_id IS DISTINCT FROM receipt.invoice_item_id::NUMERIC
      OR response_invoice_id IS DISTINCT FROM receipt.invoice_id::NUMERIC
      OR response_order_id IS DISTINCT FROM receipt.pharmacy_order_id::NUMERIC
      OR proposer_facility_id IS DISTINCT FROM receipt.facility_id::NUMERIC
     OR base_order_version<=0
     OR base_order_version<>TRUNC(base_order_version)
     OR base_order_version>2147483647
     OR base_order_sha256 !~ '^[0-9a-f]{64}$'
     OR prospective_order_version<=0
     OR prospective_order_version<>TRUNC(prospective_order_version)
     OR prospective_order_version>2147483647
     OR prospective_order_version<>base_order_version+1
     OR prospective_order_sha256 !~ '^[0-9a-f]{64}$'
     OR proposer_role NOT IN ('PHARMACY_STAFF','PHARMACY_INCHARGE')
     OR proposer_facility_id<=0
     OR proposer_facility_id<>TRUNC(proposer_facility_id)
     OR proposer_facility_id>2147483647
     OR proposer_grant_id<=0
     OR proposer_grant_id<>TRUNC(proposer_grant_id)
     OR proposer_grant_id>9223372036854775807 THEN
    RAISE EXCEPTION 'Pharmacy advance approval header is not arithmetically or structurally exact'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
  END IF;

  PERFORM 1
    FROM users proposer
   WHERE proposer.tenant_id=target_tenant_id
     AND proposer.uid=receipt.proposer_uid
     AND proposer.role=proposer_role
     AND proposer.is_active=TRUE
     AND proposer.status='active'
     AND COALESCE(proposer.is_deleted,FALSE)=FALSE
     AND proposer.merged_into_uid IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance approval proposer lacks current role/staff/facility authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_actor_753';
  END IF;
  PERFORM 1
    FROM staff staff_identity
   WHERE staff_identity.tenant_id=target_tenant_id
     AND staff_identity.user_id=receipt.proposer_uid
     AND staff_identity.is_active=TRUE
     AND staff_identity.archived=FALSE
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance approval proposer lacks current staff authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_actor_753';
  END IF;
  PERFORM 1
    FROM pharmacy_staff_facility_grants facility_grant
   WHERE facility_grant.tenant_id=target_tenant_id
     AND facility_grant.id=proposer_grant_id::BIGINT
     AND facility_grant.staff_uid=receipt.proposer_uid
     AND facility_grant.facility_id=proposer_facility_id::INTEGER
     AND facility_grant.status='active'
     AND facility_grant.revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance approval proposer lacks current facility authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_actor_753';
  END IF;

  SELECT pharmacy_order.patient_id,pharmacy_order.uid,
         pharmacy_order.funding_admission_id,
         pharmacy_order.total_amount,to_jsonb(pharmacy_order)
    INTO order_patient_id,order_lineage_uid,order_admission_id,
         base_order_total,order_row
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=receipt.pharmacy_order_id
     AND pharmacy_order.inventory_authority_version=base_order_version::INTEGER
   FOR UPDATE;
  SELECT patient.uid
    INTO order_patient_uid
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.id=order_patient_id
     AND patient.role='PATIENT'
   FOR UPDATE;
  IF order_patient_uid IS NULL
     OR public.resolve_billing_patient_terminal_753(
          target_tenant_id,order_patient_uid
        ) IS DISTINCT FROM terminal_patient_uid
     OR (order_lineage_uid IS NOT NULL AND (
       public.resolve_billing_patient_terminal_753(
         target_tenant_id,order_lineage_uid
       ) IS DISTINCT FROM terminal_patient_uid
       OR NOT order_lineage_uid=ANY(patient_uid_family)
     ))
     OR base_order_total IS DISTINCT FROM base_authoritative_amount
     OR (order_row->>'facility_id')::INTEGER IS DISTINCT FROM receipt.facility_id
     OR order_row->'items_list' IS DISTINCT FROM
        receipt.response_body #> '{base,items_list}'
     OR order_row->>'clinical_verification_items_sha256' IS DISTINCT FROM
        base_order_sha256
     OR receipt.response_body #> '{base,items_list}' IS DISTINCT FROM
        (
          SELECT approval.metadata #> '{authority,base,items_list}'
            FROM approvals approval
           WHERE approval.tenant_id=target_tenant_id
             AND approval.id=receipt.governance_approval_id
        )
     OR receipt.response_body #> '{prospective,items_list}' IS DISTINCT FROM
        (
          SELECT approval.metadata #> '{authority,prospective,items_list}'
            FROM approvals approval
           WHERE approval.tenant_id=target_tenant_id
             AND approval.id=receipt.governance_approval_id
        ) THEN
    RAISE EXCEPTION 'Pharmacy advance approval header lacks its canonical patient order'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
  END IF;
  PERFORM 1
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.uid=terminal_patient_uid
     AND patient.role='PATIENT'
     AND patient.is_active=TRUE
     AND patient.status='active'
     AND COALESCE(patient.is_deleted,FALSE)=FALSE
     AND patient.merged_into_uid IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance approval terminal patient is unavailable'
      USING ERRCODE='23514';
  END IF;

  expected_patient_family:=to_jsonb(
    public.resolve_billing_patient_family_753(
      target_tenant_id,terminal_patient_uid
    )
  );
  IF receipt.reservation_plan #>>
       '{funding,source_evidence,funding_patient_uid}' IS DISTINCT FROM
       terminal_patient_uid::text
     OR receipt.reservation_plan #>
       '{funding,source_evidence,patient_uid_family}' IS DISTINCT FROM
       expected_patient_family THEN
    RAISE EXCEPTION 'Pharmacy advance approval source plan has stale patient merge-family evidence'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_source_plan_753';
  END IF;

  SELECT invoice.patient_uid,invoice.admission_id,to_jsonb(invoice)
    INTO invoice_patient_uid,invoice_admission_id,invoice_row
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=response_invoice_id::INTEGER
     AND invoice.status='DRAFT'
   FOR UPDATE;
  SELECT to_jsonb(item)
    INTO item_row
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=response_invoice_id::INTEGER
     AND item.id=receipt.invoice_item_id
     AND item.source_ref_type='pharmacy_order'
     AND item.source_ref_id=receipt.pharmacy_order_id::BIGINT
     AND item.source_ref_active=TRUE
     AND item.source_authority_version=base_order_version::INTEGER
     AND item.source_authority_sha256=base_order_sha256
   FOR UPDATE;
  IF invoice_patient_uid IS NOT NULL THEN
    invoice_terminal_uid:=public.resolve_billing_patient_terminal_753(
      target_tenant_id,invoice_patient_uid
    );
  END IF;
  IF invoice_patient_uid IS NULL
     OR invoice_terminal_uid IS DISTINCT FROM terminal_patient_uid
     OR order_admission_id IS DISTINCT FROM invoice_admission_id
     OR invoice_row->'invoice_number'<>'null'::JSONB
     OR invoice_row->'issued_at'<>'null'::JSONB
     OR invoice_row->'voided_at'<>'null'::JSONB
     OR (invoice_row->>'amount_paid')::NUMERIC<>0
     OR (invoice_row->>'credit_note_amount')::NUMERIC<>0
     OR (invoice_row->>'amount_due')::NUMERIC IS DISTINCT FROM
        (invoice_row->>'total_amount')::NUMERIC
     OR (item_row->>'quantity')::NUMERIC<>1
     OR (item_row->>'unit_price')::NUMERIC IS DISTINCT FROM base_authoritative_amount
     OR (item_row->>'gst_rate')::NUMERIC<>0
     OR (item_row->>'line_subtotal')::NUMERIC IS DISTINCT FROM base_authoritative_amount
     OR (item_row->>'cgst_amount')::NUMERIC<>0
     OR (item_row->>'sgst_amount')::NUMERIC<>0
     OR (item_row->>'igst_amount')::NUMERIC<>0
     OR (item_row->>'line_total')::NUMERIC IS DISTINCT FROM base_authoritative_amount
     OR EXISTS (
       SELECT 1 FROM billing_payments payment
        WHERE payment.tenant_id=target_tenant_id
          AND payment.invoice_id=response_invoice_id::INTEGER
     )
     OR EXISTS (
       SELECT 1 FROM billing_refunds refund
        WHERE refund.tenant_id=target_tenant_id
          AND refund.invoice_id=response_invoice_id::INTEGER
     )
     OR EXISTS (
       SELECT 1 FROM billing_advance_settlements settlement
        WHERE settlement.tenant_id=target_tenant_id
          AND settlement.invoice_id=response_invoice_id::INTEGER
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance approval header no longer matches its invoice authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
  END IF;

  actual_base_billing:=jsonb_build_object(
    'invoice',jsonb_build_object(
      'status',invoice_row->>'status',
      'invoice_number',invoice_row->'invoice_number',
      'issued_at',invoice_row->'issued_at',
      'voided_at',invoice_row->'voided_at',
      'subtotal',(invoice_row->>'subtotal')::NUMERIC(12,2)::text,
      'cgst_amount',(invoice_row->>'cgst_amount')::NUMERIC(12,2)::text,
      'sgst_amount',(invoice_row->>'sgst_amount')::NUMERIC(12,2)::text,
      'igst_amount',(invoice_row->>'igst_amount')::NUMERIC(12,2)::text,
      'tax_amount',(
        (invoice_row->>'cgst_amount')::NUMERIC
        +(invoice_row->>'sgst_amount')::NUMERIC
        +(invoice_row->>'igst_amount')::NUMERIC
      )::NUMERIC(12,2)::text,
      'discount_amount',(invoice_row->>'discount_amount')::NUMERIC(12,2)::text,
      'credit_note_amount',(invoice_row->>'credit_note_amount')::NUMERIC(12,2)::text,
      'total_amount',(invoice_row->>'total_amount')::NUMERIC(12,2)::text,
      'amount_paid',(invoice_row->>'amount_paid')::NUMERIC(12,2)::text,
      'amount_due',(invoice_row->>'amount_due')::NUMERIC(12,2)::text
    ),
    'item',jsonb_build_object(
      'quantity',(item_row->>'quantity')::NUMERIC(10,2)::text,
      'unit_price',(item_row->>'unit_price')::NUMERIC(12,2)::text,
      'gst_rate',(item_row->>'gst_rate')::NUMERIC(5,2)::text,
      'line_subtotal',(item_row->>'line_subtotal')::NUMERIC(12,2)::text,
      'cgst_amount',(item_row->>'cgst_amount')::NUMERIC(12,2)::text,
      'sgst_amount',(item_row->>'sgst_amount')::NUMERIC(12,2)::text,
      'igst_amount',(item_row->>'igst_amount')::NUMERIC(12,2)::text,
      'tax_amount',(
        (item_row->>'cgst_amount')::NUMERIC
        +(item_row->>'sgst_amount')::NUMERIC
        +(item_row->>'igst_amount')::NUMERIC
      )::NUMERIC(12,2)::text,
      'line_total',(item_row->>'line_total')::NUMERIC(12,2)::text,
      'source_ref_type',item_row->>'source_ref_type',
      'source_ref_id',item_row->>'source_ref_id',
      'source_ref_active',(item_row->>'source_ref_active')::BOOLEAN,
      'source_authority_version',(item_row->>'source_authority_version')::INTEGER,
      'source_authority_sha256',item_row->>'source_authority_sha256'
    )
  );
  prospective_invoice_subtotal:=(invoice_row->>'subtotal')::NUMERIC
    -(item_row->>'line_subtotal')::NUMERIC+authoritative_amount;
  prospective_invoice_total:=ROUND(
    prospective_invoice_subtotal
      +(invoice_row->>'cgst_amount')::NUMERIC
      +(invoice_row->>'sgst_amount')::NUMERIC
      +(invoice_row->>'igst_amount')::NUMERIC
      -(invoice_row->>'discount_amount')::NUMERIC,
    2
  );
  prospective_invoice_due:=prospective_invoice_total
    -(invoice_row->>'amount_paid')::NUMERIC
    -(invoice_row->>'credit_note_amount')::NUMERIC;
  expected_prospective_billing:=jsonb_build_object(
    'invoice',actual_base_billing->'invoice' || jsonb_build_object(
      'subtotal',prospective_invoice_subtotal::NUMERIC(12,2)::text,
      'total_amount',prospective_invoice_total::NUMERIC(12,2)::text,
      'amount_due',prospective_invoice_due::NUMERIC(12,2)::text
    ),
    'item',actual_base_billing->'item' || jsonb_build_object(
      'unit_price',authoritative_amount::NUMERIC(12,2)::text,
      'line_subtotal',authoritative_amount::NUMERIC(12,2)::text,
      'line_total',authoritative_amount::NUMERIC(12,2)::text,
      'source_authority_version',prospective_order_version::INTEGER,
      'source_authority_sha256',prospective_order_sha256
    )
  );
  IF receipt.response_body->'billing' IS DISTINCT FROM
       receipt.reservation_authority->'billing' THEN
    RAISE EXCEPTION 'Pharmacy advance approval billing evidence is not the exact locked financial tuple'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_billing_753';
  END IF;

  IF invoice_admission_id IS NOT NULL THEN
    SELECT admission.patient_uid,
           COALESCE(admission.admitted_at,admission.created_at)
      INTO admission_patient_uid,admission_started_at
      FROM admissions admission
     WHERE admission.tenant_id=target_tenant_id
       AND admission.id=invoice_admission_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance approval header lacks exact admission authority'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
    END IF;
    admission_terminal_uid:=public.resolve_billing_patient_terminal_753(
      target_tenant_id,admission_patient_uid
    );
    IF admission_terminal_uid IS DISTINCT FROM terminal_patient_uid THEN
      RAISE EXCEPTION 'Pharmacy advance approval header lacks exact admission authority'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
    END IF;
    IF receipt.reservation_plan #>>
         '{funding,source_evidence,funding_admission_id}' IS DISTINCT FROM
         invoice_admission_id::text
       OR receipt.reservation_plan #>>
         '{funding,source_evidence,funding_admission_patient_uid}'
          IS DISTINCT FROM admission_patient_uid::text
       OR receipt.reservation_plan #>>
         '{funding,source_evidence,funding_admission_started_at}'
          IS DISTINCT FROM to_char(
            DATE_TRUNC('milliseconds',admission_started_at)
              AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ) THEN
      RAISE EXCEPTION 'Pharmacy advance approval source plan has stale admission evidence'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_advance_approval_source_plan_753';
    END IF;
  ELSIF receipt.reservation_plan #>
           '{funding,source_evidence,funding_admission_id}'
           IS DISTINCT FROM 'null'::JSONB
     OR receipt.reservation_plan #>
           '{funding,source_evidence,funding_admission_patient_uid}'
           IS DISTINCT FROM 'null'::JSONB
     OR receipt.reservation_plan #>
           '{funding,source_evidence,funding_admission_started_at}'
           IS DISTINCT FROM 'null'::JSONB THEN
    RAISE EXCEPTION 'Outpatient pharmacy advance source plan carries admission evidence'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_source_plan_753';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(receipt.reservation_plan #>
        '{funding,source_evidence,advances}') source_advance
     WHERE jsonb_typeof(source_advance) IS DISTINCT FROM 'object'
        OR jsonb_typeof(source_advance->'billing_advance_id')
             IS DISTINCT FROM 'number'
        OR jsonb_typeof(source_advance->'stored_patient_uid')
             IS DISTINCT FROM 'string'
        OR source_advance->>'stored_patient_uid'
             !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(source_advance->'admission_id')
             NOT IN ('number','null')
        OR jsonb_typeof(source_advance->'collected_at')
             IS DISTINCT FROM 'string'
        OR jsonb_typeof(source_advance->'selected_reservation_amount')
             IS DISTINCT FROM 'string'
        OR source_advance->>'selected_reservation_amount'
             !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$'
  ) THEN
    RAISE EXCEPTION 'Pharmacy advance approval source plan is not canonical typed evidence'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_source_plan_753';
  END IF;
  SELECT COUNT(*),COUNT(DISTINCT (source_advance->>'billing_advance_id')::INTEGER),
         COALESCE(jsonb_agg(jsonb_build_object(
           'billing_advance_id',(source_advance->>'billing_advance_id')::INTEGER,
           'billing_advance_patient_uid',source_advance->>'stored_patient_uid',
           'allocated_amount',source_advance->>'selected_reservation_amount'
         ) ORDER BY (source_advance->>'billing_advance_id')::INTEGER)
           FILTER (WHERE (source_advance->>'selected_reservation_amount')::NUMERIC>0),
           '[]'::JSONB)
    INTO source_plan_count,source_plan_distinct_count,expected_source_plan
    FROM jsonb_array_elements(receipt.reservation_plan #>
      '{funding,source_evidence,advances}') source_advance;
  IF source_plan_count<>source_plan_distinct_count THEN
    RAISE EXCEPTION 'Pharmacy advance approval source plan duplicates an advance identity'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_source_plan_753';
  END IF;

  FOR allocation_to_check IN
    SELECT allocation.billing_advance_id
      FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.funding_approval_receipt_id=target_receipt_id
     ORDER BY allocation.billing_advance_id,allocation.id
  LOOP
    PERFORM public.assert_pharmacy_advance_patient_scope_753(
      target_tenant_id,allocation_to_check.billing_advance_id,
      terminal_patient_uid,invoice_admission_id
    );
  END LOOP;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'billing_advance_id',allocation.billing_advance_id,
           'billing_advance_patient_uid',advance.patient_uid::text,
           'allocated_amount',allocation.allocated_amount::text
         ) ORDER BY allocation.billing_advance_id,allocation.id),'[]'::JSONB)
    INTO actual_source_plan
    FROM pharmacy_advance_allocations allocation
    JOIN billing_advances advance
      ON advance.tenant_id=allocation.tenant_id
     AND advance.id=allocation.billing_advance_id
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.funding_approval_receipt_id=target_receipt_id;
  IF actual_source_plan IS DISTINCT FROM expected_source_plan THEN
    RAISE EXCEPTION 'Relational advance allocations do not match the locked deterministic source plan'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_source_plan_753';
  END IF;

  SELECT COALESCE(SUM(allocation.allocated_amount),0),
         COUNT(*) FILTER (
           WHERE advance.id IS NULL
              OR allocation.funding_task_id IS DISTINCT FROM receipt.task_id
              OR allocation.pharmacy_order_id IS DISTINCT FROM
                 receipt.pharmacy_order_id
              OR allocation.invoice_id IS DISTINCT FROM
                 response_invoice_id::INTEGER
              OR allocation.invoice_item_id IS DISTINCT FROM
                 receipt.invoice_item_id
              OR allocation.source_authority_version IS DISTINCT FROM
                 base_order_version::INTEGER
              OR allocation.source_authority_sha256 IS DISTINCT FROM
                 base_order_sha256
              OR public.resolve_billing_patient_terminal_753(
                   target_tenant_id,advance.patient_uid
                 ) IS DISTINCT FROM terminal_patient_uid
              OR advance.status<>'ACTIVE'
              OR UPPER(BTRIM(advance.mode)) NOT IN (
                'CASH','CARD','UPI','NETBANKING','CHEQUE','DD','WALLET',
                'ONLINE','BANK_TRANSFER'
              )
              OR advance.amount<=0
              OR NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(receipt.reservation_plan #>
                    '{funding,source_evidence,advances}') source_advance
                 WHERE (source_advance->>'billing_advance_id')::INTEGER=
                       allocation.billing_advance_id
                   AND source_advance->>'stored_patient_uid'=
                       advance.patient_uid::text
                   AND (
                     (advance.admission_id IS NULL
                       AND source_advance->'admission_id'='null'::JSONB)
                     OR source_advance->>'admission_id'=
                        advance.admission_id::text
                   )
                   AND advance.collected_at IS NOT NULL
                   AND source_advance->>'collected_at'=to_char(
                     DATE_TRUNC('milliseconds',advance.collected_at)
                       AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   )
                   AND source_advance->>'selected_reservation_amount'=
                       allocation.allocated_amount::text
              )
              OR allocation.allocated_by IS DISTINCT FROM receipt.created_by
              OR allocation.evidence IS DISTINCT FROM jsonb_build_object(
                'contract','pharmacy_advance_allocation_v1',
                'governance_approval_id',receipt.governance_approval_id,
                'approval_receipt_id',receipt.id::text,
                'funding_task_id',receipt.task_id,
                'proposal_sha256',receipt.proposal_sha256,
                'proposer_uid',receipt.proposer_uid::text,
                'approver_uid',receipt.created_by::text,
                'pharmacy_order_id',receipt.pharmacy_order_id,
                'invoice_id',response_invoice_id::INTEGER,
                'invoice_item_id',receipt.invoice_item_id,
                'patient_uid',terminal_patient_uid::text,
                'admission_id',invoice_admission_id,
                'billing_advance_id',allocation.billing_advance_id,
                'billing_advance_patient_uid',advance.patient_uid::text,
                'billing_advance_terminal_patient_uid',terminal_patient_uid::text,
                'allocated_amount',allocation.allocated_amount::text,
                'allocation_command_sha256',allocation.allocation_command_sha256,
                'source_evidence_sha256',receipt.reservation_plan #>>
                  '{funding,source_evidence_sha256}',
                'base',jsonb_build_object(
                  'order_version',base_order_version::INTEGER,
                  'order_items_sha256',base_order_sha256
                ),
                'prospective',jsonb_build_object(
                  'order_version',prospective_order_version::INTEGER,
                  'order_items_sha256',prospective_order_sha256,
                  'authoritative_amount',authoritative_amount::NUMERIC(10,2)::text
                )
              )
         )::INTEGER
    INTO allocation_total,invalid_allocations
    FROM pharmacy_advance_allocations allocation
    LEFT JOIN billing_advances advance
      ON advance.tenant_id=allocation.tenant_id
     AND advance.id=allocation.billing_advance_id
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.funding_approval_receipt_id=target_receipt_id;

  expected_reservations:=jsonb_build_object(
    'required_amount',reservation_required::NUMERIC(12,2)::text,
    'reservation_count',jsonb_array_length(
      receipt.reservation_plan->'reservations'
    ),
    'source_evidence_sha256',receipt.reservation_plan #>>
      '{funding,source_evidence_sha256}',
    'source_plan_sha256',receipt.response_body #>>
      '{funding,source_plan_sha256}'
  );

  SELECT COUNT(*)
    INTO reversal_count
    FROM pharmacy_advance_allocation_reversals reversal
    JOIN pharmacy_advance_allocations allocation
      ON allocation.tenant_id=reversal.tenant_id
     AND allocation.id=reversal.allocation_id
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.funding_approval_receipt_id=target_receipt_id;

  IF allocation_total IS DISTINCT FROM reservation_required
     OR invalid_allocations<>0
     OR reversal_count<>0
     OR receipt.response_body->'advance_reservations'
          IS DISTINCT FROM expected_reservations THEN
    RAISE EXCEPTION
      'Pharmacy advance allocations do not exactly cover approval patient amount % (allocated %, invalid rows %, reversals %)',
      reservation_required,allocation_total,invalid_allocations,reversal_count
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_approval_amount_753';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_approval_complete_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  approval_receipt pharmacy_funding_commands%ROWTYPE;
BEGIN
  SELECT receipt.*
    INTO approval_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.funding_approval_receipt_id
     AND receipt.task_id=NEW.funding_task_id
     AND receipt.pharmacy_order_id=NEW.pharmacy_order_id
     AND receipt.invoice_item_id=NEW.invoice_item_id
   FOR KEY SHARE;
  IF NOT FOUND
     OR approval_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
     OR approval_receipt.status<>'COMPLETE'
     OR approval_receipt.response_body IS NULL
     OR approval_receipt.completed_at IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance allocation requires a completed approval receipt at commit'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_allocation_approval_complete_753';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_capacity_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  old_body JSONB;
  new_body JSONB;
  old_tenant_id UUID;
  new_tenant_id UUID;
  old_advance_id INTEGER;
  new_advance_id INTEGER;
BEGIN
  IF TG_OP<>'INSERT' THEN
    old_body:=to_jsonb(OLD);
    old_tenant_id:=(old_body->>'tenant_id')::UUID;
    old_advance_id:=CASE TG_TABLE_NAME
      WHEN 'billing_advances' THEN (old_body->>'id')::INTEGER
      WHEN 'billing_advance_settlements' THEN (old_body->>'advance_id')::INTEGER
      WHEN 'billing_refunds' THEN NULLIF(old_body->>'advance_id','')::INTEGER
      ELSE (old_body->>'billing_advance_id')::INTEGER
    END;
  END IF;
  IF TG_OP<>'DELETE' THEN
    new_body:=to_jsonb(NEW);
    new_tenant_id:=(new_body->>'tenant_id')::UUID;
    new_advance_id:=CASE TG_TABLE_NAME
      WHEN 'billing_advances' THEN (new_body->>'id')::INTEGER
      WHEN 'billing_advance_settlements' THEN (new_body->>'advance_id')::INTEGER
      WHEN 'billing_refunds' THEN NULLIF(new_body->>'advance_id','')::INTEGER
      ELSE (new_body->>'billing_advance_id')::INTEGER
    END;
  END IF;

  IF old_advance_id IS NOT NULL
     AND new_advance_id IS NOT NULL
     AND (old_tenant_id,old_advance_id) IS DISTINCT FROM
         (new_tenant_id,new_advance_id) THEN
    IF (old_tenant_id::text,old_advance_id)<(new_tenant_id::text,new_advance_id) THEN
      PERFORM public.assert_pharmacy_advance_capacity_753(
        old_tenant_id,old_advance_id
      );
      PERFORM public.assert_pharmacy_advance_capacity_753(
        new_tenant_id,new_advance_id
      );
    ELSE
      PERFORM public.assert_pharmacy_advance_capacity_753(
        new_tenant_id,new_advance_id
      );
      PERFORM public.assert_pharmacy_advance_capacity_753(
        old_tenant_id,old_advance_id
      );
    END IF;
  ELSIF new_advance_id IS NOT NULL THEN
    PERFORM public.assert_pharmacy_advance_capacity_753(
      new_tenant_id,new_advance_id
    );
  ELSIF old_advance_id IS NOT NULL THEN
    PERFORM public.assert_pharmacy_advance_capacity_753(
      old_tenant_id,old_advance_id
    );
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_consumption_complete_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.assert_pharmacy_advance_consumption_receipt_753(
    NEW.tenant_id,NEW.funding_consumption_receipt_id
  );
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_consumption_coverage_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.command_type<>'SUBSTITUTION_FUNDING_CONSUMPTION'
     OR NEW.status<>'COMPLETE' THEN
    RETURN NULL;
  END IF;

  PERFORM public.assert_pharmacy_advance_consumption_receipt_753(
    NEW.tenant_id,NEW.id
  );
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_consumption_link_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  approval_receipt pharmacy_funding_commands%ROWTYPE;
  consumption_receipt pharmacy_funding_commands%ROWTYPE;
  prior_link pharmacy_advance_allocation_consumptions%ROWTYPE;
  discovered_patient_uid UUID;
  terminal_patient_uid UUID;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || NEW.tenant_id::text,
    0
  ));
  SELECT receipt.patient_uid
    INTO discovered_patient_uid
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.funding_approval_receipt_id
     AND receipt.command_type='SUBSTITUTION_FUNDING_APPROVAL';
  IF discovered_patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance consumption lacks its approval patient lineage'
      USING ERRCODE='23514';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    NEW.tenant_id,discovered_patient_uid
  );
  PERFORM public.resolve_billing_patient_family_753(
    NEW.tenant_id,terminal_patient_uid
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || NEW.tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || NEW.tenant_id::text || ':'
      || NEW.pharmacy_order_id::text,
    753
  ));
  SELECT receipt.*
    INTO approval_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.funding_approval_receipt_id
     AND receipt.task_id=NEW.funding_task_id
     AND receipt.pharmacy_order_id=NEW.pharmacy_order_id
     AND receipt.invoice_item_id=NEW.invoice_item_id
   FOR UPDATE;
  IF NOT FOUND
     OR approval_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
     OR approval_receipt.status<>'COMPLETE' THEN
    RAISE EXCEPTION 'Pharmacy advance consumption lacks its exact approval receipt'
      USING ERRCODE='23514';
  END IF;
  IF approval_receipt.patient_uid IS DISTINCT FROM discovered_patient_uid
     OR approval_receipt.response_body #>> '{base,patient_uid}'
        IS DISTINCT FROM terminal_patient_uid::text THEN
    RAISE EXCEPTION 'Pharmacy advance consumption approval patient authority is stale'
      USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || NEW.tenant_id::text || ':'
      || NEW.funding_approval_receipt_id::text,
    0
  ));

  SELECT receipt.*
    INTO consumption_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.funding_consumption_receipt_id
   FOR UPDATE;
  IF NOT FOUND
     OR consumption_receipt.command_type<>'SUBSTITUTION_FUNDING_CONSUMPTION'
     OR consumption_receipt.status NOT IN ('IN_PROGRESS','COMPLETE')
     OR consumption_receipt.approval_receipt_id<>NEW.funding_approval_receipt_id
     OR consumption_receipt.task_id<>NEW.funding_task_id
     OR consumption_receipt.pharmacy_order_id<>NEW.pharmacy_order_id
     OR consumption_receipt.invoice_item_id<>NEW.invoice_item_id
     OR consumption_receipt.command_key_sha256<>NEW.consumption_command_sha256
     OR consumption_receipt.created_by<>NEW.consumed_by THEN
    RAISE EXCEPTION 'Pharmacy advance consumption link lacks its exact paired command receipt'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1
    FROM pharmacy_advance_allocations allocation
   WHERE allocation.tenant_id=NEW.tenant_id
     AND allocation.id=NEW.allocation_id
     AND allocation.pharmacy_order_id=NEW.pharmacy_order_id
     AND allocation.invoice_id=NEW.invoice_id
     AND allocation.invoice_item_id=NEW.invoice_item_id
     AND allocation.billing_advance_id=NEW.billing_advance_id
     AND allocation.source_authority_version=NEW.source_authority_version
     AND allocation.source_authority_sha256=NEW.source_authority_sha256
     AND allocation.funding_task_id=NEW.funding_task_id
     AND allocation.funding_approval_receipt_id=
         NEW.funding_approval_receipt_id
     AND allocation.evidence_sha256=NEW.allocation_evidence_sha256
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance consumption does not match exact allocation authority'
      USING ERRCODE='23503';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pharmacy_advance_allocation_reversals reversal
     WHERE reversal.tenant_id=NEW.tenant_id
       AND reversal.allocation_id=NEW.allocation_id
  ) THEN
    RAISE EXCEPTION 'A reversed pharmacy advance allocation cannot be newly consumed'
      USING ERRCODE='23514';
  END IF;

  SELECT linked.*
    INTO prior_link
    FROM pharmacy_advance_allocation_consumptions linked
   WHERE linked.tenant_id=NEW.tenant_id
     AND linked.funding_consumption_receipt_id=NEW.funding_consumption_receipt_id
   ORDER BY linked.id
   LIMIT 1
   FOR KEY SHARE;
  IF FOUND AND (
       prior_link.pharmacy_order_id<>NEW.pharmacy_order_id
       OR prior_link.invoice_id<>NEW.invoice_id
       OR prior_link.invoice_item_id<>NEW.invoice_item_id
       OR prior_link.source_authority_version<>NEW.source_authority_version
       OR prior_link.source_authority_sha256<>NEW.source_authority_sha256
       OR prior_link.funding_task_id<>NEW.funding_task_id
       OR prior_link.funding_approval_receipt_id<>NEW.funding_approval_receipt_id
       OR prior_link.consumption_command_sha256<>NEW.consumption_command_sha256
     ) THEN
    RAISE EXCEPTION 'One consumption receipt cannot bind multiple funding commands or authority generations'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_release_complete_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_TABLE_NAME='pharmacy_funding_commands' THEN
    IF NEW.command_type<>'PHARMACY_ADVANCE_RELEASE' OR NEW.status<>'COMPLETE' THEN
      RETURN NULL;
    END IF;
    PERFORM public.assert_pharmacy_advance_release_receipt_753(
      NEW.tenant_id,NEW.id
    );
  ELSIF NEW.funding_release_receipt_id IS NOT NULL THEN
    PERFORM public.assert_pharmacy_advance_release_receipt_753(
      NEW.tenant_id,NEW.funding_release_receipt_id
    );
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_reversal_balance_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  approval_receipt pharmacy_funding_commands%ROWTYPE;
  settlement_receipt pharmacy_funding_commands%ROWTYPE;
  release_receipt pharmacy_funding_commands%ROWTYPE;
  allocation_amount NUMERIC(12,2);
  prior_reversed_amount NUMERIC(12,2);
  discovered_patient_uid UUID;
  terminal_patient_uid UUID;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || NEW.tenant_id::text,
    0
  ));
  SELECT receipt.patient_uid
    INTO discovered_patient_uid
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.funding_approval_receipt_id
     AND receipt.command_type='SUBSTITUTION_FUNDING_APPROVAL';
  IF discovered_patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance reversal lacks approval patient lineage'
      USING ERRCODE='23514';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    NEW.tenant_id,discovered_patient_uid
  );
  PERFORM public.resolve_billing_patient_family_753(
    NEW.tenant_id,terminal_patient_uid
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || NEW.tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || NEW.tenant_id::text || ':'
      || NEW.pharmacy_order_id::text,
    753
  ));
  SELECT receipt.*
    INTO approval_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.funding_approval_receipt_id
     AND receipt.task_id=NEW.funding_task_id
     AND receipt.pharmacy_order_id=NEW.pharmacy_order_id
     AND receipt.invoice_item_id=NEW.invoice_item_id
   FOR UPDATE;
  IF NOT FOUND
     OR approval_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
     OR approval_receipt.status<>'COMPLETE'
     OR approval_receipt.patient_uid IS DISTINCT FROM discovered_patient_uid
     OR approval_receipt.response_body #>> '{base,patient_uid}'
        IS DISTINCT FROM terminal_patient_uid::text THEN
    RAISE EXCEPTION 'Pharmacy advance reversal lacks its exact approval receipt'
      USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || NEW.tenant_id::text || ':'
      || NEW.funding_approval_receipt_id::text,
    0
  ));

  IF NEW.reason='SETTLED_TO_INVOICE' THEN
    SELECT receipt.*
      INTO settlement_receipt
      FROM pharmacy_funding_commands receipt
     WHERE receipt.tenant_id=NEW.tenant_id
       AND receipt.id=NEW.funding_settlement_receipt_id
       AND receipt.command_type='PHARMACY_ADVANCE_SETTLEMENT'
       AND receipt.approval_receipt_id=NEW.funding_approval_receipt_id
       AND receipt.pharmacy_order_id=NEW.pharmacy_order_id
       AND receipt.invoice_id=NEW.invoice_id
       AND receipt.invoice_item_id=NEW.invoice_item_id
       AND receipt.created_by=NEW.reversed_by
       AND receipt.status IN ('IN_PROGRESS','COMPLETE')
     FOR UPDATE;
    IF NOT FOUND OR NEW.reversal_command_sha256 IS DISTINCT FROM
       settlement_receipt.command_key_sha256 THEN
      RAISE EXCEPTION 'Invoice settlement reversal lacks its exact approval-wide conversion receipt'
        USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT receipt.*
      INTO release_receipt
      FROM pharmacy_funding_commands receipt
     WHERE receipt.tenant_id=NEW.tenant_id
       AND receipt.id=NEW.funding_release_receipt_id
       AND receipt.command_type='PHARMACY_ADVANCE_RELEASE'
       AND receipt.approval_receipt_id=NEW.funding_approval_receipt_id
       AND receipt.pharmacy_order_id=NEW.pharmacy_order_id
       AND receipt.invoice_id=NEW.invoice_id
       AND receipt.invoice_item_id=NEW.invoice_item_id
       AND receipt.created_by=NEW.reversed_by
       AND receipt.release_reason=NEW.reason
       AND receipt.status IN ('IN_PROGRESS','COMPLETE')
     FOR UPDATE;
    IF NOT FOUND OR NEW.reversal_command_sha256 IS DISTINCT FROM
       release_receipt.command_key_sha256 THEN
      RAISE EXCEPTION 'Terminal pharmacy advance release lacks its exact approval-wide release receipt'
        USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM 1
    FROM billing_advances advance
   WHERE advance.tenant_id=NEW.tenant_id
     AND advance.id=NEW.billing_advance_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reversal lacks its exact advance authority'
      USING ERRCODE='23503';
  END IF;

  SELECT allocation.allocated_amount
    INTO allocation_amount
    FROM pharmacy_advance_allocations allocation
   WHERE allocation.tenant_id=NEW.tenant_id
     AND allocation.id=NEW.allocation_id
     AND allocation.pharmacy_order_id=NEW.pharmacy_order_id
     AND allocation.invoice_id=NEW.invoice_id
     AND allocation.invoice_item_id=NEW.invoice_item_id
     AND allocation.billing_advance_id=NEW.billing_advance_id
     AND allocation.source_authority_version=NEW.source_authority_version
     AND allocation.source_authority_sha256=NEW.source_authority_sha256
     AND allocation.funding_task_id=NEW.funding_task_id
     AND allocation.funding_approval_receipt_id=
         NEW.funding_approval_receipt_id
     AND allocation.evidence_sha256=NEW.allocation_evidence_sha256
   FOR UPDATE;
  IF allocation_amount IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance reversal does not match exact allocation authority'
      USING ERRCODE='23503';
  END IF;

  IF NEW.reason<>'SETTLED_TO_INVOICE' AND EXISTS (
    SELECT 1
      FROM pharmacy_advance_allocation_consumptions consumption
     WHERE consumption.tenant_id=NEW.tenant_id
       AND consumption.allocation_id=NEW.allocation_id
  ) THEN
    RAISE EXCEPTION 'A consumed pharmacy advance allocation permits only governed invoice settlement'
      USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(SUM(reversal.reversed_amount),0)
    INTO prior_reversed_amount
    FROM pharmacy_advance_allocation_reversals reversal
   WHERE reversal.tenant_id=NEW.tenant_id
     AND reversal.allocation_id=NEW.allocation_id;
  IF prior_reversed_amount+NEW.reversed_amount>allocation_amount THEN
    RAISE EXCEPTION 'Pharmacy advance reversal exceeds remaining allocation balance'
      USING ERRCODE='23514';
  END IF;
  IF NEW.reason='SETTLED_TO_INVOICE' THEN
    IF prior_reversed_amount<>0 OR NEW.reversed_amount<>allocation_amount THEN
      RAISE EXCEPTION 'Invoice settlement must fully convert one unreversed pharmacy advance allocation'
        USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pharmacy_advance_allocation_consumptions consumption
        JOIN pharmacy_funding_commands receipt
          ON receipt.tenant_id=consumption.tenant_id
         AND receipt.id=consumption.funding_consumption_receipt_id
       WHERE consumption.tenant_id=NEW.tenant_id
         AND consumption.allocation_id=NEW.allocation_id
         AND receipt.status='COMPLETE'
         AND receipt.completed_at IS NOT NULL
         AND receipt.response_body IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Invoice settlement requires completed consumption evidence for the allocation'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF prior_reversed_amount<>0 OR NEW.reversed_amount<>allocation_amount THEN
      RAISE EXCEPTION 'Terminal pharmacy advance release must fully reverse an unreversed allocation'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_settlement_complete_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  target_receipt_id BIGINT;
BEGIN
  IF TG_TABLE_NAME='pharmacy_funding_commands' THEN
    IF NEW.command_type<>'PHARMACY_ADVANCE_SETTLEMENT'
       OR NEW.status<>'COMPLETE' THEN
      RETURN NULL;
    END IF;
    target_receipt_id:=NEW.id;
  ELSIF TG_TABLE_NAME='billing_advance_settlements' THEN
    IF NEW.pharmacy_advance_settlement_receipt_id IS NULL THEN
      IF EXISTS (
        SELECT 1 FROM pharmacy_funding_commands consumption
         WHERE consumption.tenant_id=NEW.tenant_id
           AND consumption.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
           AND consumption.status='COMPLETE'
           AND consumption.invoice_id=NEW.invoice_id
      ) THEN
        RAISE EXCEPTION 'A consumed pharmacy invoice permits only governed full advance conversion'
          USING ERRCODE='23514',
                CONSTRAINT='chk_pharmacy_advance_settlement_full_set_753';
      END IF;
      RETURN NULL;
    END IF;
    target_receipt_id:=NEW.pharmacy_advance_settlement_receipt_id;
  ELSE
    IF NEW.funding_settlement_receipt_id IS NULL THEN RETURN NULL; END IF;
    target_receipt_id:=NEW.funding_settlement_receipt_id;
  END IF;
  PERFORM public.assert_pharmacy_advance_settlement_receipt_753(
    NEW.tenant_id,target_receipt_id
  );
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_advance_settlement_pair_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF NEW.pharmacy_advance_allocation_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM billing_advance_settlements settlement
     WHERE settlement.tenant_id=NEW.tenant_id
       AND settlement.id=NEW.id
       AND settlement.pharmacy_advance_allocation_id=
           NEW.pharmacy_advance_allocation_id
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pharmacy_advance_allocation_reversals reversal
     WHERE reversal.tenant_id=NEW.tenant_id
       AND reversal.billing_advance_settlement_id=NEW.id
       AND reversal.reason='SETTLED_TO_INVOICE'
       AND reversal.allocation_id=NEW.pharmacy_advance_allocation_id
       AND reversal.billing_advance_id=NEW.advance_id
       AND reversal.invoice_id=NEW.invoice_id
       AND reversal.reversed_amount=NEW.amount
        AND reversal.reversed_by=NEW.settled_by
        AND reversal.reversed_at=NEW.settled_at
        AND reversal.funding_settlement_receipt_id=
            NEW.pharmacy_advance_settlement_receipt_id
        AND reversal.allocation_evidence_sha256=
           NEW.pharmacy_advance_allocation_evidence_sha256
       AND reversal.reversal_command_sha256=
           NEW.pharmacy_advance_conversion_command_sha256
       AND reversal.evidence_sha256=
           NEW.pharmacy_advance_conversion_evidence_sha256
  ) THEN
    RAISE EXCEPTION
      'A pharmacy advance conversion settlement requires its exact reversal in the same transaction'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_settlement_pair_753';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_allocation_reversal_balance_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  allocation_amount NUMERIC(12,2);
  prior_reversed_amount NUMERIC(12,2);
BEGIN
  SELECT allocation.allocated_amount
    INTO allocation_amount
    FROM pharmacy_payment_allocations allocation
   WHERE allocation.tenant_id=NEW.tenant_id
     AND allocation.id=NEW.allocation_id
     AND allocation.pharmacy_order_id=NEW.pharmacy_order_id
     AND allocation.invoice_id=NEW.invoice_id
     AND allocation.invoice_item_id=NEW.invoice_item_id
     AND allocation.billing_payment_id=NEW.billing_payment_id
     AND allocation.source_authority_version=NEW.source_authority_version
     AND allocation.source_authority_sha256=NEW.source_authority_sha256
   FOR UPDATE;
  IF allocation_amount IS NULL THEN
    RAISE EXCEPTION 'Pharmacy allocation reversal does not match exact allocation authority'
      USING ERRCODE='23503';
  END IF;

  SELECT COALESCE(SUM(reversal.reversed_amount),0)
    INTO prior_reversed_amount
    FROM pharmacy_payment_allocation_reversals reversal
   WHERE reversal.tenant_id=NEW.tenant_id
     AND reversal.allocation_id=NEW.allocation_id;
  IF prior_reversed_amount + NEW.reversed_amount > allocation_amount THEN
    RAISE EXCEPTION 'Pharmacy allocation reversal exceeds remaining allocation balance'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_batch_storage_authority_supply_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status IN ('in_stock', 'reserved', 'quarantined')
     AND NEW.storage_location_id IS NULL THEN
    RAISE EXCEPTION 'Active or quarantined pharmacy stock requires an exact storage location'
      USING ERRCODE='23514';
  END IF;
  IF NEW.storage_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM facility_locations location
     WHERE location.tenant_id=NEW.tenant_id
       AND location.facility_id=NEW.facility_id
       AND location.id=NEW.storage_location_id
       AND location.status='active'
  ) THEN
    RAISE EXCEPTION 'Pharmacy batch storage location must be active in the exact facility'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE'
     AND NEW.storage_location_id IS DISTINCT FROM OLD.storage_location_id
     AND (
       EXISTS (
         SELECT 1 FROM pharmacy_stock_movements movement
          WHERE movement.tenant_id=OLD.tenant_id
            AND movement.inventory_batch_id=OLD.id
       )
       OR EXISTS (
         SELECT 1 FROM pharmacy_goods_receipt_items line
          WHERE line.tenant_id=OLD.tenant_id
            AND line.inventory_batch_id=OLD.id
       )
     ) THEN
    RAISE EXCEPTION 'Pharmacy batch storage lineage is immutable after custody history exists'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_funding_command_receipt_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'pharmacy funding command receipts cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF OLD.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
     AND OLD.status='IN_PROGRESS'
     AND NEW.status='ABANDONED'
     AND current_setting(
       'app.pharmacy_consumption_abandonment',TRUE
     ) IS NOT DISTINCT FROM OLD.id::TEXT
     AND jsonb_typeof(NEW.response_body)='object'
     AND NEW.response_body->>'contract'=
         'pharmacy_substitution_funding_consumption_abandoned_v1'
     AND NEW.response_body->>'status'='abandoned'
     AND NEW.response_body->>'consumption_receipt_id'=OLD.id::TEXT
     AND NEW.response_body->>'approval_receipt_id'=
         OLD.approval_receipt_id::TEXT
     AND NEW.response_body->>'pharmacy_order_id'=OLD.pharmacy_order_id::TEXT
     AND NEW.response_body->>'invoice_id'=OLD.invoice_id::TEXT
     AND NEW.response_body->>'invoice_item_id'=OLD.invoice_item_id::TEXT
     AND NEW.order_mutation_receipt_id IS NULL
     AND to_jsonb(NEW)-ARRAY[
       'status','response_body','completed_at','completed_transaction_id'
     ] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY[
       'status','response_body','completed_at','completed_transaction_id'
     ] THEN
    NEW.completed_at:=DATE_TRUNC('milliseconds',transaction_timestamp());
    NEW.completed_transaction_id:=txid_current();
    NEW.response_body:=jsonb_set(
      NEW.response_body,'{abandoned_at}',to_jsonb(to_char(
        NEW.completed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )),TRUE
    );
    RETURN NEW;
  END IF;
  IF OLD.command_type='SUBSTITUTION_FUNDING_APPROVAL'
     AND OLD.status='IN_PROGRESS' AND NEW.status='IN_PROGRESS'
     AND OLD.reservation_authority IS NULL
     AND OLD.reservation_plan IS NULL
     AND jsonb_typeof(NEW.reservation_authority)='object'
     AND jsonb_typeof(NEW.reservation_plan)='object'
     AND current_setting(
       'app.pharmacy_advance_reservation_binding',TRUE
     ) IS NOT DISTINCT FROM OLD.id::TEXT
     AND to_jsonb(NEW)-ARRAY[
       'reservation_authority','reservation_authority_sha256',
       'reservation_plan','reservation_plan_sha256','reserved_at',
       'reserved_transaction_id'
     ] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY[
       'reservation_authority','reservation_authority_sha256',
       'reservation_plan','reservation_plan_sha256','reserved_at',
       'reserved_transaction_id'
     ] THEN
    NEW.reservation_authority_sha256:=encode(public.digest(
      NEW.reservation_authority::TEXT,'sha256'
    ),'hex');
    NEW.reservation_plan_sha256:=encode(public.digest(
      NEW.reservation_plan::TEXT,'sha256'
    ),'hex');
    NEW.reserved_at:=DATE_TRUNC('milliseconds',transaction_timestamp());
    NEW.reserved_transaction_id:=txid_current();
    RETURN NEW;
  END IF;
  IF OLD.command_type='SUBSTITUTION_FUNDING_APPROVAL'
     AND OLD.status='IN_PROGRESS'
     AND NEW.status='COMPLETE' THEN
    IF OLD.approved_patient_amount IS NOT NULL
       OR NEW.approved_patient_amount IS NOT NULL
       OR jsonb_typeof(NEW.response_body #>
            '{funding,patient_payment_required_amount}')
            IS DISTINCT FROM 'string'
       OR (NEW.response_body #>>
            '{funding,patient_payment_required_amount}')
            !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN
      RAISE EXCEPTION 'Substitution funding approval completion lacks canonical patient amount'
        USING ERRCODE='23514';
    END IF;
    NEW.approved_patient_amount:=(NEW.response_body #>>
      '{funding,patient_payment_required_amount}')::NUMERIC(12,2);
  END IF;
  IF OLD.status='IN_PROGRESS' AND NEW.status='COMPLETE' THEN
    NEW.completed_at:=DATE_TRUNC('milliseconds',transaction_timestamp());
    NEW.completed_transaction_id:=txid_current();
    IF OLD.command_type='SUBSTITUTION_FUNDING_CONSUMPTION' THEN
      IF jsonb_typeof(NEW.response_body) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Substitution funding consumption completion lacks response evidence'
          USING ERRCODE='23514';
      END IF;
      NEW.response_body:=jsonb_set(
        NEW.response_body,
        '{consumed_at}',
        to_jsonb(to_char(
          NEW.completed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )),
        TRUE
      );
    ELSIF OLD.command_type='PHARMACY_ADVANCE_RELEASE' THEN
      NEW.response_body:=jsonb_set(
        NEW.response_body,
        '{released_at}',
        to_jsonb(to_char(
          NEW.completed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )),
        TRUE
      );
    ELSIF OLD.command_type='PHARMACY_ADVANCE_SETTLEMENT' THEN
      NEW.response_body:=jsonb_set(
        NEW.response_body,
        '{settled_at}',
        to_jsonb(to_char(
          NEW.completed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )),
        TRUE
      );
    END IF;
  END IF;
  IF OLD.status='IN_PROGRESS'
     AND NEW.status='COMPLETE'
     AND NEW.response_body IS NOT NULL
     AND NEW.completed_at IS NOT NULL
     AND NEW.id=OLD.id
     AND NEW.tenant_id=OLD.tenant_id
     AND NEW.command_key_sha256=OLD.command_key_sha256
     AND NEW.command_type=OLD.command_type
     AND NEW.task_id=OLD.task_id
     AND NEW.task_resource_type=OLD.task_resource_type
      AND NEW.task_resource_id=OLD.task_resource_id
      AND NEW.pharmacy_order_id=OLD.pharmacy_order_id
      AND NEW.facility_id IS NOT DISTINCT FROM OLD.facility_id
      AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id
      AND NEW.invoice_item_id=OLD.invoice_item_id
     AND NEW.tpa_claim_id IS NOT DISTINCT FROM OLD.tpa_claim_id
     AND NEW.approval_receipt_id IS NOT DISTINCT FROM OLD.approval_receipt_id
     AND NEW.consumption_receipt_id IS NOT DISTINCT FROM OLD.consumption_receipt_id
     AND NEW.governance_approval_id IS NOT DISTINCT FROM OLD.governance_approval_id
      AND NEW.proposal_sha256 IS NOT DISTINCT FROM OLD.proposal_sha256
      AND NEW.proposer_uid IS NOT DISTINCT FROM OLD.proposer_uid
      AND NEW.patient_uid IS NOT DISTINCT FROM OLD.patient_uid
      AND NEW.reservation_authority IS NOT DISTINCT FROM OLD.reservation_authority
      AND NEW.reservation_authority_sha256 IS NOT DISTINCT FROM
           OLD.reservation_authority_sha256
      AND NEW.reservation_plan IS NOT DISTINCT FROM OLD.reservation_plan
      AND NEW.reservation_plan_sha256 IS NOT DISTINCT FROM
           OLD.reservation_plan_sha256
      AND NEW.reserved_at IS NOT DISTINCT FROM OLD.reserved_at
      AND NEW.reserved_transaction_id IS NOT DISTINCT FROM
           OLD.reserved_transaction_id
      AND NEW.release_reason IS NOT DISTINCT FROM OLD.release_reason
      AND NEW.release_source_approval_id IS NOT DISTINCT FROM
           OLD.release_source_approval_id
     AND (
       (
         NEW.order_mutation_receipt_id IS NOT DISTINCT FROM
           OLD.order_mutation_receipt_id
         AND NEW.order_mutation_action IS NOT DISTINCT FROM
           OLD.order_mutation_action
         AND NEW.order_mutation_command_sha256 IS NOT DISTINCT FROM
           OLD.order_mutation_command_sha256
         AND NEW.order_mutation_request_sha256 IS NOT DISTINCT FROM
           OLD.order_mutation_request_sha256
         AND NEW.order_mutation_evidence_sha256 IS NOT DISTINCT FROM
           OLD.order_mutation_evidence_sha256
       )
       OR (
         OLD.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
         AND current_setting(
           'app.pharmacy_consumption_mutation_binding',TRUE
         ) IS NOT DISTINCT FROM OLD.id::TEXT
         AND OLD.order_mutation_receipt_id IS NULL
         AND OLD.order_mutation_action IS NULL
         AND OLD.order_mutation_command_sha256 IS NULL
         AND OLD.order_mutation_request_sha256 IS NULL
         AND OLD.order_mutation_evidence_sha256 IS NULL
         AND NEW.order_mutation_receipt_id IS NOT NULL
         AND NEW.order_mutation_action='dispense_substitution'
         AND NEW.order_mutation_command_sha256 IS NOT NULL
         AND NEW.order_mutation_request_sha256 IS NOT NULL
         AND NEW.order_mutation_evidence_sha256 IS NOT NULL
       )
     )
     AND (
       NEW.approved_patient_amount IS NOT DISTINCT FROM OLD.approved_patient_amount
       OR (
         OLD.command_type='SUBSTITUTION_FUNDING_APPROVAL'
         AND OLD.approved_patient_amount IS NULL
         AND NEW.approved_patient_amount IS NOT NULL
       )
     )
     AND NEW.request_sha256=OLD.request_sha256
     AND NEW.created_by=OLD.created_by
     AND NEW.created_at=OLD.created_at
     AND (
       NEW.completed_transaction_id IS NOT DISTINCT FROM OLD.completed_transaction_id
       OR (
         OLD.completed_transaction_id IS NULL
         AND NEW.completed_transaction_id IS NOT NULL
       )
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pharmacy funding command identity and completed response are immutable'
    USING ERRCODE='55000';
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_funding_event_chain_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  prior_event pharmacy_funding_decision_events%ROWTYPE;
BEGIN
  IF NEW.authority_generation IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_event_chain:' || NEW.tenant_id::text || ':'
      || NEW.pharmacy_order_id::text || ':' || NEW.source_authority_version::text
      || ':' || NEW.source_authority_sha256,
    753
  ));
  IF NEW.authority_generation=1 THEN
    IF EXISTS (
      SELECT 1 FROM pharmacy_funding_decision_events event
       WHERE event.tenant_id=NEW.tenant_id
         AND event.pharmacy_order_id=NEW.pharmacy_order_id
         AND event.source_authority_version=NEW.source_authority_version
         AND event.source_authority_sha256=NEW.source_authority_sha256
         AND event.authority_generation IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Initial pharmacy funding authority generation already exists';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO prior_event
    FROM pharmacy_funding_decision_events event
   WHERE event.tenant_id=NEW.tenant_id AND event.id=NEW.supersedes_event_id
   FOR KEY SHARE;
  IF NOT FOUND
     OR prior_event.pharmacy_order_id<>NEW.pharmacy_order_id
     OR prior_event.source_authority_version<>NEW.source_authority_version
     OR prior_event.source_authority_sha256<>NEW.source_authority_sha256
     OR prior_event.authority_generation IS NULL
     OR prior_event.authority_generation<>NEW.authority_generation-1 THEN
    RAISE EXCEPTION 'Pharmacy funding supersession does not continue the exact authority chain';
  END IF;
  IF (NEW.event_type='AUTHORITY_INVALIDATED' AND prior_event.event_type<>'FUNDING_RESOLVED')
     OR (NEW.event_type='FUNDING_RESOLVED'
         AND prior_event.event_type<>'AUTHORITY_INVALIDATED') THEN
    RAISE EXCEPTION 'Pharmacy funding authority state transitions must alternate resolved and invalidated';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_funding_receipt_pair_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  approval_receipt pharmacy_funding_commands%ROWTYPE;
  consumption_receipt pharmacy_funding_commands%ROWTYPE;
  governance_approval approvals%ROWTYPE;
  release_source_approval approvals%ROWTYPE;
  governance_task tasks%ROWTYPE;
  release_task tasks%ROWTYPE;
  release_source_task tasks%ROWTYPE;
  finance_task tasks%ROWTYPE;
  finance_actor_role TEXT;
  release_actor_role TEXT;
  release_source_proposer_role TEXT;
  release_source_decider_role TEXT;
  release_source_role_permitted BOOLEAN;
  release_source_grant_id BIGINT;
BEGIN
  IF NEW.command_type IN (
       'SUBSTITUTION_FUNDING_APPROVAL','SUBSTITUTION_FUNDING_CONSUMPTION',
       'PHARMACY_ADVANCE_SETTLEMENT','PHARMACY_ADVANCE_RELEASE'
     ) THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(
      'vhhealth:patient-merge-tenant:' || NEW.tenant_id::text,
      0
    ));
    SELECT approval.*
      INTO governance_approval
      FROM approvals approval
     WHERE approval.tenant_id=NEW.tenant_id
       AND approval.id=NEW.governance_approval_id
     FOR UPDATE;
    IF NOT FOUND
       OR governance_approval.approval_kind<>
          'pharmacy_substitution_funding_reauthorisation'
       OR governance_approval.subject_resource_type<>
          'pharmacy_substitution_funding_proposal'
       OR governance_approval.subject_resource_id IS DISTINCT FROM
          NEW.proposal_sha256
       OR governance_approval.created_by IS DISTINCT FROM NEW.proposer_uid
       OR governance_approval.metadata->>'contract'<>
          'pharmacy_substitution_funding_reauthorisation_v1'
       OR governance_approval.metadata->>'stage'<>
          'substitution_reauthorisation'
       OR governance_approval.metadata->>'proposal_sha256' IS DISTINCT FROM
          NEW.proposal_sha256
       OR governance_approval.metadata->>'proposer_uid' IS DISTINCT FROM
          NEW.proposer_uid::text
       OR governance_approval.task_id IS NULL
       OR governance_approval.metadata->>'task_id' IS DISTINCT FROM
          governance_approval.task_id::text
       OR governance_approval.metadata->>'task_resource_type' IS NULL
       OR governance_approval.metadata->>'pharmacy_order_id' IS DISTINCT FROM
          NEW.pharmacy_order_id::text
       OR governance_approval.metadata->>'facility_id' IS DISTINCT FROM
          NEW.facility_id::text
       OR governance_approval.metadata->>'invoice_id' IS DISTINCT FROM
          NEW.invoice_id::text
       OR governance_approval.metadata->>'invoice_item_id' IS DISTINCT FROM
          NEW.invoice_item_id::text
       OR governance_approval.metadata #>> '{authority,base,pharmacy_order_id}'
          IS DISTINCT FROM NEW.pharmacy_order_id::text
       OR governance_approval.metadata #>> '{authority,base,facility_id}'
          IS DISTINCT FROM NEW.facility_id::text
       OR governance_approval.metadata #>> '{authority,base,patient_uid}'
          IS DISTINCT FROM NEW.patient_uid::text
       OR governance_approval.expires_at IS NULL THEN
      RAISE EXCEPTION 'Pharmacy funding command lacks its exact governance approval source'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_funding_command_governance_source_753';
    END IF;

    IF NEW.command_type IN (
         'SUBSTITUTION_FUNDING_APPROVAL','SUBSTITUTION_FUNDING_CONSUMPTION'
       ) THEN
      SELECT task.*
        INTO governance_task
        FROM tasks task
       WHERE task.tenant_id=NEW.tenant_id
         AND task.id=NEW.task_id
       FOR UPDATE;
      IF NOT FOUND
         OR governance_approval.task_id IS DISTINCT FROM NEW.task_id
         OR governance_approval.workflow_run_id IS DISTINCT FROM
            governance_task.workflow_run_id
         OR governance_approval.workflow_step_id IS DISTINCT FROM
            governance_task.workflow_step_id
         OR governance_task.task_kind<>'review'
         OR governance_task.related_resource_type IS DISTINCT FROM
            NEW.task_resource_type
         OR governance_task.related_resource_id IS DISTINCT FROM
            NEW.pharmacy_order_id::text
         OR governance_task.metadata->>'contract'<>
            'pharmacy_substitution_funding_task_v1'
         OR governance_task.metadata->>'stage'<>'substitution_reauthorisation'
         OR governance_task.metadata->>'proposal_sha256' IS DISTINCT FROM
            NEW.proposal_sha256
         OR governance_task.metadata->>'proposer_uid' IS DISTINCT FROM
            NEW.proposer_uid::text
         OR governance_task.metadata->>'facility_id' IS DISTINCT FROM
            NEW.facility_id::text
         OR governance_task.metadata->>'pharmacy_order_id' IS DISTINCT FROM
            NEW.pharmacy_order_id::text
         OR governance_task.metadata->>'invoice_id' IS DISTINCT FROM
            NEW.invoice_id::text
         OR governance_task.metadata->>'invoice_item_id' IS DISTINCT FROM
            NEW.invoice_item_id::text
         OR governance_approval.metadata->>'task_resource_type' IS DISTINCT FROM
            governance_task.related_resource_type THEN
        RAISE EXCEPTION 'Pharmacy funding command lacks its exact governed task lineage'
          USING ERRCODE='23514',
                CONSTRAINT='chk_pharmacy_funding_command_governance_source_753';
      END IF;
    END IF;

    IF NEW.command_type='SUBSTITUTION_FUNDING_APPROVAL' THEN
      IF TG_OP='INSERT' AND (
           governance_approval.status<>'pending'
           OR governance_approval.decided_by IS NOT NULL
           OR governance_approval.decided_at IS NOT NULL
           OR governance_approval.expires_at<=clock_timestamp()
           OR NEW.created_by=NEW.proposer_uid
         ) THEN
        RAISE EXCEPTION 'Substitution funding approval claim is stale, decided, or lacks actor separation'
          USING ERRCODE='23514',
                CONSTRAINT='chk_pharmacy_funding_command_governance_source_753';
      END IF;
      IF TG_OP='UPDATE' AND NEW.status='COMPLETE' AND (
           governance_approval.status<>'approved'
           OR governance_approval.decided_by IS DISTINCT FROM NEW.created_by
           OR governance_approval.decided_at IS NULL
           OR governance_approval.decided_at>clock_timestamp()
           OR governance_approval.decided_at>=governance_approval.expires_at
           OR clock_timestamp()>=governance_approval.expires_at
           OR NEW.created_by=NEW.proposer_uid
           OR jsonb_typeof(NEW.response_body->'approval_id')
                IS DISTINCT FROM 'number'
           OR NEW.response_body->>'approval_id' IS DISTINCT FROM
                NEW.governance_approval_id::text
           OR NEW.response_body->>'proposal_sha256' IS DISTINCT FROM
                NEW.proposal_sha256
           OR NEW.response_body #>> '{proposer,uid}' IS DISTINCT FROM
                NEW.proposer_uid::text
           OR NEW.response_body->>'approver_uid' IS DISTINCT FROM
                NEW.created_by::text
           OR NEW.response_body->>'approval_status'<>'approved'
            OR NEW.response_body->>'invoice_item_id' IS DISTINCT FROM
                 NEW.invoice_item_id::text
            OR NEW.response_body->>'invoice_id' IS DISTINCT FROM
                 NEW.invoice_id::text
            OR NEW.response_body->>'task_id' IS DISTINCT FROM NEW.task_id::text
            OR NEW.response_body #>> '{base,pharmacy_order_id}' IS DISTINCT FROM
                 NEW.pharmacy_order_id::text
            OR NEW.response_body #>> '{base,facility_id}' IS DISTINCT FROM
                 NEW.facility_id::text
            OR NEW.response_body #>> '{base,patient_uid}' IS DISTINCT FROM
                 NEW.patient_uid::text
         ) THEN
        RAISE EXCEPTION 'Substitution funding completion does not echo its exact decided governance source'
          USING ERRCODE='23514',
                CONSTRAINT='chk_pharmacy_funding_command_governance_source_753';
      END IF;
    ELSIF governance_approval.status<>'approved'
       OR governance_approval.decided_by IS NULL
       OR governance_approval.decided_at IS NULL
       OR governance_approval.decided_at>clock_timestamp()
       OR governance_approval.decided_at>=governance_approval.expires_at THEN
      RAISE EXCEPTION 'Downstream pharmacy funding command lacks an approved governance source'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_funding_command_governance_source_753';
    END IF;
    IF NEW.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
       AND NEW.status<>'ABANDONED'
       AND clock_timestamp()>=governance_approval.expires_at THEN
      RAISE EXCEPTION 'Expired substitution funding authority cannot be consumed'
        USING ERRCODE='23514',
              CONSTRAINT='chk_pharmacy_funding_command_governance_source_753';
    END IF;
  END IF;

  IF NEW.command_type='SUBSTITUTION_FUNDING_APPROVAL' THEN
    IF TG_OP='INSERT' AND NEW.status<>'IN_PROGRESS' THEN
      RAISE EXCEPTION 'Substitution funding approval must be claimed before completion'
        USING ERRCODE='23514';
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended(
      'vh:pharmacy_advance_approval:' || NEW.tenant_id::text || ':'
        || NEW.id::text,
      0
    )) THEN
      RAISE EXCEPTION 'Substitution funding approval is changing concurrently'
        USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.command_type NOT IN (
       'SUBSTITUTION_FUNDING_CONSUMPTION','PHARMACY_ADVANCE_SETTLEMENT',
       'PHARMACY_ADVANCE_RELEASE'
     ) THEN
    IF NEW.approval_receipt_id IS NOT NULL THEN
      RAISE EXCEPTION 'Only a substitution funding consumption receipt may name an approval receipt'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
     AND TG_OP='UPDATE'
     AND OLD.status='IN_PROGRESS'
     AND NEW.status='ABANDONED'
     AND current_setting(
       'app.pharmacy_consumption_abandonment',TRUE
     ) IS NOT DISTINCT FROM NEW.id::TEXT THEN
    RETURN NEW;
  END IF;

  IF NEW.command_type='PHARMACY_ADVANCE_RELEASE' THEN
    IF TG_OP='INSERT' AND NEW.status<>'IN_PROGRESS' THEN
      RAISE EXCEPTION 'Pharmacy advance release must be claimed before completion'
        USING ERRCODE='23514';
    END IF;
    SELECT receipt.*
      INTO approval_receipt
      FROM pharmacy_funding_commands receipt
     WHERE receipt.tenant_id=NEW.tenant_id
       AND receipt.id=NEW.approval_receipt_id
       AND receipt.pharmacy_order_id=NEW.pharmacy_order_id
       AND receipt.facility_id=NEW.facility_id
       AND receipt.invoice_id=NEW.invoice_id
       AND receipt.invoice_item_id=NEW.invoice_item_id
       AND receipt.governance_approval_id=NEW.governance_approval_id
       AND receipt.proposal_sha256=NEW.proposal_sha256
       AND receipt.proposer_uid=NEW.proposer_uid
     FOR UPDATE;
    IF NOT FOUND
       OR approval_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
       OR approval_receipt.status<>'COMPLETE'
       OR approval_receipt.approved_patient_amount<=0 THEN
      RAISE EXCEPTION 'Pharmacy advance release lacks its exact positive approval receipt'
        USING ERRCODE='23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pharmacy_funding_commands consumption
       WHERE consumption.tenant_id=NEW.tenant_id
         AND consumption.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
         AND consumption.approval_receipt_id=NEW.approval_receipt_id
         AND NOT (
           (
             consumption.status='IN_PROGRESS'
             AND consumption.response_body IS NULL
             AND consumption.completed_at IS NULL
             AND consumption.order_mutation_receipt_id IS NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM pharmacy_advance_allocation_consumptions link
                WHERE link.tenant_id=consumption.tenant_id
                  AND link.funding_consumption_receipt_id=consumption.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM tasks finance_task
                WHERE finance_task.tenant_id=consumption.tenant_id
                  AND finance_task.related_resource_type=
                      'pharmacy_advance_settlement'
                  AND finance_task.related_resource_id=consumption.id::TEXT
             )
           )
           OR (
             consumption.status='ABANDONED'
             AND consumption.order_mutation_receipt_id IS NULL
             AND consumption.response_body->>'contract'=
                 'pharmacy_substitution_funding_consumption_abandoned_v1'
             AND consumption.response_body->>'release_receipt_id'=NEW.id::TEXT
             AND NOT EXISTS (
               SELECT 1
                 FROM pharmacy_advance_allocation_consumptions link
                WHERE link.tenant_id=consumption.tenant_id
                  AND link.funding_consumption_receipt_id=consumption.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM tasks finance_task
                WHERE finance_task.tenant_id=consumption.tenant_id
                  AND finance_task.related_resource_type=
                      'pharmacy_advance_settlement'
                  AND finance_task.related_resource_id=consumption.id::TEXT
             )
           )
         )
    ) THEN
      RAISE EXCEPTION 'Only an empty in-progress consumption claim may be terminally released'
        USING ERRCODE='23514';
    END IF;
    IF NEW.release_reason='AUTHORITY_SUPERSEDED' THEN
    SELECT approval.*
      INTO release_source_approval
      FROM approvals approval
     WHERE approval.tenant_id=NEW.tenant_id
       AND approval.id=NEW.release_source_approval_id
     FOR UPDATE;
    IF NOT FOUND
       OR release_source_approval.id=NEW.governance_approval_id
       OR release_source_approval.approval_kind<>
          'pharmacy_substitution_funding_reauthorisation'
       OR release_source_approval.subject_resource_type<>
          'pharmacy_substitution_funding_proposal'
       OR release_source_approval.created_by IS NULL
       OR release_source_approval.created_by IS NOT DISTINCT FROM
          release_source_approval.decided_by
       OR release_source_approval.status<>'approved'
       OR release_source_approval.decided_by IS NULL
       OR release_source_approval.decided_at IS NULL
       OR release_source_approval.decided_at>clock_timestamp()
       OR release_source_approval.expires_at IS NULL
       OR release_source_approval.decided_at>=release_source_approval.expires_at
       OR clock_timestamp()>=release_source_approval.expires_at
       OR release_source_approval.task_id IS NULL
       OR release_source_approval.subject_resource_id IS DISTINCT FROM
          release_source_approval.metadata->>'proposal_sha256'
       OR release_source_approval.metadata->>'contract'<>
          'pharmacy_substitution_funding_reauthorisation_v1'
       OR release_source_approval.metadata->>'stage'<>
          'substitution_reauthorisation'
       OR release_source_approval.metadata->>'proposer_uid' IS DISTINCT FROM
          release_source_approval.created_by::TEXT
       OR release_source_approval.metadata->>'task_id' IS DISTINCT FROM
          release_source_approval.task_id::TEXT
       OR release_source_approval.metadata->>'task_resource_type' IS NULL
       OR release_source_approval.metadata->>'supersedes_approval_id'
          IS DISTINCT FROM NEW.governance_approval_id::text
       OR release_source_approval.metadata->>'pharmacy_order_id'
          IS DISTINCT FROM NEW.pharmacy_order_id::text
       OR release_source_approval.metadata->>'facility_id'
          IS DISTINCT FROM NEW.facility_id::text
       OR release_source_approval.metadata->>'invoice_id'
          IS DISTINCT FROM NEW.invoice_id::text
       OR release_source_approval.metadata->>'invoice_item_id'
          IS DISTINCT FROM NEW.invoice_item_id::text
       OR release_source_approval.metadata->>'release_task_id'
          IS DISTINCT FROM NEW.task_id::text
       OR release_source_approval.subject_resource_id IS NOT DISTINCT FROM
           NEW.proposal_sha256
       OR jsonb_typeof(release_source_approval.metadata->'selector')
          IS DISTINCT FROM 'object'
       OR jsonb_typeof(release_source_approval.metadata->'authority')
          IS DISTINCT FROM 'object'
       OR jsonb_typeof(
            release_source_approval.metadata->'permitted_approver_roles'
          ) IS DISTINCT FROM 'array'
       OR release_source_approval.metadata #>>
            '{authority,base,pharmacy_order_id}' IS DISTINCT FROM
          NEW.pharmacy_order_id::TEXT
       OR release_source_approval.metadata #>> '{authority,base,facility_id}'
          IS DISTINCT FROM NEW.facility_id::TEXT
       OR release_source_approval.metadata #>> '{authority,base,patient_uid}'
          IS DISTINCT FROM NEW.patient_uid::TEXT
       OR release_source_approval.metadata #>>
            '{authority,base,facility_grant_id}' !~ '^[1-9][0-9]*$'
       OR release_source_approval.metadata #>>
            '{authority,base,order_version}' !~ '^[1-9][0-9]*$'
       OR release_source_approval.metadata #>>
            '{authority,base,order_items_sha256}' !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(
            release_source_approval.metadata #> '{authority,base,items_list}'
          ) IS DISTINCT FROM 'array'
       OR jsonb_typeof(
            release_source_approval.metadata #> '{authority,prospective}'
          ) IS DISTINCT FROM 'object'
       OR jsonb_typeof(
            release_source_approval.metadata #> '{authority,billing}'
          ) IS DISTINCT FROM 'object'
       OR jsonb_typeof(
            release_source_approval.metadata #> '{authority,funding}'
          ) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Pharmacy advance release lacks an exact approved superseding authority'
        USING ERRCODE='23514';
    END IF;
    BEGIN
      release_source_grant_id:=(release_source_approval.metadata #>>
        '{authority,base,facility_grant_id}')::BIGINT;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Pharmacy advance release source grant is malformed'
          USING ERRCODE='23514';
    END;
    SELECT task.*
      INTO release_source_task
      FROM tasks task
     WHERE task.tenant_id=NEW.tenant_id
       AND task.id=release_source_approval.task_id
     FOR UPDATE;
    SELECT proposer.role
      INTO release_source_proposer_role
      FROM users proposer
     WHERE proposer.tenant_id=NEW.tenant_id
       AND proposer.uid=release_source_approval.created_by
       AND proposer.role IN ('PHARMACY_STAFF','PHARMACY_INCHARGE')
       AND proposer.is_active=TRUE
       AND proposer.status='active'
       AND COALESCE(proposer.is_deleted,FALSE)=FALSE
       AND proposer.merged_into_uid IS NULL
     FOR UPDATE;
    SELECT decider.role
      INTO release_source_decider_role
      FROM users decider
     WHERE decider.tenant_id=NEW.tenant_id
       AND decider.uid=release_source_approval.decided_by
       AND decider.is_active=TRUE
       AND decider.status='active'
       AND COALESCE(decider.is_deleted,FALSE)=FALSE
       AND decider.merged_into_uid IS NULL
     FOR UPDATE;
    SELECT EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          release_source_approval.metadata->'permitted_approver_roles'
        ) permitted_role(role)
       WHERE permitted_role.role=release_source_decider_role
    ) INTO release_source_role_permitted;
    IF release_source_task.id IS NULL
       OR release_source_task.task_kind<>'review'
       OR release_source_task.status<>'completed'
       OR release_source_task.completed_at IS NULL
       OR release_source_task.created_by IS DISTINCT FROM
          release_source_approval.created_by
       OR release_source_task.workflow_run_id IS DISTINCT FROM
          release_source_approval.workflow_run_id
       OR release_source_task.workflow_step_id IS DISTINCT FROM
          release_source_approval.workflow_step_id
       OR release_source_task.related_resource_type IS DISTINCT FROM
          release_source_approval.metadata->>'task_resource_type'
       OR release_source_task.related_resource_id IS DISTINCT FROM
          NEW.pharmacy_order_id::TEXT
       OR release_source_task.metadata->>'contract'<>
          'pharmacy_substitution_funding_task_v1'
       OR release_source_task.metadata->>'stage'<>
          'substitution_reauthorisation'
       OR release_source_task.metadata->>'approval_id' IS DISTINCT FROM
          release_source_approval.id::TEXT
       OR release_source_task.metadata->>'proposal_sha256' IS DISTINCT FROM
          release_source_approval.subject_resource_id
       OR release_source_task.metadata->>'proposer_uid' IS DISTINCT FROM
          release_source_approval.created_by::TEXT
       OR release_source_task.metadata->>'facility_id' IS DISTINCT FROM
          NEW.facility_id::TEXT
       OR release_source_task.metadata->>'patient_uid' IS DISTINCT FROM
          NEW.patient_uid::TEXT
       OR release_source_task.metadata->>'pharmacy_order_id' IS DISTINCT FROM
          NEW.pharmacy_order_id::TEXT
       OR release_source_task.metadata->>'invoice_id' IS DISTINCT FROM
          NEW.invoice_id::TEXT
       OR release_source_task.metadata->>'invoice_item_id' IS DISTINCT FROM
          NEW.invoice_item_id::TEXT
       OR release_source_proposer_role IS NULL
       OR release_source_decider_role IS NULL
       OR NOT release_source_role_permitted THEN
      RAISE EXCEPTION 'Pharmacy advance release source workflow authority is stale'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1
      FROM staff proposer_staff
     WHERE proposer_staff.tenant_id=NEW.tenant_id
       AND proposer_staff.user_id=release_source_approval.created_by
       AND proposer_staff.is_active=TRUE
       AND proposer_staff.archived=FALSE
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance release source proposer staff is stale'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1
      FROM staff decider_staff
     WHERE decider_staff.tenant_id=NEW.tenant_id
       AND decider_staff.user_id=release_source_approval.decided_by
       AND decider_staff.is_active=TRUE
       AND decider_staff.archived=FALSE
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance release source decider staff is stale'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1
      FROM pharmacy_staff_facility_grants facility_grant
     WHERE facility_grant.tenant_id=NEW.tenant_id
       AND facility_grant.id=release_source_grant_id
       AND facility_grant.staff_uid=release_source_approval.created_by
       AND facility_grant.facility_id=NEW.facility_id
       AND facility_grant.status='active'
       AND facility_grant.revoked_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance release source facility grant is stale'
        USING ERRCODE='23514';
    END IF;
    ELSIF NEW.release_reason='AUTHORITY_EXPIRED' THEN
      IF NEW.release_source_approval_id IS NOT NULL
         OR governance_approval.expires_at IS NULL
         OR clock_timestamp()<governance_approval.expires_at THEN
        RAISE EXCEPTION 'Pharmacy advance expiry release requires an expired immutable approval'
          USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Pharmacy advance release reason has no governed authority source'
        USING ERRCODE='23514';
    END IF;
    SELECT actor.role
      INTO release_actor_role
      FROM users actor
     WHERE actor.tenant_id=NEW.tenant_id
       AND actor.uid=NEW.created_by
       AND actor.role='PHARMACY_INCHARGE'
       AND actor.is_active=TRUE
       AND actor.status='active'
       AND COALESCE(actor.is_deleted,FALSE)=FALSE
       AND actor.merged_into_uid IS NULL
     FOR UPDATE;
    IF release_actor_role IS NULL
       OR (
         NEW.release_reason='AUTHORITY_SUPERSEDED'
         AND NEW.created_by IS NOT DISTINCT FROM release_source_approval.decided_by
       )
       OR (
         NEW.release_reason='AUTHORITY_EXPIRED'
         AND NEW.created_by IS NOT DISTINCT FROM governance_approval.decided_by
       ) THEN
      RAISE EXCEPTION 'Pharmacy advance release requires a distinct live pharmacy executor'
        USING ERRCODE='42501';
    END IF;
    PERFORM 1
      FROM staff staff_identity
     WHERE staff_identity.tenant_id=NEW.tenant_id
       AND staff_identity.user_id=NEW.created_by
       AND staff_identity.is_active=TRUE
       AND staff_identity.archived=FALSE
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance release executor lacks active staff authority'
        USING ERRCODE='42501';
    END IF;
    PERFORM 1
      FROM pharmacy_staff_facility_grants facility_grant
     WHERE facility_grant.tenant_id=NEW.tenant_id
       AND facility_grant.staff_uid=NEW.created_by
       AND facility_grant.facility_id=NEW.facility_id
       AND facility_grant.status='active'
       AND facility_grant.revoked_at IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance release executor lacks exact facility authority'
        USING ERRCODE='42501';
    END IF;
    SELECT task.*
      INTO release_task
      FROM tasks task
     WHERE task.tenant_id=NEW.tenant_id
       AND task.id=NEW.task_id
       AND task.related_resource_type=NEW.task_resource_type
       AND task.related_resource_id=NEW.task_resource_id
     FOR UPDATE;
    IF NOT FOUND
       OR release_task.task_kind<>'review'
       OR release_task.assigned_to_role<>'PHARMACY_INCHARGE'
       OR release_task.priority<>'high'
       OR release_task.metadata->>'contract'<>'pharmacy_advance_release_task_v1'
       OR release_task.metadata->>'reason'<>NEW.release_reason
       OR release_task.metadata->>'approval_receipt_id'<>
          NEW.approval_receipt_id::text
       OR (
         NEW.release_reason='AUTHORITY_SUPERSEDED'
         AND release_task.metadata->>'source_approval_id' IS DISTINCT FROM
             NEW.release_source_approval_id::text
       )
       OR (
         NEW.release_reason='AUTHORITY_EXPIRED'
         AND (
           NOT release_task.metadata ? 'source_approval_id'
           OR jsonb_typeof(release_task.metadata->'source_approval_id')<>'null'
         )
       )
       OR release_task.metadata->>'pharmacy_order_id'<>
          NEW.pharmacy_order_id::text
       OR release_task.metadata->>'invoice_id'<>NEW.invoice_id::text
       OR release_task.metadata->>'invoice_item_id'<>NEW.invoice_item_id::text
       OR (TG_OP='INSERT' AND release_task.status<>'open')
       OR (TG_OP='UPDATE' AND NEW.status='COMPLETE'
          AND release_task.status<>'completed') THEN
      RAISE EXCEPTION 'Pharmacy advance release lacks its exact governed release task'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.command_type='PHARMACY_ADVANCE_SETTLEMENT' THEN
    IF TG_OP='INSERT' AND NEW.status<>'IN_PROGRESS' THEN
      RAISE EXCEPTION 'Pharmacy advance settlement must be claimed before completion'
        USING ERRCODE='23514';
    END IF;
    SELECT receipt.*
      INTO approval_receipt
      FROM pharmacy_funding_commands receipt
     WHERE receipt.tenant_id=NEW.tenant_id
        AND receipt.id=NEW.approval_receipt_id
        AND receipt.pharmacy_order_id=NEW.pharmacy_order_id
        AND receipt.facility_id=NEW.facility_id
        AND receipt.invoice_id=NEW.invoice_id
        AND receipt.invoice_item_id=NEW.invoice_item_id
       AND receipt.governance_approval_id=NEW.governance_approval_id
       AND receipt.proposal_sha256=NEW.proposal_sha256
       AND receipt.proposer_uid=NEW.proposer_uid
     FOR UPDATE;
    IF NOT FOUND
       OR approval_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
       OR approval_receipt.status<>'COMPLETE'
       OR approval_receipt.task_id IS DISTINCT FROM governance_approval.task_id THEN
      RAISE EXCEPTION 'Pharmacy advance settlement lacks its exact completed approval receipt'
        USING ERRCODE='23514';
    END IF;
    SELECT receipt.*
      INTO consumption_receipt
      FROM pharmacy_funding_commands receipt
     WHERE receipt.tenant_id=NEW.tenant_id
       AND receipt.id=NEW.consumption_receipt_id
       AND receipt.command_type='SUBSTITUTION_FUNDING_CONSUMPTION'
       AND receipt.status='COMPLETE'
        AND receipt.approval_receipt_id=NEW.approval_receipt_id
        AND receipt.pharmacy_order_id=NEW.pharmacy_order_id
        AND receipt.facility_id=NEW.facility_id
        AND receipt.invoice_id=NEW.invoice_id
        AND receipt.invoice_item_id=NEW.invoice_item_id
       AND receipt.governance_approval_id=NEW.governance_approval_id
       AND receipt.proposal_sha256=NEW.proposal_sha256
       AND receipt.proposer_uid=NEW.proposer_uid
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance settlement lacks its exact completed consumption receipt'
        USING ERRCODE='23514';
    END IF;
    SELECT task.*
      INTO finance_task
      FROM tasks task
     WHERE task.tenant_id=NEW.tenant_id
       AND task.id=NEW.task_id
       AND task.related_resource_type=NEW.task_resource_type
       AND task.related_resource_id=NEW.task_resource_id
     FOR UPDATE;
    IF NOT FOUND
       OR finance_task.task_kind<>'review'
       OR finance_task.related_resource_type<>'pharmacy_advance_settlement'
       OR finance_task.related_resource_id<>NEW.consumption_receipt_id::text
       OR finance_task.assigned_to_role<>'FINANCE_INCHARGE'
       OR finance_task.priority<>'high'
       OR finance_task.patient_uid IS DISTINCT FROM NEW.patient_uid
       OR finance_task.metadata->>'contract'<>
          'pharmacy_advance_settlement_task_v1'
       OR finance_task.metadata->>'stage'<>'awaiting_finance_settlement'
       OR finance_task.metadata->>'approval_receipt_id'<>
          NEW.approval_receipt_id::text
       OR finance_task.metadata->>'consumption_receipt_id'<>
          NEW.consumption_receipt_id::text
       OR finance_task.metadata->>'pharmacy_order_id'<>
          NEW.pharmacy_order_id::text
       OR finance_task.metadata->>'invoice_id'<>
          NEW.invoice_id::text
       OR finance_task.metadata->>'invoice_item_id'<>
           NEW.invoice_item_id::text
       OR finance_task.metadata IS DISTINCT FROM jsonb_build_object(
         'contract','pharmacy_advance_settlement_task_v1',
         'stage','awaiting_finance_settlement',
         'approval_id',approval_receipt.response_body->'approval_id',
         'approval_receipt_id',NEW.approval_receipt_id::text,
         'consumption_receipt_id',NEW.consumption_receipt_id::text,
         'funding_task_id',approval_receipt.task_id,
         'pharmacy_order_id',NEW.pharmacy_order_id,
         'invoice_id',NEW.invoice_id,
         'invoice_item_id',NEW.invoice_item_id,
         'patient_uid',NEW.patient_uid::text,
         'allocation_ids',consumption_receipt.response_body->'allocation_ids',
         'mutation_command_sha256',consumption_receipt.response_body #>>
           '{mutation,command_sha256}',
         'mutation_evidence_sha256',consumption_receipt.response_body #>>
           '{mutation,evidence_sha256}',
         'permitted_roles',jsonb_build_array(
           'FINANCE_INCHARGE','BILLING_INCHARGE'
         )
       )
       OR (TG_OP='INSERT' AND finance_task.status<>'open')
       OR (TG_OP='UPDATE' AND NEW.status='COMPLETE'
          AND finance_task.status<>'completed') THEN
      RAISE EXCEPTION 'Pharmacy advance settlement command lacks its exact finance task'
        USING ERRCODE='23514';
    END IF;
    SELECT actor.role
      INTO finance_actor_role
      FROM users actor
     WHERE actor.tenant_id=NEW.tenant_id
       AND actor.uid=NEW.created_by
       AND actor.role IN ('FINANCE_INCHARGE','BILLING_INCHARGE')
       AND actor.is_active=TRUE
       AND actor.status='active'
       AND COALESCE(actor.is_deleted,FALSE)=FALSE
       AND actor.merged_into_uid IS NULL
     FOR UPDATE;
    IF finance_actor_role IS NULL THEN
      RAISE EXCEPTION 'Pharmacy advance settlement actor lacks governed finance authority'
        USING ERRCODE='23514';
    END IF;
    PERFORM 1
      FROM staff staff_identity
     WHERE staff_identity.tenant_id=NEW.tenant_id
       AND staff_identity.user_id=NEW.created_by
       AND staff_identity.is_active=TRUE
       AND staff_identity.archived=FALSE
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance settlement actor lacks governed finance staff authority'
        USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND NEW.status='COMPLETE' AND (
         NEW.response_body->>'contract'<>'pharmacy_advance_settlement_v1'
         OR NEW.response_body->>'status'<>'settled_to_invoice'
         OR NEW.response_body->>'finance_task_id' IS DISTINCT FROM
              NEW.task_id::text
         OR NEW.response_body->>'approval_receipt_id' IS DISTINCT FROM
              NEW.approval_receipt_id::text
         OR NEW.response_body->>'consumption_receipt_id' IS DISTINCT FROM
              NEW.consumption_receipt_id::text
          OR NEW.response_body->>'pharmacy_order_id' IS DISTINCT FROM
               NEW.pharmacy_order_id::text
          OR NEW.response_body->>'invoice_id' IS DISTINCT FROM
               NEW.invoice_id::text
         OR NEW.response_body->>'invoice_item_id' IS DISTINCT FROM
              NEW.invoice_item_id::text
         OR NEW.response_body->>'settled_by' IS DISTINCT FROM
              NEW.created_by::text
       ) THEN
      RAISE EXCEPTION 'Pharmacy advance settlement completion does not bind its exact finance source'
        USING ERRCODE='23514';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'vh:pharmacy_advance_approval:' || NEW.tenant_id::text || ':'
        || NEW.approval_receipt_id::text,
      0
    ));
    RETURN NEW;
  END IF;

  IF TG_OP='INSERT' AND NEW.status<>'IN_PROGRESS' THEN
    RAISE EXCEPTION 'Substitution funding consumption must be claimed before completion'
      USING ERRCODE='23514';
  END IF;

  SELECT receipt.*
    INTO approval_receipt
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.approval_receipt_id
     AND receipt.task_id=NEW.task_id
     AND receipt.pharmacy_order_id=NEW.pharmacy_order_id
     AND receipt.facility_id=NEW.facility_id
     AND receipt.invoice_id=NEW.invoice_id
     AND receipt.invoice_item_id=NEW.invoice_item_id
   FOR UPDATE;

  IF NOT FOUND
     OR approval_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
     OR approval_receipt.status<>'COMPLETE'
     OR approval_receipt.response_body IS NULL
     OR approval_receipt.completed_at IS NULL
     OR approval_receipt.tpa_claim_id IS DISTINCT FROM NEW.tpa_claim_id
     OR approval_receipt.governance_approval_id IS DISTINCT FROM
          NEW.governance_approval_id
     OR approval_receipt.proposal_sha256 IS DISTINCT FROM NEW.proposal_sha256
     OR approval_receipt.proposer_uid IS DISTINCT FROM NEW.proposer_uid
     OR NEW.created_by IS DISTINCT FROM NEW.proposer_uid
     OR approval_receipt.created_by=NEW.proposer_uid
     OR approval_receipt.id=NEW.id THEN
    RAISE EXCEPTION 'Substitution funding consumption receipt lacks its exact completed approval receipt'
      USING ERRCODE='23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || NEW.tenant_id::text || ':'
      || NEW.approval_receipt_id::text,
    0
  ));
  IF EXISTS (
    SELECT 1
      FROM pharmacy_advance_allocations allocation
      JOIN pharmacy_advance_allocation_reversals reversal
        ON reversal.tenant_id=allocation.tenant_id
       AND reversal.allocation_id=allocation.id
     WHERE allocation.tenant_id=NEW.tenant_id
       AND allocation.funding_approval_receipt_id=NEW.approval_receipt_id
  ) THEN
    RAISE EXCEPTION 'A reversed pharmacy advance approval cannot be consumed'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_funding_reconciliation_case_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'pharmacy funding reconciliation cases cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF NEW.id<>OLD.id
     OR NEW.tenant_id<>OLD.tenant_id
     OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.patient_uid<>OLD.patient_uid
     OR NEW.pharmacy_order_id<>OLD.pharmacy_order_id
     OR NEW.task_id<>OLD.task_id
     OR NEW.task_resource_type<>OLD.task_resource_type
     OR NEW.task_resource_id<>OLD.task_resource_id
     OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'pharmacy funding reconciliation case identity and snapshot are immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status='RESOLVED' THEN
    RAISE EXCEPTION 'resolved pharmacy funding reconciliation cases are immutable'
      USING ERRCODE='55000';
  END IF;
  IF (NEW.snapshot_sha256<>OLD.snapshot_sha256 OR NEW.snapshot<>OLD.snapshot)
     AND NOT (OLD.status IN ('OPEN','BLOCKED') AND NEW.status='PENDING_APPROVAL') THEN
    RAISE EXCEPTION 'reconciliation snapshot may only rebase with a new governed proposal'
      USING ERRCODE='55000';
  END IF;
  IF (OLD.status IN ('OPEN','BLOCKED') AND NEW.status='PENDING_APPROVAL')
     OR (OLD.status='PENDING_APPROVAL' AND NEW.status IN ('BLOCKED','RESOLVED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal pharmacy funding reconciliation case transition'
    USING ERRCODE='55000';
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_grn_item_qc_immutable_supply_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Goods receipt lines are custody evidence and cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF OLD.qc_status IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'Completed goods receipt line QC evidence is immutable'
      USING ERRCODE='55000';
  END IF;
  IF to_jsonb(NEW) - ARRAY['qc_status','qc_notes','metadata','updated_at']
       IS DISTINCT FROM
     to_jsonb(OLD) - ARRAY['qc_status','qc_notes','metadata','updated_at']
     OR COALESCE(OLD.qc_status, 'pending')<>'pending'
     OR NEW.qc_status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'Goods receipt line changes require one terminal QC decision'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_grn_lifecycle_supply_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Goods receipts are custody evidence and cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.grn_number IS DISTINCT FROM OLD.grn_number
     OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.received_by IS DISTINCT FROM OLD.received_by
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Goods receipt custody identity is immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status IN ('rejected', 'archived') THEN
    RAISE EXCEPTION 'Terminal goods receipts are immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status='closed' AND NEW.status='archived' THEN RETURN NEW; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='received' AND NEW.status IN ('qc_pending', 'rejected'))
    OR (OLD.status='qc_pending' AND NEW.status IN ('qc_passed', 'qc_failed', 'partial', 'rejected'))
    OR (OLD.status IN ('qc_passed', 'partial') AND NEW.status='closed')
    OR (OLD.status='qc_failed' AND NEW.status='archived')
  ) THEN
    RAISE EXCEPTION 'Goods receipt status transition is not governed'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_pharmacy_supply_receipt_immutable_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  old_contract TEXT := OLD.metadata->>'contract';
  new_contract TEXT := CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.metadata->>'contract' END;
  receipt_key TEXT;
  receipt_facility TEXT;
BEGIN
  IF old_contract IS NULL OR old_contract NOT IN (
    'pharmacy_inventory_direct_receive_v1',
    'pharmacy_grn_receive_line_v1',
    'pharmacy_supply_stock_movement_v1'
  ) THEN
    IF TG_OP<>'DELETE' AND new_contract IN (
      'pharmacy_inventory_direct_receive_v1',
      'pharmacy_grn_receive_line_v1',
      'pharmacy_supply_stock_movement_v1'
    ) THEN
      RAISE EXCEPTION 'A legacy movement cannot be rewritten as a pharmacy supply command receipt'
        USING ERRCODE='55000';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Pharmacy supply command receipts cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF new_contract IS DISTINCT FROM old_contract
     OR to_jsonb(NEW) - 'metadata' IS DISTINCT FROM to_jsonb(OLD) - 'metadata' THEN
    RAISE EXCEPTION 'Pharmacy supply command identity and movement evidence are immutable'
      USING ERRCODE='55000';
  END IF;

  receipt_key := CASE
    WHEN old_contract='pharmacy_supply_stock_movement_v1' THEN 'response'
    ELSE 'response_payload'
  END;
  IF OLD.metadata ? receipt_key THEN
    IF NEW.metadata IS DISTINCT FROM OLD.metadata THEN
      RAISE EXCEPTION 'Completed pharmacy supply command receipts are immutable'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (NEW.metadata ? receipt_key)
     OR NEW.metadata - receipt_key IS DISTINCT FROM OLD.metadata THEN
    RAISE EXCEPTION 'Only one immutable pharmacy supply response may complete a command receipt'
      USING ERRCODE='55000';
  END IF;
  receipt_facility := CASE old_contract
    WHEN 'pharmacy_supply_stock_movement_v1'
      THEN NEW.metadata#>>'{response,facility_id}'
    WHEN 'pharmacy_grn_receive_line_v1'
      THEN COALESCE(
        NEW.metadata#>>'{response_payload,goods_receipt,facility_id}',
        NEW.metadata#>>'{response_payload,batch,facility_id}'
      )
    ELSE NEW.metadata#>>'{response_payload,facility_id}'
  END;
  IF receipt_facility IS NULL OR receipt_facility !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'Pharmacy supply response receipt requires a positive stored facility authority'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pharmacy_inventory_batches batch
     WHERE batch.tenant_id=OLD.tenant_id
       AND batch.id=OLD.inventory_batch_id
       AND batch.inventory_item_id=OLD.inventory_item_id
       AND batch.facility_id::text=receipt_facility
  ) THEN
    RAISE EXCEPTION 'Pharmacy supply response receipt facility does not match its immutable batch lineage'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_tpa_claim_authority_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  reference_admission_id INTEGER;
  reference_preauth_id INTEGER;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.preauth_id IS DISTINCT FROM OLD.preauth_id
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
    OR NEW.claim_type IS DISTINCT FROM OLD.claim_type
    OR NEW.stage IS DISTINCT FROM OLD.stage
    OR NEW.parent_claim_id IS DISTINCT FROM OLD.parent_claim_id
    OR NEW.total_billed IS DISTINCT FROM OLD.total_billed
    OR NEW.patient_copay IS DISTINCT FROM OLD.patient_copay
    OR NEW.non_payable_amount IS DISTINCT FROM OLD.non_payable_amount
    OR NEW.claimed_amount IS DISTINCT FROM OLD.claimed_amount
  ) THEN
    RAISE EXCEPTION 'TPA claim authority identity and billed amounts are immutable'
      USING ERRCODE='55000';
  END IF;
  IF NEW.preauth_id IS NOT NULL THEN
    SELECT admission_id INTO reference_admission_id
      FROM insurance_preauth
     WHERE tenant_id=NEW.tenant_id
       AND id=NEW.preauth_id
       AND patient_uid=NEW.patient_uid
       AND policy_id=NEW.policy_id;
    IF NOT FOUND OR reference_admission_id IS DISTINCT FROM NEW.admission_id THEN
      RAISE EXCEPTION 'claim pre-auth is not bound to the exact patient policy and admission'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.parent_claim_id IS NOT NULL THEN
    SELECT admission_id,preauth_id INTO reference_admission_id,reference_preauth_id
      FROM tpa_claims
     WHERE tenant_id=NEW.tenant_id
       AND id=NEW.parent_claim_id
       AND patient_uid=NEW.patient_uid
       AND policy_id=NEW.policy_id;
    IF NOT FOUND
       OR reference_admission_id IS DISTINCT FROM NEW.admission_id
       OR (NEW.preauth_id IS NOT NULL AND reference_preauth_id IS DISTINCT FROM NEW.preauth_id) THEN
      RAISE EXCEPTION 'parent claim is not bound to the exact patient policy pre-auth and admission'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT admission_id INTO reference_admission_id
      FROM billing_invoices
     WHERE tenant_id=NEW.tenant_id
       AND id=NEW.invoice_id
       AND patient_uid=NEW.patient_uid;
    IF NOT FOUND OR reference_admission_id IS DISTINCT FROM NEW.admission_id THEN
      RAISE EXCEPTION 'claim invoice is not bound to the exact patient and admission'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.guard_pharmacy_order_delivery_custody_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- The custody contract is demanded only where custody actually exists.
  -- DISPATCHED and DELIVERED are custody-bearing by definition: a courier is
  -- holding, or has handed over, a sealed package. UNAVAILABLE is not — it is
  -- reachable from PENDING, CONFIRMED, PREPARING, READY, ON_HOLD, REJECTED and
  -- PARTIALLY_DISPENSED (see the transition table below), where no package was
  -- ever issued and no custody was ever taken. Demanding a contract version
  -- there would force the caller to stamp `delivery_custody_contract_version=1`
  -- on an order that never had a courier, asserting custody that never
  -- happened; it would also make the pre-dispatch unavailable path unreachable
  -- for every delivery order. So the requirement is keyed on the PRE-IMAGE:
  -- UNAVAILABLE needs a contract only when the row was already custody-bearing.
  -- Legacy rows dispatched before this migration have OLD.status='DISPATCHED'
  -- with a NULL contract version, so they stay blocked here and must be
  -- resolved through the ORDER_DELIVERY_CUSTODY_UNRESOLVED worklist rather than
  -- closed as unavailable. The custody shape required of an UNAVAILABLE order
  -- that DOES carry a contract is enforced separately by
  -- chk_pharmacy_orders_delivery_handoff_lifecycle_753.
  IF NEW.delivery_type='delivery'
     AND (
       NEW.status IN ('DISPATCHED','DELIVERED')
       OR (
         NEW.status='UNAVAILABLE'
         AND (
           OLD.status IN ('DISPATCHED','DELIVERED')
           OR OLD.delivery_custody_contract_version IS NOT NULL
           OR OLD.delivery_custody_status IS NOT NULL
         )
       )
     )
     AND NEW.delivery_custody_contract_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'delivery custody contract is required before dispatch or delivery'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_custody_contract_753';
  END IF;
  IF OLD.delivery_custody_contract_version=1
     AND NEW.delivery_custody_contract_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'delivery custody contract cannot be removed after package issue'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_custody_contract_753';
  END IF;
  IF OLD.delivery_assignee_uid IS NOT NULL AND (
    (NEW.delivery_assignee_uid IS DISTINCT FROM OLD.delivery_assignee_uid
      OR NEW.delivery_handoff_token_sha256 IS DISTINCT FROM OLD.delivery_handoff_token_sha256
       OR NEW.delivery_handoff_expires_at IS DISTINCT FROM OLD.delivery_handoff_expires_at
       OR NEW.delivery_handoff_generation IS DISTINCT FROM OLD.delivery_handoff_generation
       OR NEW.delivery_handoff_notice_outbox_ids IS DISTINCT FROM OLD.delivery_handoff_notice_outbox_ids)
      AND NOT (
        current_setting('app.pharmacy_delivery_handoff_reissue', TRUE)='on'
        AND OLD.status='DISPATCHED' AND OLD.delivery_custody_status='in_transit'
        AND OLD.delivery_handoff_consumed_at IS NULL
        AND NEW.status='DISPATCHED' AND NEW.delivery_custody_status='in_transit'
        AND NEW.delivery_handoff_consumed_at IS NULL
        AND NEW.delivery_handoff_completed_by IS NULL
        AND NEW.delivery_handoff_generation=OLD.delivery_handoff_generation+1
      )
  ) THEN
    RAISE EXCEPTION 'delivery assignee and handoff authority are immutable after dispatch'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_custody_immutable_753';
  END IF;
  IF OLD.delivery_handoff_consumed_at IS NOT NULL AND (
    NEW.delivery_handoff_consumed_at IS DISTINCT FROM OLD.delivery_handoff_consumed_at
    OR NEW.delivery_handoff_completed_by IS DISTINCT FROM OLD.delivery_handoff_completed_by
  ) THEN
    RAISE EXCEPTION 'consumed delivery handoff evidence is immutable'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_handoff_consumed_753';
  END IF;
  IF OLD.delivery_custody_status IS NOT NULL
     AND NEW.delivery_custody_status IS DISTINCT FROM OLD.delivery_custody_status
     AND NOT (
       (OLD.delivery_custody_status='in_transit'
         AND NEW.delivery_custody_status IN ('delivered','return_pending'))
       OR (OLD.delivery_custody_status='return_pending'
         AND NEW.delivery_custody_status IN ('returned','quarantined'))
     ) THEN
    RAISE EXCEPTION 'invalid delivery custody transition'
      USING ERRCODE='23514', CONSTRAINT='chk_pharmacy_order_delivery_custody_transition_753';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.guard_ward_indent_facility_authority_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.facility_id IS DISTINCT FROM OLD.facility_id
     OR NEW.facility_authority_version IS DISTINCT FROM OLD.facility_authority_version THEN
    IF OLD.facility_id IS NULL
       AND NEW.facility_id IS NOT NULL
       AND NEW.facility_authority_version=OLD.facility_authority_version+1
       AND EXISTS (
         SELECT 1
           FROM pharmacy_inventory_authority_recovery_worklist recovery
          WHERE recovery.tenant_id=OLD.tenant_id
            AND recovery.id=NULLIF(
              current_setting('app.pharmacy_ward_indent_facility_recovery_id', TRUE), ''
            )::bigint
            AND recovery.entity_type='ward_indent'
            AND recovery.entity_id=OLD.id
            AND recovery.reason_code='WARD_INDENT_FACILITY_UNRESOLVED'
            AND recovery.status='OPEN'
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ward indent facility authority is immutable after creation'
      USING ERRCODE='23514', CONSTRAINT='chk_ward_indent_facility_immutable_753';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.invalidate_pharmacy_order_patient_change_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    NEW.inventory_authority_version := COALESCE(OLD.inventory_authority_version, 1) + 1;
    NEW.clinical_verification_status := 'pending';
    NEW.clinically_verified_by := NULL;
    NEW.clinically_verified_at := NULL;
    NEW.clinical_verification_notes := NULL;
    NEW.clinically_verified_order_version := NULL;
    NEW.clinical_verification_items_sha256 := NULL;
    NEW.clinical_verification_catalog_sha256 := NULL;
    NEW.clinical_verification_active_therapy_sha256 := NULL;
    NEW.clinical_verification_safety_version := NULL;
    NEW.clinical_verification_kb_version := NULL;
    NEW.clinical_verification_ruleset_version := NULL;
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.lock_pharmacy_advance_reservation_sources_753(target_tenant_id uuid, target_terminal_patient_uid uuid, target_pharmacy_order_id integer, target_invoice_id integer, target_invoice_item_id integer, target_tpa_claim_id integer, target_advance_ids integer[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  target_admission_id INTEGER;
  locked_advance_count INTEGER;
BEGIN
  PERFORM 1
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=target_pharmacy_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation order changed before lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM 1
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.uid=target_terminal_patient_uid
     AND patient.role='PATIENT'
     AND patient.merged_into_uid IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation patient changed before lock'
      USING ERRCODE='40001';
  END IF;
  SELECT invoice.admission_id
    INTO target_admission_id
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=target_invoice_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation invoice changed before lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM 1
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=target_invoice_id
     AND item.id=target_invoice_item_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation invoice item changed before lock'
      USING ERRCODE='40001';
  END IF;
  IF target_admission_id IS NOT NULL THEN
    PERFORM 1
      FROM admissions admission
     WHERE admission.tenant_id=target_tenant_id
       AND admission.id=target_admission_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance reservation admission changed before lock'
        USING ERRCODE='40001';
    END IF;
  END IF;
  PERFORM 1
    FROM billing_payments payment
   WHERE payment.tenant_id=target_tenant_id
     AND payment.invoice_id=target_invoice_id
   ORDER BY payment.id
   FOR UPDATE;
  PERFORM 1
    FROM billing_refunds refund
   WHERE refund.tenant_id=target_tenant_id
     AND refund.invoice_id=target_invoice_id
   ORDER BY refund.id
   FOR UPDATE;
  PERFORM 1
    FROM billing_advance_settlements settlement
   WHERE settlement.tenant_id=target_tenant_id
     AND settlement.invoice_id=target_invoice_id
   ORDER BY settlement.id
   FOR UPDATE;
  IF target_tpa_claim_id IS NOT NULL THEN
    PERFORM 1
      FROM tpa_claims claim
     WHERE claim.tenant_id=target_tenant_id
       AND claim.id=target_tpa_claim_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance reservation TPA claim changed before lock'
        USING ERRCODE='40001';
    END IF;
    PERFORM 1
      FROM tpa_claim_line_decisions decision
     WHERE decision.tenant_id=target_tenant_id
       AND decision.claim_id=target_tpa_claim_id
       AND decision.invalidated_at IS NULL
     ORDER BY decision.id
     FOR UPDATE;
  END IF;
  SELECT COUNT(*)
    INTO locked_advance_count
    FROM (
      SELECT advance.id
        FROM billing_advances advance
       WHERE advance.tenant_id=target_tenant_id
         AND advance.id=ANY(COALESCE(target_advance_ids,'{}'::INTEGER[]))
       ORDER BY advance.collected_at,advance.id
       FOR UPDATE
    ) locked_advances;
  IF locked_advance_count<>CARDINALITY(COALESCE(target_advance_ids,'{}'::INTEGER[])) THEN
    RAISE EXCEPTION 'Pharmacy advance reservation source set changed before lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM 1
    FROM billing_advance_settlements settlement
   WHERE settlement.tenant_id=target_tenant_id
     AND settlement.advance_id=ANY(COALESCE(target_advance_ids,'{}'::INTEGER[]))
   ORDER BY settlement.advance_id,settlement.id
   FOR UPDATE;
  PERFORM 1
    FROM billing_refunds refund
   WHERE refund.tenant_id=target_tenant_id
     AND refund.advance_id=ANY(COALESCE(target_advance_ids,'{}'::INTEGER[]))
   ORDER BY refund.advance_id,refund.id
   FOR UPDATE;
  PERFORM 1
    FROM pharmacy_advance_allocations allocation
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.billing_advance_id=ANY(
       COALESCE(target_advance_ids,'{}'::INTEGER[])
     )
   ORDER BY allocation.billing_advance_id,allocation.id
   FOR UPDATE;
  PERFORM 1
    FROM pharmacy_advance_allocation_reversals reversal
   WHERE reversal.tenant_id=target_tenant_id
     AND EXISTS (
       SELECT 1
         FROM pharmacy_advance_allocations allocation
        WHERE allocation.tenant_id=reversal.tenant_id
          AND allocation.id=reversal.allocation_id
          AND allocation.billing_advance_id=ANY(
            COALESCE(target_advance_ids,'{}'::INTEGER[])
          )
     )
   ORDER BY reversal.allocation_id,reversal.id
   FOR UPDATE;
END;
$function$;
CREATE OR REPLACE FUNCTION public.lock_pharmacy_funding_command_order_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  discovered_patient_uid UUID;
  order_lineage_uid UUID;
  terminal_patient_uid UUID;
BEGIN
  IF NEW.command_type NOT IN (
       'SUBSTITUTION_FUNDING_APPROVAL','SUBSTITUTION_FUNDING_CONSUMPTION',
       'PHARMACY_ADVANCE_SETTLEMENT','PHARMACY_ADVANCE_RELEASE'
     ) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || NEW.tenant_id::text,
    0
  ));
  SELECT patient.uid,pharmacy_order.uid
    INTO discovered_patient_uid,order_lineage_uid
    FROM pharmacy_orders pharmacy_order
    JOIN users patient
      ON patient.tenant_id=pharmacy_order.tenant_id
     AND patient.id=pharmacy_order.patient_id
     AND patient.role='PATIENT'
   WHERE pharmacy_order.tenant_id=NEW.tenant_id
     AND pharmacy_order.id=NEW.pharmacy_order_id;
  IF discovered_patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy funding command lacks its exact order patient'
      USING ERRCODE='23514';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    NEW.tenant_id,discovered_patient_uid
  );
  IF order_lineage_uid IS NOT NULL
     AND (
       public.resolve_billing_patient_terminal_753(
         NEW.tenant_id,order_lineage_uid
       ) IS DISTINCT FROM terminal_patient_uid
       OR NOT order_lineage_uid=ANY(
         public.resolve_billing_patient_family_753(
           NEW.tenant_id,terminal_patient_uid
         )
       )
     ) THEN
    RAISE EXCEPTION 'Pharmacy funding command order lineage is outside its patient family'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1
    FROM users patient
   WHERE patient.tenant_id=NEW.tenant_id
     AND patient.uid=terminal_patient_uid
     AND patient.role='PATIENT'
     AND patient.is_active=TRUE
     AND patient.status='active'
     AND COALESCE(patient.is_deleted,FALSE)=FALSE
     AND patient.merged_into_uid IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy funding command terminal patient is not active'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.patient_uid:=terminal_patient_uid;
  ELSIF NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
     OR public.resolve_billing_patient_terminal_753(
          NEW.tenant_id,OLD.patient_uid
        ) IS DISTINCT FROM terminal_patient_uid THEN
    RAISE EXCEPTION 'Pharmacy funding command patient lineage is immutable or stale'
      USING ERRCODE='23514';
  END IF;
  PERFORM public.resolve_billing_patient_family_753(
    NEW.tenant_id,terminal_patient_uid
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || NEW.tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || NEW.tenant_id::text || ':'
      || NEW.pharmacy_order_id::text,
    753
  ));
  IF NEW.command_type='SUBSTITUTION_FUNDING_APPROVAL' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'vh:pharmacy_advance_approval:' || NEW.tenant_id::text || ':'
        || NEW.id::text,
      0
    ));
    RETURN NEW;
  END IF;
  PERFORM 1
    FROM pharmacy_funding_commands receipt
   WHERE receipt.tenant_id=NEW.tenant_id
     AND receipt.id=NEW.approval_receipt_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy funding command lacks its exact approval receipt lock'
      USING ERRCODE='23503';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || NEW.tenant_id::text || ':'
      || NEW.approval_receipt_id::text,
    0
  ));
  IF NEW.command_type='PHARMACY_ADVANCE_SETTLEMENT' THEN
    PERFORM 1
      FROM pharmacy_funding_commands receipt
     WHERE receipt.tenant_id=NEW.tenant_id
       AND receipt.id=NEW.consumption_receipt_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pharmacy advance settlement lacks its exact consumption receipt lock'
        USING ERRCODE='23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.lock_pharmacy_substitution_sources_753(target_tenant_id uuid, target_terminal_patient_uid uuid, target_pharmacy_order_id integer, target_invoice_id integer, target_invoice_item_id integer, target_selector jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  order_patient_id INTEGER;
  order_facility_id INTEGER;
  order_admission_id INTEGER;
  order_items JSONB;
  order_line JSONB;
  prescription_line_index INTEGER;
  prescription_row e_prescriptions%ROWTYPE;
  prescription_count INTEGER;
  original_catalog_id INTEGER;
  final_catalog_id INTEGER;
  inventory_item_id INTEGER;
  inventory_batch_id INTEGER;
  composition_ids INTEGER[];
BEGIN
  BEGIN
    final_catalog_id:=(target_selector->>'final_catalog_id')::INTEGER;
    inventory_item_id:=(target_selector->>'inventory_item_id')::INTEGER;
    inventory_batch_id:=(target_selector->>'inventory_batch_id')::INTEGER;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Substitution source lock selector is malformed'
        USING ERRCODE='23514';
  END;
  SELECT pharmacy_order.patient_id,pharmacy_order.facility_id,
         pharmacy_order.funding_admission_id,
         pharmacy_order.items_list
    INTO order_patient_id,order_facility_id,order_admission_id,order_items
    FROM pharmacy_orders pharmacy_order
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=target_pharmacy_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Substitution order changed before source lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM 1
    FROM users patient
   WHERE patient.tenant_id=target_tenant_id
     AND patient.uid=target_terminal_patient_uid
     AND patient.role='PATIENT'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Substitution patient changed before source lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM 1
    FROM facilities facility
   WHERE facility.tenant_id=target_tenant_id
     AND facility.id=order_facility_id
     AND facility.status='active'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Substitution facility changed before source lock'
      USING ERRCODE='40001';
  END IF;
  order_line:=order_items->((target_selector->>'order_line_index')::INTEGER);
  BEGIN
    prescription_line_index:=(order_line->>'prescription_line_index')::INTEGER;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Substitution order line changed before source lock'
        USING ERRCODE='40001';
  END;
  PERFORM 1
    FROM e_prescriptions prescription
   WHERE prescription.tenant_id=target_tenant_id
     AND prescription.pharmacy_order_id=target_pharmacy_order_id
     AND prescription.patient_id=order_patient_id
     AND LOWER(COALESCE(prescription.status,'')) IN ('active','pharmacy_linked')
     AND LOWER(COALESCE(prescription.lifecycle_status,'draft'))='signed'
     AND prescription.signed_at IS NOT NULL
     AND prescription.locked_at IS NOT NULL
   ORDER BY prescription.id
   FOR UPDATE;
  GET DIAGNOSTICS prescription_count=ROW_COUNT;
  IF prescription_count<>1 THEN
    RAISE EXCEPTION 'Substitution prescription set changed before source lock'
      USING ERRCODE='40001';
  END IF;
  SELECT prescription.*
    INTO STRICT prescription_row
    FROM e_prescriptions prescription
   WHERE prescription.tenant_id=target_tenant_id
     AND prescription.pharmacy_order_id=target_pharmacy_order_id
     AND prescription.patient_id=order_patient_id
     AND LOWER(COALESCE(prescription.status,'')) IN ('active','pharmacy_linked')
     AND LOWER(COALESCE(prescription.lifecycle_status,'draft'))='signed'
     AND prescription.signed_at IS NOT NULL
     AND prescription.locked_at IS NOT NULL;
  PERFORM 1
    FROM users prescriber
   WHERE prescriber.tenant_id=target_tenant_id
     AND prescriber.uid=prescription_row.doctor_uid
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Substitution prescriber changed before source lock'
      USING ERRCODE='40001';
  END IF;
  BEGIN
    original_catalog_id:=(prescription_row.medications
      ->prescription_line_index->>'catalog_id')::INTEGER;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Substitution prescription catalog changed before lock'
        USING ERRCODE='40001';
  END;
  PERFORM 1
    FROM pharmacy_catalog catalog
   WHERE catalog.tenant_id=target_tenant_id
     AND catalog.id=ANY(ARRAY[original_catalog_id,final_catalog_id])
   ORDER BY catalog.id
   FOR UPDATE;
  SELECT COALESCE(ARRAY_AGG(DISTINCT catalog.composition_id
           ORDER BY catalog.composition_id),'{}'::INTEGER[])
    INTO composition_ids
    FROM pharmacy_catalog catalog
   WHERE catalog.tenant_id=target_tenant_id
     AND catalog.id=ANY(ARRAY[original_catalog_id,final_catalog_id])
     AND catalog.composition_id IS NOT NULL;
  PERFORM 1
    FROM drug_compositions composition
   WHERE composition.id=ANY(composition_ids)
   ORDER BY composition.id
   FOR SHARE;
  PERFORM 1
    FROM pharmacy_inventory_items item
   WHERE item.tenant_id=target_tenant_id AND item.id=inventory_item_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Substitution inventory item changed before source lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM 1
    FROM pharmacy_inventory_batches batch
   WHERE batch.tenant_id=target_tenant_id AND batch.id=inventory_batch_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Substitution inventory batch changed before source lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM 1
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id AND invoice.id=target_invoice_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Substitution invoice changed before source lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM 1
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id AND item.invoice_id=target_invoice_id
   ORDER BY item.id
   FOR UPDATE;
  PERFORM 1
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id AND item.invoice_id=target_invoice_id
     AND item.id=target_invoice_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Substitution invoice item changed before source lock'
      USING ERRCODE='40001';
  END IF;
  IF order_admission_id IS NOT NULL THEN
    PERFORM 1
      FROM admissions admission
     WHERE admission.tenant_id=target_tenant_id AND admission.id=order_admission_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Substitution admission changed before source lock'
        USING ERRCODE='40001';
    END IF;
  END IF;
  PERFORM 1
    FROM billing_payments payment
   WHERE payment.tenant_id=target_tenant_id AND payment.invoice_id=target_invoice_id
   ORDER BY payment.id
   FOR UPDATE;
  PERFORM 1
    FROM billing_refunds refund
   WHERE refund.tenant_id=target_tenant_id AND refund.invoice_id=target_invoice_id
   ORDER BY refund.id
   FOR UPDATE;
  PERFORM 1
    FROM billing_advance_settlements settlement
   WHERE settlement.tenant_id=target_tenant_id
     AND settlement.invoice_id=target_invoice_id
   ORDER BY settlement.id
   FOR UPDATE;
END;
$function$;
CREATE OR REPLACE FUNCTION public.patient_merge_lock_held_753(target_tenant_id uuid, require_exclusive boolean)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH merge_key AS (
    SELECT hashtextextended(
      'vhhealth:patient-merge-tenant:' || target_tenant_id::TEXT,0
    ) AS lock_key
  )
  SELECT EXISTS (
    SELECT 1
      FROM pg_locks held_lock
      CROSS JOIN merge_key
     WHERE held_lock.locktype='advisory'
       AND held_lock.pid=pg_backend_pid()
       AND held_lock.classid::BIGINT=
           ((merge_key.lock_key >> 32) & 4294967295)::BIGINT
       AND held_lock.objid::BIGINT=
           (merge_key.lock_key & 4294967295)::BIGINT
       AND held_lock.objsubid=1
       AND held_lock.granted
       AND (
         (require_exclusive AND held_lock.mode='ExclusiveLock')
         OR (NOT require_exclusive
             AND held_lock.mode IN ('ShareLock','ExclusiveLock'))
       )
  );
$function$;
CREATE OR REPLACE FUNCTION public.pharmacy_advance_invoice_projection_753(target_tenant_id uuid, target_invoice_id integer, target_invoice_item_id integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  invoice_row billing_invoices%ROWTYPE;
  item_row billing_invoice_items%ROWTYPE;
  invoice_items JSONB;
BEGIN
  SELECT invoice.*
    INTO invoice_row
    FROM billing_invoices invoice
   WHERE invoice.tenant_id=target_tenant_id
     AND invoice.id=target_invoice_id;
  SELECT item.*
    INTO item_row
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=target_invoice_id
     AND item.id=target_invoice_item_id;
  SELECT COALESCE(jsonb_agg(
           public.pharmacy_substitution_invoice_item_projection_753(item)
           ORDER BY item.id
         ),'[]'::JSONB)
    INTO invoice_items
    FROM billing_invoice_items item
   WHERE item.tenant_id=target_tenant_id
     AND item.invoice_id=target_invoice_id
     AND item.source_ref_active=TRUE;
  IF invoice_row.id IS NULL OR item_row.id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance invoice projection target is unavailable'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_invoice_projection_753';
  END IF;
  RETURN jsonb_build_object(
    'invoice',jsonb_build_object(
      'status',invoice_row.status,
      'invoice_number',invoice_row.invoice_number,
      'issued_at',invoice_row.issued_at,
      'voided_at',invoice_row.voided_at,
      'subtotal',invoice_row.subtotal::NUMERIC(12,2)::TEXT,
      'cgst_amount',COALESCE(invoice_row.cgst_amount,0)::NUMERIC(12,2)::TEXT,
      'sgst_amount',COALESCE(invoice_row.sgst_amount,0)::NUMERIC(12,2)::TEXT,
      'igst_amount',COALESCE(invoice_row.igst_amount,0)::NUMERIC(12,2)::TEXT,
      'tax_amount',(
        COALESCE(invoice_row.cgst_amount,0)
        +COALESCE(invoice_row.sgst_amount,0)
        +COALESCE(invoice_row.igst_amount,0)
      )::NUMERIC(12,2)::TEXT,
      'discount_amount',COALESCE(invoice_row.discount_amount,0)::NUMERIC(12,2)::TEXT,
      'credit_note_amount',COALESCE(invoice_row.credit_note_amount,0)::NUMERIC(12,2)::TEXT,
      'total_amount',invoice_row.total_amount::NUMERIC(12,2)::TEXT,
      'amount_paid',COALESCE(invoice_row.amount_paid,0)::NUMERIC(12,2)::TEXT,
      'amount_due',invoice_row.amount_due::NUMERIC(12,2)::TEXT
    ),
    'item',jsonb_build_object(
      'quantity',item_row.quantity::NUMERIC(10,2)::TEXT,
      'unit_price',item_row.unit_price::NUMERIC(12,2)::TEXT,
      'gst_rate',item_row.gst_rate::NUMERIC(5,2)::TEXT,
      'line_subtotal',item_row.line_subtotal::NUMERIC(12,2)::TEXT,
      'cgst_amount',COALESCE(item_row.cgst_amount,0)::NUMERIC(12,2)::TEXT,
      'sgst_amount',COALESCE(item_row.sgst_amount,0)::NUMERIC(12,2)::TEXT,
      'igst_amount',COALESCE(item_row.igst_amount,0)::NUMERIC(12,2)::TEXT,
      'tax_amount',(
        COALESCE(item_row.cgst_amount,0)
        +COALESCE(item_row.sgst_amount,0)
        +COALESCE(item_row.igst_amount,0)
      )::NUMERIC(12,2)::TEXT,
      'line_total',item_row.line_total::NUMERIC(12,2)::TEXT,
      'source_ref_type',item_row.source_ref_type,
      'source_ref_id',item_row.source_ref_id::TEXT,
      'source_ref_active',item_row.source_ref_active,
      'source_authority_version',item_row.source_authority_version,
      'source_authority_sha256',item_row.source_authority_sha256
    ),
    'items',invoice_items,
    'items_generation_sha256',encode(public.digest(
      invoice_items::TEXT,'sha256'
    ),'hex')
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.pharmacy_advance_reservation_public_plan_753(internal_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE STRICT
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  funding JSONB;
  reservations JSONB;
  source_plan_sha256 CHAR(64);
BEGIN
  funding:=internal_plan->'funding';
  reservations:=internal_plan->'reservations';
  IF jsonb_typeof(internal_plan) IS DISTINCT FROM 'object'
     OR internal_plan->>'contract'<>'pharmacy_advance_reservation_plan_v1'
     OR jsonb_typeof(funding) IS DISTINCT FROM 'object'
     OR jsonb_typeof(reservations) IS DISTINCT FROM 'array'
     OR funding->>'funding_source' NOT IN (
       'tpa_claim','mixed','patient_advance'
     )
     OR funding->>'source_evidence_sha256' !~ '^[0-9a-f]{64}$'
     OR funding->>'evidence_sha256' !~ '^[0-9a-f]{64}$'
     OR encode(public.digest(
          ((funding-'evidence_sha256'))::TEXT,'sha256'
        ),'hex') IS DISTINCT FROM funding->>'evidence_sha256' THEN
    RAISE EXCEPTION 'Internal pharmacy advance plan is not canonical DB evidence'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_public_plan_753';
  END IF;
  source_plan_sha256:=encode(public.digest(
    (internal_plan-ARRAY['allocations','approval_receipt_id'])::TEXT,'sha256'
  ),'hex');
  RETURN jsonb_build_object(
    'contract','pharmacy_advance_reservation_public_v1',
    'pharmacy_order_id',(internal_plan->>'pharmacy_order_id')::INTEGER,
    'invoice_id',(internal_plan->>'invoice_id')::INTEGER,
    'invoice_item_id',(internal_plan->>'invoice_item_id')::INTEGER,
    'base_order_version',(internal_plan->>'base_order_version')::INTEGER,
    'base_order_items_sha256',internal_plan->>'base_order_items_sha256',
    'prospective_authoritative_amount',
      internal_plan->>'prospective_authoritative_amount',
    'funding',jsonb_build_object(
      'contract','pharmacy_substitution_advance_capacity_public_v1',
      'funding_source',funding->>'funding_source',
      'tpa_claim_id',funding->'tpa_claim_id',
      'tpa_decision_id',funding->'tpa_decision_id',
      'tpa_used_amount',funding->>'tpa_used_amount',
      'patient_payment_required_amount',
        funding->>'patient_payment_required_amount',
      'combined_authority_amount',funding->>'combined_authority_amount',
      'headroom_amount',funding->>'headroom_amount',
      'reservation_required_amount',funding->>'reservation_required_amount',
      'source_evidence_sha256',funding->>'source_evidence_sha256',
      'source_plan_sha256',source_plan_sha256,
      'reservation_count',jsonb_array_length(reservations)
    )
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.pharmacy_funding_duplicate_line_snapshot_753(p_tenant_id uuid, p_pharmacy_order_id integer)
 RETURNS TABLE(snapshot jsonb, snapshot_sha256 character, active_line_count integer)
 LANGUAGE sql
 STABLE
AS $function$
  WITH authority AS (
    SELECT pharmacy_order.id,pharmacy_order.facility_id,
           pharmacy_order.inventory_authority_version,
           pharmacy_order.funding_admission_id,
           pharmacy_order.funding_admission_order_version,
           pharmacy_order.funding_admission_items_sha256,
           encode(public.digest(COALESCE(pharmacy_order.items_list,'[]'::jsonb)::text,'sha256'),'hex')
             AS order_items_storage_sha256,
           COALESCE((
             SELECT jsonb_agg(
               jsonb_build_object(
                 'movement_id',movement.id,
                 'movement_kind',movement.movement_kind,
                 'quantity_delta',movement.quantity_delta,
                 'reference_type',movement.reference_type,
                 'reference_id',movement.reference_id,
                 'contract',movement.metadata->>'contract',
                 'command_key_sha256',movement.metadata->>'command_key_sha256'
               ) ORDER BY movement.id
             )
             FROM pharmacy_stock_movements movement
            WHERE movement.tenant_id=pharmacy_order.tenant_id
              AND movement.metadata->>'order_id'=pharmacy_order.id::text
           ),'[]'::jsonb) AS stock_evidence
      FROM pharmacy_orders pharmacy_order
     WHERE pharmacy_order.tenant_id=p_tenant_id
       AND pharmacy_order.id=p_pharmacy_order_id
  ), line_evidence AS (
    SELECT item.id AS invoice_item_id,item.invoice_id,invoice.status AS invoice_status,
           invoice.patient_uid,invoice.admission_id,
           invoice.subtotal AS invoice_subtotal,
           invoice.cgst_amount AS invoice_cgst_amount,
           invoice.sgst_amount AS invoice_sgst_amount,
           invoice.igst_amount AS invoice_igst_amount,
           invoice.total_amount AS invoice_total_amount,
           invoice.amount_paid AS invoice_amount_paid,invoice.amount_due AS invoice_amount_due,
           item.description,item.category,item.quantity,item.unit_price,item.line_subtotal,
           item.cgst_amount,item.sgst_amount,item.igst_amount,item.line_total,item.source_ref_active,
           item.source_authority_version,item.source_authority_sha256,
           encode(public.digest(jsonb_build_object(
             'invoice_item_id',item.id,'invoice_id',item.invoice_id,
             'description',item.description,'category',item.category,
             'quantity',item.quantity,'unit_price',item.unit_price,
             'line_subtotal',item.line_subtotal,'cgst_amount',item.cgst_amount,
             'sgst_amount',item.sgst_amount,'igst_amount',item.igst_amount,
             'line_total',item.line_total,'source_ref_active',item.source_ref_active,
             'source_authority_version',item.source_authority_version,
             'source_authority_sha256',item.source_authority_sha256
           )::text,'sha256'),'hex') AS invoice_item_sha256,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'payment_id',payment.id,'amount',payment.amount,'mode',payment.mode,
               'reference',payment.reference,'reversed',payment.reversed
             ) ORDER BY payment.id)
               FROM billing_payments payment
              WHERE payment.tenant_id=item.tenant_id
                AND payment.invoice_id=item.invoice_id
           ),'[]'::jsonb) AS payments,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'allocation_id',allocation.id,
               'billing_payment_id',allocation.billing_payment_id,
               'allocated_amount',allocation.allocated_amount,
               'source_authority_version',allocation.source_authority_version,
               'source_authority_sha256',allocation.source_authority_sha256,
               'reversed_amount',COALESCE(reversal.reversed_amount,0)
             ) ORDER BY allocation.id)
               FROM pharmacy_payment_allocations allocation
               LEFT JOIN (
                 SELECT tenant_id,allocation_id,SUM(reversed_amount) AS reversed_amount
                   FROM pharmacy_payment_allocation_reversals
                  GROUP BY tenant_id,allocation_id
               ) reversal
                 ON reversal.tenant_id=allocation.tenant_id
                AND reversal.allocation_id=allocation.id
              WHERE allocation.tenant_id=item.tenant_id
                AND allocation.invoice_item_id=item.id
           ),'[]'::jsonb) AS allocations,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'decision_id',decision.id,'claim_id',decision.claim_id,
               'approved_amount',decision.approved_amount,
               'non_payable_amount',decision.non_payable_amount,
               'source_authority_version',decision.source_authority_version,
               'source_authority_sha256',decision.source_authority_sha256,
               'invalidated_at',decision.invalidated_at
             ) ORDER BY decision.id)
               FROM tpa_claim_line_decisions decision
              WHERE decision.tenant_id=item.tenant_id
                AND decision.invoice_item_id=item.id
           ),'[]'::jsonb) AS tpa_decisions
      FROM billing_invoice_items item
      JOIN billing_invoices invoice
        ON invoice.tenant_id=item.tenant_id AND invoice.id=item.invoice_id
     WHERE item.tenant_id=p_tenant_id
       AND item.source_ref_type='pharmacy_order'
       AND item.source_ref_id=p_pharmacy_order_id
  ), evidence AS (
    SELECT jsonb_build_object(
      'contract','pharmacy_funding_duplicate_line_snapshot_v1',
      'tenant_id',p_tenant_id,
      'pharmacy_order_id',p_pharmacy_order_id,
      'facility_id',authority.facility_id,
      'order_version',authority.inventory_authority_version,
      'funding_admission_id',authority.funding_admission_id,
      'funding_admission_order_version',authority.funding_admission_order_version,
      'funding_admission_items_sha256',authority.funding_admission_items_sha256,
      'order_items_storage_sha256',authority.order_items_storage_sha256,
      'stock_evidence',authority.stock_evidence,
      'lines',COALESCE(jsonb_agg(to_jsonb(line_evidence) ORDER BY line_evidence.invoice_item_id)
                       FILTER (WHERE line_evidence.invoice_item_id IS NOT NULL),'[]'::jsonb)
    ) AS body,
    COUNT(line_evidence.invoice_item_id) FILTER (WHERE line_evidence.source_ref_active)::integer
      AS line_count
      FROM authority
      LEFT JOIN line_evidence ON TRUE
     GROUP BY authority.facility_id,authority.inventory_authority_version,
              authority.funding_admission_id,authority.funding_admission_order_version,
              authority.funding_admission_items_sha256,authority.order_items_storage_sha256,
              authority.stock_evidence
  )
  SELECT evidence.body,
         encode(public.digest(evidence.body::text,'sha256'),'hex')::char(64),
         evidence.line_count
    FROM evidence;
$function$;
CREATE OR REPLACE FUNCTION public.pharmacy_patient_safety_projection_753(source_table text, payload jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE source_table
    WHEN 'users' THEN jsonb_build_object(
      'birthday', payload->'birthday', 'gender', payload->'gender',
      'is_pregnant', payload->'is_pregnant',
      'pregnancy_lmp_date', payload->'pregnancy_lmp_date',
      'allergies', payload->'allergies', 'role', payload->'role',
      'status', payload->'status', 'is_active', payload->'is_active',
      'is_deleted', payload->'is_deleted', 'merged_into_uid', payload->'merged_into_uid',
      'chronic_medications', public.pharmacy_erx_clinical_projection_753(payload->'chronic_medications'),
      'chronic_medications_updated_at', payload->'chronic_medications_updated_at'
    )
    WHEN 'patient_allergies' THEN payload - ARRAY['updated_at', 'created_at']::TEXT[]
    WHEN 'allergies' THEN payload - ARRAY['updated_at', 'created_at']::TEXT[]
    WHEN 'admissions' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status',
      'allergies', payload->'allergies', 'created_at', payload->'created_at'
    )
    WHEN 'appointments' THEN jsonb_build_object(
      'patient_id', payload->'patient_id', 'notes', payload->'notes',
      'reason', payload->'reason', 'created_at', payload->'created_at'
    )
    WHEN 'clinical_notes' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'notes', payload->'notes',
      'content', payload->'content', 'status', payload->'status',
      'created_at', payload->'created_at'
    )
    WHEN 'e_prescriptions' THEN jsonb_build_object(
      'patient_id', payload->'patient_id', 'patient_uid', payload->'patient_uid',
      'pharmacy_order_id', payload->'pharmacy_order_id',
      'status', payload->'status', 'follow_up_date', payload->'follow_up_date',
      'lifecycle_status', payload->'lifecycle_status', 'signed_at', payload->'signed_at',
      'medication_name', payload->'medication_name',
      'medications', public.pharmacy_erx_clinical_projection_753(payload->'medications')
    )
    WHEN 'pharmacy_orders' THEN jsonb_build_object(
      'patient_id', payload->'patient_id',
      'authority_origin', payload->'authority_origin',
      'status_class', CASE
        WHEN payload->>'status' IN (
          'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED',
          'PARTIALLY_DISPENSED', 'ON_HOLD'
        ) THEN 'active'
        WHEN payload->>'status' IN ('DISPENSED', 'DELIVERED') THEN 'dispensed'
        ELSE payload->>'status'
      END,
      'ordered_at', payload->'ordered_at', 'dispensed_at', payload->'dispensed_at',
      'items_list', public.pharmacy_erx_clinical_projection_753(payload->'items_list'),
      'dispensed_medications', public.pharmacy_erx_clinical_projection_753(payload->'dispensed_medications')
    )
    WHEN 'clinical_orders' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'order_type', payload->'order_type',
      'status', payload->'status', 'start_date', payload->'start_date',
      'end_date', payload->'end_date', 'route', payload->'route',
      'details', payload->'details', 'updated_at', payload->'updated_at'
    )
    WHEN 'medication_administrations' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid',
      'medication_name', payload->'medication_name',
      'dose', payload->'dose', 'dosage', payload->'dosage',
      'route', payload->'route',
      'status_class', CASE
        WHEN payload->>'status' IN ('scheduled', 'due', 'administered') THEN 'active'
        ELSE payload->>'status'
      END,
      'clinical_order_id', payload->'clinical_order_id',
      'scheduled_time', payload->'scheduled_time', 'administered_at', payload->'administered_at',
      'updated_at', payload->'updated_at'
    )
    WHEN 'medication_reconciliations' THEN jsonb_build_object(
      'patient_id', payload->'patient_id', 'patient_uid', payload->'patient_uid',
      'status', payload->'status', 'rec_type', payload->'rec_type',
      'completed_at', payload->'completed_at', 'updated_at', payload->'updated_at'
    )
    WHEN 'medication_reconciliation_items' THEN jsonb_build_object(
      'reconciliation_id', payload->'reconciliation_id',
      'medication_name', payload->'medication_name', 'dose', payload->'dose',
      'frequency', payload->'frequency', 'route', payload->'route',
      'decision', payload->'decision', 'changed_dose', payload->'changed_dose',
      'changed_frequency', payload->'changed_frequency', 'changed_route', payload->'changed_route',
      'source_ref', payload->'source_ref', 'metadata', payload->'metadata',
      'updated_at', payload->'updated_at'
    )
    WHEN 'medication_reminders' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'medication_name', payload->'medication_name',
      'dosage', payload->'dosage', 'frequency', payload->'frequency',
      'start_date', payload->'start_date', 'end_date', payload->'end_date',
      'is_active', payload->'is_active', 'updated_at', payload->'updated_at'
    )
    WHEN 'prescriptions' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'medication_name', payload->'medication_name',
      'dosage', payload->'dosage', 'frequency', payload->'frequency',
      'status', payload->'status', 'duration_days', payload->'duration_days',
      'issued_at', payload->'issued_at'
    )
    WHEN 'pharmacy_counter_sales' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status',
      'voided_at', payload->'voided_at', 'updated_at', payload->'updated_at'
    )
    WHEN 'pharmacy_counter_sale_lines' THEN jsonb_build_object(
      'counter_sale_id', payload->'counter_sale_id',
      'inventory_item_id', payload->'inventory_item_id',
      'item_name', payload->'item_name', 'quantity', payload->'quantity'
    )
    WHEN 'chemo_treatment_plans' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status',
      'start_date', payload->'start_date', 'updated_at', payload->'updated_at'
    )
    WHEN 'chemo_cycles' THEN jsonb_build_object(
      'plan_id', payload->'plan_id', 'scheduled_date', payload->'scheduled_date',
      'status', payload->'status', 'updated_at', payload->'updated_at'
    )
    WHEN 'chemo_administrations' THEN jsonb_build_object(
      'cycle_id', payload->'cycle_id', 'drug_name', payload->'drug_name',
      'final_dose', payload->'final_dose', 'route', payload->'route',
      'status', payload->'status', 'administered_at', payload->'administered_at',
      'updated_at', payload->'updated_at'
    )
    WHEN 'dialysis_patients' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status',
      'updated_at', payload->'updated_at'
    )
    WHEN 'dialysis_prescriptions' THEN jsonb_build_object(
      'dialysis_patient_id', payload->'dialysis_patient_id',
      'anticoag', payload->'anticoag', 'anticoag_loading', payload->'anticoag_loading',
      'anticoag_maintenance', payload->'anticoag_maintenance',
      'status', payload->'status', 'valid_from', payload->'valid_from',
      'superseded_at', payload->'superseded_at', 'updated_at', payload->'updated_at'
    )
    WHEN 'maternity_supplements' THEN jsonb_build_object(
      'pregnancy_id', payload->'pregnancy_id', 'supplement', payload->'supplement',
      'dose', payload->'dose', 'frequency', payload->'frequency', 'route', payload->'route',
      'start_date', payload->'start_date', 'end_date', payload->'end_date',
      'updated_at', payload->'updated_at'
    )
    WHEN 'resuscitation_medication_links' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid',
      'mar_administration_id', payload->'mar_administration_id',
      'medication_name', payload->'medication_name', 'dose', payload->'dose',
      'route', payload->'route', 'reconciliation_status', payload->'reconciliation_status',
      'updated_at', payload->'updated_at'
    )
    WHEN 'vitals_chart' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'weight_kg', payload->'weight_kg',
      'recorded_at', payload->'recorded_at'
    )
    WHEN 'maternity_pregnancies' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'status', payload->'status'
    )
    WHEN 'lab_results' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'test_name', payload->'test_name',
      'test_code', payload->'test_code', 'value_numeric', payload->'value_numeric',
      'value_text', payload->'value_text', 'unit', payload->'unit',
      'received_at', payload->'received_at'
    )
    WHEN 'patient_problems' THEN jsonb_build_object(
      'patient_uid', payload->'patient_uid', 'icd10_code', payload->'icd10_code',
      'title', payload->'title', 'status', payload->'status'
    )
    ELSE payload - ARRAY['updated_at']::TEXT[]
  END
$function$;
CREATE OR REPLACE FUNCTION public.pharmacy_substitution_invoice_item_projection_753(source_item billing_invoice_items)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'id',source_item.id,
    'invoice_id',source_item.invoice_id,
    'service_code',source_item.service_code,
    'description',source_item.description,
    'category',source_item.category,
    'hsn_sac',source_item.hsn_sac,
    'quantity',source_item.quantity::NUMERIC(10,2)::TEXT,
    'unit_price',source_item.unit_price::NUMERIC(12,2)::TEXT,
    'gst_rate',source_item.gst_rate::NUMERIC(5,2)::TEXT,
    'line_subtotal',source_item.line_subtotal::NUMERIC(12,2)::TEXT,
    'cgst_amount',COALESCE(source_item.cgst_amount,0)::NUMERIC(12,2)::TEXT,
    'sgst_amount',COALESCE(source_item.sgst_amount,0)::NUMERIC(12,2)::TEXT,
    'igst_amount',COALESCE(source_item.igst_amount,0)::NUMERIC(12,2)::TEXT,
    'line_total',source_item.line_total::NUMERIC(12,2)::TEXT,
    'notes',source_item.notes,
    'created_at',CASE WHEN source_item.created_at IS NULL THEN NULL ELSE
      to_char(DATE_TRUNC('milliseconds',source_item.created_at)
        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'source_ref_type',source_item.source_ref_type,
    'source_ref_id',source_item.source_ref_id::TEXT,
    'source_ref_active',source_item.source_ref_active,
    'source_authority_version',source_item.source_authority_version,
    'source_authority_sha256',source_item.source_authority_sha256,
    'source_ref_reconciliation_case_id',
      source_item.source_ref_reconciliation_case_id::TEXT,
    'source_ref_deactivated_at',CASE
      WHEN source_item.source_ref_deactivated_at IS NULL THEN NULL ELSE
        to_char(DATE_TRUNC('milliseconds',source_item.source_ref_deactivated_at)
          AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'source_ref_deactivated_by',source_item.source_ref_deactivated_by::TEXT,
    'tpa_decision',source_item.tpa_decision,
    'tpa_non_payable_reason',source_item.tpa_non_payable_reason,
    'tpa_decided_at',CASE WHEN source_item.tpa_decided_at IS NULL THEN NULL ELSE
      to_char(DATE_TRUNC('milliseconds',source_item.tpa_decided_at)
        AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'tpa_decided_by',source_item.tpa_decided_by::TEXT
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.pharmacy_substitution_line_total_753(target_line jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE STRICT
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  dispensed NUMERIC(14,4);
  candidate TEXT;
  inventory_candidate TEXT;
  substitution_candidate TEXT;
  history_entry JSONB;
  history_subtotal NUMERIC(12,2);
  history_cumulative NUMERIC(12,2);
  direct_total NUMERIC(12,2);
  history_has_cumulative BOOLEAN:=FALSE;
  history_missing_cumulative BOOLEAN:=FALSE;
  total NUMERIC(14,2):=0;
BEGIN
  IF jsonb_typeof(target_line) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Pharmacy substitution order line is not an object'
      USING ERRCODE='23514';
  END IF;
  BEGIN
    dispensed:=COALESCE(NULLIF(
      target_line->>'inventory_dispensed_quantity',''
    ),'0')::NUMERIC(14,4);
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pharmacy substitution line has invalid dispensed quantity'
        USING ERRCODE='23514';
  END;
  IF dispensed<0 THEN
    RAISE EXCEPTION 'Pharmacy substitution line has negative dispensed quantity'
      USING ERRCODE='23514';
  END IF;
  IF dispensed=0 THEN RETURN 0::NUMERIC(12,2); END IF;
  inventory_candidate:=NULLIF(target_line->>'inventory_billable_total','');
  substitution_candidate:=NULLIF(
    target_line->>'substitution_billable_total',''
  );
  candidate:=COALESCE(inventory_candidate,substitution_candidate);
  IF candidate IS NOT NULL THEN
    IF candidate !~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$'
       OR (
         inventory_candidate IS NOT NULL
         AND inventory_candidate !~
           '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$'
       )
       OR (
         substitution_candidate IS NOT NULL
         AND substitution_candidate !~
           '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$'
       ) THEN
      RAISE EXCEPTION 'Pharmacy substitution line has invalid billable total'
        USING ERRCODE='23514';
    END IF;
    BEGIN
      total:=candidate::NUMERIC(12,2);
      IF inventory_candidate IS NOT NULL
         AND substitution_candidate IS NOT NULL THEN
        direct_total:=substitution_candidate::NUMERIC(12,2);
        IF direct_total IS DISTINCT FROM total::NUMERIC(12,2) THEN
          RAISE EXCEPTION 'Pharmacy substitution line billable totals disagree'
            USING ERRCODE='23514';
        END IF;
      END IF;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Pharmacy substitution line has invalid billable total'
          USING ERRCODE='23514';
    END;
    IF total<0 THEN
      RAISE EXCEPTION 'Pharmacy substitution line has negative billable total'
        USING ERRCODE='23514';
    END IF;
    RETURN total::NUMERIC(12,2);
  END IF;
  IF jsonb_typeof(target_line->'substitution_history') IS DISTINCT FROM 'array'
     OR jsonb_array_length(target_line->'substitution_history')=0 THEN
    RAISE EXCEPTION 'Prior inventory dispense lacks immutable billing evidence'
      USING ERRCODE='23514';
  END IF;
  FOR history_entry IN
    SELECT value FROM jsonb_array_elements(target_line->'substitution_history') value
  LOOP
    candidate:=NULLIF(history_entry->>'billable_subtotal','');
    IF jsonb_typeof(history_entry) IS DISTINCT FROM 'object'
       OR jsonb_typeof(history_entry->'billable_subtotal') IS DISTINCT FROM 'string'
       OR candidate !~ '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN
      RAISE EXCEPTION 'Substitution history lacks canonical incremental billing evidence'
        USING ERRCODE='23514';
    END IF;
    BEGIN
      history_subtotal:=candidate::NUMERIC(12,2);
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Substitution history has invalid billable evidence'
          USING ERRCODE='23514';
    END;
    IF history_subtotal<0 THEN
      RAISE EXCEPTION 'Substitution history has negative incremental billing evidence'
        USING ERRCODE='23514';
    END IF;
    total:=total+history_subtotal;
    IF total<0 OR total>=10000000000 THEN
      RAISE EXCEPTION 'Substitution history exceeds funding authority bounds'
        USING ERRCODE='23514';
    END IF;
    IF history_entry ? 'line_total' THEN
      history_has_cumulative:=TRUE;
      IF jsonb_typeof(history_entry->'line_total') IS DISTINCT FROM 'string'
         OR history_entry->>'line_total' !~
            '^(0|[1-9][0-9]{0,9})\.[0-9]{2}$' THEN
        RAISE EXCEPTION 'Substitution history has noncanonical cumulative billing evidence'
          USING ERRCODE='23514';
      END IF;
      BEGIN
        history_cumulative:=(history_entry->>'line_total')::NUMERIC(12,2);
      EXCEPTION
        WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          RAISE EXCEPTION 'Substitution history has invalid cumulative billing evidence'
            USING ERRCODE='23514';
      END;
      IF history_cumulative IS DISTINCT FROM total::NUMERIC(12,2) THEN
        RAISE EXCEPTION 'Substitution history cumulative billing evidence is inconsistent'
          USING ERRCODE='23514';
      END IF;
    ELSE
      history_missing_cumulative:=TRUE;
    END IF;
  END LOOP;
  IF history_has_cumulative AND history_missing_cumulative THEN
    RAISE EXCEPTION 'Substitution history mixes cumulative evidence generations'
      USING ERRCODE='23514';
  END IF;
  RETURN total::NUMERIC(12,2);
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_allocated_billing_payment_reversal_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF COALESCE(OLD.reversed,FALSE)=FALSE AND COALESCE(NEW.reversed,FALSE)=TRUE
     AND EXISTS (
       SELECT 1
         FROM pharmacy_payment_allocations allocation
         LEFT JOIN pharmacy_payment_allocation_reversals reversal
           ON reversal.tenant_id=allocation.tenant_id
          AND reversal.allocation_id=allocation.id
        WHERE allocation.tenant_id=OLD.tenant_id
          AND allocation.billing_payment_id=OLD.id
        GROUP BY allocation.id,allocation.allocated_amount
       HAVING allocation.allocated_amount
              - COALESCE(SUM(reversal.reversed_amount),0) > 0.001
     ) THEN
    RAISE EXCEPTION 'Allocated pharmacy funding payment % has unreversed pharmacy allocations', OLD.id
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_billing_advance_settlement_identity_update_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.advance_id IS DISTINCT FROM OLD.advance_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    RAISE EXCEPTION 'Billing advance settlement lineage is immutable'
      USING ERRCODE='23514',
            CONSTRAINT='chk_billing_advance_settlement_patient_lineage_753';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_bound_ipd_deposit_mutation_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM billing_advances advance
     WHERE advance.tenant_id=OLD.tenant_id
       AND advance.ipd_advance_deposit_id=OLD.id
  ) THEN
    IF TG_OP='DELETE' THEN
      RAISE EXCEPTION 'A billing-bound IPD deposit source is immutable'
        USING ERRCODE='23514';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
       OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
       OR NEW.receipt_number IS DISTINCT FROM OLD.receipt_number
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.parent_deposit_id IS DISTINCT FROM OLD.parent_deposit_id
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
       OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
       OR NEW.purpose IS DISTINCT FROM OLD.purpose
       OR NEW.is_refund IS DISTINCT FROM OLD.is_refund
       OR NEW.collected_by IS DISTINCT FROM OLD.collected_by
       OR NEW.collected_at IS DISTINCT FROM OLD.collected_at THEN
      RAISE EXCEPTION 'A billing-bound IPD deposit source is immutable'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_new_duplicate_pharmacy_billing_line_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.source_ref_type='pharmacy_order'
     AND NEW.source_ref_id IS NOT NULL
     AND NEW.source_ref_active THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'vh:pharmacy_billing_line:' || NEW.tenant_id::text || ':' || NEW.source_ref_id::text,
      753
    ));
    IF EXISTS (
      SELECT 1 FROM billing_invoice_items existing
       WHERE existing.tenant_id=NEW.tenant_id
         AND existing.source_ref_type='pharmacy_order'
         AND existing.source_ref_id=NEW.source_ref_id
         AND existing.source_ref_active
         AND existing.id IS DISTINCT FROM NEW.id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE='23505',
        CONSTRAINT='trg_prevent_new_duplicate_pharmacy_billing_line_753',
        MESSAGE='A governed active pharmacy billing line already owns this order';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_nhcx_transport_receipt_rewrite_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.transport_accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Accepted NHCX transport receipt is immutable and cannot be deleted'
        USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.transport_accepted_at IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.cycle IS DISTINCT FROM OLD.cycle
    OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
    OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
    OR NEW.preauth_id IS DISTINCT FROM OLD.preauth_id
    OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
    OR NEW.admission_id IS DISTINCT FROM OLD.admission_id
    OR NEW.transport_accepted_at IS DISTINCT FROM OLD.transport_accepted_at
    OR NEW.transport_http_status IS DISTINCT FROM OLD.transport_http_status
    OR NEW.transport_response_sha256 IS DISTINCT FROM OLD.transport_response_sha256
    OR NEW.transport_gateway_reference IS DISTINCT FROM OLD.transport_gateway_reference
    OR NEW.transport_response_excerpt IS DISTINCT FROM OLD.transport_response_excerpt
    OR NEW.status <> 'accepted'
  ) THEN
    RAISE EXCEPTION 'Accepted NHCX transport receipt is immutable and cannot be resent'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_pharmacy_advance_allocation_mutation_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE='23514';
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_pharmacy_advance_settlement_rebinding_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'Billing advance settlements are append-only'
    USING ERRCODE='55000';
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_pharmacy_funding_reconciliation_event_mutation_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'pharmacy funding reconciliation events are append-only'
    USING ERRCODE='55000';
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_pharmacy_inventory_item_rehome_supply_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  has_history BOOLEAN;
BEGIN
  IF NEW.facility_id IS NOT DISTINCT FROM OLD.facility_id
     AND NEW.catalog_id IS NOT DISTINCT FROM OLD.catalog_id
     AND NEW.default_supplier_id IS NOT DISTINCT FROM OLD.default_supplier_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  SELECT (
    EXISTS (SELECT 1 FROM pharmacy_inventory_batches batch
             WHERE batch.tenant_id=OLD.tenant_id
               AND batch.inventory_item_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_purchase_order_items line
                WHERE line.tenant_id=OLD.tenant_id
                  AND line.inventory_item_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_goods_receipt_items line
                WHERE line.tenant_id=OLD.tenant_id
                  AND line.inventory_item_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_stock_movements movement
                WHERE movement.tenant_id=OLD.tenant_id
                  AND movement.inventory_item_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_substitutes substitute
                WHERE substitute.tenant_id=OLD.tenant_id
                  AND (substitute.primary_item_id=OLD.id
                    OR substitute.substitute_item_id=OLD.id))
  ) INTO has_history;
  IF has_history AND NOT (
    current_setting('app.pharmacy_authority_recovery_id', TRUE) ~ '^[1-9][0-9]*$'
    AND EXISTS (
      SELECT 1 FROM pharmacy_inventory_authority_recovery_worklist recovery
       WHERE recovery.id=current_setting(
               'app.pharmacy_authority_recovery_id', TRUE
             )::bigint
         AND recovery.tenant_id=OLD.tenant_id
         AND recovery.entity_type='inventory_item'
         AND recovery.entity_id=OLD.id
         AND recovery.reason_code='INVENTORY_ITEM_AUTHORITY_REHOME'
         AND recovery.status='OPEN'
         AND recovery.authority_snapshot->>'target_facility_id'=NEW.facility_id::text
         AND recovery.authority_snapshot->>'target_catalog_id'=NEW.catalog_id::text
         AND COALESCE(
               recovery.authority_snapshot->>'target_default_supplier_id',
               ''
             )=COALESCE(NEW.default_supplier_id::text, '')
         AND recovery.authority_snapshot->>'target_status'=NEW.status
    )
  ) THEN
    RAISE EXCEPTION 'Inventory item facility, catalog, supplier, and status authority is immutable after custody history'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_pharmacy_payment_allocation_mutation_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE='23514';
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_pharmacy_storage_location_rehome_supply_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_tenant UUID := CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  target_id INTEGER := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM pharmacy_inventory_batches batch
       WHERE batch.tenant_id=target_tenant
         AND batch.storage_location_id=target_id
    ) THEN
      RAISE EXCEPTION 'A pharmacy storage location with batch lineage cannot be deleted'
        USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pharmacy_inventory_batches batch
     WHERE batch.tenant_id=target_tenant
       AND batch.storage_location_id=target_id
  ) AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.facility_id IS DISTINCT FROM OLD.facility_id
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'A pharmacy storage location with batch lineage cannot be moved or inactivated'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_pharmacy_supplier_rehome_supply_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  has_history BOOLEAN;
BEGIN
  IF NEW.facility_id IS NOT DISTINCT FROM OLD.facility_id THEN RETURN NEW; END IF;
  SELECT (
    EXISTS (SELECT 1 FROM pharmacy_inventory_items item
             WHERE item.tenant_id=OLD.tenant_id
               AND item.default_supplier_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_inventory_batches batch
                WHERE batch.tenant_id=OLD.tenant_id
                  AND batch.supplier_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_purchase_orders po
                WHERE po.tenant_id=OLD.tenant_id
                  AND po.supplier_id=OLD.id)
    OR EXISTS (SELECT 1 FROM pharmacy_goods_receipts grn
                WHERE grn.tenant_id=OLD.tenant_id
                  AND grn.supplier_id=OLD.id)
  ) INTO has_history;
  IF has_history AND NOT (
    current_setting('app.pharmacy_authority_recovery_id', TRUE) ~ '^[1-9][0-9]*$'
    AND EXISTS (
      SELECT 1 FROM pharmacy_inventory_authority_recovery_worklist recovery
       WHERE recovery.id=current_setting(
               'app.pharmacy_authority_recovery_id', TRUE
             )::bigint
         AND recovery.tenant_id=OLD.tenant_id
         AND recovery.entity_type='supplier'
         AND recovery.entity_id=OLD.id
         AND recovery.reason_code='SUPPLIER_FACILITY_AUTHORITY_UNRESOLVED'
         AND recovery.status='OPEN'
         AND recovery.authority_snapshot->>'target_facility_id'=NEW.facility_id::text
    )
  ) THEN
    RAISE EXCEPTION 'Supplier facility authority is immutable after supply lineage exists'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_settled_advance_lineage_drift_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.patient_uid IS DISTINCT FROM OLD.patient_uid
     OR NEW.admission_id IS DISTINCT FROM OLD.admission_id THEN
    IF EXISTS (
      SELECT 1
        FROM billing_advance_settlements settlement
       WHERE settlement.tenant_id=OLD.tenant_id
         AND settlement.advance_id=OLD.id
    ) THEN
      RAISE EXCEPTION 'A settled billing advance patient lineage is immutable'
        USING ERRCODE='23514',
              CONSTRAINT='chk_billing_advance_settlement_patient_lineage_753';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.prevent_settled_invoice_scope_drift_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
BEGIN
  IF (NEW.tenant_id,NEW.id,NEW.admission_id) IS DISTINCT FROM
       (OLD.tenant_id,OLD.id,OLD.admission_id)
     AND EXISTS (
       SELECT 1
         FROM billing_advance_settlements settlement
        WHERE settlement.tenant_id=OLD.tenant_id
          AND settlement.invoice_id=OLD.id
     ) THEN
    RAISE EXCEPTION 'A settled billing invoice admission lineage is immutable'
      USING ERRCODE='23514',
            CONSTRAINT='chk_billing_advance_settlement_patient_lineage_753';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.preview_pharmacy_advance_reservation_753(target_tenant_id uuid, target_pharmacy_order_id integer, target_selector jsonb, target_proposer_uid uuid, target_facility_grant_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  order_patient_uid UUID;
  order_lineage_uid UUID;
  order_facility_id INTEGER;
  target_invoice_id INTEGER;
  target_invoice_item_id INTEGER;
  target_tpa_claim_id INTEGER;
  funding_target_count INTEGER;
  terminal_patient_uid UUID;
  patient_uid_family UUID[];
  proposer_role TEXT;
  authority JSONB;
  prospective_amount NUMERIC(10,2);
  prelock_plan JSONB;
  advance_ids INTEGER[];
  plan JSONB;
BEGIN
  IF current_setting('app.current_tenant_id',TRUE) IS NULL
     OR current_setting('app.current_tenant_id',TRUE) IN ('','bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM target_tenant_id
     OR target_proposer_uid IS NULL
     OR target_facility_grant_id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance preview requires exact tenant and actor context'
      USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  SELECT patient.uid,pharmacy_order.uid,pharmacy_order.facility_id
    INTO order_patient_uid,order_lineage_uid,order_facility_id
    FROM pharmacy_orders pharmacy_order
    JOIN users patient
      ON patient.tenant_id=pharmacy_order.tenant_id
     AND patient.id=pharmacy_order.patient_id
     AND patient.role='PATIENT'
   WHERE pharmacy_order.tenant_id=target_tenant_id
     AND pharmacy_order.id=target_pharmacy_order_id;
  IF order_patient_uid IS NULL OR order_facility_id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance preview lacks its exact order target'
      USING ERRCODE='23514';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,order_patient_uid
  );
  patient_uid_family:=public.resolve_billing_patient_family_753(
    target_tenant_id,terminal_patient_uid
  );
  IF order_lineage_uid IS NOT NULL
     AND (
       NOT order_lineage_uid=ANY(patient_uid_family)
       OR public.resolve_billing_patient_terminal_753(
            target_tenant_id,order_lineage_uid
          ) IS DISTINCT FROM terminal_patient_uid
       OR NOT EXISTS (
         SELECT 1
           FROM users lineage_patient
          WHERE lineage_patient.tenant_id=target_tenant_id
            AND lineage_patient.uid=order_lineage_uid
            AND lineage_patient.role='PATIENT'
       )
     ) THEN
    RAISE EXCEPTION 'Pharmacy advance preview order UUID lineage is stale'
      USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || target_tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || target_tenant_id::text || ':'
      || target_pharmacy_order_id::text,
    753
  ));
  SELECT COUNT(*),MIN(event.invoice_id),MIN(event.invoice_item_id),
         MIN(event.tpa_claim_id)
    INTO funding_target_count,target_invoice_id,target_invoice_item_id,
         target_tpa_claim_id
    FROM pharmacy_funding_decision_events event
    JOIN pharmacy_orders pharmacy_order
      ON pharmacy_order.tenant_id=event.tenant_id
     AND pharmacy_order.id=event.pharmacy_order_id
     AND pharmacy_order.inventory_authority_version=
         event.source_authority_version
     AND pharmacy_order.clinical_verification_items_sha256=
         event.source_authority_sha256
   WHERE event.tenant_id=target_tenant_id
     AND event.pharmacy_order_id=target_pharmacy_order_id
     AND event.event_type='LINE_MATERIALIZED';
  IF funding_target_count<>1 OR target_invoice_id IS NULL
     OR target_invoice_item_id IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance preview lacks one current DB funding target'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_reservation_funding_event_753';
  END IF;
  SELECT proposer.role
    INTO proposer_role
    FROM users proposer
   WHERE proposer.tenant_id=target_tenant_id
     AND proposer.uid=target_proposer_uid
     AND proposer.role IN ('PHARMACY_STAFF','PHARMACY_INCHARGE')
     AND proposer.is_active=TRUE
     AND proposer.status='active'
     AND COALESCE(proposer.is_deleted,FALSE)=FALSE
     AND proposer.merged_into_uid IS NULL
   FOR SHARE;
  IF proposer_role IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance preview proposer lacks active role authority'
      USING ERRCODE='42501';
  END IF;
  PERFORM 1
    FROM staff staff_identity
   WHERE staff_identity.tenant_id=target_tenant_id
     AND staff_identity.user_id=target_proposer_uid
     AND staff_identity.is_active=TRUE
     AND staff_identity.archived=FALSE
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance preview proposer lacks active staff authority'
      USING ERRCODE='42501';
  END IF;
  PERFORM 1
    FROM pharmacy_staff_facility_grants facility_grant
   WHERE facility_grant.tenant_id=target_tenant_id
     AND facility_grant.id=target_facility_grant_id
     AND facility_grant.staff_uid=target_proposer_uid
     AND facility_grant.facility_id=order_facility_id
     AND facility_grant.status='active'
     AND facility_grant.revoked_at IS NULL
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance preview proposer lacks exact facility authority'
      USING ERRCODE='42501';
  END IF;
  PERFORM public.lock_pharmacy_substitution_sources_753(
    target_tenant_id,terminal_patient_uid,target_pharmacy_order_id,
    target_invoice_id,target_invoice_item_id,target_selector
  );
  authority:=public.build_pharmacy_substitution_authority_753(
    target_tenant_id,terminal_patient_uid,patient_uid_family,
    target_pharmacy_order_id,target_invoice_id,target_invoice_item_id,
    target_selector,target_facility_grant_id
  );
  prospective_amount:=(authority #>>
    '{prospective,authoritative_amount}')::NUMERIC(10,2);
  prelock_plan:=public.build_pharmacy_advance_reservation_plan_753(
    target_tenant_id,terminal_patient_uid,patient_uid_family,
    target_pharmacy_order_id,target_invoice_id,target_invoice_item_id,
    target_tpa_claim_id,prospective_amount,NULL
  );
  SELECT COALESCE(ARRAY_AGG((source_advance->>'billing_advance_id')::INTEGER
           ORDER BY (source_advance->>'collected_at')::TIMESTAMPTZ,
                    (source_advance->>'billing_advance_id')::INTEGER),
         '{}'::INTEGER[])
    INTO advance_ids
    FROM jsonb_array_elements(
      prelock_plan #> '{funding,source_evidence,advances}'
    ) source_advance;
  PERFORM public.lock_pharmacy_advance_reservation_sources_753(
    target_tenant_id,terminal_patient_uid,target_pharmacy_order_id,
    target_invoice_id,target_invoice_item_id,target_tpa_claim_id,advance_ids
  );
  plan:=public.build_pharmacy_advance_reservation_plan_753(
    target_tenant_id,terminal_patient_uid,patient_uid_family,
    target_pharmacy_order_id,target_invoice_id,target_invoice_item_id,
    target_tpa_claim_id,prospective_amount,NULL
  );
  IF plan IS DISTINCT FROM prelock_plan THEN
    RAISE EXCEPTION 'Pharmacy advance preview changed while locking its sources'
      USING ERRCODE='40001';
  END IF;
  RETURN public.pharmacy_advance_reservation_public_plan_753(plan)
    || jsonb_build_object(
    'selector',authority->'selector',
    'base',authority->'base',
    'prospective',authority->'prospective',
    'billing',authority->'billing',
    'proposer',jsonb_build_object(
      'uid',target_proposer_uid::TEXT,
      'role',proposer_role,
      'facility_grant_id',target_facility_grant_id::TEXT
    )
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.reject_pharmacy_authority_recovery_event_mutation_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'pharmacy authority recovery events are append-only'
    USING ERRCODE='23514';
END;
$function$;
CREATE OR REPLACE FUNCTION public.reject_pharmacy_delivery_custody_event_mutation_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'pharmacy delivery custody events are append-only'
    USING ERRCODE='23514';
END;
$function$;
CREATE OR REPLACE FUNCTION public.reject_pharmacy_delivery_location_mutation_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'pharmacy delivery location evidence is append-only'
    USING ERRCODE='23514';
END;
$function$;
CREATE OR REPLACE FUNCTION public.reject_pharmacy_order_command_receipt_mutation_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'pharmacy order command receipts are append-only'
    USING ERRCODE='23514';
END;
$function$;
CREATE OR REPLACE FUNCTION public.reject_pharmacy_staff_facility_grant_event_mutation_753()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'pharmacy staff facility grant events are append-only'
    USING ERRCODE='23514';
END;
$function$;
CREATE OR REPLACE FUNCTION public.reserve_pharmacy_advance_allocations_753(target_tenant_id uuid, target_approval_receipt_id bigint, target_approver_uid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  discovered_receipt pharmacy_funding_commands%ROWTYPE;
  approval_receipt pharmacy_funding_commands%ROWTYPE;
  governance_approval approvals%ROWTYPE;
  governance_task tasks%ROWTYPE;
  terminal_patient_uid UUID;
  patient_uid_family UUID[];
  prospective_amount NUMERIC(10,2);
  prospective_version INTEGER;
  prospective_sha256 CHAR(64);
  base_version INTEGER;
  base_sha256 CHAR(64);
  expected_funding JSONB;
  prelock_plan JSONB;
  locked_plan JSONB;
  public_plan JSONB;
  advance_ids INTEGER[];
  reservation JSONB;
  allocation_payload JSONB;
  allocation_evidence JSONB;
  allocation_command_sha256 CHAR(64);
  inserted_allocation pharmacy_advance_allocations%ROWTYPE;
  persisted_allocations JSONB;
  proposer_grant_id BIGINT;
  approver_role TEXT;
  expected_task_resource_type TEXT;
  expected_assigned_role TEXT;
  expected_permitted_roles JSONB;
  selector JSONB;
  locked_authority JSONB;
  reservation_receipt JSONB;
  bound_reservation_count INTEGER;
BEGIN
  IF current_setting('app.current_tenant_id',TRUE) IS NULL
     OR current_setting('app.current_tenant_id',TRUE) IN ('','bypass')
     OR public.app_current_tenant_id_uuid() IS DISTINCT FROM target_tenant_id
     OR target_approval_receipt_id IS NULL
     OR target_approver_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance reservation requires exact tenant and actor context'
      USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  SELECT command.*
    INTO discovered_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_approval_receipt_id;
  IF NOT FOUND
     OR discovered_receipt.command_type<>'SUBSTITUTION_FUNDING_APPROVAL'
     OR discovered_receipt.patient_uid IS NULL THEN
    RAISE EXCEPTION 'Pharmacy advance reservation lacks its approval command'
      USING ERRCODE='23503';
  END IF;
  terminal_patient_uid:=public.resolve_billing_patient_terminal_753(
    target_tenant_id,discovered_receipt.patient_uid
  );
  patient_uid_family:=public.resolve_billing_patient_family_753(
    target_tenant_id,terminal_patient_uid
  );
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_funding_authority:' || target_tenant_id::text || ':'
      || terminal_patient_uid::text,
    753
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:substitution-funding:order:' || target_tenant_id::text || ':'
      || discovered_receipt.pharmacy_order_id::text,
    753
  ));
  SELECT command.*
    INTO approval_receipt
    FROM pharmacy_funding_commands command
   WHERE command.tenant_id=target_tenant_id
     AND command.id=target_approval_receipt_id
     AND command.command_type='SUBSTITUTION_FUNDING_APPROVAL'
     AND command.patient_uid=discovered_receipt.patient_uid
   FOR UPDATE;
  IF NOT FOUND
     OR approval_receipt.status<>'IN_PROGRESS'
     OR approval_receipt.created_by IS DISTINCT FROM target_approver_uid THEN
    RAISE EXCEPTION 'Pharmacy advance reservation approval changed before lock'
      USING ERRCODE='40001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'vh:pharmacy_advance_approval:' || target_tenant_id::text || ':'
      || target_approval_receipt_id::text,
    0
  ));
  SELECT approval.*
    INTO governance_approval
    FROM approvals approval
   WHERE approval.tenant_id=target_tenant_id
     AND approval.id=approval_receipt.governance_approval_id
   FOR UPDATE;
  SELECT task.*
    INTO governance_task
    FROM tasks task
   WHERE task.tenant_id=target_tenant_id
     AND task.id=approval_receipt.task_id
   FOR UPDATE;
  IF governance_approval.id IS NULL
     OR governance_task.id IS NULL
     OR governance_approval.status<>'approved'
     OR governance_approval.approval_kind<>
        'pharmacy_substitution_funding_reauthorisation'
     OR governance_approval.subject_resource_type<>
        'pharmacy_substitution_funding_proposal'
     OR governance_approval.created_by IS DISTINCT FROM approval_receipt.proposer_uid
     OR governance_approval.decided_by IS DISTINCT FROM target_approver_uid
     OR governance_approval.decided_at IS NULL
     OR governance_approval.decided_at>clock_timestamp()
     OR governance_approval.expires_at IS NULL
     OR governance_approval.decided_at>=governance_approval.expires_at
     OR clock_timestamp()>=governance_approval.expires_at
     OR governance_approval.subject_resource_id IS DISTINCT FROM
        approval_receipt.proposal_sha256
     OR governance_approval.task_id IS DISTINCT FROM approval_receipt.task_id
     OR governance_task.status NOT IN ('open','in_progress')
     OR governance_task.created_by IS DISTINCT FROM approval_receipt.proposer_uid
     OR governance_task.related_resource_type IS DISTINCT FROM
        approval_receipt.task_resource_type
     OR governance_task.related_resource_id IS DISTINCT FROM
        approval_receipt.pharmacy_order_id::text THEN
    RAISE EXCEPTION 'Pharmacy advance reservation lacks current governed approval authority'
      USING ERRCODE='23514';
  END IF;
  BEGIN
    prospective_amount:=(governance_approval.metadata #>>
      '{authority,prospective,authoritative_amount}')::NUMERIC(10,2);
    prospective_version:=(governance_approval.metadata #>>
      '{authority,prospective,order_version}')::INTEGER;
    prospective_sha256:=governance_approval.metadata #>>
      '{authority,prospective,order_items_sha256}';
    base_version:=(governance_approval.metadata #>>
      '{authority,base,order_version}')::INTEGER;
    base_sha256:=governance_approval.metadata #>>
      '{authority,base,order_items_sha256}';
    proposer_grant_id:=(governance_approval.metadata #>>
      '{authority,base,facility_grant_id}')::BIGINT;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Pharmacy advance reservation governance tuple is malformed'
        USING ERRCODE='23514';
  END;
  expected_funding:=governance_approval.metadata #> '{authority,funding}';
  expected_task_resource_type:=CASE expected_funding->>'funding_source'
    WHEN 'tpa_claim' THEN 'pharmacy_tpa_line_decision'
    WHEN 'mixed' THEN 'pharmacy_tpa_line_decision'
    WHEN 'patient_advance' THEN 'pharmacy_patient_advance'
    ELSE NULL
  END;
  expected_assigned_role:=CASE expected_funding->>'funding_source'
    WHEN 'tpa_claim' THEN 'INSURANCE_COORDINATOR'
    WHEN 'mixed' THEN 'FINANCE_INCHARGE'
    WHEN 'patient_advance' THEN 'FINANCE_INCHARGE'
    ELSE NULL
  END;
  expected_permitted_roles:=CASE expected_funding->>'funding_source'
    WHEN 'tpa_claim' THEN jsonb_build_array(
      'INSURANCE_COORDINATOR','CLAIMS_MANAGER','FINANCE_INCHARGE'
    )
    WHEN 'mixed' THEN jsonb_build_array('FINANCE_INCHARGE')
    WHEN 'patient_advance' THEN jsonb_build_array(
      'FINANCE_INCHARGE','BILLING_INCHARGE'
    )
    ELSE NULL
  END;
  IF jsonb_typeof(expected_funding) IS DISTINCT FROM 'object'
     OR expected_task_resource_type IS NULL
     OR expected_assigned_role IS NULL
     OR expected_permitted_roles IS NULL
     OR prospective_amount<=0
     OR prospective_version<>base_version+1
     OR prospective_sha256 !~ '^[0-9a-f]{64}$'
     OR base_version<=0
     OR base_sha256 !~ '^[0-9a-f]{64}$'
     OR governance_approval.metadata #>> '{authority,base,patient_uid}'
        IS DISTINCT FROM terminal_patient_uid::text
     OR governance_approval.metadata #>> '{authority,base,pharmacy_order_id}'
        IS DISTINCT FROM approval_receipt.pharmacy_order_id::text
     OR governance_approval.metadata->>'invoice_id' IS DISTINCT FROM
        approval_receipt.invoice_id::text
     OR governance_approval.metadata->>'invoice_item_id' IS DISTINCT FROM
        approval_receipt.invoice_item_id::text THEN
    RAISE EXCEPTION 'Pharmacy advance reservation governance plan is not exact'
      USING ERRCODE='23514';
  END IF;
  IF governance_task.task_kind<>'review'
     OR governance_task.status NOT IN ('open','in_progress')
     OR governance_task.related_resource_type IS DISTINCT FROM
        expected_task_resource_type
     OR governance_task.related_resource_id IS DISTINCT FROM
        approval_receipt.pharmacy_order_id::text
     OR governance_task.assigned_to_role IS DISTINCT FROM expected_assigned_role
     OR NOT governance_task.patient_uid=ANY(patient_uid_family)
     OR governance_task.metadata IS DISTINCT FROM jsonb_build_object(
       'contract','pharmacy_substitution_funding_task_v1',
       'stage','substitution_reauthorisation',
       'approval_id',governance_approval.id,
       'proposal_sha256',approval_receipt.proposal_sha256,
       'proposer_uid',approval_receipt.proposer_uid::text,
       'facility_id',approval_receipt.facility_id,
       'patient_uid',terminal_patient_uid::text,
       'pharmacy_order_id',approval_receipt.pharmacy_order_id,
       'invoice_id',approval_receipt.invoice_id,
       'invoice_item_id',approval_receipt.invoice_item_id,
       'tpa_claim_id',approval_receipt.tpa_claim_id,
       'base_order_version',base_version,
       'base_order_items_sha256',base_sha256,
       'prospective_order_version',prospective_version,
       'prospective_order_items_sha256',prospective_sha256,
       'prospective_authoritative_amount',prospective_amount::NUMERIC(10,2)::text,
       'permitted_roles',expected_permitted_roles
     )
     OR governance_approval.metadata->'permitted_approver_roles'
        IS DISTINCT FROM expected_permitted_roles THEN
    RAISE EXCEPTION 'Pharmacy advance reservation task authority is stale or incomplete'
      USING ERRCODE='23514';
  END IF;
  SELECT approver.role
    INTO approver_role
    FROM users approver
   WHERE approver.tenant_id=target_tenant_id
     AND approver.uid=target_approver_uid
     AND approver.is_active=TRUE
     AND approver.status='active'
     AND COALESCE(approver.is_deleted,FALSE)=FALSE
     AND approver.merged_into_uid IS NULL
     AND (
       (expected_funding->>'funding_source'='tpa_claim'
         AND approver.role IN (
           'INSURANCE_COORDINATOR','CLAIMS_MANAGER','FINANCE_INCHARGE'
         ))
       OR (expected_funding->>'funding_source'='mixed'
         AND approver.role='FINANCE_INCHARGE')
       OR (expected_funding->>'funding_source'='patient_advance'
         AND approver.role IN ('FINANCE_INCHARGE','BILLING_INCHARGE'))
     )
   FOR UPDATE;
  IF approver_role IS NULL
     OR target_approver_uid=approval_receipt.proposer_uid THEN
    RAISE EXCEPTION 'Pharmacy advance reservation approver lacks independent live role authority'
      USING ERRCODE='42501';
  END IF;
  PERFORM 1
    FROM staff staff_identity
   WHERE staff_identity.tenant_id=target_tenant_id
     AND staff_identity.user_id=target_approver_uid
     AND staff_identity.is_active=TRUE
     AND staff_identity.archived=FALSE
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation approver lacks active staff authority'
      USING ERRCODE='42501';
  END IF;
  PERFORM 1
    FROM users proposer
   WHERE proposer.tenant_id=target_tenant_id
     AND proposer.uid=approval_receipt.proposer_uid
     AND proposer.role IN ('PHARMACY_STAFF','PHARMACY_INCHARGE')
     AND proposer.is_active=TRUE
     AND proposer.status='active'
     AND COALESCE(proposer.is_deleted,FALSE)=FALSE
     AND proposer.merged_into_uid IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation proposer authority is stale'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1
    FROM staff staff_identity
   WHERE staff_identity.tenant_id=target_tenant_id
     AND staff_identity.user_id=approval_receipt.proposer_uid
     AND staff_identity.is_active=TRUE
     AND staff_identity.archived=FALSE
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation proposer staff authority is stale'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1
    FROM pharmacy_staff_facility_grants facility_grant
   WHERE facility_grant.tenant_id=target_tenant_id
     AND facility_grant.id=proposer_grant_id
     AND facility_grant.staff_uid=approval_receipt.proposer_uid
     AND facility_grant.facility_id=approval_receipt.facility_id
     AND facility_grant.status='active'
     AND facility_grant.revoked_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pharmacy advance reservation proposer facility authority is stale'
      USING ERRCODE='23514';
  END IF;
  selector:=governance_approval.metadata->'selector';
  PERFORM public.lock_pharmacy_substitution_sources_753(
    target_tenant_id,terminal_patient_uid,approval_receipt.pharmacy_order_id,
    approval_receipt.invoice_id,approval_receipt.invoice_item_id,selector
  );
  locked_authority:=public.build_pharmacy_substitution_authority_753(
    target_tenant_id,terminal_patient_uid,patient_uid_family,
    approval_receipt.pharmacy_order_id,approval_receipt.invoice_id,
    approval_receipt.invoice_item_id,selector,proposer_grant_id
  );
  IF selector IS DISTINCT FROM locked_authority->'selector'
     OR governance_approval.metadata #> '{authority,base}'
          IS DISTINCT FROM locked_authority->'base'
     OR governance_approval.metadata #> '{authority,prospective}'
          IS DISTINCT FROM locked_authority->'prospective'
     OR governance_approval.metadata #> '{authority,billing}'
          IS DISTINCT FROM locked_authority->'billing'
     OR prospective_amount IS DISTINCT FROM
          (locked_authority #>> '{prospective,authoritative_amount}')::NUMERIC(10,2)
     OR prospective_version IS DISTINCT FROM
          (locked_authority #>> '{prospective,order_version}')::INTEGER
     OR prospective_sha256 IS DISTINCT FROM
          locked_authority #>> '{prospective,order_items_sha256}'
     OR base_version IS DISTINCT FROM
          (locked_authority #>> '{base,order_version}')::INTEGER
     OR base_sha256 IS DISTINCT FROM
          locked_authority #>> '{base,order_items_sha256}' THEN
    RAISE EXCEPTION 'Approved substitution projection differs from locked database authority'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_substitution_db_authority_753';
  END IF;
  prelock_plan:=public.build_pharmacy_advance_reservation_plan_753(
    target_tenant_id,terminal_patient_uid,patient_uid_family,
    approval_receipt.pharmacy_order_id,approval_receipt.invoice_id,
    approval_receipt.invoice_item_id,approval_receipt.tpa_claim_id,
    prospective_amount,target_approval_receipt_id
  );
  SELECT COALESCE(ARRAY_AGG((source_advance->>'billing_advance_id')::INTEGER
           ORDER BY (source_advance->>'collected_at')::TIMESTAMPTZ,
                    (source_advance->>'billing_advance_id')::INTEGER),
         '{}'::INTEGER[])
    INTO advance_ids
    FROM jsonb_array_elements(
      prelock_plan #> '{funding,source_evidence,advances}'
    ) source_advance;
  PERFORM public.lock_pharmacy_advance_reservation_sources_753(
    target_tenant_id,terminal_patient_uid,
    approval_receipt.pharmacy_order_id,approval_receipt.invoice_id,
    approval_receipt.invoice_item_id,approval_receipt.tpa_claim_id,advance_ids
  );
  locked_plan:=public.build_pharmacy_advance_reservation_plan_753(
    target_tenant_id,terminal_patient_uid,patient_uid_family,
    approval_receipt.pharmacy_order_id,approval_receipt.invoice_id,
    approval_receipt.invoice_item_id,approval_receipt.tpa_claim_id,
    prospective_amount,target_approval_receipt_id
  );
  public_plan:=public.pharmacy_advance_reservation_public_plan_753(locked_plan);
  IF locked_plan IS DISTINCT FROM prelock_plan
     OR public_plan->'funding' IS DISTINCT FROM expected_funding
     OR (locked_plan->>'base_order_version')::INTEGER<>base_version
     OR locked_plan->>'base_order_items_sha256'<>base_sha256 THEN
    RAISE EXCEPTION 'Approved pharmacy advance source plan changed before reservation'
      USING ERRCODE='40001';
  END IF;
  FOR reservation IN
    SELECT value
      FROM jsonb_array_elements(locked_plan->'reservations') value
     ORDER BY (value->>'billing_advance_id')::INTEGER
  LOOP
    allocation_payload:=jsonb_build_object(
      'contract','pharmacy_advance_allocation_v1','command','reserve',
      'tenant_id',target_tenant_id::text,
      'governance_approval_id',approval_receipt.governance_approval_id,
      'approval_receipt_id',approval_receipt.id::text,
      'funding_task_id',approval_receipt.task_id,
      'proposal_sha256',approval_receipt.proposal_sha256,
      'billing_advance_id',(reservation->>'billing_advance_id')::INTEGER,
      'billing_advance_patient_uid',reservation->>'stored_patient_uid',
      'billing_advance_terminal_patient_uid',terminal_patient_uid::text,
      'allocated_amount',reservation->>'allocated_amount',
      'pharmacy_order_id',approval_receipt.pharmacy_order_id,
      'invoice_id',approval_receipt.invoice_id,
      'invoice_item_id',approval_receipt.invoice_item_id,
      'source_authority_version',base_version,
      'source_authority_sha256',base_sha256
    );
    allocation_command_sha256:=encode(
      public.digest(allocation_payload::text,'sha256'),'hex'
    );
    allocation_evidence:=jsonb_build_object(
      'contract','pharmacy_advance_allocation_v1',
      'governance_approval_id',approval_receipt.governance_approval_id,
      'approval_receipt_id',approval_receipt.id::text,
      'funding_task_id',approval_receipt.task_id,
      'proposal_sha256',approval_receipt.proposal_sha256,
      'proposer_uid',approval_receipt.proposer_uid::text,
      'approver_uid',approval_receipt.created_by::text,
      'pharmacy_order_id',approval_receipt.pharmacy_order_id,
      'invoice_id',approval_receipt.invoice_id,
      'invoice_item_id',approval_receipt.invoice_item_id,
      'patient_uid',terminal_patient_uid::text,
      'admission_id',governance_approval.metadata #>
        '{authority,base,admission_id}',
      'billing_advance_id',(reservation->>'billing_advance_id')::INTEGER,
      'billing_advance_patient_uid',reservation->>'stored_patient_uid',
      'billing_advance_terminal_patient_uid',terminal_patient_uid::text,
      'allocated_amount',reservation->>'allocated_amount',
      'allocation_command_sha256',allocation_command_sha256,
      'source_evidence_sha256',expected_funding->>'source_evidence_sha256',
      'base',jsonb_build_object(
        'order_version',base_version,'order_items_sha256',base_sha256
      ),
      'prospective',jsonb_build_object(
        'order_version',prospective_version,
        'order_items_sha256',prospective_sha256,
        'authoritative_amount',prospective_amount::NUMERIC(10,2)::text
      )
    );
    SELECT allocation.*
      INTO inserted_allocation
      FROM pharmacy_advance_allocations allocation
     WHERE allocation.tenant_id=target_tenant_id
       AND allocation.funding_approval_receipt_id=target_approval_receipt_id
       AND allocation.billing_advance_id=
          (reservation->>'billing_advance_id')::INTEGER
     FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO pharmacy_advance_allocations (
        tenant_id,pharmacy_order_id,invoice_id,invoice_item_id,
        billing_advance_id,source_authority_version,source_authority_sha256,
        allocated_amount,allocation_command_sha256,funding_task_id,
        funding_approval_receipt_id,allocated_by,evidence
      ) VALUES (
        target_tenant_id,approval_receipt.pharmacy_order_id,
        approval_receipt.invoice_id,approval_receipt.invoice_item_id,
        (reservation->>'billing_advance_id')::INTEGER,base_version,base_sha256,
        (reservation->>'allocated_amount')::NUMERIC(12,2),
        allocation_command_sha256,approval_receipt.task_id,
        approval_receipt.id,approval_receipt.created_by,allocation_evidence
      ) RETURNING * INTO inserted_allocation;
    ELSIF inserted_allocation.allocated_amount IS DISTINCT FROM
             (reservation->>'allocated_amount')::NUMERIC(12,2)
       OR inserted_allocation.allocation_command_sha256<>
          allocation_command_sha256
       OR inserted_allocation.evidence IS DISTINCT FROM allocation_evidence THEN
      RAISE EXCEPTION 'Pharmacy advance reservation replay changed allocation identity'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'allocation_id',allocation.id::text,
           'billing_advance_id',allocation.billing_advance_id,
           'billing_advance_patient_uid',advance.patient_uid::TEXT,
           'billing_advance_terminal_patient_uid',terminal_patient_uid::TEXT,
           'allocated_amount',allocation.allocated_amount::NUMERIC(12,2)::text,
           'allocation_command_sha256',allocation.allocation_command_sha256,
           'allocation_evidence_sha256',allocation.evidence_sha256,
           'source_authority_version',allocation.source_authority_version,
           'source_authority_sha256',allocation.source_authority_sha256,
           'allocated_by',allocation.allocated_by::text,
           'allocated_at',to_char(DATE_TRUNC('milliseconds',allocation.allocated_at)
             AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         ) ORDER BY allocation.id),'[]'::JSONB)
    INTO persisted_allocations
    FROM pharmacy_advance_allocations allocation
    JOIN billing_advances advance
      ON advance.tenant_id=allocation.tenant_id
     AND advance.id=allocation.billing_advance_id
   WHERE allocation.tenant_id=target_tenant_id
     AND allocation.funding_approval_receipt_id=target_approval_receipt_id;
  IF jsonb_array_length(persisted_allocations)<>
       jsonb_array_length(locked_plan->'reservations') THEN
    RAISE EXCEPTION 'Pharmacy advance reservation did not persist its exact allocation set'
      USING ERRCODE='23514';
  END IF;
  reservation_receipt:=locked_plan || jsonb_build_object(
    'approval_receipt_id',target_approval_receipt_id::text,
    'allocations',persisted_allocations
  );
  IF approval_receipt.reservation_authority IS NULL THEN
    PERFORM set_config(
      'app.pharmacy_advance_reservation_binding',
      target_approval_receipt_id::TEXT,TRUE
    );
    UPDATE pharmacy_funding_commands command
       SET reservation_authority=locked_authority,
           reservation_plan=reservation_receipt
     WHERE command.tenant_id=target_tenant_id
       AND command.id=target_approval_receipt_id
       AND command.status='IN_PROGRESS'
       AND command.reservation_authority IS NULL
       AND command.reservation_plan IS NULL;
    GET DIAGNOSTICS bound_reservation_count=ROW_COUNT;
    IF bound_reservation_count<>1 THEN
      RAISE EXCEPTION 'Pharmacy advance reservation changed before receipt binding'
        USING ERRCODE='40001';
    END IF;
  ELSIF approval_receipt.reservation_authority IS DISTINCT FROM locked_authority
     OR approval_receipt.reservation_plan IS DISTINCT FROM reservation_receipt THEN
    RAISE EXCEPTION 'Pharmacy advance reservation replay changed immutable evidence'
      USING ERRCODE='23514';
  END IF;
  RETURN public_plan || jsonb_build_object(
    'approval_receipt_id',target_approval_receipt_id::TEXT
  );
END;
$function$;
CREATE OR REPLACE FUNCTION public.resolve_billing_patient_family_753(target_tenant_id uuid, target_terminal_uid uuid)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  family_uids UUID[];
  has_cycle BOOLEAN;
  has_truncated_family BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  IF public.resolve_billing_patient_terminal_753(
       target_tenant_id,target_terminal_uid
     ) IS DISTINCT FROM target_terminal_uid THEN
    RAISE EXCEPTION 'Patient funding identity is not the terminal tenant patient'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_patient_family_753';
  END IF;
  WITH RECURSIVE family AS (
    SELECT patient.uid,ARRAY[patient.uid]::UUID[] AS path,
           0 AS depth,FALSE AS cycle
      FROM users patient
     WHERE patient.tenant_id=target_tenant_id
       AND patient.uid=target_terminal_uid
       AND patient.role='PATIENT'
    UNION ALL
    SELECT predecessor.uid,family.path || predecessor.uid,
           family.depth+1,predecessor.uid=ANY(family.path)
      FROM family
      JOIN users predecessor
        ON predecessor.tenant_id=target_tenant_id
       AND predecessor.merged_into_uid=family.uid
       AND predecessor.role='PATIENT'
     WHERE family.depth<32
       AND family.cycle=FALSE
  )
  SELECT ARRAY[target_terminal_uid]
         || COALESCE(ARRAY_AGG(DISTINCT uid ORDER BY uid)
              FILTER (WHERE uid<>target_terminal_uid),'{}'::UUID[]),
         COALESCE(BOOL_OR(cycle),FALSE)
    INTO family_uids,has_cycle
    FROM family;
  IF family_uids IS NULL OR CARDINALITY(family_uids)=0 OR has_cycle THEN
    RAISE EXCEPTION 'Patient funding family is missing or cyclic'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_patient_family_753';
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM users predecessor
     WHERE predecessor.tenant_id=target_tenant_id
       AND predecessor.role='PATIENT'
       AND predecessor.merged_into_uid=ANY(family_uids)
       AND NOT predecessor.uid=ANY(family_uids)
  ) INTO has_truncated_family;
  IF has_truncated_family THEN
    RAISE EXCEPTION 'Patient funding family exceeds the governed depth bound'
      USING ERRCODE='23514',
            CONSTRAINT='chk_pharmacy_advance_patient_family_753';
  END IF;
  RETURN family_uids;
END;
$function$;
CREATE OR REPLACE FUNCTION public.resolve_billing_patient_terminal_753(target_tenant_id uuid, target_patient_uid uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  terminal_uid UUID;
  terminal_count INTEGER;
  has_cycle BOOLEAN;
  has_truncated_chain BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(
    'vhhealth:patient-merge-tenant:' || target_tenant_id::text,
    0
  ));
  WITH RECURSIVE patient_chain AS (
    SELECT patient.uid,patient.merged_into_uid,
           ARRAY[patient.uid]::UUID[] AS path,1 AS depth,FALSE AS cycle
      FROM users patient
     WHERE patient.tenant_id=target_tenant_id
       AND patient.uid=target_patient_uid
       AND patient.role='PATIENT'
    UNION ALL
    SELECT successor.uid,successor.merged_into_uid,
           chain.path || successor.uid,chain.depth+1,
           successor.uid=ANY(chain.path)
      FROM patient_chain chain
      JOIN users successor
        ON successor.tenant_id=target_tenant_id
       AND successor.uid=chain.merged_into_uid
       AND successor.role='PATIENT'
     WHERE chain.merged_into_uid IS NOT NULL
       AND chain.cycle=FALSE
       AND chain.depth<32
  )
  SELECT (ARRAY_AGG(uid) FILTER (
           WHERE merged_into_uid IS NULL AND cycle=FALSE
         ))[1],
         COUNT(*) FILTER (WHERE merged_into_uid IS NULL AND cycle=FALSE),
         COALESCE(BOOL_OR(cycle),FALSE),
         COALESCE(BOOL_OR(depth=32 AND merged_into_uid IS NOT NULL
           AND cycle=FALSE),FALSE)
    INTO terminal_uid,terminal_count,has_cycle,has_truncated_chain
    FROM patient_chain;
  IF terminal_count<>1 OR terminal_uid IS NULL OR has_cycle
     OR has_truncated_chain THEN
    RAISE EXCEPTION 'Patient merge lineage is missing, cyclic, ambiguous, or too deep'
      USING ERRCODE='23514',
            CONSTRAINT='chk_billing_advance_settlement_patient_lineage_753';
  END IF;
  RETURN terminal_uid;
END;
$function$;
CREATE OR REPLACE FUNCTION public.revalidate_admission_advance_lineage_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  affected_allocation RECORD;
  affected_settlement RECORD;
BEGIN
  FOR affected_allocation IN
    SELECT allocation.billing_advance_id,allocation.invoice_id
      FROM pharmacy_advance_allocations allocation
      JOIN billing_invoices invoice
        ON invoice.tenant_id=allocation.tenant_id
       AND invoice.id=allocation.invoice_id
     WHERE allocation.tenant_id=NEW.tenant_id
       AND invoice.admission_id=NEW.id
       AND (
         allocation.allocated_amount>(
           SELECT COALESCE(SUM(reversal.reversed_amount),0)
             FROM pharmacy_advance_allocation_reversals reversal
            WHERE reversal.tenant_id=allocation.tenant_id
              AND reversal.allocation_id=allocation.id
         )
         OR EXISTS (
           SELECT 1
             FROM pharmacy_advance_allocation_consumptions consumption
            WHERE consumption.tenant_id=allocation.tenant_id
              AND consumption.allocation_id=allocation.id
         )
       )
     ORDER BY allocation.billing_advance_id,allocation.id
  LOOP
    PERFORM public.assert_pharmacy_advance_patient_scope_753(
      NEW.tenant_id,affected_allocation.billing_advance_id,
      NEW.patient_uid,NEW.id
    );
  END LOOP;
  FOR affected_settlement IN
    SELECT settlement.advance_id,settlement.invoice_id
      FROM billing_advance_settlements settlement
      JOIN billing_invoices invoice
        ON invoice.tenant_id=settlement.tenant_id
       AND invoice.id=settlement.invoice_id
     WHERE settlement.tenant_id=NEW.tenant_id
       AND invoice.admission_id=NEW.id
     ORDER BY settlement.advance_id,settlement.id
  LOOP
    PERFORM public.assert_billing_advance_settlement_lineage_753(
      NEW.tenant_id,affected_settlement.advance_id,
      affected_settlement.invoice_id
    );
  END LOOP;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.revalidate_invoice_settlement_lineage_753()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  affected_settlement RECORD;
BEGIN
  FOR affected_settlement IN
    SELECT settlement.advance_id,settlement.invoice_id
      FROM billing_advance_settlements settlement
     WHERE settlement.tenant_id=NEW.tenant_id
       AND settlement.invoice_id=NEW.id
     ORDER BY settlement.advance_id,settlement.id
  LOOP
    PERFORM public.assert_billing_advance_settlement_lineage_753(
      NEW.tenant_id,affected_settlement.advance_id,
      affected_settlement.invoice_id
    );
  END LOOP;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.validate_pharmacy_order_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  canonical CONSTANT text[] := ARRAY[
    'PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'DISPATCHED',
    'PARTIALLY_DISPENSED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE',
    'CANCELLED', 'ON_HOLD', 'REJECTED'
  ];
  allowed text[];
  old_semantic text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NULL OR NOT (NEW.status = ANY (canonical)) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_pharmacy_order_status_vocabulary',
      MESSAGE = FORMAT('Pharmacy order status %L is not in the canonical vocabulary', NEW.status);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_semantic := UPPER(REPLACE(REPLACE(BTRIM(OLD.status), '-', '_'), ' ', '_'));
    IF OLD.status IS NULL OR NOT (old_semantic = ANY (canonical)) THEN
      IF NEW.status IN ('ON_HOLD', 'CANCELLED')
         AND current_setting('app.pharmacy_authority_recovery_id', TRUE) ~ '^[0-9]+$'
         AND EXISTS (
           SELECT 1
             FROM pharmacy_inventory_authority_recovery_worklist recovery
            WHERE recovery.id=current_setting(
                    'app.pharmacy_authority_recovery_id', TRUE
                  )::bigint
              AND recovery.tenant_id=NEW.tenant_id
              AND recovery.entity_type='pharmacy_order'
              AND recovery.entity_id=NEW.id
              AND recovery.reason_code='ORDER_STATUS_NONCANONICAL'
              AND recovery.status='OPEN'
         ) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_pharmacy_order_status_legacy_recovery_required',
        MESSAGE = FORMAT(
          'Pharmacy order status %L requires governed recovery before transition',
          OLD.status
        );
    END IF;
    IF NEW.status = old_semantic AND OLD.status IS DISTINCT FROM old_semantic THEN
      RETURN NEW;
    END IF;
    allowed := CASE old_semantic
      WHEN 'PENDING' THEN ARRAY['CONFIRMED', 'READY', 'ON_HOLD', 'PARTIALLY_DISPENSED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'CONFIRMED' THEN ARRAY['ON_HOLD', 'PREPARING', 'READY', 'DISPATCHED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'PARTIALLY_DISPENSED' THEN ARRAY['DISPENSED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'PREPARING' THEN ARRAY['READY', 'DISPATCHED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'READY' THEN ARRAY['DISPATCHED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'DISPATCHED' THEN ARRAY['DELIVERED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'ON_HOLD' THEN ARRAY['CONFIRMED', 'UNAVAILABLE', 'CANCELLED']
      WHEN 'REJECTED' THEN ARRAY['UNAVAILABLE', 'CANCELLED']
      ELSE ARRAY[]::text[]
    END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_pharmacy_order_status_transition',
        MESSAGE = FORMAT('Pharmacy order transition %s -> %s is not allowed', OLD.status, NEW.status);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ---- new table: pharmacy_advance_allocation_consumptions ----
CREATE TABLE public.pharmacy_advance_allocation_consumptions (
    id bigint NOT NULL,
    tenant_id uuid NOT NULL,
    allocation_id bigint NOT NULL,
    pharmacy_order_id integer NOT NULL,
    invoice_id integer NOT NULL,
    invoice_item_id integer NOT NULL,
    billing_advance_id integer NOT NULL,
    source_authority_version integer NOT NULL,
    source_authority_sha256 character(64) NOT NULL,
    funding_task_id integer NOT NULL,
    funding_approval_receipt_id bigint NOT NULL,
    allocation_evidence_sha256 character(64) NOT NULL,
    funding_consumption_receipt_id bigint NOT NULL,
    consumption_command_sha256 character(64) NOT NULL,
    consumed_by uuid NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL,
    evidence jsonb NOT NULL,
    evidence_sha256 character(64) GENERATED ALWAYS AS (encode(public.digest((evidence)::text, 'sha256'::text), 'hex'::text)) STORED NOT NULL,
    CONSTRAINT chk_pharmacy_advance_allocation_consumption_753 CHECK (((source_authority_version > 0) AND (source_authority_sha256 ~ '^[0-9a-f]{64}$'::text) AND (allocation_evidence_sha256 ~ '^[0-9a-f]{64}$'::text) AND (consumption_command_sha256 ~ '^[0-9a-f]{64}$'::text) AND (funding_consumption_receipt_id <> funding_approval_receipt_id) AND (jsonb_typeof(evidence) = 'object'::text)))
);
ALTER TABLE ONLY public.pharmacy_advance_allocation_consumptions FORCE ROW LEVEL SECURITY;
COMMENT ON TABLE public.pharmacy_advance_allocation_consumptions IS 'Append-only final-dispense links from immutable advance holds to one paired completed funding-consumption receipt and authority generation.';
CREATE SEQUENCE public.pharmacy_advance_allocation_consumptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.pharmacy_advance_allocation_consumptions_id_seq OWNED BY public.pharmacy_advance_allocation_consumptions.id;
ALTER TABLE ONLY public.pharmacy_advance_allocation_consumptions ALTER COLUMN id SET DEFAULT nextval('public.pharmacy_advance_allocation_consumptions_id_seq'::regclass);
ALTER TABLE ONLY public.pharmacy_advance_allocation_consumptions
    ADD CONSTRAINT pharmacy_advance_allocation_consumptions_pkey PRIMARY KEY (id);
CREATE INDEX idx_pharmacy_advance_consumptions_actor_753 ON public.pharmacy_advance_allocation_consumptions USING btree (tenant_id, consumed_by, id);
CREATE INDEX idx_pharmacy_advance_consumptions_exact_fk_753 ON public.pharmacy_advance_allocation_consumptions USING btree (tenant_id, allocation_id, pharmacy_order_id, invoice_id, invoice_item_id, billing_advance_id, source_authority_version, source_authority_sha256, funding_task_id, funding_approval_receipt_id, allocation_evidence_sha256, id);
CREATE INDEX idx_pharmacy_advance_consumptions_order_753 ON public.pharmacy_advance_allocation_consumptions USING btree (tenant_id, pharmacy_order_id, source_authority_version, source_authority_sha256, id);
CREATE INDEX idx_pharmacy_advance_consumptions_receipt_753 ON public.pharmacy_advance_allocation_consumptions USING btree (tenant_id, funding_consumption_receipt_id, funding_task_id, pharmacy_order_id, invoice_item_id, funding_approval_receipt_id, consumption_command_sha256, allocation_id, id);
CREATE UNIQUE INDEX ux_pharmacy_advance_consumptions_allocation_753 ON public.pharmacy_advance_allocation_consumptions USING btree (tenant_id, allocation_id);
CREATE UNIQUE INDEX ux_pharmacy_advance_consumptions_identity_753 ON public.pharmacy_advance_allocation_consumptions USING btree (tenant_id, id, allocation_id, funding_consumption_receipt_id, consumption_command_sha256, evidence_sha256);
CREATE TRIGGER trg_00_pharmacy_advance_consumption_time_753 BEFORE INSERT ON public.pharmacy_advance_allocation_consumptions FOR EACH ROW EXECUTE FUNCTION public.derive_pharmacy_advance_consumption_time_753();
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_consumption_complete_753 AFTER INSERT ON public.pharmacy_advance_allocation_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_advance_consumption_complete_753();
CREATE TRIGGER trg_pharmacy_advance_consumption_link_753 BEFORE INSERT ON public.pharmacy_advance_allocation_consumptions FOR EACH ROW EXECUTE FUNCTION public.enforce_pharmacy_advance_consumption_link_753();
CREATE TRIGGER trg_pharmacy_advance_consumptions_append_only_753 BEFORE DELETE OR UPDATE ON public.pharmacy_advance_allocation_consumptions FOR EACH ROW EXECUTE FUNCTION public.prevent_pharmacy_advance_allocation_mutation_753();
CREATE POLICY explicit_tenant_context ON public.pharmacy_advance_allocation_consumptions AS RESTRICTIVE USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = public.app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = public.app_current_tenant_id_uuid())));
ALTER TABLE public.pharmacy_advance_allocation_consumptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.pharmacy_advance_allocation_consumptions USING (((current_setting('app.current_tenant_id'::text, true) = ANY (ARRAY[''::text, 'bypass'::text])) OR (current_setting('app.current_tenant_id'::text, true) IS NULL) OR (tenant_id = public.app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) = ANY (ARRAY[''::text, 'bypass'::text])) OR (current_setting('app.current_tenant_id'::text, true) IS NULL) OR (tenant_id = public.app_current_tenant_id_uuid())));

-- ---- columns added to existing tables ----
ALTER TABLE public.pharmacy_order_command_receipts ADD COLUMN IF NOT EXISTS response_evidence_sha256 character(64) GENERATED ALWAYS AS (encode(digest((response_payload)::text, 'sha256'::text), 'hex'::text)) STORED;
ALTER TABLE public.pharmacy_order_command_receipts ALTER COLUMN response_evidence_sha256 SET NOT NULL;
ALTER TABLE public.billing_advance_settlements ADD COLUMN IF NOT EXISTS pharmacy_advance_settlement_receipt_id bigint;
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS reservation_authority jsonb;
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS reservation_plan jsonb;
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS order_mutation_command_sha256 character(64);
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS reservation_plan_sha256 character(64);
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS order_mutation_request_sha256 character(64);
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS order_mutation_action character varying(64);
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS patient_uid uuid;
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS completed_transaction_id bigint;
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS order_mutation_receipt_id bigint;
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS release_source_approval_id integer;
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS reservation_authority_sha256 character(64);
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS release_reason character varying(40);
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS order_mutation_evidence_sha256 character(64);
ALTER TABLE public.pharmacy_order_command_receipts ADD COLUMN IF NOT EXISTS authority_transaction_id bigint;
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS reserved_at timestamp with time zone;
ALTER TABLE public.pharmacy_funding_commands ADD COLUMN IF NOT EXISTS reserved_transaction_id bigint;

-- ---- indexes ----
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_order_command_receipt_evidence_753 ON public.pharmacy_order_command_receipts USING btree (tenant_id, id, pharmacy_order_id, action, command_key_sha256, request_sha256, response_evidence_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_commands_receipt_identity_753 ON public.pharmacy_funding_commands USING btree (tenant_id, id, task_id, pharmacy_order_id, invoice_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_commands_tenant_id_753 ON public.pharmacy_funding_commands USING btree (tenant_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_commands_approval_amount_753 ON public.pharmacy_funding_commands USING btree (tenant_id, id, task_id, pharmacy_order_id, invoice_item_id, approved_patient_amount);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_commands_pair_identity_753 ON public.pharmacy_funding_commands USING btree (tenant_id, id, task_id, pharmacy_order_id, invoice_item_id, approval_receipt_id, command_key_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_commands_governance_identity_753 ON public.pharmacy_funding_commands USING btree (tenant_id, id, pharmacy_order_id, facility_id, invoice_id, invoice_item_id, governance_approval_id, proposal_sha256, proposer_uid, patient_uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_commands_consumption_identity_753 ON public.pharmacy_funding_commands USING btree (tenant_id, id, approval_receipt_id, pharmacy_order_id, facility_id, invoice_id, invoice_item_id, governance_approval_id, proposal_sha256, proposer_uid, patient_uid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_approval_task_753 ON public.pharmacy_funding_commands USING btree (tenant_id, task_id) WHERE ((command_type)::text = 'SUBSTITUTION_FUNDING_APPROVAL'::text);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_consumption_approval_753 ON public.pharmacy_funding_commands USING btree (tenant_id, approval_receipt_id) WHERE ((command_type)::text = 'SUBSTITUTION_FUNDING_CONSUMPTION'::text);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_consumption_task_753 ON public.pharmacy_funding_commands USING btree (tenant_id, task_id) WHERE ((command_type)::text = 'SUBSTITUTION_FUNDING_CONSUMPTION'::text);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_settlement_consumption_753 ON public.pharmacy_funding_commands USING btree (tenant_id, consumption_receipt_id) WHERE ((command_type)::text = 'PHARMACY_ADVANCE_SETTLEMENT'::text);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_settlement_task_753 ON public.pharmacy_funding_commands USING btree (tenant_id, task_id) WHERE ((command_type)::text = 'PHARMACY_ADVANCE_SETTLEMENT'::text);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_release_approval_753 ON public.pharmacy_funding_commands USING btree (tenant_id, approval_receipt_id) WHERE ((command_type)::text = 'PHARMACY_ADVANCE_RELEASE'::text);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_release_task_753 ON public.pharmacy_funding_commands USING btree (tenant_id, task_id) WHERE ((command_type)::text = 'PHARMACY_ADVANCE_RELEASE'::text);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_release_source_753 ON public.pharmacy_funding_commands USING btree (tenant_id, release_source_approval_id) WHERE (((command_type)::text = 'PHARMACY_ADVANCE_RELEASE'::text) AND (release_source_approval_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_advance_settlements_exact_753 ON public.billing_advance_settlements USING btree (tenant_id, id, advance_id, invoice_id, amount);
CREATE INDEX IF NOT EXISTS idx_billing_advance_settlements_capacity_753 ON public.billing_advance_settlements USING btree (tenant_id, advance_id, settled_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_settlement_receipt_identity_753 ON public.pharmacy_funding_commands USING btree (tenant_id, id, approval_receipt_id, consumption_receipt_id, pharmacy_order_id, facility_id, invoice_id, invoice_item_id, created_by) WHERE ((command_type)::text = 'PHARMACY_ADVANCE_SETTLEMENT'::text);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_command_invoice_actor_753 ON public.pharmacy_funding_commands USING btree (tenant_id, id, invoice_id, created_by);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_command_reversal_receipt_753 ON public.pharmacy_funding_commands USING btree (tenant_id, id, approval_receipt_id, pharmacy_order_id, invoice_id, invoice_item_id, created_by);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_commands_order_753 ON public.pharmacy_funding_commands USING btree (tenant_id, pharmacy_order_id, facility_id, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_commands_invoice_753 ON public.pharmacy_funding_commands USING btree (tenant_id, invoice_id, invoice_item_id, id) WHERE (invoice_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_commands_claim_753 ON public.pharmacy_funding_commands USING btree (tenant_id, tpa_claim_id, id) WHERE (tpa_claim_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_commands_actor_753 ON public.pharmacy_funding_commands USING btree (tenant_id, created_by, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_commands_approval_receipt_753 ON public.pharmacy_funding_commands USING btree (tenant_id, approval_receipt_id, task_id, pharmacy_order_id, invoice_item_id) WHERE (approval_receipt_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_commands_governance_753 ON public.pharmacy_funding_commands USING btree (tenant_id, governance_approval_id, proposal_sha256, proposer_uid, id) WHERE (governance_approval_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pharmacy_funding_commands_proposer_753 ON public.pharmacy_funding_commands USING btree (tenant_id, proposer_uid, id) WHERE (proposer_uid IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_funding_commands_order_mutation_753 ON public.pharmacy_funding_commands USING btree (tenant_id, order_mutation_receipt_id) WHERE (order_mutation_receipt_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_advance_deposits_ipd_source_753 ON public.advance_deposits USING btree (tenant_id, id, patient_uid, admission_id, amount, payment_method, collected_by, collected_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_advances_ipd_source_753 ON public.billing_advances USING btree (tenant_id, ipd_advance_deposit_id) WHERE (ipd_advance_deposit_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_billing_advances_ipd_source_fk_753 ON public.billing_advances USING btree (tenant_id, ipd_advance_deposit_id, patient_uid, admission_id, amount, ipd_advance_deposit_payment_method, collected_by, ipd_advance_deposit_collected_at, id) WHERE (ipd_advance_deposit_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_billing_advance_settlements_tenant_advance_753 ON public.billing_advance_settlements USING btree (tenant_id, advance_id, id);
CREATE INDEX IF NOT EXISTS idx_billing_advance_settlements_tenant_invoice_753 ON public.billing_advance_settlements USING btree (tenant_id, invoice_id, id);
CREATE INDEX IF NOT EXISTS idx_billing_refunds_advance_capacity_753 ON public.billing_refunds USING btree (tenant_id, advance_id, approval_status, raised_at, id) WHERE ((advance_id IS NOT NULL) AND ((approval_status)::text <> 'REJECTED'::text));
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_allocations_exact_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, funding_approval_receipt_id, billing_advance_id, invoice_item_id, source_authority_version, source_authority_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_allocations_command_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, allocation_command_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_allocations_identity_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, id, pharmacy_order_id, invoice_id, invoice_item_id, billing_advance_id, source_authority_version, source_authority_sha256, funding_task_id, funding_approval_receipt_id, evidence_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_allocations_settlement_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, id, billing_advance_id, invoice_id, allocated_amount, evidence_sha256);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_allocations_capacity_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, billing_advance_id, allocated_at, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_allocations_order_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, pharmacy_order_id, source_authority_version, source_authority_sha256, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_allocations_invoice_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, invoice_id, invoice_item_id, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_allocations_item_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, invoice_item_id, invoice_id, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_allocations_task_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, funding_task_id, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_allocations_approval_receipt_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, funding_approval_receipt_id, funding_task_id, pharmacy_order_id, invoice_item_id, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_allocations_actor_753 ON public.pharmacy_advance_allocations USING btree (tenant_id, allocated_by, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_advance_settlements_pharmacy_allocation_753 ON public.billing_advance_settlements USING btree (tenant_id, pharmacy_advance_allocation_id) WHERE (pharmacy_advance_allocation_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_advance_settlements_pharmacy_receipt_allocation_753 ON public.billing_advance_settlements USING btree (tenant_id, pharmacy_advance_settlement_receipt_id, pharmacy_advance_allocation_id) WHERE (pharmacy_advance_settlement_receipt_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_advance_settlements_pharmacy_command_753 ON public.billing_advance_settlements USING btree (tenant_id, pharmacy_advance_settlement_receipt_id, pharmacy_advance_conversion_command_sha256, pharmacy_advance_allocation_id) WHERE (pharmacy_advance_conversion_command_sha256 IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_advance_settlements_pharmacy_exact_753 ON public.billing_advance_settlements USING btree (tenant_id, id, advance_id, invoice_id, amount, settled_by, pharmacy_advance_allocation_id, pharmacy_advance_settlement_receipt_id, pharmacy_advance_allocation_evidence_sha256, pharmacy_advance_conversion_command_sha256, pharmacy_advance_conversion_evidence_sha256);
CREATE INDEX IF NOT EXISTS idx_billing_advance_settlements_pharmacy_fk_753 ON public.billing_advance_settlements USING btree (tenant_id, pharmacy_advance_allocation_id, advance_id, invoice_id, amount, pharmacy_advance_allocation_evidence_sha256, id) WHERE (pharmacy_advance_allocation_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_allocation_reversals_command_753 ON public.pharmacy_advance_allocation_reversals USING btree (tenant_id, reversal_command_sha256, allocation_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_allocation_reversals_settlement_753 ON public.pharmacy_advance_allocation_reversals USING btree (tenant_id, billing_advance_settlement_id) WHERE (billing_advance_settlement_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_reversal_settlement_receipt_753 ON public.pharmacy_advance_allocation_reversals USING btree (tenant_id, funding_settlement_receipt_id, allocation_id) WHERE (funding_settlement_receipt_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pharmacy_advance_reversal_release_receipt_753 ON public.pharmacy_advance_allocation_reversals USING btree (tenant_id, funding_release_receipt_id, allocation_id) WHERE (funding_release_receipt_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_allocation_reversals_allocation_753 ON public.pharmacy_advance_allocation_reversals USING btree (tenant_id, allocation_id, reversed_at, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_reversals_exact_fk_753 ON public.pharmacy_advance_allocation_reversals USING btree (tenant_id, allocation_id, pharmacy_order_id, invoice_id, invoice_item_id, billing_advance_id, source_authority_version, source_authority_sha256, funding_task_id, funding_approval_receipt_id, allocation_evidence_sha256, id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_reversals_settlement_fk_753 ON public.pharmacy_advance_allocation_reversals USING btree (tenant_id, billing_advance_settlement_id, billing_advance_id, invoice_id, reversed_amount, reversed_by, allocation_id, funding_settlement_receipt_id, allocation_evidence_sha256, reversal_command_sha256, evidence_sha256, id) WHERE (billing_advance_settlement_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_pharmacy_advance_allocation_reversals_actor_753 ON public.pharmacy_advance_allocation_reversals USING btree (tenant_id, reversed_by, id);

-- ---- constraints ----
ALTER TABLE public.pharmacy_order_command_receipts DROP CONSTRAINT IF EXISTS chk_pharmacy_order_command_receipt_transaction_753;
ALTER TABLE public.pharmacy_order_command_receipts ADD CONSTRAINT chk_pharmacy_order_command_receipt_transaction_753 CHECK (((((action)::text = 'dispense_substitution'::text) AND (authority_transaction_id > 0)) OR (((action)::text <> 'dispense_substitution'::text) AND (authority_transaction_id IS NULL))));
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_proposer_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_proposer_753 FOREIGN KEY (tenant_id, proposer_uid) REFERENCES users(tenant_id, uid) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_patient_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_patient_753 FOREIGN KEY (tenant_id, patient_uid) REFERENCES users(tenant_id, uid) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_order_mutation_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_order_mutation_753 FOREIGN KEY (tenant_id, order_mutation_receipt_id, pharmacy_order_id, order_mutation_action, order_mutation_command_sha256, order_mutation_request_sha256, order_mutation_evidence_sha256) REFERENCES pharmacy_order_command_receipts(tenant_id, id, pharmacy_order_id, action, command_key_sha256, request_sha256, response_evidence_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS chk_pharmacy_funding_command_type_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT chk_pharmacy_funding_command_type_753 CHECK (((command_type IN ('TPA_LINE_DECISION', 'POSTED_PAYMENT_RETRY', 'SUBSTITUTION_FUNDING_APPROVAL', 'SUBSTITUTION_FUNDING_CONSUMPTION', 'PHARMACY_ADVANCE_SETTLEMENT', 'PHARMACY_ADVANCE_RELEASE'))));
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS chk_pharmacy_funding_command_receipt_pair_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT chk_pharmacy_funding_command_receipt_pair_753 CHECK (((((command_type)::text = 'SUBSTITUTION_FUNDING_CONSUMPTION'::text) AND (approval_receipt_id IS NOT NULL) AND (consumption_receipt_id IS NULL)) OR (((command_type)::text = 'PHARMACY_ADVANCE_RELEASE'::text) AND (approval_receipt_id IS NOT NULL) AND (consumption_receipt_id IS NULL)) OR (((command_type)::text = 'PHARMACY_ADVANCE_SETTLEMENT'::text) AND (approval_receipt_id IS NOT NULL) AND (consumption_receipt_id IS NOT NULL) AND (consumption_receipt_id <> approval_receipt_id)) OR (((command_type NOT IN ('SUBSTITUTION_FUNDING_CONSUMPTION', 'PHARMACY_ADVANCE_SETTLEMENT', 'PHARMACY_ADVANCE_RELEASE'))) AND (approval_receipt_id IS NULL) AND (consumption_receipt_id IS NULL))));
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS chk_pharmacy_funding_command_governance_source_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT chk_pharmacy_funding_command_governance_source_753 CHECK (((((command_type IN ('SUBSTITUTION_FUNDING_APPROVAL', 'SUBSTITUTION_FUNDING_CONSUMPTION', 'PHARMACY_ADVANCE_SETTLEMENT', 'PHARMACY_ADVANCE_RELEASE'))) AND (facility_id IS NOT NULL) AND (invoice_id IS NOT NULL) AND (governance_approval_id IS NOT NULL) AND (proposal_sha256 IS NOT NULL) AND (proposer_uid IS NOT NULL) AND (patient_uid IS NOT NULL)) OR (((command_type NOT IN ('SUBSTITUTION_FUNDING_APPROVAL', 'SUBSTITUTION_FUNDING_CONSUMPTION', 'PHARMACY_ADVANCE_SETTLEMENT', 'PHARMACY_ADVANCE_RELEASE'))) AND (facility_id IS NULL) AND (invoice_id IS NULL) AND (governance_approval_id IS NULL) AND (proposal_sha256 IS NULL) AND (proposer_uid IS NULL) AND (patient_uid IS NULL))));
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS chk_pharmacy_funding_command_release_source_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT chk_pharmacy_funding_command_release_source_753 CHECK (((((command_type)::text = 'PHARMACY_ADVANCE_RELEASE'::text) AND ((release_reason)::text = 'AUTHORITY_SUPERSEDED'::text) AND (release_source_approval_id IS NOT NULL)) OR (((command_type)::text = 'PHARMACY_ADVANCE_RELEASE'::text) AND ((release_reason)::text = 'AUTHORITY_EXPIRED'::text) AND (release_source_approval_id IS NULL)) OR (((command_type)::text <> 'PHARMACY_ADVANCE_RELEASE'::text) AND (release_reason IS NULL) AND (release_source_approval_id IS NULL))));
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS chk_pharmacy_funding_command_order_mutation_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT chk_pharmacy_funding_command_order_mutation_753 CHECK (((((command_type)::text = 'SUBSTITUTION_FUNDING_CONSUMPTION'::text) AND ((((status)::text = 'COMPLETE'::text) AND (order_mutation_receipt_id IS NOT NULL) AND ((order_mutation_action)::text = 'dispense_substitution'::text) AND (order_mutation_command_sha256 IS NOT NULL) AND (order_mutation_request_sha256 IS NOT NULL) AND (order_mutation_evidence_sha256 IS NOT NULL)) OR (((status IN ('IN_PROGRESS', 'ABANDONED'))) AND (order_mutation_receipt_id IS NULL) AND (order_mutation_action IS NULL) AND (order_mutation_command_sha256 IS NULL) AND (order_mutation_request_sha256 IS NULL) AND (order_mutation_evidence_sha256 IS NULL)))) OR (((command_type)::text <> 'SUBSTITUTION_FUNDING_CONSUMPTION'::text) AND (order_mutation_receipt_id IS NULL) AND (order_mutation_action IS NULL) AND (order_mutation_command_sha256 IS NULL) AND (order_mutation_request_sha256 IS NULL) AND (order_mutation_evidence_sha256 IS NULL))));
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS chk_pharmacy_funding_command_patient_amount_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT chk_pharmacy_funding_command_patient_amount_753 CHECK (((((command_type)::text = 'SUBSTITUTION_FUNDING_APPROVAL'::text) AND ((((status)::text = 'IN_PROGRESS'::text) AND (approved_patient_amount IS NULL)) OR (((status)::text = 'COMPLETE'::text) AND (approved_patient_amount IS NOT NULL) AND (approved_patient_amount >= (0)::numeric)))) OR (((command_type)::text <> 'SUBSTITUTION_FUNDING_APPROVAL'::text) AND (approved_patient_amount IS NULL))));
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS chk_pharmacy_funding_command_reservation_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT chk_pharmacy_funding_command_reservation_753 CHECK (((((command_type)::text = 'SUBSTITUTION_FUNDING_APPROVAL'::text) AND (((reservation_authority IS NULL) AND (reservation_authority_sha256 IS NULL) AND (reservation_plan IS NULL) AND (reservation_plan_sha256 IS NULL) AND (reserved_at IS NULL) AND (reserved_transaction_id IS NULL) AND ((status)::text = 'IN_PROGRESS'::text)) OR ((jsonb_typeof(reservation_authority) = 'object'::text) AND (reservation_authority_sha256 ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof(reservation_plan) = 'object'::text) AND (reservation_plan_sha256 ~ '^[0-9a-f]{64}$'::text) AND (reserved_at IS NOT NULL) AND (reserved_transaction_id > 0)))) OR (((command_type)::text <> 'SUBSTITUTION_FUNDING_APPROVAL'::text) AND (reservation_authority IS NULL) AND (reservation_authority_sha256 IS NULL) AND (reservation_plan IS NULL) AND (reservation_plan_sha256 IS NULL) AND (reserved_at IS NULL) AND (reserved_transaction_id IS NULL))));
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_order_facility_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_order_facility_753 FOREIGN KEY (tenant_id, pharmacy_order_id, facility_id) REFERENCES pharmacy_orders(tenant_id, id, facility_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_invoice_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_invoice_753 FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing_invoices(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_invoice_item_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_invoice_item_753 FOREIGN KEY (tenant_id, invoice_item_id, invoice_id) REFERENCES billing_invoice_items(tenant_id, id, invoice_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_governance_approval_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_governance_approval_753 FOREIGN KEY (tenant_id, governance_approval_id) REFERENCES approvals(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_release_source_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_release_source_753 FOREIGN KEY (tenant_id, release_source_approval_id) REFERENCES approvals(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_approval_receipt_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_approval_receipt_753 FOREIGN KEY (tenant_id, approval_receipt_id, pharmacy_order_id, facility_id, invoice_id, invoice_item_id, governance_approval_id, proposal_sha256, proposer_uid, patient_uid) REFERENCES pharmacy_funding_commands(tenant_id, id, pharmacy_order_id, facility_id, invoice_id, invoice_item_id, governance_approval_id, proposal_sha256, proposer_uid, patient_uid) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS fk_pharmacy_funding_command_consumption_receipt_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT fk_pharmacy_funding_command_consumption_receipt_753 FOREIGN KEY (tenant_id, consumption_receipt_id, approval_receipt_id, pharmacy_order_id, facility_id, invoice_id, invoice_item_id, governance_approval_id, proposal_sha256, proposer_uid, patient_uid) REFERENCES pharmacy_funding_commands(tenant_id, id, approval_receipt_id, pharmacy_order_id, facility_id, invoice_id, invoice_item_id, governance_approval_id, proposal_sha256, proposer_uid, patient_uid) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.billing_advances DROP CONSTRAINT IF EXISTS chk_billing_advance_ipd_source_binding_753;
ALTER TABLE public.billing_advances ADD CONSTRAINT chk_billing_advance_ipd_source_binding_753 CHECK ((((ipd_advance_deposit_id IS NULL) AND (ipd_advance_deposit_payment_method IS NULL) AND (ipd_advance_deposit_collected_at IS NULL) AND ((COALESCE(reference, ''::character varying))::text !~~ 'IPD/%'::text)) OR ((ipd_advance_deposit_id IS NOT NULL) AND (ipd_advance_deposit_payment_method IS NOT NULL) AND (ipd_advance_deposit_collected_at IS NOT NULL) AND (admission_id IS NOT NULL) AND (collected_by IS NOT NULL) AND ((reference)::text ~~ 'IPD/%'::text))));
ALTER TABLE public.billing_advances DROP CONSTRAINT IF EXISTS fk_billing_advance_ipd_source_753;
ALTER TABLE public.billing_advances ADD CONSTRAINT fk_billing_advance_ipd_source_753 FOREIGN KEY (tenant_id, ipd_advance_deposit_id, patient_uid, admission_id, amount, ipd_advance_deposit_payment_method, collected_by, ipd_advance_deposit_collected_at) REFERENCES advance_deposits(tenant_id, id, patient_uid, admission_id, amount, payment_method, collected_by, collected_at) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE public.billing_advance_settlements DROP CONSTRAINT IF EXISTS fk_billing_advance_settlement_tenant_advance_753;
ALTER TABLE public.billing_advance_settlements ADD CONSTRAINT fk_billing_advance_settlement_tenant_advance_753 FOREIGN KEY (tenant_id, advance_id) REFERENCES billing_advances(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.billing_advance_settlements DROP CONSTRAINT IF EXISTS fk_billing_advance_settlement_tenant_invoice_753;
ALTER TABLE public.billing_advance_settlements ADD CONSTRAINT fk_billing_advance_settlement_tenant_invoice_753 FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing_invoices(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocation_reversals DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_reversal_settlement_753;
ALTER TABLE public.pharmacy_advance_allocation_reversals ADD CONSTRAINT fk_pharmacy_advance_allocation_reversal_settlement_753 FOREIGN KEY (tenant_id, billing_advance_settlement_id, billing_advance_id, invoice_id, reversed_amount, reversed_by, allocation_id, funding_settlement_receipt_id, allocation_evidence_sha256, reversal_command_sha256, evidence_sha256) REFERENCES billing_advance_settlements(tenant_id, id, advance_id, invoice_id, amount, settled_by, pharmacy_advance_allocation_id, pharmacy_advance_settlement_receipt_id, pharmacy_advance_allocation_evidence_sha256, pharmacy_advance_conversion_command_sha256, pharmacy_advance_conversion_evidence_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.billing_advance_settlements DROP CONSTRAINT IF EXISTS chk_billing_advance_settlements_positive_amount_753;
ALTER TABLE public.billing_advance_settlements ADD CONSTRAINT chk_billing_advance_settlements_positive_amount_753 CHECK ((amount > (0)::numeric));
ALTER TABLE public.billing_refunds DROP CONSTRAINT IF EXISTS chk_billing_refunds_positive_amount_753;
ALTER TABLE public.billing_refunds ADD CONSTRAINT chk_billing_refunds_positive_amount_753 CHECK ((amount > (0)::numeric));
ALTER TABLE public.billing_advance_settlements DROP CONSTRAINT IF EXISTS chk_billing_advance_settlements_pharmacy_conversion_753;
ALTER TABLE public.billing_advance_settlements ADD CONSTRAINT chk_billing_advance_settlements_pharmacy_conversion_753 CHECK ((((pharmacy_advance_allocation_id IS NULL) AND (pharmacy_advance_settlement_receipt_id IS NULL) AND (pharmacy_advance_allocation_evidence_sha256 IS NULL) AND (pharmacy_advance_conversion_command_sha256 IS NULL) AND (pharmacy_advance_conversion_evidence_sha256 IS NULL)) OR ((pharmacy_advance_allocation_id IS NOT NULL) AND (pharmacy_advance_settlement_receipt_id IS NOT NULL) AND (pharmacy_advance_allocation_evidence_sha256 ~ '^[0-9a-f]{64}$'::text) AND (pharmacy_advance_conversion_command_sha256 ~ '^[0-9a-f]{64}$'::text) AND (pharmacy_advance_conversion_evidence_sha256 ~ '^[0-9a-f]{64}$'::text) AND (settled_by IS NOT NULL) AND (settled_at IS NOT NULL))));
ALTER TABLE public.pharmacy_advance_allocations DROP CONSTRAINT IF EXISTS chk_pharmacy_advance_allocation_authority_753;
ALTER TABLE public.pharmacy_advance_allocations ADD CONSTRAINT chk_pharmacy_advance_allocation_authority_753 CHECK (((source_authority_version > 0) AND (source_authority_sha256 ~ '^[0-9a-f]{64}$'::text) AND (allocation_command_sha256 ~ '^[0-9a-f]{64}$'::text) AND (allocated_amount > (0)::numeric) AND (jsonb_typeof(evidence) = 'object'::text)));
ALTER TABLE public.pharmacy_advance_allocations DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_tenant_753;
ALTER TABLE public.pharmacy_advance_allocations ADD CONSTRAINT fk_pharmacy_advance_allocation_tenant_753 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocations DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_order_753;
ALTER TABLE public.pharmacy_advance_allocations ADD CONSTRAINT fk_pharmacy_advance_allocation_order_753 FOREIGN KEY (tenant_id, pharmacy_order_id) REFERENCES pharmacy_orders(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocations DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_invoice_753;
ALTER TABLE public.pharmacy_advance_allocations ADD CONSTRAINT fk_pharmacy_advance_allocation_invoice_753 FOREIGN KEY (tenant_id, invoice_id) REFERENCES billing_invoices(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocations DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_item_753;
ALTER TABLE public.pharmacy_advance_allocations ADD CONSTRAINT fk_pharmacy_advance_allocation_item_753 FOREIGN KEY (tenant_id, invoice_item_id, invoice_id) REFERENCES billing_invoice_items(tenant_id, id, invoice_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocations DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_advance_753;
ALTER TABLE public.pharmacy_advance_allocations ADD CONSTRAINT fk_pharmacy_advance_allocation_advance_753 FOREIGN KEY (tenant_id, billing_advance_id) REFERENCES billing_advances(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocations DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_task_753;
ALTER TABLE public.pharmacy_advance_allocations ADD CONSTRAINT fk_pharmacy_advance_allocation_task_753 FOREIGN KEY (tenant_id, funding_task_id) REFERENCES tasks(tenant_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocations DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_approval_receipt_753;
ALTER TABLE public.pharmacy_advance_allocations ADD CONSTRAINT fk_pharmacy_advance_allocation_approval_receipt_753 FOREIGN KEY (tenant_id, funding_approval_receipt_id, funding_task_id, pharmacy_order_id, invoice_item_id) REFERENCES pharmacy_funding_commands(tenant_id, id, task_id, pharmacy_order_id, invoice_item_id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocations DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_actor_753;
ALTER TABLE public.pharmacy_advance_allocations ADD CONSTRAINT fk_pharmacy_advance_allocation_actor_753 FOREIGN KEY (tenant_id, allocated_by) REFERENCES users(tenant_id, uid) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.billing_advance_settlements DROP CONSTRAINT IF EXISTS fk_billing_advance_settlement_pharmacy_allocation_753;
ALTER TABLE public.billing_advance_settlements ADD CONSTRAINT fk_billing_advance_settlement_pharmacy_allocation_753 FOREIGN KEY (tenant_id, pharmacy_advance_allocation_id, advance_id, invoice_id, amount, pharmacy_advance_allocation_evidence_sha256) REFERENCES pharmacy_advance_allocations(tenant_id, id, billing_advance_id, invoice_id, allocated_amount, evidence_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.billing_advance_settlements DROP CONSTRAINT IF EXISTS fk_billing_advance_settlement_pharmacy_receipt_753;
ALTER TABLE public.billing_advance_settlements ADD CONSTRAINT fk_billing_advance_settlement_pharmacy_receipt_753 FOREIGN KEY (tenant_id, pharmacy_advance_settlement_receipt_id, invoice_id, settled_by) REFERENCES pharmacy_funding_commands(tenant_id, id, invoice_id, created_by) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocation_reversals DROP CONSTRAINT IF EXISTS chk_pharmacy_advance_allocation_reversal_753;
ALTER TABLE public.pharmacy_advance_allocation_reversals ADD CONSTRAINT chk_pharmacy_advance_allocation_reversal_753 CHECK (((source_authority_version > 0) AND (source_authority_sha256 ~ '^[0-9a-f]{64}$'::text) AND (allocation_evidence_sha256 ~ '^[0-9a-f]{64}$'::text) AND (reversal_command_sha256 ~ '^[0-9a-f]{64}$'::text) AND (reversed_amount > (0)::numeric) AND ((reason IN ('AUTHORITY_SUPERSEDED', 'AUTHORITY_EXPIRED', 'SETTLED_TO_INVOICE'))) AND ((((reason)::text = 'SETTLED_TO_INVOICE'::text) AND (billing_advance_settlement_id IS NOT NULL) AND (funding_settlement_receipt_id IS NOT NULL) AND (funding_release_receipt_id IS NULL)) OR (((reason)::text <> 'SETTLED_TO_INVOICE'::text) AND (billing_advance_settlement_id IS NULL) AND (funding_settlement_receipt_id IS NULL) AND (funding_release_receipt_id IS NOT NULL))) AND (jsonb_typeof(evidence) = 'object'::text)));
ALTER TABLE public.pharmacy_advance_allocation_reversals DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_reversal_exact_753;
ALTER TABLE public.pharmacy_advance_allocation_reversals ADD CONSTRAINT fk_pharmacy_advance_allocation_reversal_exact_753 FOREIGN KEY (tenant_id, allocation_id, pharmacy_order_id, invoice_id, invoice_item_id, billing_advance_id, source_authority_version, source_authority_sha256, funding_task_id, funding_approval_receipt_id, allocation_evidence_sha256) REFERENCES pharmacy_advance_allocations(tenant_id, id, pharmacy_order_id, invoice_id, invoice_item_id, billing_advance_id, source_authority_version, source_authority_sha256, funding_task_id, funding_approval_receipt_id, evidence_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocation_reversals DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_reversal_settlement_receipt_753;
ALTER TABLE public.pharmacy_advance_allocation_reversals ADD CONSTRAINT fk_pharmacy_advance_allocation_reversal_settlement_receipt_753 FOREIGN KEY (tenant_id, funding_settlement_receipt_id, funding_approval_receipt_id, pharmacy_order_id, invoice_id, invoice_item_id, reversed_by) REFERENCES pharmacy_funding_commands(tenant_id, id, approval_receipt_id, pharmacy_order_id, invoice_id, invoice_item_id, created_by) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocation_reversals DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_reversal_release_receipt_753;
ALTER TABLE public.pharmacy_advance_allocation_reversals ADD CONSTRAINT fk_pharmacy_advance_allocation_reversal_release_receipt_753 FOREIGN KEY (tenant_id, funding_release_receipt_id, funding_approval_receipt_id, pharmacy_order_id, invoice_id, invoice_item_id, reversed_by) REFERENCES pharmacy_funding_commands(tenant_id, id, approval_receipt_id, pharmacy_order_id, invoice_id, invoice_item_id, created_by) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.pharmacy_advance_allocation_reversals DROP CONSTRAINT IF EXISTS fk_pharmacy_advance_allocation_reversal_actor_753;
ALTER TABLE public.pharmacy_advance_allocation_reversals ADD CONSTRAINT fk_pharmacy_advance_allocation_reversal_actor_753 FOREIGN KEY (tenant_id, reversed_by) REFERENCES users(tenant_id, uid) ON UPDATE RESTRICT ON DELETE RESTRICT;

-- ---- constraints tightened in place ----
-- These exist in the published schema under the same name with a weaker
-- definition; the stricter version is the point of this migration.
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS chk_pharmacy_funding_command_hashes_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT chk_pharmacy_funding_command_hashes_753 CHECK (((command_key_sha256 ~ '^[0-9a-f]{64}$'::text) AND (request_sha256 ~ '^[0-9a-f]{64}$'::text) AND ((proposal_sha256 IS NULL) OR (proposal_sha256 ~ '^[0-9a-f]{64}$'::text)) AND ((order_mutation_command_sha256 IS NULL) OR (order_mutation_command_sha256 ~ '^[0-9a-f]{64}$'::text)) AND ((order_mutation_request_sha256 IS NULL) OR (order_mutation_request_sha256 ~ '^[0-9a-f]{64}$'::text)) AND ((order_mutation_evidence_sha256 IS NULL) OR (order_mutation_evidence_sha256 ~ '^[0-9a-f]{64}$'::text))));
ALTER TABLE public.pharmacy_funding_commands DROP CONSTRAINT IF EXISTS chk_pharmacy_funding_command_status_753;
ALTER TABLE public.pharmacy_funding_commands ADD CONSTRAINT chk_pharmacy_funding_command_status_753 CHECK (((((status)::text = 'IN_PROGRESS'::text) AND (completed_at IS NULL) AND (completed_transaction_id IS NULL) AND (response_body IS NULL)) OR (((status IN ('COMPLETE', 'ABANDONED'))) AND (completed_at IS NOT NULL) AND (completed_transaction_id > 0) AND (response_body IS NOT NULL))));

-- ---- triggers ----
DROP TRIGGER IF EXISTS trg_00_pharmacy_order_command_receipt_time_753 ON public.pharmacy_order_command_receipts;
CREATE TRIGGER trg_00_pharmacy_order_command_receipt_time_753 BEFORE INSERT ON public.pharmacy_order_command_receipts FOR EACH ROW EXECUTE FUNCTION derive_pharmacy_order_command_receipt_time_753();
DROP TRIGGER IF EXISTS trg_00_pharmacy_funding_command_order_753 ON public.pharmacy_funding_commands;
CREATE TRIGGER trg_00_pharmacy_funding_command_order_753 BEFORE INSERT OR UPDATE ON public.pharmacy_funding_commands FOR EACH ROW EXECUTE FUNCTION lock_pharmacy_funding_command_order_753();
DROP TRIGGER IF EXISTS trg_pharmacy_funding_receipt_pair_753 ON public.pharmacy_funding_commands;
CREATE TRIGGER trg_pharmacy_funding_receipt_pair_753 BEFORE INSERT OR UPDATE ON public.pharmacy_funding_commands FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_funding_receipt_pair_753();
DROP TRIGGER IF EXISTS trg_billing_advance_ipd_source_753 ON public.billing_advances;
CREATE TRIGGER trg_billing_advance_ipd_source_753 BEFORE INSERT OR DELETE OR UPDATE ON public.billing_advances FOR EACH ROW EXECUTE FUNCTION enforce_billing_advance_ipd_source_753();
DROP TRIGGER IF EXISTS trg_bound_ipd_deposit_mutation_753 ON public.advance_deposits;
CREATE TRIGGER trg_bound_ipd_deposit_mutation_753 BEFORE DELETE OR UPDATE ON public.advance_deposits FOR EACH ROW EXECUTE FUNCTION prevent_bound_ipd_deposit_mutation_753();
DROP TRIGGER IF EXISTS trg_billing_advance_settlement_lineage_753 ON public.billing_advance_settlements;
CREATE TRIGGER trg_billing_advance_settlement_lineage_753 BEFORE INSERT ON public.billing_advance_settlements FOR EACH ROW EXECUTE FUNCTION enforce_billing_advance_settlement_lineage_753();
DROP TRIGGER IF EXISTS trg_admission_patient_merge_path_753 ON public.admissions;
CREATE TRIGGER trg_admission_patient_merge_path_753 BEFORE UPDATE OF patient_uid ON public.admissions FOR EACH ROW WHEN ((new.patient_uid IS DISTINCT FROM old.patient_uid)) EXECUTE FUNCTION enforce_admission_patient_merge_path_753();
DROP TRIGGER IF EXISTS trg_admission_chronology_lock_753 ON public.admissions;
CREATE TRIGGER trg_admission_chronology_lock_753 BEFORE UPDATE OF admitted_at, created_at ON public.admissions FOR EACH ROW WHEN (((new.admitted_at IS DISTINCT FROM old.admitted_at) OR (new.created_at IS DISTINCT FROM old.created_at))) EXECUTE FUNCTION enforce_admission_chronology_lock_753();
DROP TRIGGER IF EXISTS trg_admission_advance_lineage_753 ON public.admissions;
CREATE CONSTRAINT TRIGGER trg_admission_advance_lineage_753 AFTER UPDATE OF patient_uid, admitted_at, created_at ON public.admissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.patient_uid IS DISTINCT FROM old.patient_uid) OR (new.admitted_at IS DISTINCT FROM old.admitted_at) OR (new.created_at IS DISTINCT FROM old.created_at))) EXECUTE FUNCTION revalidate_admission_advance_lineage_753();
DROP TRIGGER IF EXISTS trg_billing_advance_settlement_identity_update_753 ON public.billing_advance_settlements;
CREATE TRIGGER trg_billing_advance_settlement_identity_update_753 BEFORE UPDATE OF tenant_id, advance_id, invoice_id ON public.billing_advance_settlements FOR EACH ROW EXECUTE FUNCTION prevent_billing_advance_settlement_identity_update_753();
DROP TRIGGER IF EXISTS trg_billing_advance_settlement_parent_drift_753 ON public.billing_advances;
CREATE TRIGGER trg_billing_advance_settlement_parent_drift_753 BEFORE UPDATE OF tenant_id, id, patient_uid, admission_id ON public.billing_advances FOR EACH ROW EXECUTE FUNCTION prevent_settled_advance_lineage_drift_753();
DROP TRIGGER IF EXISTS trg_billing_invoice_settlement_parent_drift_753 ON public.billing_invoices;
CREATE TRIGGER trg_billing_invoice_settlement_parent_drift_753 BEFORE UPDATE OF patient_uid ON public.billing_invoices FOR EACH ROW WHEN ((new.patient_uid IS DISTINCT FROM old.patient_uid)) EXECUTE FUNCTION enforce_invoice_patient_merge_path_753();
DROP TRIGGER IF EXISTS trg_billing_invoice_settlement_scope_drift_753 ON public.billing_invoices;
CREATE TRIGGER trg_billing_invoice_settlement_scope_drift_753 BEFORE UPDATE OF tenant_id, id, admission_id ON public.billing_invoices FOR EACH ROW EXECUTE FUNCTION prevent_settled_invoice_scope_drift_753();
DROP TRIGGER IF EXISTS trg_billing_invoice_settlement_lineage_recheck_753 ON public.billing_invoices;
CREATE CONSTRAINT TRIGGER trg_billing_invoice_settlement_lineage_recheck_753 AFTER UPDATE OF patient_uid ON public.billing_invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.patient_uid IS DISTINCT FROM old.patient_uid)) EXECUTE FUNCTION revalidate_invoice_settlement_lineage_753();
DROP TRIGGER IF EXISTS trg_00_pharmacy_advance_settlement_time_753 ON public.billing_advance_settlements;
CREATE TRIGGER trg_00_pharmacy_advance_settlement_time_753 BEFORE INSERT ON public.billing_advance_settlements FOR EACH ROW EXECUTE FUNCTION derive_pharmacy_advance_settlement_time_753();
DROP TRIGGER IF EXISTS trg_00_pharmacy_advance_allocation_time_753 ON public.pharmacy_advance_allocations;
CREATE TRIGGER trg_00_pharmacy_advance_allocation_time_753 BEFORE INSERT ON public.pharmacy_advance_allocations FOR EACH ROW EXECUTE FUNCTION derive_pharmacy_advance_allocation_time_753();
DROP TRIGGER IF EXISTS trg_00_pharmacy_advance_reversal_time_753 ON public.pharmacy_advance_allocation_reversals;
CREATE TRIGGER trg_00_pharmacy_advance_reversal_time_753 BEFORE INSERT ON public.pharmacy_advance_allocation_reversals FOR EACH ROW EXECUTE FUNCTION derive_pharmacy_advance_reversal_time_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_settlement_rebinding_753 ON public.billing_advance_settlements;
CREATE TRIGGER trg_pharmacy_advance_settlement_rebinding_753 BEFORE DELETE OR UPDATE ON public.billing_advance_settlements FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_advance_settlement_rebinding_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_settlement_pair_753 ON public.billing_advance_settlements;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_settlement_pair_753 AFTER INSERT ON public.billing_advance_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_settlement_pair_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_allocation_authority_753 ON public.pharmacy_advance_allocations;
CREATE TRIGGER trg_pharmacy_advance_allocation_authority_753 BEFORE INSERT ON public.pharmacy_advance_allocations FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_allocation_authority_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_approval_complete_753 ON public.pharmacy_advance_allocations;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_approval_complete_753 AFTER INSERT ON public.pharmacy_advance_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_approval_complete_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_approval_amount_allocations_753 ON public.pharmacy_advance_allocations;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_approval_amount_allocations_753 AFTER INSERT ON public.pharmacy_advance_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_approval_amount_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_approval_amount_commands_753 ON public.pharmacy_funding_commands;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_approval_amount_commands_753 AFTER INSERT OR UPDATE ON public.pharmacy_funding_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_approval_amount_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_consumption_coverage_753 ON public.pharmacy_funding_commands;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_consumption_coverage_753 AFTER INSERT OR UPDATE ON public.pharmacy_funding_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_consumption_coverage_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_reversal_balance_753 ON public.pharmacy_advance_allocation_reversals;
CREATE TRIGGER trg_pharmacy_advance_reversal_balance_753 BEFORE INSERT ON public.pharmacy_advance_allocation_reversals FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_reversal_balance_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_release_reversal_set_753 ON public.pharmacy_advance_allocation_reversals;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_release_reversal_set_753 AFTER INSERT ON public.pharmacy_advance_allocation_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_release_complete_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_release_command_753 ON public.pharmacy_funding_commands;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_release_command_753 AFTER INSERT OR UPDATE ON public.pharmacy_funding_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_release_complete_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_settlement_command_set_753 ON public.pharmacy_funding_commands;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_settlement_command_set_753 AFTER INSERT OR UPDATE ON public.pharmacy_funding_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_settlement_complete_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_settlement_reversal_set_753 ON public.pharmacy_advance_allocation_reversals;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_settlement_reversal_set_753 AFTER INSERT ON public.pharmacy_advance_allocation_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_settlement_complete_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_settlement_row_set_753 ON public.billing_advance_settlements;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_settlement_row_set_753 AFTER INSERT ON public.billing_advance_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_settlement_complete_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_capacity_allocations_753 ON public.pharmacy_advance_allocations;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_capacity_allocations_753 AFTER INSERT OR DELETE OR UPDATE ON public.pharmacy_advance_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_capacity_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_capacity_reversals_753 ON public.pharmacy_advance_allocation_reversals;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_capacity_reversals_753 AFTER INSERT OR DELETE OR UPDATE ON public.pharmacy_advance_allocation_reversals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_capacity_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_capacity_settlements_753 ON public.billing_advance_settlements;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_capacity_settlements_753 AFTER INSERT OR DELETE OR UPDATE ON public.billing_advance_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_capacity_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_capacity_refunds_753 ON public.billing_refunds;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_capacity_refunds_753 AFTER INSERT OR DELETE OR UPDATE ON public.billing_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_capacity_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_capacity_parent_753 ON public.billing_advances;
CREATE CONSTRAINT TRIGGER trg_pharmacy_advance_capacity_parent_753 AFTER DELETE OR UPDATE ON public.billing_advances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_advance_capacity_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_allocations_append_only_753 ON public.pharmacy_advance_allocations;
CREATE TRIGGER trg_pharmacy_advance_allocations_append_only_753 BEFORE DELETE OR UPDATE ON public.pharmacy_advance_allocations FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_advance_allocation_mutation_753();
DROP TRIGGER IF EXISTS trg_pharmacy_advance_allocation_reversals_append_only_753 ON public.pharmacy_advance_allocation_reversals;
CREATE TRIGGER trg_pharmacy_advance_allocation_reversals_append_only_753 BEFORE DELETE OR UPDATE ON public.pharmacy_advance_allocation_reversals FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_advance_allocation_mutation_753();

-- ---- row-level security policies ----
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.billing_invoice_counter;
CREATE POLICY explicit_tenant_context_753 ON public.billing_invoice_counter AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.admissions;
CREATE POLICY explicit_tenant_context_753 ON public.admissions AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.doctors;
CREATE POLICY explicit_tenant_context_753 ON public.doctors AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.staff;
CREATE POLICY explicit_tenant_context_753 ON public.staff AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.departments;
CREATE POLICY explicit_tenant_context_753 ON public.departments AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.advance_deposits;
CREATE POLICY explicit_tenant_context_753 ON public.advance_deposits AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.billing_advances;
CREATE POLICY explicit_tenant_context_753 ON public.billing_advances AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.facilities;
CREATE POLICY explicit_tenant_context_753 ON public.facilities AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.tasks;
CREATE POLICY explicit_tenant_context_753 ON public.tasks AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.users;
CREATE POLICY explicit_tenant_context_753 ON public.users AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.billing_credit_notes;
CREATE POLICY explicit_tenant_context_753 ON public.billing_credit_notes AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.billing_advance_settlements;
CREATE POLICY explicit_tenant_context_753 ON public.billing_advance_settlements AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.billing_refunds;
CREATE POLICY explicit_tenant_context_753 ON public.billing_refunds AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.pharmacy_orders;
CREATE POLICY explicit_tenant_context_753 ON public.pharmacy_orders AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.billing_invoices;
CREATE POLICY explicit_tenant_context_753 ON public.billing_invoices AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.billing_payments;
CREATE POLICY explicit_tenant_context_753 ON public.billing_payments AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.approvals;
CREATE POLICY explicit_tenant_context_753 ON public.approvals AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.pharmacy_staff_facility_grants;
CREATE POLICY explicit_tenant_context_753 ON public.pharmacy_staff_facility_grants AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.tpa_claims;
CREATE POLICY explicit_tenant_context_753 ON public.tpa_claims AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.tpa_claim_line_decisions;
CREATE POLICY explicit_tenant_context_753 ON public.tpa_claim_line_decisions AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.e_prescriptions;
CREATE POLICY explicit_tenant_context_753 ON public.e_prescriptions AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.pharmacy_catalog;
CREATE POLICY explicit_tenant_context_753 ON public.pharmacy_catalog AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.pharmacy_inventory_items;
CREATE POLICY explicit_tenant_context_753 ON public.pharmacy_inventory_items AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.ledger_accounts;
CREATE POLICY explicit_tenant_context_753 ON public.ledger_accounts AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.ledger_entries;
CREATE POLICY explicit_tenant_context_753 ON public.ledger_entries AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.ledger_postings;
CREATE POLICY explicit_tenant_context_753 ON public.ledger_postings AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.ledger_balances;
CREATE POLICY explicit_tenant_context_753 ON public.ledger_balances AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.billing_invoice_items;
CREATE POLICY explicit_tenant_context_753 ON public.billing_invoice_items AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));
DROP POLICY IF EXISTS explicit_tenant_context_753 ON public.pharmacy_inventory_batches;
CREATE POLICY explicit_tenant_context_753 ON public.pharmacy_inventory_batches AS RESTRICTIVE TO public USING (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid()))) WITH CHECK (((current_setting('app.current_tenant_id'::text, true) IS NOT NULL) AND (current_setting('app.current_tenant_id'::text, true) <> ALL (ARRAY[''::text, 'bypass'::text])) AND (tenant_id = app_current_tenant_id_uuid())));

-- ---- object comments ----
COMMENT ON COLUMN public.pharmacy_funding_commands.approval_receipt_id IS 'Only consumption receipts use this immutable pointer to their exact completed substitution-funding approval receipt.';
COMMENT ON TABLE public.pharmacy_advance_allocations IS 'Append-only approval-time holds on exact patient-funded advances. Holds remain capacity until a governed reversal; consumption never mutates them.';
COMMENT ON TABLE public.pharmacy_advance_allocation_reversals IS 'Append-only exact compensating evidence that releases an advance hold or atomically converts it to an exact invoice settlement.';

-- ---- new-table foreign keys, deferred until their backing
-- ---- unique indexes exist ----
ALTER TABLE ONLY public.pharmacy_advance_allocation_consumptions
    ADD CONSTRAINT fk_pharmacy_advance_allocation_consumption_actor_753 FOREIGN KEY (tenant_id, consumed_by) REFERENCES public.users(tenant_id, uid) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE ONLY public.pharmacy_advance_allocation_consumptions
    ADD CONSTRAINT fk_pharmacy_advance_allocation_consumption_exact_753 FOREIGN KEY (tenant_id, allocation_id, pharmacy_order_id, invoice_id, invoice_item_id, billing_advance_id, source_authority_version, source_authority_sha256, funding_task_id, funding_approval_receipt_id, allocation_evidence_sha256) REFERENCES public.pharmacy_advance_allocations(tenant_id, id, pharmacy_order_id, invoice_id, invoice_item_id, billing_advance_id, source_authority_version, source_authority_sha256, funding_task_id, funding_approval_receipt_id, evidence_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE ONLY public.pharmacy_advance_allocation_consumptions
    ADD CONSTRAINT fk_pharmacy_advance_allocation_consumption_receipt_753 FOREIGN KEY (tenant_id, funding_consumption_receipt_id, funding_task_id, pharmacy_order_id, invoice_item_id, funding_approval_receipt_id, consumption_command_sha256) REFERENCES public.pharmacy_funding_commands(tenant_id, id, task_id, pharmacy_order_id, invoice_item_id, approval_receipt_id, command_key_sha256) ON UPDATE RESTRICT ON DELETE RESTRICT;
