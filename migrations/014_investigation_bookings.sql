-- Patient-initiated investigation bookings (separate from doctor-ordered investigations)
CREATE TABLE IF NOT EXISTS investigation_bookings (
  id SERIAL PRIMARY KEY,
  booking_number VARCHAR(30) UNIQUE,  -- auto: INV-2026-XXXX
  patient_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  patient_phone VARCHAR(20),
  patient_name VARCHAR(255),

  -- What they want tested
  selected_tests INTEGER[],  -- FK refs to investigation_test_catalog.id
  custom_test_names TEXT,  -- free-text if patient types test names
  slip_photo_key TEXT,  -- R2 key for uploaded prescription/slip photo
  slip_photo_url TEXT,  -- signed URL (regenerated on demand)
  notes TEXT,  -- patient notes

  -- Collection preference
  collection_type VARCHAR(20) NOT NULL DEFAULT 'home',  -- 'home' | 'walk_in'
  collection_address TEXT,  -- for home collection
  collection_landmark TEXT,
  collection_lat NUMERIC(10,7),
  collection_lng NUMERIC(10,7),
  preferred_date DATE,
  preferred_time_slot VARCHAR(30),  -- e.g. '09:00-12:00', '12:00-15:00', '15:00-18:00'

  -- Cost
  estimated_cost NUMERIC(10,2),  -- sum of selected test costs from catalog
  final_cost NUMERIC(10,2),  -- staff can adjust after confirming actual tests

  -- Lifecycle: BOOKED → CONFIRMED → DISPATCHED → COLLECTED → PROCESSING → RESULT_READY → DELIVERED
  status VARCHAR(20) DEFAULT 'BOOKED',

  -- Staff workflow
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TIMESTAMP,
  confirmation_notes TEXT,
  actual_tests TEXT,  -- staff transcribes from slip photo / confirms selected tests

  -- Dispatch & collection
  assigned_collector INTEGER REFERENCES users(id),
  dispatched_at TIMESTAMP,
  collector_phone VARCHAR(20),
  collection_otp VARCHAR(6),  -- optional: verify patient identity

  collected_at TIMESTAMP,
  collected_by INTEGER REFERENCES users(id),
  collection_notes TEXT,

  -- Processing
  processing_started_at TIMESTAMP,

  -- Results
  result_uploaded_at TIMESTAMP,
  result_uploaded_by INTEGER REFERENCES users(id),
  result_file_key TEXT,  -- R2 key for result PDF
  result_file_url TEXT,
  result_notes TEXT,

  -- Delivery
  delivered_at TIMESTAMP,  -- when patient acknowledged / downloaded
  patient_notified_at TIMESTAMP,

  -- SLA tracking
  sla_confirm_target TIMESTAMP,  -- booked_at + 30 min
  sla_dispatch_target TIMESTAMP,  -- confirmed_at + 1 hour
  sla_collect_target TIMESTAMP,  -- dispatched_at + based on location
  sla_result_target TIMESTAMP,  -- collected_at + turnaround_target_hours

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Status history for full audit trail
CREATE TABLE IF NOT EXISTS investigation_booking_history (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER REFERENCES investigation_bookings(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_by_role VARCHAR(30),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Auto-number trigger for booking_number
CREATE OR REPLACE FUNCTION generate_inv_booking_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(booking_number FROM 10) AS INTEGER)), 0) + 1
  INTO next_num
  FROM investigation_bookings
  WHERE booking_number LIKE 'INV-' || EXTRACT(YEAR FROM NOW()) || '-%';

  NEW.booking_number := 'INV-' || EXTRACT(YEAR FROM NOW()) || '-' || LPAD(next_num::TEXT, 4, '0');
  NEW.sla_confirm_target := NEW.created_at + INTERVAL '30 minutes';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inv_booking_number ON investigation_bookings;
CREATE TRIGGER trg_inv_booking_number
  BEFORE INSERT ON investigation_bookings
  FOR EACH ROW
  WHEN (NEW.booking_number IS NULL)
  EXECUTE FUNCTION generate_inv_booking_number();

-- Add home_collection_fee to test catalog
ALTER TABLE investigation_test_catalog
  ADD COLUMN IF NOT EXISTS home_collection_surcharge NUMERIC(10,2) DEFAULT 50.00;

CREATE INDEX IF NOT EXISTS idx_inv_bookings_status ON investigation_bookings(status);
CREATE INDEX IF NOT EXISTS idx_inv_bookings_patient ON investigation_bookings(patient_id);
CREATE INDEX IF NOT EXISTS idx_inv_bookings_collector ON investigation_bookings(assigned_collector);
CREATE INDEX IF NOT EXISTS idx_inv_booking_hist ON investigation_booking_history(booking_id);
