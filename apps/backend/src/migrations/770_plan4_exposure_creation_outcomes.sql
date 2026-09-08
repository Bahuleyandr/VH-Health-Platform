BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- A legacy event has no trustworthy occurrence instant; NULL cannot authorize exclusion.
ALTER TABLE public.bloodborne_exposure_outbox ADD COLUMN occurred_at TIMESTAMPTZ(6);
ALTER TABLE public.bloodborne_exposure_outbox ALTER COLUMN occurred_at SET DEFAULT clock_timestamp();

CREATE FUNCTION public.plan4_exposure_creation_instant_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'reprocessable_devices' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_at := clock_timestamp();
    ELSIF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Device creation instant is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF TG_OP = 'INSERT' THEN
      NEW.occurred_at := clock_timestamp();
    ELSIF NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
      RAISE EXCEPTION 'Exposure occurrence instant is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER plan4_device_creation_instant_guard
  BEFORE INSERT OR UPDATE ON public.reprocessable_devices
  FOR EACH ROW EXECUTE FUNCTION public.plan4_exposure_creation_instant_guard();
CREATE TRIGGER plan4_exposure_occurrence_instant_guard
  BEFORE INSERT OR UPDATE ON public.bloodborne_exposure_outbox
  FOR EACH ROW EXECUTE FUNCTION public.plan4_exposure_creation_instant_guard();

ALTER TABLE public.bloodborne_exposure_applications
  DROP CONSTRAINT bloodborne_exposure_applications_result_check,
  ADD CONSTRAINT bloodborne_exposure_applications_result_check CHECK (
    result IN ('hold_created', 'hold_associated', 'already_applied', 'not_applicable',
               'not_applicable_predates_creation')
  ),
  ADD CONSTRAINT bloodborne_exposure_applications_creation_evidence_check CHECK (
    result <> 'not_applicable_predates_creation'
    OR (hold_id IS NULL AND source_usage_id IS NULL
        AND metadata->'event_occurred_at' IS NOT NULL
        AND metadata->'device_created_at' IS NOT NULL
        AND jsonb_typeof(metadata->'event_occurred_at') = 'string'
        AND jsonb_typeof(metadata->'device_created_at') = 'string')
  );

CREATE INDEX idx_bloodborne_exposure_outbox_patient_event
  ON public.bloodborne_exposure_outbox (tenant_id, patient_uid, id);

COMMIT;
