-- Migration 262: First-class Staff Messaging V2 threads.
--
-- Staff messaging originally persisted one row per sender/recipient message
-- and the Flutter app grouped those rows into conversations. This adds the
-- server-owned thread model, per-participant read/archive/mute controls, and a
-- lightweight attachment metadata table while backfilling existing messages.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_message_threads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  thread_type     VARCHAR(30) NOT NULL DEFAULT 'direct',
  subject         VARCHAR(255),
  patient_uid     UUID,
  admission_id    INTEGER,
  created_by_uid  UUID NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  priority        VARCHAR(20) NOT NULL DEFAULT 'normal',
  last_message_id INTEGER,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_staff_message_threads_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_staff_message_threads_type
    CHECK (thread_type IN ('direct', 'patient_context', 'department', 'team', 'announcement')),
  CONSTRAINT chk_staff_message_threads_status
    CHECK (status IN ('active', 'closed')),
  CONSTRAINT chk_staff_message_threads_priority
    CHECK (priority IN ('normal', 'urgent', 'critical'))
);

CREATE TABLE IF NOT EXISTS staff_message_thread_participants (
  thread_id       UUID NOT NULL,
  participant_uid UUID NOT NULL,
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  last_read_at    TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  muted_until     TIMESTAMPTZ,
  urgent_only     BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, participant_uid),
  CONSTRAINT fk_staff_msg_participants_thread
    FOREIGN KEY (thread_id) REFERENCES staff_message_threads(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_staff_msg_participants_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS staff_message_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  thread_id       UUID NOT NULL,
  message_id      INTEGER,
  uploaded_by_uid UUID NOT NULL,
  file_name       VARCHAR(255) NOT NULL,
  content_type    VARCHAR(120) NOT NULL,
  file_size       INTEGER NOT NULL,
  storage_key     TEXT NOT NULL,
  scan_status     VARCHAR(30) NOT NULL DEFAULT 'pending',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_staff_msg_attachments_thread
    FOREIGN KEY (thread_id) REFERENCES staff_message_threads(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT fk_staff_msg_attachments_message
    FOREIGN KEY (message_id) REFERENCES staff_messages(id) ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT fk_staff_msg_attachments_tenant
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT chk_staff_msg_attachments_scan
    CHECK (scan_status IN ('pending', 'clean', 'quarantined', 'failed'))
);

ALTER TABLE staff_messages
  ADD COLUMN IF NOT EXISTS thread_id UUID;

DROP TABLE IF EXISTS _staff_message_thread_backfill;

CREATE TEMP TABLE _staff_message_thread_backfill ON COMMIT DROP AS
SELECT
  gen_random_uuid() AS thread_id,
  COALESCE(tenant_id, '00000000-0000-4000-8000-000000000001'::uuid) AS tenant_id,
  LEAST(sender_uid, recipient_uid) AS participant_a,
  GREATEST(sender_uid, recipient_uid) AS participant_b,
  patient_uid,
  (ARRAY_AGG(NULLIF(subject, '') ORDER BY created_at ASC NULLS LAST, id ASC)
    FILTER (WHERE NULLIF(subject, '') IS NOT NULL))[1] AS subject,
  (ARRAY_AGG(priority ORDER BY
    CASE priority WHEN 'critical' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END,
    created_at DESC NULLS LAST,
    id DESC
  ))[1] AS priority,
  (ARRAY_AGG(id ORDER BY created_at DESC NULLS LAST, id DESC))[1] AS last_message_id,
  MAX(COALESCE(created_at, NOW())) AS last_message_at,
  (ARRAY_AGG(sender_uid ORDER BY created_at ASC NULLS LAST, id ASC))[1] AS created_by_uid,
  MIN(COALESCE(created_at, NOW())) AS created_at
FROM staff_messages
WHERE thread_id IS NULL
GROUP BY
  COALESCE(tenant_id, '00000000-0000-4000-8000-000000000001'::uuid),
  LEAST(sender_uid, recipient_uid),
  GREATEST(sender_uid, recipient_uid),
  patient_uid;

INSERT INTO staff_message_threads (
  id,
  tenant_id,
  thread_type,
  subject,
  patient_uid,
  created_by_uid,
  priority,
  last_message_id,
  last_message_at,
  created_at,
  updated_at
)
SELECT
  thread_id,
  tenant_id,
  CASE WHEN patient_uid IS NULL THEN 'direct' ELSE 'patient_context' END,
  subject,
  patient_uid,
  created_by_uid,
  COALESCE(priority, 'normal'),
  last_message_id,
  last_message_at,
  created_at,
  last_message_at
FROM _staff_message_thread_backfill
ON CONFLICT (id) DO NOTHING;

INSERT INTO staff_message_thread_participants (thread_id, participant_uid, tenant_id, created_at, updated_at)
SELECT thread_id, participant_a, tenant_id, created_at, created_at
FROM _staff_message_thread_backfill
ON CONFLICT (thread_id, participant_uid) DO NOTHING;

INSERT INTO staff_message_thread_participants (thread_id, participant_uid, tenant_id, created_at, updated_at)
SELECT thread_id, participant_b, tenant_id, created_at, created_at
FROM _staff_message_thread_backfill
ON CONFLICT (thread_id, participant_uid) DO NOTHING;

UPDATE staff_messages m
   SET thread_id = b.thread_id
  FROM _staff_message_thread_backfill b
 WHERE m.thread_id IS NULL
   AND COALESCE(m.tenant_id, '00000000-0000-4000-8000-000000000001'::uuid) = b.tenant_id
   AND LEAST(m.sender_uid, m.recipient_uid) = b.participant_a
   AND GREATEST(m.sender_uid, m.recipient_uid) = b.participant_b
   AND m.patient_uid IS NOT DISTINCT FROM b.patient_uid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_staff_messages_thread'
  ) THEN
    ALTER TABLE staff_messages
      ADD CONSTRAINT fk_staff_messages_thread
      FOREIGN KEY (thread_id) REFERENCES staff_message_threads(id)
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_staff_message_threads_participant_lookup
  ON staff_message_thread_participants (participant_uid, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_message_threads_tenant_last_message
  ON staff_message_threads (tenant_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_message_threads_patient
  ON staff_message_threads (patient_uid) WHERE patient_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_message_threads_admission
  ON staff_message_threads (admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_messages_thread
  ON staff_messages (thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_staff_msg_attachments_thread
  ON staff_message_attachments (thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_msg_attachments_message
  ON staff_message_attachments (message_id) WHERE message_id IS NOT NULL;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'staff_message_threads',
    'staff_message_thread_participants',
    'staff_message_attachments'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
    $f$, t);
  END LOOP;
END
$$;

INSERT INTO audit_logs (action, resource, resource_id, metadata, created_at)
SELECT
  'STAFF_MESSAGE_THREADS_APPLIED',
  'staff_message_threads',
  'staff_message_threads',
  jsonb_build_object(
    'migration', '262_staff_message_threads.sql',
    'reason', 'Staff Messaging V2: thread IDs, participant state, notification controls, attachment metadata, and backfilled direct conversations.'
  ),
  NOW()
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'audit_logs'
)
AND NOT EXISTS (
  SELECT 1 FROM audit_logs
  WHERE action = 'STAFF_MESSAGE_THREADS_APPLIED'
    AND resource = 'staff_message_threads'
);

COMMIT;
