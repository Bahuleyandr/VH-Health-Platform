-- The original 155 domain includes discharged_undelivered (22 characters),
-- but the baseline column holds only 20. Migration 801 restores that domain;
-- this forward repair makes its existing valid value representable.
-- Preserve historical values, CHECK validation states and wider lineages.
-- This changes storage capacity, not clinical transition authority.

BEGIN;

DO $$
DECLARE
  status_type REGTYPE;
  status_typmod INTEGER;
BEGIN
  SELECT atttypid::regtype, atttypmod INTO STRICT status_type, status_typmod
    FROM pg_attribute
   WHERE attrelid = 'public.maternity_labor_admissions'::regclass
     AND attname = 'status' AND attnum > 0 AND NOT attisdropped;

  IF status_type = 'character varying'::regtype AND status_typmod BETWEEN 5 AND 25 THEN
    ALTER TABLE public.maternity_labor_admissions ALTER COLUMN status TYPE VARCHAR(22);
  ELSIF status_type NOT IN ('character varying'::regtype, 'text'::regtype) THEN
    RAISE EXCEPTION 'Migration 802: unsupported maternity labor status type %, operator review required', status_type;
  END IF;
END
$$;

COMMIT;
