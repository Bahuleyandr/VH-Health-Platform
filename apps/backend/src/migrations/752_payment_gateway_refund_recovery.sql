-- 752_payment_gateway_refund_recovery.sql
--
-- GWR-01: durable, provider-backed refund recovery.
--
-- A provider refund id is correlation evidence, never proof that money moved.
-- This migration adds the lease/retry projection used to poll the authoritative
-- provider status and binds an operator task plus SLA clock to every unresolved
-- execution leg. Outbound recovery remains fail-closed behind
-- PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED=true, the existing gateway gates,
-- an enabled exact provider config, and decryptable provider credentials.

BEGIN;

ALTER TABLE payment_gateway_refunds
  ADD COLUMN IF NOT EXISTS provider_request_fingerprint CHAR(64),
  ADD COLUMN IF NOT EXISTS provider_request_replay_authorized BOOLEAN,
  ADD COLUMN IF NOT EXISTS recovery_state VARCHAR(30) NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS recovery_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_status_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_claim_token UUID,
  ADD COLUMN IF NOT EXISTS recovery_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_last_error_code VARCHAR(100),
  ADD COLUMN IF NOT EXISTS recovery_last_error_reason VARCHAR(500),
  ADD COLUMN IF NOT EXISTS recovery_terminal_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_task_id INTEGER,
  ADD COLUMN IF NOT EXISTS recovery_sla_instance_id UUID,
  ADD COLUMN IF NOT EXISTS reconciliation_disposition VARCHAR(40),
  ADD COLUMN IF NOT EXISTS reconciliation_evidence JSONB,
  ADD COLUMN IF NOT EXISTS reconciliation_reviewed_by UUID,
  ADD COLUMN IF NOT EXISTS reconciliation_reviewed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION payment_gateway_refund_request_fingerprint(
  target_tenant_id UUID,
  target_provider TEXT,
  target_provider_payment_id TEXT,
  target_billing_refund_id INTEGER,
  target_gateway_order_id INTEGER,
  target_amount NUMERIC,
  target_currency TEXT,
  target_provider_idempotency_key TEXT
)
RETURNS CHAR(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(digest(
    jsonb_build_array(
      target_tenant_id::text,
      target_provider,
      target_provider_payment_id,
      COALESCE(target_billing_refund_id::text, ''),
      target_gateway_order_id::text,
      target_amount::numeric(12, 2)::text,
      upper(target_currency),
      target_provider_idempotency_key
    )::text,
    'sha256'
  ), 'hex')::char(64)
$$;

UPDATE payment_gateway_refunds
   SET provider_request_fingerprint = payment_gateway_refund_request_fingerprint(
         tenant_id,
         provider,
         provider_payment_id,
         billing_refund_id,
         gateway_order_id,
         amount,
         currency,
         provider_idempotency_key
       )
 WHERE provider_request_fingerprint IS NULL;

-- Migration-time rows predate a durable assertion that the provider accepted
-- this exact request identity. They may be polled when a provider refund id is
-- already known, but they must never be replayed from a locally generated key.
UPDATE payment_gateway_refunds
   SET provider_request_replay_authorized = FALSE
 WHERE provider_request_replay_authorized IS NULL;

ALTER TABLE payment_gateway_refunds
  ALTER COLUMN provider_request_replay_authorized SET DEFAULT FALSE,
  ALTER COLUMN provider_request_replay_authorized SET NOT NULL;

-- Historical rows also predate the four-eyes execution contract. Park every
-- unresolved leg that cannot prove a same-tenant initiator, independent
-- approver, and post-approval initiation before any recovery worker sees it.
UPDATE payment_gateway_refunds AS refund
   SET status = 'requires_reconciliation',
       failure_code = 'legacy_refund_authority_invalid',
       failure_reason = 'Historical gateway refund lacks independent same-tenant post-approval authority',
       updated_at = NOW()
  FROM billing_refunds AS billing
 WHERE refund.tenant_id = billing.tenant_id
   AND refund.billing_refund_id = billing.id
   AND refund.status IN ('initiated', 'pending', 'requires_reconciliation')
   AND (
     refund.initiated_by IS NOT NULL
     AND billing.approved_by IS NOT NULL
     AND billing.approved_at IS NOT NULL
     AND refund.initiated_by IS DISTINCT FROM billing.approved_by
     AND refund.initiated_at > billing.approved_at
     AND EXISTS (
       SELECT 1
         FROM users AS initiator
        WHERE initiator.tenant_id = refund.tenant_id
          AND initiator.uid = refund.initiated_by
     )
   ) IS NOT TRUE;

UPDATE payment_gateway_refunds AS refund
   SET status = 'requires_reconciliation',
       failure_code = 'legacy_refund_authority_invalid',
       failure_reason = 'Historical gateway refund billing authority row is unavailable',
       updated_at = NOW()
 WHERE refund.status IN ('initiated', 'pending', 'requires_reconciliation')
   AND NOT EXISTS (
     SELECT 1
       FROM billing_refunds AS billing
      WHERE billing.tenant_id = refund.tenant_id
        AND billing.id = refund.billing_refund_id
   );

-- Even historically valid four-eyes rows cannot safely repeat a create call
-- without a persisted provider refund id because their local retry key was not
-- created under this contract.
UPDATE payment_gateway_refunds
   SET status = 'requires_reconciliation',
       failure_code = 'legacy_refund_replay_identity_unavailable',
       failure_reason = 'Historical gateway refund has no proven provider request replay identity',
       updated_at = NOW()
 WHERE status IN ('initiated', 'pending')
   AND provider_refund_id IS NULL
   AND provider_request_replay_authorized IS NOT TRUE;

UPDATE payment_gateway_refunds
   SET recovery_state = CASE status
         WHEN 'processed' THEN 'succeeded'
         WHEN 'failed' THEN 'failed'
         WHEN 'requires_reconciliation' THEN 'requires_reconciliation'
         ELSE 'queued'
       END,
       recovery_next_attempt_at = CASE
         WHEN status IN ('initiated', 'pending') THEN NOW()
         ELSE NULL
       END,
       recovery_terminal_at = CASE
         WHEN status = 'processed' THEN COALESCE(processed_at, updated_at, NOW())
         WHEN status = 'failed' THEN COALESCE(failed_at, updated_at, NOW())
         WHEN status = 'requires_reconciliation' THEN COALESCE(updated_at, NOW())
         ELSE NULL
       END;

-- Free-text reconciliation from the pre-GWR contract is not authoritative
-- provider evidence. Preserve it for audit, then reopen the row so every
-- post-migration closure must satisfy the structured evidence contract.
UPDATE payment_gateway_refunds
   SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{legacy_gateway_refund_reconciliation}',
         jsonb_strip_nulls(jsonb_build_object(
           'reconciled_at', reconciled_at,
           'reconciliation_note', reconciliation_note,
           'reconciled_by', reconciled_by,
           'superseded_by', 'migration_752_structured_reconciliation_required'
         )),
         true
       ),
       reconciled_at = NULL,
       reconciliation_note = NULL,
       reconciled_by = NULL,
       updated_at = NOW()
 WHERE reconciliation_disposition IS NULL
   AND (
     reconciled_at IS NOT NULL
     OR reconciliation_note IS NOT NULL
     OR reconciled_by IS NOT NULL
   );

