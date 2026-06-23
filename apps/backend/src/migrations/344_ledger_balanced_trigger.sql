-- 344_ledger_balanced_trigger.sql
-- Invariant 1 (§4.1): every journal entry's signed postings sum to ZERO.
-- DEFERRABLE INITIALLY DEFERRED so the check runs at COMMIT, after all of an
-- entry's posting lines have been inserted within the transaction.
CREATE OR REPLACE FUNCTION ledger_assert_entry_balanced() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_sum BIGINT;
BEGIN
  SELECT COALESCE(SUM(amount_paise), 0) INTO v_sum
    FROM ledger_postings WHERE entry_id = NEW.entry_id;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'ledger entry % is unbalanced: postings sum to % paise (must be 0)', NEW.entry_id, v_sum
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ledger_postings_balanced ON ledger_postings;
CREATE CONSTRAINT TRIGGER ledger_postings_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_entry_balanced();
