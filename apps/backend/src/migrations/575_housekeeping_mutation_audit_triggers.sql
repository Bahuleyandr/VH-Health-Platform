-- Semantic, transaction-local audit coverage for housekeeping workflows.
-- The universal request audit shows that an endpoint was called; these
-- triggers prove which housekeeping record changed, even for internal jobs or
-- future writers that do not pass through HTTP middleware.

CREATE OR REPLACE FUNCTION audit_housekeeping_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  audit_actor uuid;
  audit_action text;
  previous_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    audit_actor := COALESCE(NEW.assigned_by_uid, NEW.requester_uid);
    audit_action := 'HOUSEKEEPING_REQUEST_CREATED';
    previous_status := NULL;
  ELSE
    audit_actor := COALESCE(
      NEW.verified_by_uid,
      CASE WHEN NEW.assigned_by_uid IS DISTINCT FROM OLD.assigned_by_uid THEN NEW.assigned_by_uid END,
      NEW.assigned_to_uid,
      NEW.requester_uid
    );
    previous_status := OLD.status;
    audit_action := CASE
      WHEN NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN 'HOUSEKEEPING_REQUEST_VERIFIED'
      WHEN NEW.assigned_to_uid IS DISTINCT FROM OLD.assigned_to_uid THEN 'HOUSEKEEPING_REQUEST_ASSIGNED'
      WHEN NEW.status IS DISTINCT FROM OLD.status THEN
        'HOUSEKEEPING_REQUEST_' || UPPER(REPLACE(COALESCE(NEW.status, 'UPDATED'), ' ', '_'))
      ELSE 'HOUSEKEEPING_REQUEST_UPDATED'
    END;
  END IF;

  INSERT INTO audit_logs
    (uid, actor_uid, action, resource, resource_id, metadata, tenant_id, created_at)
  VALUES
    (audit_actor, audit_actor, audit_action, 'housekeeping_request', NEW.id::text,
     jsonb_build_object(
       'request_number', NEW.request_number,
       'request_type', NEW.request_type,
       'urgency', NEW.urgency,
       'zone_id', NEW.zone_id,
       'assigned_to_uid', NEW.assigned_to_uid,
       'previous_status', previous_status,
       'status', NEW.status
     ),
     NEW.tenant_id,
     clock_timestamp());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_housekeeping_request_mutation ON housekeeping_requests;
CREATE TRIGGER trg_audit_housekeeping_request_mutation
AFTER INSERT OR UPDATE ON housekeeping_requests
FOR EACH ROW EXECUTE FUNCTION audit_housekeeping_request_mutation();

CREATE OR REPLACE FUNCTION audit_housekeeping_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  audit_actor uuid;
  audit_action text;
  previous_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    audit_actor := NEW.staff_uid;
    audit_action := 'HOUSEKEEPING_LOG_SUBMITTED';
    previous_status := NULL;
  ELSE
    audit_actor := COALESCE(NEW.verified_by_uid, NEW.staff_uid);
    previous_status := OLD.status;
    audit_action := CASE
      WHEN NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN 'HOUSEKEEPING_LOG_VERIFIED'
      WHEN NEW.status IS DISTINCT FROM OLD.status THEN
        'HOUSEKEEPING_LOG_' || UPPER(REPLACE(COALESCE(NEW.status, 'UPDATED'), ' ', '_'))
      ELSE 'HOUSEKEEPING_LOG_UPDATED'
    END;
  END IF;

  INSERT INTO audit_logs
    (uid, actor_uid, action, resource, resource_id, metadata, tenant_id, created_at)
  VALUES
    (audit_actor, audit_actor, audit_action, 'housekeeping_log', NEW.id::text,
     jsonb_build_object(
       'log_number', NEW.log_number,
       'cleaning_type', NEW.cleaning_type,
       'zone_id', NEW.zone_id,
       'previous_status', previous_status,
       'status', NEW.status
     ),
     NEW.tenant_id,
     clock_timestamp());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_housekeeping_log_mutation ON housekeeping_logs;
CREATE TRIGGER trg_audit_housekeeping_log_mutation
AFTER INSERT OR UPDATE ON housekeeping_logs
FOR EACH ROW EXECUTE FUNCTION audit_housekeeping_log_mutation();

CREATE OR REPLACE FUNCTION audit_housekeeping_assignment_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  audit_action text;
BEGIN
  audit_action := CASE
    WHEN TG_OP = 'INSERT' THEN 'HOUSEKEEPING_ASSIGNMENT_CREATED'
    WHEN NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'ended'
      THEN 'HOUSEKEEPING_ASSIGNMENT_ENDED'
    ELSE 'HOUSEKEEPING_ASSIGNMENT_UPDATED'
  END;

  INSERT INTO audit_logs
    (uid, actor_uid, action, resource, resource_id, metadata, tenant_id, created_at)
  VALUES
    (NEW.assigned_by_uid, NEW.assigned_by_uid, audit_action,
     'housekeeping_floor_assignment', NEW.id::text,
     jsonb_build_object(
       'staff_uid', NEW.staff_uid,
       'zone_id', NEW.zone_id,
       'floor', NEW.floor,
       'building', NEW.building,
       'status', NEW.status,
       'effective_from', NEW.effective_from,
       'effective_to', NEW.effective_to
     ),
     NEW.tenant_id,
     clock_timestamp());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_housekeeping_assignment_mutation ON housekeeping_floor_assignments;
CREATE TRIGGER trg_audit_housekeeping_assignment_mutation
AFTER INSERT OR UPDATE ON housekeeping_floor_assignments
FOR EACH ROW EXECUTE FUNCTION audit_housekeeping_assignment_mutation();