CREATE OR REPLACE FUNCTION payment_gateway_refund_derive_request_fingerprint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       OLD.tenant_id,
       OLD.provider,
       OLD.environment,
       OLD.provider_payment_id,
       OLD.billing_refund_id,
       OLD.gateway_order_id,
       OLD.amount,
       OLD.currency,
       OLD.provider_idempotency_key,
       OLD.provider_request_replay_authorized,
       OLD.initiated_by,
       OLD.initiated_at
     ) IS DISTINCT FROM (
       NEW.tenant_id,
       NEW.provider,
       NEW.environment,
       NEW.provider_payment_id,
       NEW.billing_refund_id,
       NEW.gateway_order_id,
       NEW.amount,
       NEW.currency,
       NEW.provider_idempotency_key,
       NEW.provider_request_replay_authorized,
       NEW.initiated_by,
       NEW.initiated_at
     )
  THEN
    RAISE EXCEPTION 'gateway refund provider request identity and initiation authority are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.provider_request_fingerprint := payment_gateway_refund_request_fingerprint(
    NEW.tenant_id,
    NEW.provider,
    NEW.provider_payment_id,
    NEW.billing_refund_id,
    NEW.gateway_order_id,
    NEW.amount,
    NEW.currency,
    NEW.provider_idempotency_key
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pg_refund_request_fingerprint ON payment_gateway_refunds;
CREATE TRIGGER trg_pg_refund_request_fingerprint
  BEFORE INSERT OR UPDATE OF
    tenant_id, provider, environment, provider_payment_id, billing_refund_id,
    gateway_order_id, amount, currency, provider_idempotency_key,
    provider_request_replay_authorized, initiated_by, initiated_at,
    provider_request_fingerprint
  ON payment_gateway_refunds
  FOR EACH ROW
  EXECUTE FUNCTION payment_gateway_refund_derive_request_fingerprint();

ALTER TABLE payment_gateway_refunds
  ALTER COLUMN provider_request_fingerprint SET NOT NULL,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_request_fingerprint,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_recovery_state,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_recovery_attempt_count,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_recovery_lease,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_recovery_terminal,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_recovery_obligation_pair,
  DROP CONSTRAINT IF EXISTS chk_pg_refund_reconciliation_review;

ALTER TABLE payment_gateway_refunds
  ADD CONSTRAINT chk_pg_refund_request_fingerprint
    CHECK (
      provider_request_fingerprint ~ '^[0-9a-f]{64}$'
      AND provider_request_fingerprint = payment_gateway_refund_request_fingerprint(
        tenant_id,
        provider,
        provider_payment_id,
        billing_refund_id,
        gateway_order_id,
        amount,
        currency,
        provider_idempotency_key
      )
    ),
  ADD CONSTRAINT chk_pg_refund_recovery_state
    CHECK (recovery_state IN (
      'queued', 'claimed', 'provider_pending', 'retry_wait',
      'blocked_authority', 'succeeded', 'failed', 'requires_reconciliation'
    )),
  ADD CONSTRAINT chk_pg_refund_recovery_attempt_count
    CHECK (recovery_attempt_count BETWEEN 0 AND 100),
  ADD CONSTRAINT chk_pg_refund_recovery_lease
    CHECK (
      (
        recovery_claim_token IS NULL
        AND recovery_claimed_at IS NULL
        AND recovery_lease_expires_at IS NULL
        AND recovery_state <> 'claimed'
      )
      OR (
        recovery_claim_token IS NOT NULL
        AND recovery_claimed_at IS NOT NULL
        AND recovery_lease_expires_at > recovery_claimed_at
        AND recovery_state = 'claimed'
      )
    ),
  ADD CONSTRAINT chk_pg_refund_recovery_terminal
    CHECK (
      (
        recovery_state IN ('succeeded', 'failed', 'requires_reconciliation')
        AND recovery_terminal_at IS NOT NULL
        AND recovery_next_attempt_at IS NULL
      )
      OR (
        recovery_state NOT IN ('succeeded', 'failed', 'requires_reconciliation')
        AND recovery_terminal_at IS NULL
      )
    ),
  ADD CONSTRAINT chk_pg_refund_recovery_obligation_pair
    CHECK (
      (recovery_task_id IS NULL AND recovery_sla_instance_id IS NULL)
      OR (recovery_task_id IS NOT NULL AND recovery_sla_instance_id IS NOT NULL)
    ),
  ADD CONSTRAINT chk_pg_refund_reconciliation_review
    CHECK (
      (reconciliation_disposition IS NULL
       AND reconciliation_evidence IS NULL
       AND reconciliation_reviewed_by IS NULL
       AND reconciliation_reviewed_at IS NULL
       AND reconciled_at IS NULL
       AND reconciliation_note IS NULL
       AND reconciled_by IS NULL)
      OR
      ((reconciliation_disposition IN (
          'provider_processed', 'provider_failed',
          'provider_pending', 'provider_status_unknown'
        )
        AND jsonb_typeof(reconciliation_evidence) = 'object'
        AND reconciliation_evidence ?& ARRAY[
          'source', 'reference', 'observed_at', 'provider_status'
        ]
        AND reconciliation_evidence - ARRAY[
          'source', 'reference', 'observed_at', 'provider_status', 'notes'
        ] = '{}'::jsonb
        AND jsonb_typeof(reconciliation_evidence->'source') = 'string'
        AND jsonb_typeof(reconciliation_evidence->'reference') = 'string'
        AND jsonb_typeof(reconciliation_evidence->'observed_at') = 'string'
        AND jsonb_typeof(reconciliation_evidence->'provider_status') = 'string'
        AND (
          NOT (reconciliation_evidence ? 'notes')
          OR jsonb_typeof(reconciliation_evidence->'notes') = 'string'
        )
        AND reconciliation_evidence->>'source' IN (
          'provider_dashboard', 'provider_support',
          'bank_statement', 'other_authoritative'
        )
        AND length(btrim(reconciliation_evidence->>'reference')) BETWEEN 6 AND 255
        AND reconciliation_evidence->>'provider_status' = CASE reconciliation_disposition
          WHEN 'provider_processed' THEN 'processed'
          WHEN 'provider_failed' THEN 'failed'
          WHEN 'provider_pending' THEN 'pending'
          WHEN 'provider_status_unknown' THEN 'unknown'
        END
        AND reconciliation_evidence->>'observed_at' ~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
        AND pg_input_is_valid(
          reconciliation_evidence->>'observed_at', 'timestamp with time zone'
        )
        AND length(COALESCE(reconciliation_evidence->>'notes', '')) <= 500
        AND reconciliation_reviewed_by IS NOT NULL
        AND reconciliation_reviewed_at IS NOT NULL
        AND (
          (
            reconciliation_disposition = 'provider_failed'
            AND provider_refund_id IS NOT NULL
            AND length(btrim(provider_refund_id)) BETWEEN 1 AND 120
            AND (
              (provider = 'razorpay' AND provider_refund_id ~ '^rfnd_[A-Za-z0-9]+$')
              OR (
                provider <> 'razorpay'
                AND provider_refund_id !~* '(\*{2,}|masked|redacted)'
              )
            )
            AND reconciled_at IS NOT NULL
            AND reconciled_by = reconciliation_reviewed_by
          )
          OR (
            reconciliation_disposition IN (
              'provider_processed', 'provider_pending', 'provider_status_unknown'
            )
            AND reconciled_at IS NULL
            AND reconciled_by IS NULL
          )
          OR (
            reconciliation_disposition = 'provider_failed'
            AND provider_refund_id IS NULL
            AND reconciled_at IS NULL
            AND reconciled_by IS NULL
          )
        )) IS TRUE)
    );

