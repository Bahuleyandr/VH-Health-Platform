-- Migration 012: Appointment improvements — reminders, walk-in, feedback scheduling

-- Add reminder tracking columns to appointments
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reminder_1h_sent BOOLEAN DEFAULT FALSE;

-- Scheduled notifications (for deferred push notifications like post-visit feedback)
CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  data JSONB,
  send_at TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_notif ON scheduled_notifications(send_at, status);
CREATE INDEX IF NOT EXISTS idx_sched_notif_user ON scheduled_notifications(user_id);
