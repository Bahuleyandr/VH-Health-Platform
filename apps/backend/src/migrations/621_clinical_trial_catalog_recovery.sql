-- 621_clinical_trial_catalog_recovery.sql
-- C6.1-G / I23: retain clinical_trials_catalog and
-- clinical_ai_trial_sync_runs. A canonical run row is one provider page;
-- provider continuation/revision evidence, never status or upsert count,
-- defines page completeness. No parallel HWM table is introduced.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.clinical_ai_trial_sync_runs
  ADD COLUMN source_partition VARCHAR(160),
  ADD COLUMN sync_session_id UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN provider_page_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN provider_page_token TEXT,
  ADD COLUMN provider_page_token_sha256 CHAR(64),
  ADD COLUMN provider_next_page_token TEXT,
  ADD COLUMN provider_next_page_token_sha256 CHAR(64),
  ADD COLUMN provider_revision VARCHAR(64),
  ADD COLUMN provider_page_sha256 CHAR(64),
  ADD COLUMN provider_page_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN recovery_inbox_id UUID,
  ADD COLUMN recovery_interface_family VARCHAR(8),
  ADD COLUMN recovery_owner_uid UUID,
  ADD COLUMN recovery_owner_reason VARCHAR(500),
  ADD COLUMN recovery_evidence JSONB,
  ADD COLUMN effect_disposition VARCHAR(32) NOT NULL DEFAULT 'live';

UPDATE public.clinical_ai_trial_sync_runs
   SET source_partition = 'clinicaltrials_gov_v2:legacy:' || id::text,
       provider_page_token = 'legacy:' || id::text,
       provider_page_token_sha256 = encode(
         digest(('legacy:' || id::text)::bytea, 'sha256'), 'hex'
       );

ALTER TABLE public.clinical_ai_trial_sync_runs
  ALTER COLUMN source_partition SET NOT NULL,
  ALTER COLUMN provider_page_token SET NOT NULL,
  ALTER COLUMN provider_page_token_sha256 SET NOT NULL,
  ADD CONSTRAINT uq_clinical_ai_trial_sync_runs_tenant_id
    UNIQUE (tenant_id, id),
  ADD CONSTRAINT fk_clinical_ai_trial_sync_runs_recovery_inbox
    FOREIGN KEY (tenant_id, recovery_inbox_id, recovery_interface_family)
    REFERENCES public.pathway_projector_inbox (tenant_id, inbox_id, interface_family)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT fk_clinical_ai_trial_sync_runs_recovery_owner
    FOREIGN KEY (tenant_id, recovery_owner_uid)
    REFERENCES public.users (tenant_id, uid)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_clinical_ai_trial_sync_runs_i23_page_identity
    CHECK (
      source_partition ~ '^clinicaltrials_gov_v2:([0-9a-f]{64}|legacy:[0-9]+)$'
      AND provider_page_number >= 1
      AND length(provider_page_token) > 0
      AND provider_page_token_sha256 ~ '^[0-9a-f]{64}$'
      AND provider_page_token_sha256 = encode(
        digest(provider_page_token::bytea, 'sha256'), 'hex'
      )
      AND (
        (provider_next_page_token IS NULL AND provider_next_page_token_sha256 IS NULL)
        OR (
          provider_next_page_token IS NOT NULL
          AND length(provider_next_page_token) > 0
          AND provider_next_page_token_sha256 ~ '^[0-9a-f]{64}$'
          AND provider_next_page_token_sha256 = encode(
            digest(provider_next_page_token::bytea, 'sha256'), 'hex'
          )
        )
      )
    ),
  ADD CONSTRAINT chk_clinical_ai_trial_sync_runs_i23_page_complete
    CHECK (
      source_partition LIKE 'clinicaltrials_gov_v2:legacy:%'
      OR (
        (
          provider_page_complete
          AND status = 'completed'
          AND finished_at IS NOT NULL
          AND provider_revision IS NOT NULL
          AND length(btrim(provider_revision)) > 0
          AND provider_page_sha256 ~ '^[0-9a-f]{64}$'
          AND error_message IS NULL
        )
        OR (
          NOT provider_page_complete
          AND status IN ('running', 'failed')
          AND (
            (status = 'running' AND finished_at IS NULL)
            OR (status = 'failed' AND finished_at IS NOT NULL AND error_message IS NOT NULL)
          )
        )
      )
    ),
  ADD CONSTRAINT chk_clinical_ai_trial_sync_runs_i23_recovery_shape
    CHECK (
      (
        recovery_inbox_id IS NULL
        AND recovery_interface_family IS NULL
        AND recovery_owner_uid IS NULL
        AND recovery_owner_reason IS NULL
        AND recovery_evidence IS NULL
        AND effect_disposition = 'live'
      )
      OR (
        recovery_inbox_id IS NOT NULL
        AND recovery_interface_family = 'I23'
        AND recovery_owner_uid IS NOT NULL
        AND recovery_owner_reason IS NOT NULL
        AND length(btrim(recovery_owner_reason)) > 0
        AND recovery_evidence IS NOT NULL
        AND jsonb_typeof(recovery_evidence) = 'object'
        AND recovery_evidence <> '{}'::jsonb
        AND status = 'failed'
        AND NOT provider_page_complete
        AND provider_revision IS NOT NULL
        AND provider_page_sha256 IS NOT NULL
        AND effect_disposition = 'late_pending_only'
      )
    ),
  ADD CONSTRAINT chk_clinical_ai_trial_sync_runs_i23_effect_disposition
    CHECK (effect_disposition IN ('live', 'late_pending_only'));

