-- Revenue cycle foundations.
--
-- (a) icd_cpt_map — diagnosis → billable procedure + default charge.
--     Seeded with a small set of common codes; admin portal will expand.
-- (b) claim_denials — records of insurance denials with reason code + appeal status.
--     Upstream of full 837 EDI generation (that plumbing is a separate follow-up).

CREATE TABLE IF NOT EXISTS icd_cpt_map (
  id           SERIAL PRIMARY KEY,
  icd10_code   VARCHAR(10)  NOT NULL,
  cpt_code     VARCHAR(10)  NOT NULL,
  description  TEXT,
  default_charge NUMERIC(10,2) NOT NULL DEFAULT 0,
  UNIQUE (icd10_code, cpt_code)
);

CREATE INDEX IF NOT EXISTS idx_icdcpt_icd ON icd_cpt_map(icd10_code);

INSERT INTO icd_cpt_map (icd10_code, cpt_code, description, default_charge) VALUES
  ('I10',   '99213', 'Essential hypertension — outpatient eval, moderate',        500.00),
  ('E11.9', '99214', 'Type 2 diabetes — outpatient eval, established',            750.00),
  ('J45.9', '94640', 'Asthma — nebulizer treatment',                              400.00),
  ('K21.0', '99212', 'GERD — outpatient eval, brief',                             350.00),
  ('M54.5', '97110', 'Low back pain — therapeutic exercise',                      600.00),
  ('R51',   '99213', 'Headache — outpatient eval',                                500.00),
  ('N39.0', '87086', 'UTI — urine culture',                                       300.00),
  ('J06.9', '99213', 'Upper respiratory infection — outpatient eval',             500.00)
ON CONFLICT (icd10_code, cpt_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS claim_denials (
  id             SERIAL PRIMARY KEY,
  invoice_id     INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  patient_uid    UUID,
  payer          VARCHAR(255),
  reason_code    VARCHAR(30),
  reason_text    TEXT,
  denied_amount  NUMERIC(10,2),
  appealed       BOOLEAN NOT NULL DEFAULT false,
  appeal_outcome VARCHAR(30),
  denied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_denials_denied_at ON claim_denials(denied_at DESC);
CREATE INDEX IF NOT EXISTS idx_claim_denials_reason    ON claim_denials(reason_code);
