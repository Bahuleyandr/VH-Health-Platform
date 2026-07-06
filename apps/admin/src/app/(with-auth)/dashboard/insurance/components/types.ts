// Shared types for the insurance/TPA admin page.

export interface InsurancePolicy {
  id: number;
  patient_uid: string;
  payer_id: number | null;
  tpa_id: number | null;
  payer_name: string | null;
  tpa_name: string | null;
  policy_number: string;
  member_id: string | null;
  policyholder_name: string | null;
  policy_type: string | null;
  sum_insured: number | string | null;
  cumulative_used: number | string | null;
  valid_from: string | null;
  valid_to: string | null;
  status: "active" | "expired" | "cancelled";
}

export interface Preauth {
  id: number;
  preauth_number: string;
  patient_uid: string;
  policy_number: string;
  payer_name: string | null;
  tpa_name: string | null;
  primary_diagnosis: string;
  expected_cost: number | string;
  sanctioned_amount: number | string | null;
  status:
    | "draft"
    | "submitted"
    | "queried"
    | "approved"
    | "partially_approved"
    | "denied"
    | "cancelled"
    | "lapsed";
  submitted_at: string | null;
  created_at: string;
}

export interface Claim {
  id: number;
  claim_number: string;
  patient_uid: string;
  claim_type: "cashless" | "reimbursement";
  claimed_amount: number | string;
  approved_amount: number | string | null;
  paid_amount: number | string | null;
  submitted_at: string | null;
  status: string;
  aging_bucket: string;
  days_since_submit: number | null;
  policy_number: string | null;
}

export interface PaymentNoticeDiscrepancy {
  code: string;
  severity: "info" | "warning" | "critical" | string;
  message: string;
}

export interface PaymentNoticeReview {
  id: string;
  status: string;
  received_at: string | null;
  processed_at: string | null;
  last_error: string | null;
  hcx_api_call_id: string | null;
  hcx_correlation_id: string | null;
  hcx_workflow_id: string | null;
  participant_code_counterparty: string | null;
  notice: {
    amount: number | string | null;
    currency: string | null;
    payment_reference: string | null;
    paid_at: string | null;
    resource_id: string | null;
    reconciliation_id: string | null;
  };
  claim: {
    id: number;
    claim_number: string | null;
    status: string | null;
    claimed_amount: number | string | null;
    approved_amount: number | string | null;
    paid_amount: number | string | null;
    policy_number: string | null;
    payer_name: string | null;
    tpa_name: string | null;
  } | null;
  settlement_draft: {
    claim_id: number;
    paid_amount: number | string;
    payment_reference: string;
    paid_at: string | null;
    expected_amount: number | string | null;
    short_pay: boolean;
    disallowed_amount_preview: number | string;
  } | null;
  discrepancies: PaymentNoticeDiscrepancy[];
  review_status: string;
  reason: string | null;
}

export const STATUS_COLOURS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  submitted: "bg-blue-100 text-blue-800",
  queried: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  partially_approved: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  denied: "bg-rose-100 text-rose-800",
  cancelled: "bg-slate-200 text-slate-600",
  lapsed: "bg-slate-200 text-slate-600",
  paid: "bg-emerald-200 text-emerald-900",
  prepared: "bg-slate-100 text-slate-700",
  closed: "bg-slate-200 text-slate-600",
};

export function fmtINR(n: number | string | null | undefined): string {
  const num = Number(n ?? 0);
  if (!Number.isFinite(num)) return "₹0";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(num);
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}