CREATE UNIQUE INDEX IF NOT EXISTS ux_pg_refund_tenant_id
  ON payment_gateway_refunds (tenant_id, id);

ALTER TABLE payment_gateway_refunds
  DROP CONSTRAINT IF EXISTS fk_pg_refund_recovery_task,
  DROP CONSTRAINT IF EXISTS fk_pg_refund_recovery_sla,
  DROP CONSTRAINT IF EXISTS fk_pg_refund_reconciliation_reviewer;

ALTER TABLE payment_gateway_refunds
  ADD CONSTRAINT fk_pg_refund_recovery_task
    FOREIGN KEY (tenant_id, recovery_task_id)
    REFERENCES tasks (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_pg_refund_recovery_sla
    FOREIGN KEY (tenant_id, recovery_sla_instance_id)
    REFERENCES workflow_sla_instances (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_pg_refund_reconciliation_reviewer
    FOREIGN KEY (tenant_id, reconciliation_reviewed_by)
    REFERENCES users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_pg_refund_recovery_due
  ON payment_gateway_refunds (
    tenant_id, recovery_next_attempt_at, recovery_lease_expires_at, id
  )
  WHERE status IN ('initiated', 'pending')
    AND recovery_state IN ('queued', 'provider_pending', 'retry_wait', 'claimed');

CREATE INDEX IF NOT EXISTS idx_pg_refund_recovery_task
  ON payment_gateway_refunds (tenant_id, recovery_task_id)
  WHERE recovery_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pg_refund_recovery_sla
  ON payment_gateway_refunds (tenant_id, recovery_sla_instance_id)
  WHERE recovery_sla_instance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pg_refund_reconciliation_reviewer
  ON payment_gateway_refunds (tenant_id, reconciliation_reviewed_by)
  WHERE reconciliation_reviewed_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pg_refund_recovery_projection_drift
  ON payment_gateway_refunds (tenant_id, id)
  WHERE (status = 'processed' AND recovery_state <> 'succeeded')
     OR (status = 'failed' AND recovery_state <> 'failed');

-- Register the refund obligation as a typed domain-evidence task/SLA contract.
--
-- Two shapes are used, chosen per function from how that predecessor is
-- actually structured at this migration's turn:
--
--   * Rename-and-delegate - the pattern established by 744/745/746/748 - for
--     care_pathway_assert_task_sla_source_binding and
--     care_pathway_assert_task_sla_completion_receipt. Those migrations have
--     already wrapped both, so their live top-level bodies are thin delegating
--     wrappers and the historical rule_code dispatch now lives several
--     delegation levels down; a textual anchor against the top-level body
--     matches zero times. 752 becomes the new outermost wrapper: it claims only
--     the gateway-refund obligation and PERFORMs the immediately preceding
--     definition - renamed to ..._pre_752, by name, whatever its nesting depth -
--     for everything else, so no existing rule_code branch is re-implemented,
--     moved, or dropped.
--
--   * In-place extension for the four functions that nothing in this stack has
--     wrapped or redefined, whose anchors are therefore still present in the
--     live body exactly once:
--       care_pathway_route_actionable_roles(text)     - last defined by 743
--       tasks_sync_workflow_sla_compat()              - 580 body + 594 patch
--       care_pathway_assert_human_sla_task_obligation - last defined by 585
--       care_pathway_assert_actionable_task_owner     - 586 body + 594 patch
--     tasks_sync_workflow_sla_compat() could not be delegated to in any case:
--     PL/pgSQL refuses a direct call to a trigger function.
--
-- Every extension of either shape is anchored against the exact predecessor and
-- aborts the migration if that predecessor drifted; no existing contract is
-- weakened.
DO $gwr_task_sla_contract$
DECLARE
  function_definition TEXT;
  anchor TEXT;
  replacement TEXT;
  match_count INTEGER;
BEGIN
  SELECT pg_get_functiondef('care_pathway_route_actionable_roles(text)'::regprocedure)
    INTO function_definition;
  -- Function bodies are stored VERBATIM by Postgres, so a function created by a
  -- migration file with CRLF endings (585 is one) carries \r\n inside its body,
  -- while the multi-line anchors below are written with bare \n and can never
  -- match it. Normalize first so an anchor matches either form. Note replace() is
  -- a literal (non-regex) substitution, so the anchor must equal the real bytes.
  function_definition := replace(function_definition, E'\r\n', E'\n');
  IF POSITION('payment_gateway_refund_recovery' IN function_definition) = 0 THEN
    anchor := $anchor$WHEN obligation_rule_code = 'cold_chain_excursion_ack' THEN$anchor$;
    SELECT COUNT(*)::integer INTO match_count
      FROM regexp_matches(function_definition, anchor, 'g');
    IF match_count <> 1 THEN
      RAISE EXCEPTION 'Cannot extend refund task roles: expected one route-role anchor, found %', match_count;
    END IF;
    replacement := $replacement$WHEN obligation_rule_code = 'payment_gateway_refund_recovery' THEN ARRAY[
      'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'ADMIN', 'SUPER_ADMIN'
    ]::TEXT[]
    WHEN obligation_rule_code = 'cold_chain_excursion_ack' THEN$replacement$;
    EXECUTE replace(function_definition, anchor, replacement);
  END IF;

  SELECT pg_get_functiondef('tasks_sync_workflow_sla_compat()'::regprocedure)
    INTO function_definition;
  -- Function bodies are stored VERBATIM by Postgres, so a function created by a
  -- migration file with CRLF endings (585 is one) carries \r\n inside its body,
  -- while the multi-line anchors below are written with bare \n and can never
  -- match it. Normalize first so an anchor matches either form. Note replace() is
  -- a literal (non-regex) substitution, so the anchor must equal the real bytes.
  function_definition := replace(function_definition, E'\r\n', E'\n');
  IF POSITION($needle$sla_record.rule_code = 'payment_gateway_refund_recovery'$needle$ IN function_definition) = 0 THEN
    anchor := $anchor$ELSIF sla_record.rule_code = 'mortuary_unclaimed_body' THEN$anchor$;
    SELECT COUNT(*)::integer INTO match_count
      FROM regexp_matches(function_definition, anchor, 'g');
    IF match_count <> 1 THEN
      RAISE EXCEPTION 'Cannot extend task compatibility: expected one domain anchor, found %', match_count;
    END IF;
    replacement := $replacement$ELSIF sla_record.rule_code = 'payment_gateway_refund_recovery' THEN
    expected_semantics := 'domain_evidence';
    IF NEW.related_resource_type IS DISTINCT FROM 'payment_gateway_refunds'
       OR NULLIF(BTRIM(NEW.related_resource_id), '') IS NULL
       OR sla_record.source_table IS DISTINCT FROM 'payment_gateway_refunds'
       OR sla_record.source_id IS DISTINCT FROM NEW.related_resource_id
       OR NOT EXISTS (
         SELECT 1 FROM payment_gateway_refunds AS refund
          WHERE refund.tenant_id = NEW.tenant_id
            AND refund.id::text = NEW.related_resource_id
       )
    THEN
      RAISE EXCEPTION 'gateway refund task and linked SLA must describe the same obligation'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF sla_record.rule_code = 'mortuary_unclaimed_body' THEN$replacement$;
    EXECUTE replace(function_definition, anchor, replacement);
  END IF;

  SELECT pg_get_functiondef(
    'care_pathway_assert_human_sla_task_obligation(uuid,uuid)'::regprocedure
  ) INTO function_definition;
  -- Function bodies are stored VERBATIM by Postgres, so a function created by a
  -- migration file with CRLF endings (585 is one) carries \r\n inside its body,
  -- while the multi-line anchors below are written with bare \n and can never
  -- match it. Normalize first so an anchor matches either form. Note replace() is
  -- a literal (non-regex) substitution, so the anchor must equal the real bytes.
  function_definition := replace(function_definition, E'\r\n', E'\n');
  IF POSITION($needle$sla_record.rule_code = 'payment_gateway_refund_recovery'$needle$ IN function_definition) = 0 THEN
    anchor := $anchor$ELSIF sla_record.rule_code = 'mortuary_unclaimed_body' THEN
    expected_semantics := 'domain_evidence';$anchor$;
    SELECT COUNT(*)::integer INTO match_count
      FROM regexp_matches(function_definition, anchor, 'g');
    IF match_count <> 1 THEN
      RAISE EXCEPTION 'Cannot extend human SLA obligation: expected one domain anchor, found %', match_count;
    END IF;
    replacement := $replacement$ELSIF sla_record.rule_code = 'payment_gateway_refund_recovery' THEN
    expected_semantics := 'domain_evidence';
  ELSIF sla_record.rule_code = 'mortuary_unclaimed_body' THEN
    expected_semantics := 'domain_evidence';$replacement$;
    EXECUTE replace(function_definition, anchor, replacement);
  END IF;

  SELECT pg_get_functiondef(
    'care_pathway_assert_actionable_task_owner(uuid,integer)'::regprocedure
  ) INTO function_definition;
  -- Function bodies are stored VERBATIM by Postgres, so a function created by a
  -- migration file with CRLF endings (585 is one) carries \r\n inside its body,
  -- while the multi-line anchors below are written with bare \n and can never
  -- match it. Normalize first so an anchor matches either form. Note replace() is
  -- a literal (non-regex) substitution, so the anchor must equal the real bytes.
  function_definition := replace(function_definition, E'\r\n', E'\n');
  IF POSITION($needle$'payment_gateway_refund_recovery'$needle$ IN function_definition) = 0 THEN
    anchor := $anchor$'critical_result_ack',[[:space:]]*'cold_chain_excursion_ack',[[:space:]]*'referral_response',[[:space:]]*'mortuary_unclaimed_body'$anchor$;
    SELECT COUNT(*)::integer INTO match_count
      FROM regexp_matches(function_definition, anchor, 'g');
    IF match_count <> 1 THEN
      RAISE EXCEPTION 'Cannot extend actionable task ownership: expected one rule anchor, found %', match_count;
    END IF;
    replacement := $replacement$'critical_result_ack', 'cold_chain_excursion_ack', 'referral_response', 'mortuary_unclaimed_body', 'payment_gateway_refund_recovery'$replacement$;
    EXECUTE regexp_replace(function_definition, anchor, replacement, 'g');
  END IF;
END
$gwr_task_sla_contract$;

-- care_pathway_assert_task_sla_source_binding is already a delegating wrapper
-- (748 over 746 over 745 over the 744 dispatch), so the gateway-refund branch
-- is added by wrapping it once more rather than by editing a body that is no
-- longer where the dispatch lives. The rename is skipped when this extension is
-- already installed, so a re-run cannot double-wrap.
DO $gwr_source_binding_rename$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.care_pathway_assert_task_sla_source_binding(uuid,integer)'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'Cannot extend task source binding: care_pathway_assert_task_sla_source_binding(uuid,integer) is absent';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.care_pathway_assert_task_sla_source_binding_pre_752(uuid,integer)'
     ) IS NULL
  THEN
    IF POSITION(
         'payment_gateway_refund_recovery' IN pg_catalog.pg_get_functiondef(
           'public.care_pathway_assert_task_sla_source_binding(uuid,integer)'::regprocedure
         )
       ) > 0
    THEN
      RAISE EXCEPTION
        'Cannot extend task source binding: the live function already carries a gateway refund branch without a 752 predecessor';
    END IF;

    EXECUTE 'ALTER FUNCTION public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER)'
      || ' RENAME TO care_pathway_assert_task_sla_source_binding_pre_752';
  END IF;
END
$gwr_source_binding_rename$;

CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_source_binding(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $gwr_source_binding$
DECLARE
  task_record public.tasks%ROWTYPE;
  sla_record public.workflow_sla_instances%ROWTYPE;
  sla_found BOOLEAN := FALSE;
  valid_binding BOOLEAN := FALSE;
BEGIN
  SELECT task.*
    INTO task_record
    FROM public.tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF FOUND AND task_record.workflow_sla_instance_id IS NOT NULL THEN
    SELECT sla.*
      INTO sla_record
      FROM public.workflow_sla_instances sla
     WHERE sla.tenant_id = task_record.tenant_id
       AND sla.id = task_record.workflow_sla_instance_id;
    sla_found := FOUND;
  END IF;

  -- The gateway-refund branch sits after the workflow-step branch in the
  -- inherited dispatch, so a refund-rule task that is also bound to a workflow
  -- step keeps the workflow-step contract. Everything else - unknown task,
  -- unlinked task, dangling SLA, any other rule_code - is the predecessor's.
  IF NOT sla_found
     OR task_record.workflow_step_id IS NOT NULL
     OR sla_record.rule_code IS DISTINCT FROM 'payment_gateway_refund_recovery'
  THEN
    PERFORM public.care_pathway_assert_task_sla_source_binding_pre_752(
      target_tenant_id,
      target_task_id
    );
    RETURN;
  END IF;

  -- Shared prelude, carried verbatim from the inherited contract so the refund
  -- branch is guarded exactly as it would be inside that dispatch chain. The
  -- SLA row is known to exist on this path.
  IF task_record.metadata->>'sla_instance_id'
       IS DISTINCT FROM task_record.workflow_sla_instance_id::text
     OR NULLIF(BTRIM(task_record.metadata->>'sla_key'), '')
       IS DISTINCT FROM sla_record.rule_code
  THEN
    RAISE EXCEPTION
      'typed task SLA legacy aliases must equal the linked instance and rule'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.due_at IS NULL THEN
    RAISE EXCEPTION
      'linked task deadline must be present'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.status IN ('open', 'in_progress', 'blocked', 'overdue')
     AND (
       sla_record.due_at IS NULL
       OR task_record.due_at IS DISTINCT FROM sla_record.due_at
     )
  THEN
    RAISE EXCEPTION
      'task and linked SLA deadlines must both be present and exactly equal'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.sla_completion_semantics = 'acknowledgement'
     AND task_record.status = 'in_progress'
     AND sla_record.completed_at IS NULL
  THEN
    RAISE EXCEPTION
      'acknowledged task must have a completed linked SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.sla_completion_semantics = 'acknowledgement'
     AND task_record.status IN ('open', 'blocked', 'overdue')
     AND (
       sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
     )
  THEN
    RAISE EXCEPTION
      'actionable acknowledgement task must have an incomplete linked SLA clock'
      USING ERRCODE = 'check_violation';
  END IF;

  valid_binding := task_record.sla_completion_semantics = 'domain_evidence'
    AND task_record.related_resource_type IS NOT DISTINCT FROM 'payment_gateway_refunds'
    AND NULLIF(BTRIM(task_record.related_resource_id), '') IS NOT NULL
    AND sla_record.source_table IS NOT DISTINCT FROM 'payment_gateway_refunds'
    AND sla_record.source_id IS NOT DISTINCT FROM task_record.related_resource_id
    AND EXISTS (
      SELECT 1 FROM public.payment_gateway_refunds AS refund
       WHERE refund.tenant_id = task_record.tenant_id
         AND refund.id::text = task_record.related_resource_id
    );

  IF NOT valid_binding THEN
    RAISE EXCEPTION
      'task and linked SLA source do not describe the same obligation'
      USING ERRCODE = 'check_violation';
  END IF;
END
$gwr_source_binding$;

-- care_pathway_assert_task_sla_completion_receipt is wrapped the same way
-- (748 over 746 over 745 over 744's two wrappers over the 580 dispatch), so the
-- gateway-refund receipt is added as one more outer wrapper. Only the shared
-- domain-evidence prelude that the refund branch sits behind is carried over;
-- every other receipt contract stays with the predecessor.
DO $gwr_completion_receipt_rename$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.care_pathway_assert_task_sla_completion_receipt(uuid,integer)'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'Cannot extend task completion receipt: care_pathway_assert_task_sla_completion_receipt(uuid,integer) is absent';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.care_pathway_assert_task_sla_completion_receipt_pre_752(uuid,integer)'
     ) IS NULL
  THEN
    IF POSITION(
         'payment_gateway_refund_recovery' IN pg_catalog.pg_get_functiondef(
           'public.care_pathway_assert_task_sla_completion_receipt(uuid,integer)'::regprocedure
         )
       ) > 0
    THEN
      RAISE EXCEPTION
        'Cannot extend task completion receipt: the live function already carries a gateway refund branch without a 752 predecessor';
    END IF;

    EXECUTE 'ALTER FUNCTION public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER)'
      || ' RENAME TO care_pathway_assert_task_sla_completion_receipt_pre_752';
  END IF;
END
$gwr_completion_receipt_rename$;

CREATE OR REPLACE FUNCTION public.care_pathway_assert_task_sla_completion_receipt(
  target_tenant_id UUID,
  target_task_id INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $gwr_completion_receipt$
DECLARE
  task_record public.tasks%ROWTYPE;
  sla_record public.workflow_sla_instances%ROWTYPE;
  sla_found BOOLEAN := FALSE;
  evidence JSONB;
BEGIN
  SELECT task.*
    INTO task_record
    FROM public.tasks task
   WHERE task.tenant_id = target_tenant_id
     AND task.id = target_task_id;

  IF FOUND AND task_record.workflow_sla_instance_id IS NOT NULL THEN
    SELECT sla.*
      INTO sla_record
      FROM public.workflow_sla_instances sla
     WHERE sla.tenant_id = task_record.tenant_id
       AND sla.id = task_record.workflow_sla_instance_id;
    sla_found := FOUND;
  END IF;

  -- The gateway-refund receipt lives inside the domain-evidence arm of the
  -- inherited dispatch. Anything else - unknown task, unlinked task, 'none' or
  -- acknowledgement semantics, a missing SLA row (which the predecessor rejects
  -- with its own error), any other rule_code - stays with the predecessor.
  IF NOT sla_found
     OR task_record.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
     OR sla_record.rule_code IS DISTINCT FROM 'payment_gateway_refund_recovery'
  THEN
    PERFORM public.care_pathway_assert_task_sla_completion_receipt_pre_752(
      target_tenant_id,
      target_task_id
    );
    RETURN;
  END IF;

  -- Shared domain-evidence prelude, carried verbatim from the inherited
  -- contract so the refund receipt is guarded exactly as it would be inside
  -- that dispatch chain.
  IF task_record.status IN ('open', 'in_progress', 'blocked', 'overdue') THEN
    IF sla_record.completed_at IS NOT NULL
       OR sla_record.status NOT IN ('active', 'breached', 'escalated')
       OR COALESCE(sla_record.metadata, '{}'::jsonb) ?| ARRAY[
            'completed_via',
            'completed_by_task',
            'completed_by',
            'acknowledged_at',
            'acknowledged_by',
            'acknowledged_via',
            'completion_evidence'
          ]
    THEN
      RAISE EXCEPTION
        'actionable domain-evidence task must have a clean incomplete SLA clock'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;

  IF task_record.status IN ('completed', 'cancelled')
     AND sla_record.completed_at IS NOT NULL
     AND task_record.due_at IS DISTINCT FROM sla_record.due_at
  THEN
    RAISE EXCEPTION
      'terminal domain-evidence task and terminal SLA deadlines must exactly match'
      USING ERRCODE = 'check_violation';
  END IF;

  evidence := sla_record.metadata->'completion_evidence';
  IF task_record.status NOT IN ('completed', 'cancelled')
     OR sla_record.completed_at IS NULL
     OR sla_record.status NOT IN ('completed', 'breached', 'escalated')
     OR sla_record.metadata->>'completed_via' IS DISTINCT FROM 'domain_evidence'
     OR sla_record.metadata->>'completed_by_task' IS DISTINCT FROM task_record.id::text
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION
      'terminal domain-evidence task requires its exact completed SLA receipt'
      USING ERRCODE = 'check_violation';
  END IF;

  IF task_record.related_resource_type IS DISTINCT FROM 'payment_gateway_refunds'
     OR evidence->>'resource_type' IS DISTINCT FROM 'payment_gateway_refunds'
     OR evidence->>'resource_id' IS DISTINCT FROM task_record.related_resource_id
     OR NOT EXISTS (
       SELECT 1
         FROM public.payment_gateway_refunds AS refund
         LEFT JOIN public.billing_refunds AS billing
           ON billing.tenant_id = refund.tenant_id
          AND billing.id = refund.billing_refund_id
        WHERE refund.tenant_id = task_record.tenant_id
          AND refund.id::text = task_record.related_resource_id
          AND (
            (
              evidence->>'kind' = 'payment_gateway_refund_provider_status'
              AND refund.status IN ('processed', 'failed')
              AND evidence->>'provider_status' = refund.status
              AND evidence->>'provider_refund_id'
                    IS NOT DISTINCT FROM refund.provider_refund_id
            )
            OR
            (
              evidence->>'kind' = 'payment_gateway_refund_operator_reconciliation'
              AND refund.reconciled_at IS NOT NULL
              AND refund.reconciliation_disposition = 'provider_failed'
              AND refund.provider_refund_id IS NOT NULL
              AND length(btrim(refund.provider_refund_id)) BETWEEN 1 AND 120
              AND (
                (refund.provider = 'razorpay'
                 AND refund.provider_refund_id ~ '^rfnd_[A-Za-z0-9]+$')
                OR
                (refund.provider <> 'razorpay'
                 AND refund.provider_refund_id !~* '(\*{2,}|masked|redacted)')
              )
              AND refund.status = 'failed'
              AND evidence->>'disposition' = refund.reconciliation_disposition
              AND evidence->'evidence' = refund.reconciliation_evidence
              AND evidence->>'reviewed_by' = refund.reconciled_by::text
              AND refund.reconciled_by IS DISTINCT FROM refund.initiated_by
              AND refund.reconciled_by IS DISTINCT FROM billing.raised_by
              AND refund.reconciled_by IS DISTINCT FROM billing.approved_by
            )
          )
     )
  THEN
    RAISE EXCEPTION 'gateway refund domain-evidence receipt is not authoritative'
      USING ERRCODE = 'check_violation';
  END IF;
END
$gwr_completion_receipt$;

-- The two new wrappers are freshly created objects, so they carry the default
-- PUBLIC EXECUTE grant. Restore the closed default that 745/746/748 apply to
-- every link in this delegation chain.
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_source_binding(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_source_binding_pre_752(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION
  public.care_pathway_assert_task_sla_completion_receipt_pre_752(UUID, INTEGER) FROM PUBLIC;

DO $gwr_task_sla_runtime_privileges$
DECLARE
  runtime_role TEXT;
  callable_function_name TEXT;
  callable_functions CONSTANT TEXT[] := ARRAY[
    'care_pathway_assert_task_sla_source_binding',
    'care_pathway_assert_task_sla_source_binding_pre_752',
    'care_pathway_assert_task_sla_completion_receipt',
    'care_pathway_assert_task_sla_completion_receipt_pre_752'
  ];
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]
  LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NULL THEN
      CONTINUE;
    END IF;
    FOREACH callable_function_name IN ARRAY callable_functions
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.%I(UUID, INTEGER) FROM %I',
        callable_function_name,
        runtime_role
      );
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.%I(UUID, INTEGER) TO %I',
        callable_function_name,
        runtime_role
      );
    END LOOP;
  END LOOP;
END
$gwr_task_sla_runtime_privileges$;

-- Resource-side mutation must not be able to detach or falsify the deferred
-- task/SLA contract after its task row has already passed validation.
CREATE OR REPLACE FUNCTION payment_gateway_refund_task_sla_constraint()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_task RECORD;
  current_refund payment_gateway_refunds%ROWTYPE;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    SELECT *
      INTO current_refund
      FROM payment_gateway_refunds
     WHERE tenant_id = NEW.tenant_id
       AND id = NEW.id;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP <> 'DELETE'
     AND current_refund.reconciled_at IS NOT NULL
     AND current_refund.reconciliation_disposition IS NULL
  THEN
    RAISE EXCEPTION 'gateway refund reconciliation requires structured disposition and evidence'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'DELETE'
     AND current_refund.reconciliation_evidence IS NOT NULL
     AND (
       current_refund.reconciliation_evidence->>'observed_at'
     )::timestamptz > clock_timestamp()
  THEN
    RAISE EXCEPTION 'gateway refund reconciliation evidence cannot be future-dated'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'DELETE'
     AND (
       current_refund.reconciliation_disposition IS NOT NULL
       OR current_refund.recovery_state NOT IN ('succeeded', 'failed')
     )
     AND current_refund.recovery_task_id IS NULL
  THEN
    RAISE EXCEPTION 'gateway refund recovery state requires its typed task and SLA obligation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'DELETE'
     AND current_refund.status IN ('initiated', 'pending')
     AND current_refund.recovery_state IN (
       'queued', 'claimed', 'provider_pending', 'retry_wait', 'blocked_authority'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM billing_refunds AS billing
        WHERE billing.tenant_id = current_refund.tenant_id
          AND billing.id = current_refund.billing_refund_id
          AND billing.approved_by IS NOT NULL
          AND billing.approved_at IS NOT NULL
          AND current_refund.initiated_by IS NOT NULL
          AND current_refund.initiated_by IS DISTINCT FROM billing.approved_by
          AND current_refund.initiated_at > billing.approved_at
          AND EXISTS (
            SELECT 1
              FROM users AS initiator
             WHERE initiator.tenant_id = current_refund.tenant_id
               AND initiator.uid = current_refund.initiated_by
          )
     )
  THEN
    RAISE EXCEPTION 'automatic gateway refund recovery requires independent same-tenant post-approval authority'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'DELETE'
     AND current_refund.status IN ('initiated', 'pending')
     AND current_refund.provider_refund_id IS NULL
     AND current_refund.provider_request_replay_authorized IS NOT TRUE
  THEN
    RAISE EXCEPTION 'provider refund creation requires an explicitly authorized replay identity'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'DELETE'
     AND current_refund.reconciliation_disposition IN ('provider_processed', 'provider_failed')
     AND (
       current_refund.reconciliation_reviewed_by = current_refund.initiated_by
       OR EXISTS (
         SELECT 1
           FROM billing_refunds AS billing
          WHERE billing.tenant_id = current_refund.tenant_id
            AND billing.id = current_refund.billing_refund_id
            AND current_refund.reconciliation_reviewed_by IN (
              billing.raised_by, billing.approved_by
            )
       )
     )
  THEN
    RAISE EXCEPTION 'processed or failed gateway refund reconciliation requires an independent reviewer'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'DELETE'
     AND current_refund.recovery_task_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = current_refund.tenant_id
          AND task.id = current_refund.recovery_task_id
          AND task.related_resource_type = 'payment_gateway_refunds'
          AND task.related_resource_id = current_refund.id::text
          AND task.sla_completion_semantics = 'domain_evidence'
          AND sla.id = current_refund.recovery_sla_instance_id
          AND sla.rule_code = 'payment_gateway_refund_recovery'
          AND sla.source_table = 'payment_gateway_refunds'
          AND sla.source_id = current_refund.id::text
     )
  THEN
    RAISE EXCEPTION 'gateway refund recovery task and SLA pointers are not an exact typed obligation'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP <> 'INSERT' THEN
    FOR linked_task IN
      SELECT DISTINCT task.id, task.tenant_id, task.workflow_sla_instance_id
        FROM tasks AS task
       WHERE task.tenant_id = OLD.tenant_id
         AND (
           task.id = OLD.recovery_task_id
           OR (
             task.related_resource_type = 'payment_gateway_refunds'
             AND task.related_resource_id = OLD.id::text
           )
         )
    LOOP
      PERFORM care_pathway_assert_task_sla_source_binding(
        linked_task.tenant_id, linked_task.id
      );
      PERFORM care_pathway_assert_task_sla_completion_receipt(
        linked_task.tenant_id, linked_task.id
      );
      PERFORM care_pathway_assert_actionable_task_owner(
        linked_task.tenant_id, linked_task.id
      );
      IF linked_task.workflow_sla_instance_id IS NOT NULL THEN
        PERFORM care_pathway_assert_human_sla_task_obligation(
          linked_task.tenant_id, linked_task.workflow_sla_instance_id
        );
      END IF;
    END LOOP;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    FOR linked_task IN
      SELECT DISTINCT task.id, task.tenant_id, task.workflow_sla_instance_id
       FROM tasks AS task
       WHERE task.tenant_id = current_refund.tenant_id
         AND (
           task.id = current_refund.recovery_task_id
           OR (
             task.related_resource_type = 'payment_gateway_refunds'
             AND task.related_resource_id = current_refund.id::text
           )
         )
    LOOP
      PERFORM care_pathway_assert_task_sla_source_binding(
        linked_task.tenant_id, linked_task.id
      );
      PERFORM care_pathway_assert_task_sla_completion_receipt(
        linked_task.tenant_id, linked_task.id
      );
      PERFORM care_pathway_assert_actionable_task_owner(
        linked_task.tenant_id, linked_task.id
      );
      IF linked_task.workflow_sla_instance_id IS NOT NULL THEN
        PERFORM care_pathway_assert_human_sla_task_obligation(
          linked_task.tenant_id, linked_task.workflow_sla_instance_id
        );
      END IF;
    END LOOP;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_pg_refund_task_sla_contract
  AFTER INSERT OR UPDATE OR DELETE ON payment_gateway_refunds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_gateway_refund_task_sla_constraint();

INSERT INTO workflow_sla_rules
  (tenant_id, rule_code, title, trigger_event_type, target_minutes, severity,
   owner_role_codes, escalation_role_codes, metadata)
VALUES
  (
    NULL::uuid,
    'payment_gateway_refund_recovery',
    'Payment gateway refund provider confirmation',
    'billing.gateway_refund.pending',
    30,
    'high',
    ARRAY['FINANCE_INCHARGE', 'BILLING_INCHARGE']::TEXT[],
    ARRAY['ADMIN', 'SUPER_ADMIN']::TEXT[],
    jsonb_build_object(
      'description', 'Time to obtain authoritative provider refund status and project the terminal billing outcome',
      'completion_authority', 'provider_status_evidence',
      'activation_gate', 'PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED=true'
    )
  )
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

-- Existing unresolved legs predate the recovery task/SLA contract. Bind each
-- one before the deferred resource constraint becomes effective at commit.
INSERT INTO workflow_sla_instances
  (tenant_id, rule_id, rule_code, patient_uid, source_table, source_id,
   status, priority, started_at, due_at, assigned_role_codes, metadata)
SELECT refund.tenant_id,
       rule.id,
       rule.rule_code,
       orders.patient_uid,
       'payment_gateway_refunds',
       refund.id::text,
       'active',
       rule.severity,
       COALESCE(refund.initiated_at, NOW()),
       COALESCE(refund.initiated_at, NOW())
         + make_interval(mins => rule.target_minutes),
       rule.owner_role_codes,
       jsonb_build_object(
         'gateway_refund_id', refund.id,
         'billing_refund_id', refund.billing_refund_id,
         'escalation_role_codes', rule.escalation_role_codes,
         'completion_authority', 'provider_status_evidence',
         'backfilled_by', 'migration_752'
       )
  FROM payment_gateway_refunds AS refund
  JOIN payment_gateway_orders AS orders
    ON orders.tenant_id = refund.tenant_id
   AND orders.id = refund.gateway_order_id
  JOIN LATERAL (
    SELECT candidate.*
      FROM workflow_sla_rules AS candidate
     WHERE candidate.enabled = TRUE
       AND candidate.rule_code = 'payment_gateway_refund_recovery'
       AND (candidate.tenant_id = refund.tenant_id OR candidate.tenant_id IS NULL)
     ORDER BY CASE WHEN candidate.tenant_id = refund.tenant_id THEN 0 ELSE 1 END
     LIMIT 1
  ) AS rule ON TRUE
 WHERE refund.status IN ('initiated', 'pending', 'requires_reconciliation')
ON CONFLICT (tenant_id, rule_code, source_table, source_id)
WHERE source_table IS NOT NULL AND source_id IS NOT NULL
DO NOTHING;

INSERT INTO tasks
  (tenant_id, task_kind, title, description, patient_uid,
   related_resource_type, related_resource_id, priority, status,
   assigned_to_uid, assigned_to_role, due_at, workflow_sla_instance_id,
   sla_completion_semantics, metadata)
SELECT refund.tenant_id,
       'review',
       'Confirm payment gateway refund with provider',
       'Provider confirmation is required before this refund can be treated as paid.',
       orders.patient_uid,
       'payment_gateway_refunds',
       refund.id::text,
       'high',
       CASE WHEN refund.status = 'requires_reconciliation' THEN 'blocked' ELSE 'open' END,
       NULL,
       'FINANCE_INCHARGE',
       sla.due_at,
       sla.id,
       'domain_evidence',
       jsonb_build_object(
         'gateway_refund_id', refund.id,
         'billing_refund_id', refund.billing_refund_id,
         'gateway_refund_recovery_sla_id', sla.id,
         'sla_instance_id', sla.id::text,
         'sla_key', 'payment_gateway_refund_recovery',
         'owner_role_codes', ARRAY[
           'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'ADMIN', 'SUPER_ADMIN'
         ]::text[],
         'task_contract', 'payment_gateway_refund_recovery_v1',
         'provider', refund.provider,
         'environment', refund.environment,
         'provider_request_fingerprint', refund.provider_request_fingerprint,
         'backfilled_by', 'migration_752'
       )
  FROM payment_gateway_refunds AS refund
  JOIN payment_gateway_orders AS orders
    ON orders.tenant_id = refund.tenant_id
   AND orders.id = refund.gateway_order_id
  JOIN workflow_sla_instances AS sla
    ON sla.tenant_id = refund.tenant_id
   AND sla.rule_code = 'payment_gateway_refund_recovery'
   AND sla.source_table = 'payment_gateway_refunds'
   AND sla.source_id = refund.id::text
 WHERE refund.status IN ('initiated', 'pending', 'requires_reconciliation')
ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
  AND related_resource_type IS NOT NULL
  AND related_resource_id IS NOT NULL
DO UPDATE SET
  task_kind = EXCLUDED.task_kind,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  patient_uid = EXCLUDED.patient_uid,
  priority = EXCLUDED.priority,
  status = EXCLUDED.status,
  assigned_to_uid = NULL,
  assigned_to_role = EXCLUDED.assigned_to_role,
  due_at = EXCLUDED.due_at,
  completed_at = NULL,
  workflow_sla_instance_id = EXCLUDED.workflow_sla_instance_id,
  sla_completion_semantics = EXCLUDED.sla_completion_semantics,
  metadata = tasks.metadata || EXCLUDED.metadata,
  updated_at = NOW();

UPDATE payment_gateway_refunds AS refund
   SET recovery_task_id = task.id,
       recovery_sla_instance_id = sla.id,
       updated_at = NOW()
  FROM workflow_sla_instances AS sla
  JOIN tasks AS task
    ON task.tenant_id = sla.tenant_id
   AND task.workflow_sla_instance_id = sla.id
   AND task.related_resource_type = 'payment_gateway_refunds'
   AND task.related_resource_id = sla.source_id
   AND task.sla_completion_semantics = 'domain_evidence'
   AND task.status IN ('open', 'in_progress', 'blocked', 'overdue')
 WHERE refund.tenant_id = sla.tenant_id
   AND sla.rule_code = 'payment_gateway_refund_recovery'
   AND sla.source_table = 'payment_gateway_refunds'
   AND sla.source_id = refund.id::text
   AND refund.status IN ('initiated', 'pending', 'requires_reconciliation');

DO $gwr_backfill_postflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM payment_gateway_refunds AS refund
      LEFT JOIN tasks AS task
        ON task.tenant_id = refund.tenant_id
       AND task.id = refund.recovery_task_id
      LEFT JOIN workflow_sla_instances AS sla
        ON sla.tenant_id = refund.tenant_id
       AND sla.id = refund.recovery_sla_instance_id
     WHERE refund.status IN ('initiated', 'pending', 'requires_reconciliation')
       AND (
         task.id IS NULL
         OR sla.id IS NULL
         OR task.workflow_sla_instance_id IS DISTINCT FROM sla.id
         OR task.related_resource_type IS DISTINCT FROM 'payment_gateway_refunds'
         OR task.related_resource_id IS DISTINCT FROM refund.id::text
         OR task.sla_completion_semantics IS DISTINCT FROM 'domain_evidence'
         OR sla.rule_code IS DISTINCT FROM 'payment_gateway_refund_recovery'
         OR sla.source_table IS DISTINCT FROM 'payment_gateway_refunds'
         OR sla.source_id IS DISTINCT FROM refund.id::text
       )
  ) THEN
    RAISE EXCEPTION '752 postflight: unresolved gateway refund lacks an exact task/SLA obligation'
      USING ERRCODE = 'check_violation';
  END IF;
