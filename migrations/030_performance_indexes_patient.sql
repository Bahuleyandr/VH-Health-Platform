-- 030_performance_indexes_patient.sql
-- Composite indexes for common patient-facing query patterns

-- Pharmacy orders: patient list with status filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pharmacy_orders_patient_status
  ON pharmacy_orders (patient_id, status, created_at DESC);

-- Investigations: patient list with status filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_investigation_bookings_patient_status
  ON investigation_bookings (patient_id, status, created_at DESC);

-- Appointments: doctor schedule views
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_appointments_doctor_date
  ON appointments (doctor_id, appointment_date, status);

-- Notifications: mark-all-read and patient list
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_phone_read
  ON notifications (phone, read, created_at DESC);

-- Patient vitals: by patient and date
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_patient_vitals_uid_date
  ON patient_vitals (patient_uid, recorded_at DESC);
