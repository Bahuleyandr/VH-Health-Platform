-- Migration 025: SOS services tables + Prisma alignment support
-- Fixes final cross-repo audit issue (2026-04-04)

-- ===================================================================
-- 1. emergency_services / sos_services
--    admin SOS service tries emergency_services first, then sos_services
--    Neither existed in DB. Create both with same shape for compatibility.
-- ===================================================================
CREATE TABLE IF NOT EXISTS emergency_services (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  phone      VARCHAR(20),
  type       VARCHAR(50) DEFAULT 'hospital',
  address    TEXT,
  latitude   DOUBLE PRECISION,
  longitude  DOUBLE PRECISION,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sos_services (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  phone      VARCHAR(20),
  type       VARCHAR(50) DEFAULT 'hospital',
  address    TEXT,
  latitude   DOUBLE PRECISION,
  longitude  DOUBLE PRECISION,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_emergency_services_name ON emergency_services(name);
CREATE INDEX IF NOT EXISTS idx_sos_services_name ON sos_services(name);

-- Backfill from hospitals where emergency_services=true (idempotent by name+phone)
INSERT INTO emergency_services (name, phone, type, address, latitude, longitude)
SELECT h.name, h.phone, 'hospital', h.address, h.latitude, h.longitude
FROM hospitals h
WHERE COALESCE(h.emergency_services, false) = true
  AND NOT EXISTS (
    SELECT 1 FROM emergency_services es
    WHERE es.name = h.name AND COALESCE(es.phone, '') = COALESCE(h.phone, '')
  );

INSERT INTO sos_services (name, phone, type, address, latitude, longitude)
SELECT h.name, h.phone, 'hospital', h.address, h.latitude, h.longitude
FROM hospitals h
WHERE COALESCE(h.emergency_services, false) = true
  AND NOT EXISTS (
    SELECT 1 FROM sos_services ss
    WHERE ss.name = h.name AND COALESCE(ss.phone, '') = COALESCE(h.phone, '')
  );
