-- NL-7 P4 Scope A: association re-confirm TTL can close stale device bindings.

ALTER TABLE device_patient_associations
  DROP CONSTRAINT IF EXISTS device_patient_associations_end_reason_check,
  ADD CONSTRAINT device_patient_associations_end_reason_check CHECK (
    end_reason IS NULL OR end_reason IN (
      'manual',
      'device_reassigned',
      'discharge',
      'transfer',
      'device_retired',
      'ttl_expired'
    )
  );
