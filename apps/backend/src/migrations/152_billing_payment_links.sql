-- Migration 152: Billing payment links + UPI deep-link tracking (Sprint 4).
--
-- Bill payment in Indian hospitals goes one of three ways:
--
--   1) UPI deep link — patient scans the QR or taps a link, app opens
--      PhonePe/GPay/Paytm prefilled, they tap pay. Hospital reconciles
--      manually (the cashier marks the payment received). Cheap, no
--      gateway fees, ubiquitous.
--   2) Payment gateway link (Razorpay/Cashfree/PayU) — fully automated
--      reconciliation via webhook. Real fees (≈2%); requires a gateway
--      account.
--   3) Cash / card at counter — captured directly by billing_payments.
--
-- This migration adds the link table that tracks #1 and #2; the row
-- carries a UPI deep-link string regardless of provider so the WhatsApp
-- + SMS notification fan-out always has something to send. Manual
-- reconciliation marks the link "paid" and creates a billing_payments
-- row through the existing service.

BEGIN;

CREATE TABLE IF NOT EXISTS billing_payment_links (
  id                  SERIAL PRIMARY KEY,
  link_token          VARCHAR(64) UNIQUE NOT NULL,    -- public, opaque; goes in the URL
  invoice_id          INTEGER REFERENCES billing_invoices(id) ON DELETE SET NULL,
  patient_uid         UUID NOT NULL,
  amount              NUMERIC(12, 2) NOT NULL,
  currency            VARCHAR(3) NOT NULL DEFAULT 'INR',
  -- UPI-specific fields used to build the upi://pay?... deep link.
  upi_payee_vpa       VARCHAR(100),                   -- hospital's VPA (e.g. hospital@upi)
  upi_payee_name      VARCHAR(100),                   -- displayed in UPI app
  upi_transaction_ref VARCHAR(100),                   -- our reference; goes into the tn= param
  upi_deep_link       TEXT,                           -- pre-built upi://pay?...
  -- Optional gateway provider (razorpay/cashfree/payu/etc.). Provider-
  -- generated invoice id + URL stored when the gateway is involved.
  provider            VARCHAR(20) DEFAULT 'upi_intent',
  provider_invoice_id VARCHAR(100),
  provider_payment_url TEXT,
  -- Status walk: created -> sent -> paid / expired / cancelled
  status              VARCHAR(20) NOT NULL DEFAULT 'created',
  expires_at          TIMESTAMPTZ,                    -- typical 24-48h
  notes               TEXT,
  -- Linked to a payment row when reconciled
  linked_payment_id   INTEGER REFERENCES billing_payments(id) ON DELETE SET NULL,
  paid_at             TIMESTAMPTZ,
  paid_via            VARCHAR(20),                    -- upi / card / netbanking / wallet / other
  paid_reference      VARCHAR(100),                   -- UPI ref / gateway txn id
  cancelled_at        TIMESTAMPTZ,
  -- Communication audit
  sent_via_whatsapp_at TIMESTAMPTZ,
  sent_via_sms_at     TIMESTAMPTZ,
  sent_via_email_at   TIMESTAMPTZ,
  created_by          UUID,
  tenant_id           UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_links_invoice ON billing_payment_links(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_links_patient ON billing_payment_links(patient_uid);
CREATE INDEX IF NOT EXISTS idx_payment_links_status ON billing_payment_links(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_links_expires ON billing_payment_links(expires_at) WHERE status IN ('created', 'sent');

COMMIT;