END
$gwr_backfill_postflight$;

COMMENT ON COLUMN payment_gateway_refunds.provider_request_fingerprint IS
  'Database-derived SHA-256 identity of the exact tenant, provider, payment, refund authority, amount, currency, and provider idempotency key used for retry.';
COMMENT ON COLUMN payment_gateway_refunds.provider_request_replay_authorized IS
  'True only when the refund-intent service explicitly commits a provider create identity under the GWR-01 replay contract. The fail-closed default and all historical keys remain false.';
COMMENT ON COLUMN payment_gateway_refunds.recovery_state IS
  'Durable provider-status recovery projection. Only exact provider processed evidence may produce succeeded.';
COMMENT ON COLUMN payment_gateway_refunds.recovery_claim_token IS
  'Single-attempt fencing token. Poll/retry projections must present the live token they claimed; signed webhooks remain independently authoritative.';
COMMENT ON COLUMN payment_gateway_refunds.recovery_task_id IS
  'Operator-visible finance task for the unresolved provider refund. The domain service closes it only from terminal provider evidence.';
COMMENT ON COLUMN payment_gateway_refunds.recovery_sla_instance_id IS
  'SLA clock for authoritative provider confirmation; linked by the exact payment_gateway_refunds resource identity.';
COMMENT ON COLUMN payment_gateway_refunds.reconciliation_disposition IS
  'Structured operator disposition. Processed, pending, and unknown observations remain open until trusted provider API settlement; only verified provider_failed manual closure is terminal.';
COMMENT ON COLUMN payment_gateway_refunds.reconciliation_evidence IS
  'Structured, attributable evidence supporting the operator disposition; never substitutes for provider API success evidence.';

COMMIT;
