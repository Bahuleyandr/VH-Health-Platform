// src/lib/api/billing.ts
// Billing & Invoicing API functions for the admin portal

import { getJSON, postJSON, putJSON } from "./core";
import type { QueryParams } from "./core";
import { API_ENDPOINTS } from "../api-config";
import type { ApiData } from "@/lib/openapi-data";

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

export interface RecordPaymentPayload {
  amount: number;
  method: "cash" | "card" | "upi" | "insurance" | "cheque";
  transaction_ref?: string;
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

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

// ── Spec-derived response types (OpenAPI Phase 5) ──────────────────
// Derived from the canonical spec via `ApiData` (the unwrapped `.data`) so they
// can't drift. `Invoice(Detail).items` keeps the typed line shape via
// intersection — the backend stores items as freeform JSON, but the admin owns
// the line shape it writes. Sub-types come from indexed access.
export type Invoice =
  Omit<ApiData<"/api/v1/billing/invoice", "post">, "items"> & { items: InvoiceLineItem[] };
export type InvoiceDetail =
  Omit<ApiData<"/api/v1/billing/invoice/{id}", "get">, "items"> & { items: InvoiceLineItem[] };
export type PaymentTransaction = InvoiceDetail["payment_transactions"][number];
export type PaymentResult = ApiData<"/api/v1/billing/invoice/{id}/payment", "post">;
export type InsuranceClaim = ApiData<"/api/v1/billing/insurance/claim", "post">;
export type RevenueStats = ApiData<"/api/v1/billing/revenue", "get">;
export type RevenueSummary = RevenueStats["summary"];
export type ARAgingSummary = ApiData<"/api/v1/billing/ar-aging", "get">;
export type ARAgingBucket = ARAgingSummary["buckets"][number];
export type ARAgingInvoice = ARAgingSummary["invoices"][number];
export type ClaimQueueResponse = ApiData<"/api/v1/billing/claim-queue", "get">;
export type ClaimQueueSummary = ClaimQueueResponse["summary"][number];
export type ClaimQueueItem = ClaimQueueResponse["claims"][number];

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
