-- Migration 261: Backfill first-class appointment queues for existing OP rows.
--
-- Migration 260 creates the appointment_queues substrate and future code links
-- new appointments at write time. This migration gives existing scheduled,
-- confirmed, in-progress, and completed appointments a queue_id so the Front
-- Office Workbench and Doctor queue calendar can consume one queue model.

BEGIN;

WITH appointment_context AS (
  SELECT DISTINCT
    a.tenant_id,
    a.appointment_date::date AS queue_date,
    CASE
      WHEN UPPER(COALESCE(a.visit_type, '')) = 'EMERGENCY'
        OR UPPER(COALESCE(a.department, doc_dept.name, doc.department, '')) ~ '(^|[^A-Z0-9])(ER|EMERGENCY|CASUALTY)([^A-Z0-9]|$)'
        THEN 'emergency'
      WHEN LOWER(COALESCE(a.appointment_time, '')) IN ('walk-in', 'walk in')
        THEN 'walk_in'
      WHEN a.doctor_id IS NOT NULL
        THEN 'doctor'
      WHEN COALESCE(a.department, doc_dept.name, doc.department) IS NOT NULL
        THEN 'department'
      ELSE 'op'
    END AS queue_kind,
    dept.id AS department_id,
    COALESCE(dept.name, a.department, doc_dept.name, doc.department) AS department_name,
    a.doctor_id,
    doc_user.uid AS doctor_uid,
    LEFT(
      CONCAT_WS(
        ' - ',
        NULLIF(doc_user.name, ''),
        NULLIF(COALESCE(dept.name, a.department, doc_dept.name, doc.department), ''),
        CASE
          WHEN LOWER(COALESCE(a.appointment_time, '')) IN ('walk-in', 'walk in') THEN 'Walk-in'
          WHEN UPPER(COALESCE(a.visit_type, '')) = 'EMERGENCY' THEN 'Emergency'
          ELSE NULL
        END
      ),
      255
    ) AS queue_label
  FROM appointments a
  LEFT JOIN users doc_user ON doc_user.id = a.doctor_id
  LEFT JOIN doctors doc ON doc.user_id = a.doctor_id
  LEFT JOIN departments doc_dept ON doc_dept.id = doc.department_id
  LEFT JOIN departments dept
    ON LOWER(dept.name) = LOWER(COALESCE(NULLIF(a.department, ''), doc_dept.name, doc.department, ''))
  WHERE a.queue_id IS NULL
    AND COALESCE(a.status, '') NOT IN ('CANCELLED', 'NO_SHOW')
    AND a.appointment_date IS NOT NULL
),
missing_queues AS (
  SELECT c.*
  FROM appointment_context c
  WHERE NOT EXISTS (
    SELECT 1
    FROM appointment_queues q
    WHERE q.tenant_id = c.tenant_id
      AND q.queue_date = c.queue_date
      AND q.queue_kind = c.queue_kind
      AND COALESCE(q.facility_id, 0) = 0
      AND COALESCE(q.department_id, 0) = COALESCE(c.department_id, 0)
      AND COALESCE(q.doctor_id, 0) = COALESCE(c.doctor_id, 0)
      AND q.status IN ('draft', 'open', 'paused')
  )
),
deduped_missing_queues AS (
  SELECT DISTINCT ON (
    tenant_id,
    queue_date,
    queue_kind,
    COALESCE(department_id, 0),
    COALESCE(doctor_id, 0)
  )
    *
  FROM missing_queues
  ORDER BY
    tenant_id,
    queue_date,
    queue_kind,
    COALESCE(department_id, 0),
    COALESCE(doctor_id, 0),
    NULLIF(queue_label, '') NULLS LAST
)
INSERT INTO appointment_queues (
  tenant_id, queue_date, queue_kind, department_id, department_name,
  doctor_id, doctor_uid, queue_label, status, metadata,
  created_at, updated_at
)
SELECT
  tenant_id,
  queue_date,
  queue_kind,
  department_id,
  LEFT(department_name, 120),
  doctor_id,
  doctor_uid,
  COALESCE(NULLIF(queue_label, ''), 'OP Queue'),
  'open',
  jsonb_build_object('source', 'migration_261_backfill'),
  NOW(),
  NOW()
FROM deduped_missing_queues
ON CONFLICT DO NOTHING;

WITH appointment_context AS (
  SELECT
    a.id AS appointment_id,
    a.tenant_id,
    a.appointment_date::date AS queue_date,
    CASE
      WHEN UPPER(COALESCE(a.visit_type, '')) = 'EMERGENCY'
        OR UPPER(COALESCE(a.department, doc_dept.name, doc.department, '')) ~ '(^|[^A-Z0-9])(ER|EMERGENCY|CASUALTY)([^A-Z0-9]|$)'
        THEN 'emergency'
      WHEN LOWER(COALESCE(a.appointment_time, '')) IN ('walk-in', 'walk in')
        THEN 'walk_in'
      WHEN a.doctor_id IS NOT NULL
        THEN 'doctor'
      WHEN COALESCE(a.department, doc_dept.name, doc.department) IS NOT NULL
        THEN 'department'
      ELSE 'op'
    END AS queue_kind,
    dept.id AS department_id,
    a.doctor_id
  FROM appointments a
  LEFT JOIN doctors doc ON doc.user_id = a.doctor_id
  LEFT JOIN departments doc_dept ON doc_dept.id = doc.department_id
  LEFT JOIN departments dept
    ON LOWER(dept.name) = LOWER(COALESCE(NULLIF(a.department, ''), doc_dept.name, doc.department, ''))
  WHERE a.queue_id IS NULL
    AND COALESCE(a.status, '') NOT IN ('CANCELLED', 'NO_SHOW')
    AND a.appointment_date IS NOT NULL
),
matched_queues AS (
  SELECT c.appointment_id, q.id AS queue_id
  FROM appointment_context c
  JOIN appointment_queues q
    ON q.tenant_id = c.tenant_id
   AND q.queue_date = c.queue_date
   AND q.queue_kind = c.queue_kind
   AND COALESCE(q.facility_id, 0) = 0
   AND COALESCE(q.department_id, 0) = COALESCE(c.department_id, 0)
   AND COALESCE(q.doctor_id, 0) = COALESCE(c.doctor_id, 0)
   AND q.status IN ('draft', 'open', 'paused')
)
UPDATE appointments a
   SET queue_id = m.queue_id,
       updated_at = NOW()
  FROM matched_queues m
 WHERE a.id = m.appointment_id
   AND a.queue_id IS NULL;

INSERT INTO appointment_queue_status_history (
  tenant_id, appointment_queue_id, from_status, to_status,
  reason, metadata, created_at, updated_at
)
SELECT
  q.tenant_id,
  q.id,
  NULL,
  q.status,
  'Backfilled from existing appointments',
  jsonb_build_object('source', 'migration_261_backfill'),
  NOW(),
  NOW()
FROM appointment_queues q
WHERE q.metadata->>'source' = 'migration_261_backfill'
  AND NOT EXISTS (
    SELECT 1
    FROM appointment_queue_status_history h
    WHERE h.appointment_queue_id = q.id
  );

COMMIT;
