-- Migration 632: doctors full-text search vector.
--
-- searchDoctors (src/utils/search/searchService.js) queries doctors.search_vector
-- with to_tsquery/@@ on every multi-word search, but no migration ever created
-- the column. Only the standalone setupSearchIndexes.js runtime helper did, and
-- that helper referenced stale column names (specialization/qualification) that
-- no longer exist on doctors, so its multi-statement setup rolled back and the
-- column was never created anywhere. Every ts_query path therefore failed with
-- `column d.search_vector does not exist`; only the short-query ILIKE fallback
-- survived.
--
-- This adds the column as a deterministic, DB-maintained GENERATED STORED
-- tsvector over the real doctors columns (name, specialty, qualifications) --
-- matching the search intent and the ILIKE fallback in searchDoctors -- plus the
-- GIN index that searchDoctors relies on. Idempotent and self-converging: any
-- plain column/trigger a prior helper run may have left behind is dropped first.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

-- Converge from any prior setupSearchIndexes.js artifacts to the canonical
-- GENERATED column. All three are no-ops on a clean DB.
DROP TRIGGER IF EXISTS trg_doctors_search_vector ON public.doctors;
DROP FUNCTION IF EXISTS doctors_search_vector_update();
ALTER TABLE public.doctors DROP COLUMN IF EXISTS search_vector;

ALTER TABLE public.doctors
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
      to_tsvector(
        'english'::regconfig,
        (((COALESCE((name)::text, ''::text) || ' '::text)
          || COALESCE((specialty)::text, ''::text)) || ' '::text)
          || COALESCE(qualifications, ''::text)
      )
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_doctors_search
  ON public.doctors USING GIN (search_vector);

COMMENT ON COLUMN public.doctors.search_vector IS
  'DB-maintained full-text index over name, specialty, qualifications; consumed by searchDoctors.';

COMMIT;
