-- Migration 104: scheduled_notifications.
--
-- The appointment "complete" workflow schedules a feedback request 2
-- hours after completion (see appointmentWorkflowController:197). A
-- cron job in appointmentReminderJob.processPendingScheduledNotifications
-- runs every 5 minutes to deliver them. The table the job reads/writes
-- never existed, so:
--   • Every appointment completion silently fails to schedule the
--     follow-up feedback request (try/catch warn-only)
--   • The cron logs an empty error every 5 minutes (the err.message
--     was being swallowed by the winston multi-arg call format)
--
-- This adds the table with the columns both call sites expect, plus
-- an index on (status, send_at) so the cron's ORDER BY + WHERE pair
-- can be served from an index even with millions of rows.

BEGIN;

CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  type        VARCHAR(64) NOT NULL,
  data        JSONB,
  send_at     TIMESTAMP WITH TIME ZONE NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  sent_at     TIMESTAMP WITH TIME ZONE,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT scheduled_notifications_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_pending_due
  ON scheduled_notifications(send_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_user
  ON scheduled_notifications(user_id, status);

COMMIT;
