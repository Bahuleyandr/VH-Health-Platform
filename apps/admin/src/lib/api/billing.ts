// src/lib/api/billing.ts
// Billing & Invoicing API functions for the admin portal

import { getJSON, postJSON, putJSON } from "./core";
import type { QueryParams } from "./core";
import { API_ENDPOINTS } from "../api-config";

// ── Types ──────────────────────────────────────────────────────────

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate?: number;
  amount: number;
}

export interface CreateInvoicePayload {
  patient_uid: string;
  appointment_id?: number;
  type: "consultation" | "investigation" | "pharmacy" | "procedure" | "room_charge";
  items: InvoiceLineItem[];
  subtotal: number;
  tax_amount?: number;
  discount_amount?: number;
  total_amount: number;
  payment_method?: string;
  notes?: string;
  due_date?: string;
}

export interface Invoice {
  id: number;
  invoice_number: string;
  patient_uid: string;
  appointment_id: number | null;
  type: string;
  items: InvoiceLineItem[];
  subtotal: string;
  tax_amount: string;
  discount_amount: string;
  total_amount: string;
  paid_amount: string;
  payment_status: string;
  payment_method: string | null;
  insurance_claim_id: number | null;
  notes: string | null;
  issued_by: string | null;
  issued_at: string;
  paid_at: string | null;
  due_date: string | null;
  created_at: string;
}

export interface InvoiceDetail extends Invoice {
  payment_transactions: PaymentTransaction[];
  insurance_claim: InsuranceClaim | null;
}

export interface PaymentTransaction {
  id: number;
  amount: string;
  payment_method: string;
  transaction_ref: string | null;
  status: string;
  processed_by: string | null;
  created_at: string;
}

export interface RecordPaymentPayload {
  amount: number;
  method: "cash" | "card" | "upi" | "insurance" | "cheque";
  transaction_ref?: string;
}

export interface PaymentResult {
  invoice: Invoice;
  transaction: PaymentTransaction;
}

export interface InsuranceClaim {
  id: number;
  claim_number: string;
  patient_uid: string;
  invoice_id: number | null;
  insurance_provider: string;
  policy_number: string;
  claim_amount: string;
  approved_amount: string | null;
  status: string;
  submitted_at: string;
  reviewed_at: string | null;
  rejection_reason: string | null;
  documents: string[];
  created_at: string;
}

export interface SubmitClaimPayload {
  patient_uid: string;
  invoice_id?: number;
  insurance_provider: string;
  policy_number: string;
  claim_amount: number;
  documents?: string[];
}

export interface UpdateClaimPayload {
  status: "submitted" | "under_review" | "approved" | "partially_approved" | "rejected" | "paid";
  approved_amount?: number;
  reason?: string;
}

export interface RevenueSummary {
  total_invoices: string;
  total_billed: string;
  total_collected: string;
  total_outstanding: string;
  total_discounts: string;
  total_taxes: string;
  paid_count: string;
  pending_count: string;
  partial_count: string;
}

export interface RevenueStats {
  summary: RevenueSummary;
  by_type: Array<{
    type: string;
    invoice_count: string;
    total_billed: string;
    total_collected: string;
    outstanding: string;
  }>;
  by_payment_method: Array<{
    payment_method: string;
    transaction_count: string;
    total_amount: string;
  }>;
  daily_totals: Array<{
    date: string;
    invoice_count: string;
    billed: string;
    collected: string;
  }>;
}

export interface ARAgingBucket {
  bucket: "0-30" | "31-60" | "61-90" | "90+";
  invoice_count: number;
  outstanding_amount: number;
}

export interface ARAgingInvoice {
  id: number;
  invoice_number: string;
  patient_uid: string;
  patient_name: string | null;
  type: string;
  payment_status: string;
  total_amount: number;
  paid_amount: number;
  outstanding_amount: number;
  due_date: string | null;
  issued_at: string;
  age_days: number;
}

export interface ARAgingSummary {
  as_of: string;
  overall: {
    invoice_count: number;
    total_outstanding: number;
    oldest_age_days: number;
  };
  buckets: ARAgingBucket[];
  invoices: ARAgingInvoice[];
}

export interface ClaimQueueSummary {
  status: string;
  count: number;
  claim_amount: number;
  payer_balance: number;
}

export interface ClaimQueueItem {
  id: number;
  claim_number: string;
  patient_uid: string;
  patient_name: string | null;
  invoice_id: number | null;
  invoice_number: string | null;
  insurance_provider: string;
  policy_number: string;
  claim_amount: number;
  approved_amount: number | null;
  payer_balance: number;
  status: string;
  submitted_at: string;
  reviewed_at: string | null;
  rejection_reason: string | null;
  days_in_queue: number;
}

export interface ClaimQueueResponse {
  statuses: string[];
  summary: ClaimQueueSummary[];
  claims: ClaimQueueItem[];
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ── API Functions ──────────────────────────────────────────────────

/** Create a new invoice */
export function createInvoice(data: CreateInvoicePayload) {
  return postJSON<Invoice>(API_ENDPOINTS.billing.createInvoice, data);
}

/** Get invoices for a specific patient */
export function getPatientInvoices(
  patientUid: string,
  params?: QueryParams,
) {
  return getJSON<Invoice[]>(
    API_ENDPOINTS.billing.patientInvoices(patientUid),
    params,
  );
}

/** Get full invoice detail with payment history */
export function getInvoiceDetail(invoiceId: number) {
  return getJSON<InvoiceDetail>(
    API_ENDPOINTS.billing.invoiceDetail(invoiceId),
  );
}

/** Record a payment against an invoice */
export function recordPayment(invoiceId: number, data: RecordPaymentPayload) {
  return postJSON<PaymentResult>(
    API_ENDPOINTS.billing.recordPayment(invoiceId),
    data,
  );
}

/** Get revenue statistics for a date range (admin only) */
export function getRevenueStats(dateFrom: string, dateTo: string) {
  return getJSON<RevenueStats>(API_ENDPOINTS.billing.revenue, {
    date_from: dateFrom,
    date_to: dateTo,
  });
}

/** Get open invoice aging buckets and oldest balances */
export function getARAging(params?: QueryParams) {
  return getJSON<ARAgingSummary>(API_ENDPOINTS.billing.revenueCycle.arAging, params);
}

/** Get actionable insurance claims for payer follow-up */
export function getClaimQueue(params?: QueryParams) {
  return getJSON<ClaimQueueResponse>(API_ENDPOINTS.billing.revenueCycle.claimQueue, params);
}

/** Submit an insurance claim */
export function submitInsuranceClaim(data: SubmitClaimPayload) {
  return postJSON<InsuranceClaim>(
    API_ENDPOINTS.billing.insurance.submitClaim,
    data,
  );
}

/** List insurance claims with optional filters */
export function getInsuranceClaims(params?: QueryParams) {
  return getJSON<InsuranceClaim[]>(
    API_ENDPOINTS.billing.insurance.listClaims,
    params,
  );
}

/** Update an insurance claim status */
export function updateInsuranceClaimStatus(
  claimId: number,
  data: UpdateClaimPayload,
) {
  return putJSON<InsuranceClaim>(
    API_ENDPOINTS.billing.insurance.updateClaim(claimId),
    data,
  );
}
