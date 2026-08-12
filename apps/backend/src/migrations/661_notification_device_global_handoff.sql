-- Migration 661: Atomically hand notification-device ownership between accounts.
-- user_devices remains under the forced restrictive policy installed by 604.

CREATE OR REPLACE FUNCTION public.notification_device_handoff(
  p_tenant_id UUID,
  p_user_uid UUID,
  p_device_id TEXT,
  p_fcm_token TEXT,
  p_device_name TEXT,
  p_platform TEXT,
  p_app_version TEXT,
  p_os_version TEXT,
  p_require_existing BOOLEAN
)
RETURNS TABLE (
  id INTEGER,
  device_name VARCHAR,
  is_new_registration BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $notification_device_handoff$
DECLARE
  caller_tenant TEXT;
  displaced_tokens TEXT[];
  target_exists BOOLEAN;
  lock_key TEXT;
BEGIN
  caller_tenant := pg_catalog.current_setting('app.current_tenant_id', true);
  IF caller_tenant IS NULL
     OR pg_catalog.btrim(caller_tenant) IN ('', 'bypass')
     OR pg_catalog.btrim(caller_tenant) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR pg_catalog.btrim(caller_tenant)::UUID <> p_tenant_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'notification device handoff requires matching tenant context';
  END IF;

  IF p_tenant_id IS NULL OR p_user_uid IS NULL OR p_require_existing IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'notification device identity is required';
  END IF;
  IF p_device_id IS NULL
     OR pg_catalog.btrim(p_device_id) = ''
     OR pg_catalog.octet_length(p_device_id) > 255 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid notification device id';
  END IF;
  IF p_fcm_token IS NULL
     OR pg_catalog.btrim(p_fcm_token) = ''
     OR pg_catalog.octet_length(p_fcm_token) > 4096 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid notification token';
  END IF;
  IF (p_device_name IS NOT NULL AND pg_catalog.octet_length(p_device_name) > 255)
     OR (p_platform IS NOT NULL AND pg_catalog.octet_length(p_platform) > 50)
     OR (p_app_version IS NOT NULL AND pg_catalog.octet_length(p_app_version) > 50)
     OR (p_os_version IS NOT NULL AND pg_catalog.octet_length(p_os_version) > 50) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'notification device metadata is too long';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.users AS target_user
     WHERE target_user.tenant_id = p_tenant_id
       AND target_user.uid = p_user_uid
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      CONSTRAINT = 'cc_user_devices_user_tenant_fk',
      MESSAGE = 'notification device target user does not exist';
  END IF;

  FOR lock_key IN
    SELECT candidate.key
      FROM pg_catalog.unnest(ARRAY[
        'notification-device:' || p_device_id,
        'notification-token:' || p_fcm_token
      ]) AS candidate(key)
     ORDER BY candidate.key
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(lock_key, 0)
    );
  END LOOP;

  SELECT EXISTS (
    SELECT 1
      FROM public.user_devices AS target_device
     WHERE target_device.tenant_id = p_tenant_id
       AND target_device.user_uid = p_user_uid
       AND target_device.device_id = p_device_id
  )
  INTO target_exists;

  IF p_require_existing AND NOT target_exists THEN
    RETURN;
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT displaced.fcm_token)
    FILTER (WHERE displaced.fcm_token IS NOT NULL)
    INTO displaced_tokens
    FROM public.user_devices AS displaced
   WHERE (displaced.device_id = p_device_id OR displaced.fcm_token = p_fcm_token)
     AND NOT (
       displaced.tenant_id = p_tenant_id
       AND displaced.user_uid = p_user_uid
       AND displaced.device_id = p_device_id
     );

  displaced_tokens := COALESCE(displaced_tokens, ARRAY[]::TEXT[]);

  UPDATE public.users AS displaced_user
     SET device_token = NULL,
         updated_at = pg_catalog.statement_timestamp()
   WHERE displaced_user.device_token IS NOT NULL
     AND NOT (
       displaced_user.tenant_id = p_tenant_id
       AND displaced_user.uid = p_user_uid
     )
     AND (
       displaced_user.device_token = p_fcm_token
       OR displaced_user.device_token = ANY(displaced_tokens)
     );

  UPDATE public.user_devices AS displaced_device
     SET fcm_token = NULL,
         updated_at = pg_catalog.statement_timestamp()
   WHERE (displaced_device.device_id = p_device_id OR displaced_device.fcm_token = p_fcm_token)
     AND NOT (
       displaced_device.tenant_id = p_tenant_id
       AND displaced_device.user_uid = p_user_uid
       AND displaced_device.device_id = p_device_id
     );

  IF p_require_existing THEN
    RETURN QUERY
    UPDATE public.user_devices AS target_device
       SET fcm_token = p_fcm_token,
           last_active = pg_catalog.statement_timestamp()
     WHERE target_device.tenant_id = p_tenant_id
       AND target_device.user_uid = p_user_uid
       AND target_device.device_id = p_device_id
    RETURNING target_device.id, target_device.device_name, FALSE;
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.user_devices AS target_device (
    tenant_id,
    user_uid,
    device_id,
    device_name,
    platform,
    app_version,
    os_version,
    fcm_token,
    last_active,
    created_at
  )
  VALUES (
    p_tenant_id,
    p_user_uid,
    p_device_id,
    p_device_name,
    p_platform,
    p_app_version,
    p_os_version,
    p_fcm_token,
    pg_catalog.statement_timestamp(),
    pg_catalog.statement_timestamp()
  )
  ON CONFLICT (tenant_id, user_uid, device_id)
  DO UPDATE SET
    device_name = EXCLUDED.device_name,
    platform = EXCLUDED.platform,
    app_version = EXCLUDED.app_version,
    os_version = EXCLUDED.os_version,
    fcm_token = EXCLUDED.fcm_token,
    last_active = pg_catalog.statement_timestamp()
  RETURNING target_device.id, target_device.device_name, NOT target_exists;
END;
$notification_device_handoff$;

DO $notification_device_handoff_owner$
DECLARE
  owner_is_privileged BOOLEAN;
BEGIN
  SELECT role.rolsuper OR role.rolbypassrls
    INTO owner_is_privileged
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_roles AS role ON role.oid = routine.proowner
   WHERE routine.oid = 'public.notification_device_handoff(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN)'::pg_catalog.regprocedure;

  IF NOT COALESCE(owner_is_privileged, FALSE) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'notification_device_handoff owner must be superuser or BYPASSRLS';
  END IF;
END
$notification_device_handoff_owner$;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.notification_device_handoff(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN)
  FROM PUBLIC;

DO $notification_device_handoff_runtime_grants$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[] LOOP
    IF pg_catalog.to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION public.notification_device_handoff(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END
$notification_device_handoff_runtime_grants$;

COMMENT ON FUNCTION public.notification_device_handoff(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BOOLEAN)
  IS 'Claims FCM installation ownership globally after verifying the caller tenant GUC; preserves user-device projection rows.';
