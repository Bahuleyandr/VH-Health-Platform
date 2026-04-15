-- Structured lab results from inbound HL7 ORU^R01 messages. Each OBX segment
-- becomes an entry in this array; LOINC code comes from the observationId
-- field when the sender populates it.

ALTER TABLE investigations
  ADD COLUMN IF NOT EXISTS structured_results JSONB;

CREATE INDEX IF NOT EXISTS idx_investigations_structured
  ON investigations USING GIN (structured_results);
