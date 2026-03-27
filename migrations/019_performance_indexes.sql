-- Performance indexes for scale (100K+ patients)
-- These prevent full table scans on the most common query patterns

-- Appointment queries: status filtering + date ordering
CREATE INDEX IF NOT EXISTS idx_appointments_status_date ON appointments(status, appointment_date DESC);

-- Notification queries: per-user listing + pagination
CREATE INDEX IF NOT EXISTS idx_notifications_phone_created ON notifications(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);

-- Notification outbox: retry job query
CREATE INDEX IF NOT EXISTS idx_notification_outbox_retry ON notification_outbox(status, retry_count, last_attempt_at);

-- Audit log: rate limiting lookups
CREATE INDEX IF NOT EXISTS idx_audit_logs_uid_action_time ON audit_logs(uid, action, created_at DESC);

-- Pharmacy orders: status dashboard + SLA queries
CREATE INDEX IF NOT EXISTS idx_pharmacy_orders_status_created ON pharmacy_orders(status, created_at);

-- Scheduled notifications: pending job processing
CREATE INDEX IF NOT EXISTS idx_scheduled_notif_status_time ON scheduled_notifications(status, send_at);

-- Appointment reminders: reminder job query
CREATE INDEX IF NOT EXISTS idx_appointments_reminder ON appointments(status, appointment_date, reminder_24h_sent);

-- Investigation bookings: queue and SLA queries
CREATE INDEX IF NOT EXISTS idx_investigation_bookings_status ON investigation_bookings(status, created_at);