CREATE UNIQUE INDEX ux_clinical_ai_trial_sync_runs_i23_page
  ON public.clinical_ai_trial_sync_runs
    (tenant_id, source_partition, sync_session_id, provider_page_token_sha256)
  WHERE source_partition NOT LIKE 'clinicaltrials_gov_v2:legacy:%';

CREATE INDEX idx_clinical_ai_trial_sync_runs_i23_partition
  ON public.clinical_ai_trial_sync_runs
    (tenant_id, source_partition, id DESC);

ALTER TABLE public.clinical_trials_catalog
  ADD COLUMN provider_revision VARCHAR(64),
  ADD COLUMN source_payload_sha256 CHAR(64),
  ADD COLUMN source_sync_run_id INTEGER,
  ADD CONSTRAINT fk_clinical_trials_catalog_source_sync_run
    FOREIGN KEY (tenant_id, source_sync_run_id)
    REFERENCES public.clinical_ai_trial_sync_runs (tenant_id, id)
    ON UPDATE NO ACTION ON DELETE RESTRICT,
  ADD CONSTRAINT chk_clinical_trials_catalog_i23_source_shape
    CHECK (
      (
        provider_revision IS NULL
        AND source_payload_sha256 IS NULL
        AND source_sync_run_id IS NULL
      )
      OR (
        provider_revision IS NOT NULL
        AND length(btrim(provider_revision)) > 0
        AND source_payload_sha256 ~ '^[0-9a-f]{64}$'
        AND source_sync_run_id IS NOT NULL
      )
    );

CREATE INDEX idx_clinical_trials_catalog_i23_source_run
  ON public.clinical_trials_catalog (tenant_id, source_sync_run_id)
  WHERE source_sync_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.assert_clinical_trial_i23_recovery_binding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  inbox RECORD;
  expected_duplicate TEXT;
BEGIN
  IF NEW.recovery_inbox_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT item.interface_family, item.direction, item.source_partition,
         item.source_position, item.duplicate_key, item.arrival_class,
         item.effect_disposition, item.status
    INTO inbox
    FROM public.pathway_projector_inbox AS item
   WHERE item.tenant_id = NEW.tenant_id
     AND item.inbox_id = NEW.recovery_inbox_id;

  expected_duplicate := 'i23:' || NEW.id::text || ':'
                        || NEW.provider_page_token_sha256::text || ':'
                        || NEW.provider_page_sha256::text;

  IF inbox.interface_family IS DISTINCT FROM 'I23'
     OR inbox.direction IS DISTINCT FROM 'inbound'
     OR inbox.source_partition IS DISTINCT FROM NEW.source_partition
     OR inbox.source_position IS DISTINCT FROM NEW.id::bigint
     OR inbox.duplicate_key IS DISTINCT FROM expected_duplicate
     OR inbox.arrival_class IS DISTINCT FROM 'recovery_backlog'
     OR inbox.effect_disposition IS DISTINCT FROM 'late_pending_only'
     OR inbox.status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_clinical_trial_i23_recovery_inbox_binding',
      MESSAGE = 'I23 trial page recovery does not match canonical inbox provenance';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_trial_i23_recovery_binding
