-- Delivery tracking for pharmacy orders
ALTER TABLE pharmacy_orders
  ADD COLUMN IF NOT EXISTS estimated_delivery_mins INTEGER,
  ADD COLUMN IF NOT EXISTS delivery_started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS delivery_tracking_active BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delivery_distance_km NUMERIC(6,2);

-- Delivery tracking for investigation bookings (home collection)
ALTER TABLE investigation_bookings
  ADD COLUMN IF NOT EXISTS estimated_collection_mins INTEGER,
  ADD COLUMN IF NOT EXISTS collector_lat NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS collector_lng NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS collection_tracking_active BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS collection_distance_km NUMERIC(6,2);

-- Delivery location history (for both pharmacy and investigation)
CREATE TABLE IF NOT EXISTS delivery_location_updates (
  id SERIAL PRIMARY KEY,
  order_type VARCHAR(20) NOT NULL,  -- 'pharmacy' | 'investigation'
  order_id INTEGER NOT NULL,
  delivery_person_id INTEGER REFERENCES users(id),
  lat NUMERIC(10,7) NOT NULL,
  lng NUMERIC(10,7) NOT NULL,
  accuracy NUMERIC(6,2),
  speed NUMERIC(6,2),
  heading NUMERIC(6,2),
  battery_level INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_loc_order ON delivery_location_updates(order_type, order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_loc_time ON delivery_location_updates(created_at);
