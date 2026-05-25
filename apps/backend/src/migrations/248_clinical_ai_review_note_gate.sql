-- Clinical AI rollout governance: require an explicit human reviewer note
-- before shared clinical_ai_reviews rows can be accepted/signed/edited.

ALTER TABLE clinical_ai_reviews
  ADD COLUMN IF NOT EXISTS reviewer_note TEXT;

COMMENT ON COLUMN clinical_ai_reviews.reviewer_note IS
  'Human reviewer note captured when a Clinical AI draft is accepted, signed, approved, edited, rejected, or otherwise reviewed.';
