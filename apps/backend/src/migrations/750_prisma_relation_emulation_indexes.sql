-- 750_prisma_relation_emulation_indexes.sql
-- Back the two manually curated Prisma relations that do not already have
-- child-key indexes in PostgreSQL.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_doctors_user_id_prisma_relation
  ON doctors (user_id);

CREATE INDEX IF NOT EXISTS idx_investigations_requested_by_prisma_relation
  ON investigations (requested_by);

COMMENT ON INDEX idx_doctors_user_id_prisma_relation IS
  'Supports the curated doctors-to-users Prisma relation without changing the database foreign-key contract.';
COMMENT ON INDEX idx_investigations_requested_by_prisma_relation IS
  'Supports the curated investigations requester Prisma relation without changing the database foreign-key contract.';

COMMIT;
