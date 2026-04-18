-- Billing tables: invoices, payment_transactions, insurance_claims

CREATE TABLE IF NOT EXISTS "invoices" (
  "id"                  SERIAL PRIMARY KEY,
  "invoice_number"      VARCHAR(30)    NOT NULL UNIQUE,
  "patient_uid"         UUID           NOT NULL,
  "appointment_id"      INTEGER,
  "type"                VARCHAR(50)    NOT NULL,
  "items"               JSONB          NOT NULL,
  "subtotal"            DECIMAL(10, 2) NOT NULL,
  "tax_amount"          DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "discount_amount"     DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "total_amount"        DECIMAL(10, 2) NOT NULL,
  "paid_amount"         DECIMAL(10, 2) NOT NULL DEFAULT 0,
  "payment_status"      VARCHAR(50)    NOT NULL DEFAULT 'pending',
  "payment_method"      VARCHAR(50),
  "insurance_claim_id"  INTEGER,
  "notes"               TEXT,
  "issued_by"           UUID,
  "issued_at"           TIMESTAMP(6)   NOT NULL DEFAULT NOW(),
  "paid_at"             TIMESTAMP(6),
  "due_date"            DATE,
  "created_at"          TIMESTAMP(6)   NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMP(6)   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "invoices_patient_uid_idx"     ON "invoices" ("patient_uid");
CREATE INDEX IF NOT EXISTS "invoices_invoice_number_idx"  ON "invoices" ("invoice_number");
CREATE INDEX IF NOT EXISTS "invoices_payment_status_idx"  ON "invoices" ("payment_status");
CREATE INDEX IF NOT EXISTS "invoices_type_idx"            ON "invoices" ("type");
CREATE INDEX IF NOT EXISTS "invoices_issued_at_idx"       ON "invoices" ("issued_at");

CREATE TABLE IF NOT EXISTS "payment_transactions" (
  "id"              SERIAL PRIMARY KEY,
  "invoice_id"      INTEGER,
  "amount"          DECIMAL(10, 2) NOT NULL,
  "payment_method"  VARCHAR(50)    NOT NULL,
  "transaction_ref" VARCHAR(255),
  "status"          VARCHAR(50)    NOT NULL DEFAULT 'completed',
  "processed_by"    UUID,
  "created_at"      TIMESTAMP(6)   NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_payment_transactions_invoice"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices" ("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "payment_transactions_invoice_id_idx" ON "payment_transactions" ("invoice_id");
CREATE INDEX IF NOT EXISTS "payment_transactions_created_at_idx" ON "payment_transactions" ("created_at");

CREATE TABLE IF NOT EXISTS "insurance_claims" (
  "id"                 SERIAL PRIMARY KEY,
  "claim_number"       VARCHAR(30)    NOT NULL UNIQUE,
  "patient_uid"        UUID           NOT NULL,
  "invoice_id"         INTEGER,
  "insurance_provider" VARCHAR(255)   NOT NULL,
  "policy_number"      VARCHAR(100)   NOT NULL,
  "claim_amount"       DECIMAL(10, 2) NOT NULL,
  "approved_amount"    DECIMAL(10, 2),
  "status"             VARCHAR(50)    NOT NULL DEFAULT 'submitted',
  "documents"          JSONB,
  "submitted_at"       TIMESTAMP(6)   NOT NULL DEFAULT NOW(),
  "reviewed_at"        TIMESTAMP(6),
  "rejection_reason"   TEXT,
  "created_at"         TIMESTAMP(6)   NOT NULL DEFAULT NOW(),
  "updated_at"         TIMESTAMP(6)   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "insurance_claims_patient_uid_idx" ON "insurance_claims" ("patient_uid");
CREATE INDEX IF NOT EXISTS "insurance_claims_status_idx"      ON "insurance_claims" ("status");
CREATE INDEX IF NOT EXISTS "insurance_claims_submitted_at_idx" ON "insurance_claims" ("submitted_at");