BEFORE INSERT OR UPDATE OF recovery_inbox_id
ON public.clinical_ai_trial_sync_runs
FOR EACH ROW EXECUTE FUNCTION public.assert_clinical_trial_i23_recovery_binding();

CREATE OR REPLACE FUNCTION public.assert_clinical_trial_i23_evidence_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.recovery_inbox_id IS NOT NULL
       OR (
         OLD.source_partition NOT LIKE 'clinicaltrials_gov_v2:legacy:%'
         AND OLD.provider_page_complete
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_clinical_trial_i23_evidence_immutable',
        MESSAGE = 'I23 complete-page and recovery evidence is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.source_partition IS DISTINCT FROM NEW.source_partition
     OR OLD.sync_session_id IS DISTINCT FROM NEW.sync_session_id
     OR OLD.provider_page_number IS DISTINCT FROM NEW.provider_page_number
     OR OLD.provider_page_token IS DISTINCT FROM NEW.provider_page_token
     OR OLD.provider_page_token_sha256 IS DISTINCT FROM NEW.provider_page_token_sha256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_clinical_trial_i23_page_identity_immutable',
      MESSAGE = 'I23 trial page identity is immutable';
  END IF;

  IF OLD.provider_page_complete OR OLD.status = 'failed' THEN
    IF NEW.provider_next_page_token IS DISTINCT FROM OLD.provider_next_page_token
       OR NEW.provider_next_page_token_sha256 IS DISTINCT FROM OLD.provider_next_page_token_sha256
       OR NEW.provider_revision IS DISTINCT FROM OLD.provider_revision
       OR NEW.provider_page_sha256 IS DISTINCT FROM OLD.provider_page_sha256
       OR NEW.provider_page_complete IS DISTINCT FROM OLD.provider_page_complete
       OR NEW.fetched_count IS DISTINCT FROM OLD.fetched_count
       OR NEW.upserted_count IS DISTINCT FROM OLD.upserted_count
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
       OR NEW.error_message IS DISTINCT FROM OLD.error_message THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'chk_clinical_trial_i23_page_evidence_immutable',
        MESSAGE = 'I23 terminal provider-page evidence is immutable';
    END IF;
  END IF;

  IF OLD.recovery_inbox_id IS NOT NULL AND (
    NEW.recovery_inbox_id IS DISTINCT FROM OLD.recovery_inbox_id
    OR NEW.recovery_interface_family IS DISTINCT FROM OLD.recovery_interface_family
    OR NEW.recovery_owner_uid IS DISTINCT FROM OLD.recovery_owner_uid
    OR NEW.recovery_owner_reason IS DISTINCT FROM OLD.recovery_owner_reason
    OR NEW.recovery_evidence IS DISTINCT FROM OLD.recovery_evidence
    OR NEW.effect_disposition IS DISTINCT FROM OLD.effect_disposition
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'chk_clinical_trial_i23_recovery_immutable',
      MESSAGE = 'I23 recovery evidence is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER clinical_trial_i23_evidence_transition
BEFORE UPDATE OR DELETE ON public.clinical_ai_trial_sync_runs
FOR EACH ROW EXECUTE FUNCTION public.assert_clinical_trial_i23_evidence_transition();

CREATE POLICY clinical_trial_i23_recovery_explicit_context
  ON public.clinical_ai_trial_sync_runs
  AS RESTRICTIVE
  USING (
    recovery_inbox_id IS NULL
    OR (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  )
  WITH CHECK (
    recovery_inbox_id IS NULL
    OR (
      current_setting('app.current_tenant_id', true) IS NOT NULL
      AND current_setting('app.current_tenant_id', true) <> ''
      AND current_setting('app.current_tenant_id', true) <> 'bypass'
      AND tenant_id = public.app_current_tenant_id_uuid()
    )
  );

COMMIT;
