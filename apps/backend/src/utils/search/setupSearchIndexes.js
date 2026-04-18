// src/utils/search/setupSearchIndexes.js
// Idempotent full-text search setup for PostgreSQL

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const SETUP_SQL = `
-- =============================================
-- Users search vector
-- =============================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_users_search ON users USING GIN(search_vector);

UPDATE users SET search_vector =
  to_tsvector('english', coalesce(name, '') || ' ' || coalesce(phone, '') || ' ' || coalesce(email, ''))
WHERE search_vector IS NULL;

-- Trigger function for users
CREATE OR REPLACE FUNCTION users_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    coalesce(NEW.name, '') || ' ' || coalesce(NEW.phone, '') || ' ' || coalesce(NEW.email, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_search_vector ON users;
CREATE TRIGGER trg_users_search_vector
  BEFORE INSERT OR UPDATE OF name, phone, email ON users
  FOR EACH ROW EXECUTE FUNCTION users_search_vector_update();

-- =============================================
-- Doctors search vector
-- =============================================
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_doctors_search ON doctors USING GIN(search_vector);

UPDATE doctors SET search_vector =
  to_tsvector('english',
    coalesce(name, '') || ' ' || coalesce(specialization, '') || ' ' || coalesce(qualification, ''))
WHERE search_vector IS NULL;

CREATE OR REPLACE FUNCTION doctors_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    coalesce(NEW.name, '') || ' ' || coalesce(NEW.specialization, '') || ' ' || coalesce(NEW.qualification, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_doctors_search_vector ON doctors;
CREATE TRIGGER trg_doctors_search_vector
  BEFORE INSERT OR UPDATE OF name, specialization, qualification ON doctors
  FOR EACH ROW EXECUTE FUNCTION doctors_search_vector_update();

-- =============================================
-- Appointments expression index (no stored column needed)
-- =============================================
CREATE INDEX IF NOT EXISTS idx_appointments_search
  ON appointments USING GIN(to_tsvector('english', coalesce(reason, '') || ' ' || coalesce(notes, '')));
`;

export async function setupSearchIndexes() {
  try {
    logger.info('🔍 Setting up full-text search indexes...');
    await prisma.$queryRawUnsafe(SETUP_SQL);
    logger.info('✅ Full-text search indexes created successfully');
    return true;
  } catch (err) {
    logger.error('❌ Failed to set up search indexes:', err.message);
    // Non-fatal — app can still work with ILIKE fallback
    return false;
  }
}

// Allow running directly: node src/utils/search/setupSearchIndexes.js
if (process.argv[1]?.endsWith('setupSearchIndexes.js')) {
  import('dotenv').then(d => d.config());
  setupSearchIndexes().then(() => process.exit(0)).catch(() => process.exit(1));
}
