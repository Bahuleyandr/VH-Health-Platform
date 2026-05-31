-- Track the client device class that performed audited actions.
-- Values are minted into JWTs by the login flow as mobile/tablet/desktop/web.

ALTER TABLE public.audit_log
    ADD COLUMN IF NOT EXISTS device_type text;

ALTER TABLE public.hipaa_access_log
    ADD COLUMN IF NOT EXISTS device_type text;

CREATE INDEX IF NOT EXISTS idx_audit_log_device_type_created
    ON public.audit_log (device_type, created_at DESC)
    WHERE device_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_hipaa_access_log_device_type_accessed
    ON public.hipaa_access_log (device_type, accessed_at DESC)
    WHERE device_type IS NOT NULL;
