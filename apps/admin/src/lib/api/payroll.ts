// src/lib/api/payroll.ts
import { assertIdempotencyKey } from "../idempotencyKey";
import { getJSON, postJSON, QueryParams } from "./core";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PayrollRun {
  id: number;
  month: number;
  year: number;
  status:
    | "draft"
    | "processing"
    | "completed"
    | "completed_with_errors"
    | "approved"
    | "locked";
  total_staff: number;
  /** Staff whose payslip calculation failed in this run; > 0 implies completed_with_errors. */
  failed_staff_count: number;
  /**
   * Identity (uid + name) of each staff member whose payslip failed — shown to
   * the signer before they acknowledge a completed_with_errors run. The
   * backend never returns the internal failure reason text.
   */
  failed_staff_summary?: Array<{ staff_uid: string; name: string | null }>;
  total_gross: string;
  total_net: string;
  total_deductions: string;
  generated_by: string | null;
  generated_by_name: string | null;
  generated_at: string | null;
  locked_at: string | null;
  notes: string | null;
  created_at: string;
  // Dual sign fields
  hr_approved_by: string | null;
  hr_approved_at: string | null;
  hr_comment: string | null;
  admin_approved_by: string | null;
  admin_approved_at: string | null;
  admin_comment: string | null;
  approval_hash: string | null;
}

export interface Payslip {
  id: number;
  payroll_run_id: number;
  staff_uid: string;
  staff_name?: string;
  department?: string;
  role?: string;
  month: number;
  year: number;
  total_working_days: number;
  days_present: number;
  days_absent: number;
  days_leave: number;
  overtime_hours: string;
  overtime_rate: string;
  basic_earned: string;
  hra_earned: string;
  da_earned: string;
  special_allowance_earned: string;
  transport_allowance_earned: string;
  medical_allowance_earned: string;
  overtime_pay: string;
  bonus_this_month: string;
  gross_salary: string;
  pf_employee: string;
  esi_employee: string;
  professional_tax: string;
  tds: string;
  total_deductions: string;
  net_salary: string;
  pdf_key: string | null;
  status: "draft" | "issued" | "viewed" | "downloaded";
  issued_at: string | null;
}

export interface StaffSalaryConfig {
  id?: number;
  staff_uid: string;
  name?: string;
  basic_salary: string;
  hra_pct: string;
  da_pct: string;
  special_allowance: string;
  transport_allowance: string;
  medical_allowance: string;
  pf_employee_pct: string;
  esi_applicable: boolean;
  professional_tax: string;
  tds_monthly: string;
  designation: string | null;
  department: string | null;
  employee_id: string | null;
  date_of_joining: string | null;
  pan_number: string | null;
  pf_uan: string | null;
  bank_account: string | null;
  bank_name: string | null;
  bank_ifsc: string | null;
  is_active: boolean;
  no_config?: boolean;
}

export interface StaffForPayroll {
  uid: string;
  name: string;
  role: string;
  phone: string;
  department: string | null;
  employee_id: string | null;
  has_salary_config: boolean;
  basic_salary: string | null;
  designation: string | null;
}

export interface SalaryRevision {
  id: number;
  revision_number: string;
  staff_uid: string;
  staff_name: string;
  department: string | null;
  revision_type:
    "increment" | "bonus" | "deduction_change" | "component_change";
  current_basic: string | null;
  proposed_basic: string | null;
  increment_amount: string | null;
  increment_pct: string | null;
  bonus_amount: string | null;
  bonus_reason: string | null;
  other_changes: Record<string, unknown> | null;
  effective_from: string;
  reason: string;
  proposed_by: string | null;
  proposed_by_name: string | null;
  proposed_at: string;
  hr_signed_by: string | null;
  hr_signed_by_name: string | null;
  hr_signed_at: string | null;
  hr_comment: string | null;
  admin_signed_by: string | null;
  admin_signed_by_name: string | null;
  admin_signed_at: string | null;
  admin_comment: string | null;
  status:
    | "pending_hr"
    | "pending_admin"
    | "approved"
    | "rejected"
    | "cancelled"
    | "applied";
  rejected_by: string | null;
  rejection_reason: string | null;
  applied_at: string | null;
  created_at: string;
}

export interface AnnualReviewStaff {
  uid: string;
  name: string;
  department: string | null;
  role: string;
  basic_salary: string;
  date_of_joining: string;
  years_of_service: number;
  review_status: string | null;
  reminder_id: number | null;
  revision_this_year: string | null;
}

// ─── API functions ────────────────────────────────────────────────────────────

export const getPayrollRuns = <T = PayrollRun[]>() =>
  getJSON<T>("/api/v1/staff/admin/payroll/runs");

export const getPayrollRunDetail = <
  T = { run: PayrollRun; payslips: Payslip[] },
>(
  runId: string | number,
) => getJSON<T>(`/api/v1/staff/admin/payroll/runs/${runId}`);

/**
 * POST /staff/admin/payroll/run.
 *
 * The route is mounted with `requireIdempotencyKey({ required: true, scope:
 * 'payroll_run' })`, so the header is not optional — omitting it is a hard 400,
 * not a degraded call. `idempotencyKey` is therefore a REQUIRED parameter: a
 * call site that forgets it fails to compile instead of failing in production.
 *
 * Mint the key with `useIdempotencyKey`/`createAttemptKeyStore`, keyed on the
 * `{ month, year }` payload, and `reset()` the attempt once the run concludes.
 * Do NOT pass a fresh `crypto.randomUUID()` per click: that makes a
 * double-click run payroll twice, which is the failure this header exists to
 * prevent.
 */
export const runPayroll = <T = unknown>(
  data: { month: number; year: number },
  idempotencyKey: string,
) =>
  postJSON<T>("/api/v1/staff/admin/payroll/run", data, true, {
    "Idempotency-Key": assertIdempotencyKey(idempotencyKey),
  });

export const issuePayslips = <T = unknown>(data: {
  month: number;
  year: number;
  /** Required (true) when the run has failed payslips — see PayrollRun.failed_staff_count. */
  acknowledge_failed_payslips?: boolean;
}) => postJSON<T>("/api/v1/staff/admin/payroll/issue", data);

export const getStaffForPayroll = <T = StaffForPayroll[]>(params?: {
  search?: string;
  department?: string;
}) =>
  getJSON<T>(
    "/api/v1/staff/admin/payroll/staff",
    params as QueryParams | undefined,
  );

export const getStaffSalaryConfig = <T = StaffSalaryConfig>(staffUid: string) =>
  getJSON<T>(`/api/v1/staff/admin/payroll/salary/${staffUid}`);

export const upsertSalaryConfig = <T = StaffSalaryConfig>(
  staffUid: string,
  data: Record<string, unknown>,
) => postJSON<T>(`/api/v1/staff/admin/payroll/salary/${staffUid}`, data);

export const getRevisions = <T = SalaryRevision[]>(params?: {
  status?: string;
  staff_uid?: string;
  limit?: number;
}) =>
  getJSON<T>(
    "/api/v1/staff/admin/payroll/revisions",
    params as QueryParams | undefined,
  );

export const getRevisionDetail = <T = SalaryRevision>(id: string | number) =>
  getJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}`);

export const getAnnualReviewStatus = <
  T = { year: number; staff: AnnualReviewStaff[] },
>() => getJSON<T>("/api/v1/staff/admin/payroll/annual-review");

export const proposeRevision = <T = SalaryRevision>(
  data: Record<string, unknown>,
) => postJSON<T>("/api/v1/staff/admin/payroll/revisions/propose", data);

export const hrSignRevision = <T = SalaryRevision>(
  id: string | number,
  data: { comment?: string },
) => postJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}/hr-sign`, data);

export const adminSignRevision = <T = SalaryRevision>(
  id: string | number,
  data: { comment?: string },
) =>
  postJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}/admin-sign`, data);

export const applyRevision = <T = unknown>(id: string | number) =>
  postJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}/apply`, {});

export const rejectRevision = <T = unknown>(
  id: string | number,
  data: { reason?: string },
) => postJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}/reject`, data);

// Payroll run dual sign + manual edit. `acknowledge_failed_payslips: true` is
// required by the backend when the run is completed_with_errors — the signer
// must explicitly confirm they reviewed the failed payslips.
export const hrSignPayrollRun = <T = unknown>(
  runId: string,
  data: { comment?: string; acknowledge_failed_payslips?: boolean },
) => postJSON<T>(`/api/v1/staff/admin/payroll/runs/${runId}/hr-sign`, data);

export const adminSignPayrollRun = <T = unknown>(
  runId: string,
  data: { comment?: string; acknowledge_failed_payslips?: boolean },
) => postJSON<T>(`/api/v1/staff/admin/payroll/runs/${runId}/admin-sign`, data);

export const manualEditPayslip = <T = unknown>(
  payslipId: string,
  data: Record<string, unknown>,
) =>
  postJSON<T>(`/api/v1/staff/admin/payroll/payslips/${payslipId}/edit`, data);

// ─── New Features ─────────────────────────────────────────────────────────────

// CSV export URL builders (use window.open() for direct file download)
export const exportPayrollSummaryUrl = (month: number, year: number): string =>
  `/api/v1/staff/admin/payroll/export/summary?month=${month}&year=${year}`;
export const exportPFRegisterUrl = (month: number, year: number): string =>
  `/api/v1/staff/admin/payroll/export/pf?month=${month}&year=${year}`;
export const exportESIRegisterUrl = (month: number, year: number): string =>
  `/api/v1/staff/admin/payroll/export/esi?month=${month}&year=${year}`;

// Annual tax summaries
export const generateTaxSummaries = <T = unknown>(data: {
  financial_year: string;
}) => postJSON<T>("/api/v1/staff/admin/payroll/tax-summary/all", data);

// Salary advances
export const getAllAdvances = <T = unknown>(status?: string) =>
  getJSON<T>(
    "/api/v1/staff/admin/payroll/advances",
    status ? ({ status } as QueryParams) : undefined,
  );

export const createAdvance = <T = unknown>(data: Record<string, unknown>) =>
  postJSON<T>("/api/v1/staff/admin/payroll/advances/create", data);

// Arrears
export const calculateArrears = <T = unknown>(revisionId: string | number) =>
  postJSON<T>(
    `/api/v1/staff/admin/payroll/revisions/${revisionId}/arrears`,
    {},
  );

// Payroll Comparison
export interface PayrollComparisonData {
  month_range: Array<{ month: number; year: number }>;
  staff: Array<{
    staff_uid: string;
    name: string;
    employee_id: string;
    designation: string;
    department: string;
    payslips: Array<{
      month: number;
      year: number;
      days_present: number;
      days_absent: number;
      lop_days: number;
      overtime_hours: number;
      basic_earned: number;
      hra_earned: number;
      da_earned: number;
      special_allowance: number;
      transport_allowance: number;
      medical_allowance: number;
      overtime_pay: number;
      bonus: number;
      arrears: number;
      gross_salary: number;
      pf: number;
      esi: number;
      professional_tax: number;
      tds: number;
      advance_deduction: number;
      total_deductions: number;
      net_salary: number;
      status: string;
    }>;
  }>;
  total_staff: number;
  total_payslips: number;
}

export const getPayrollComparison = <T = PayrollComparisonData>(
  fromMonth: number,
  fromYear: number,
  toMonth: number,
  toYear: number,
  staffUid?: string,
) =>
  getJSON<T>("/api/v1/staff/admin/payroll/comparison", {
    from_month: fromMonth,
    from_year: fromYear,
    to_month: toMonth,
    to_year: toYear,
    ...(staffUid && { staff_uid: staffUid }),
  } as QueryParams);

// ─── Compliance API ───────────────────────────────────────────────────────────

export interface FnFSettlement {
  id: number;
  staff_uid: string;
  staff_name: string;
  department: string;
  designation: string;
  employee_id: string;
  separation_type: string;
  last_working_day: string;
  last_month_basic: string;
  last_month_allowances: string;
  years_of_service: string;
  gratuity_eligible: boolean;
  gratuity_amount: string;
  bonus_payable: string;
  notice_shortfall_days: number;
  notice_recovery_amount: string;
  other_deductions: string;
  gross_payable: string;
  total_deductions: string;
  net_payable: string;
  status: string;
  payment_date: string | null;
  payment_reference: string | null;
  created_at: string;
}

export interface GratuityStatus {
  staff_uid: string;
  name: string;
  employee_id: string;
  designation: string;
  department: string;
  date_of_joining: string;
  years_of_service: number;
  gratuity_eligible: boolean;
  projected_gratuity: number;
  days_to_five_years: number;
}

export interface InvestmentDeclaration {
  id: number;
  staff_uid: string;
  staff_name: string;
  department: string;
  designation: string;
  employee_id: string;
  financial_year: string;
  ppf: string;
  epf_voluntary: string;
  elss: string;
  lic_premium: string;
  nsc: string;
  home_loan_principal: string;
  tuition_fees: string;
  other_80c: string;
  health_insurance_self: string;
  health_insurance_parents: string;
  education_loan_interest: string;
  rent_paid_monthly: string;
  rent_receipt_provided: boolean;
  home_loan_interest: string;
  nps_contribution: string;
  status: string;
  submitted_at: string | null;
  approved_at: string | null;
}

export interface PayslipQuery {
  id: number;
  payslip_id: number;
  staff_uid: string;
  staff_name: string;
  employee_id: string;
  month: number;
  year: number;
  net_salary: string;
  subject: string;
  description: string;
  category: string;
  status: string;
  created_at: string;
  replies: Array<{
    id: number;
    author_uid: string;
    author_role: string;
    message: string;
    created_at: string;
  }> | null;
}

export interface ComplianceDeadline {
  label: string;
  due_date: string;
  due_in_days: number;
  status: string;
  type: string;
  note?: string;
}

export interface BulkRevisionJob {
  id: number;
  description: string;
  revision_type: string;
  target_type: string;
  target_value: string | null;
  increment_type: string | null;
  increment_value: string | null;
  bonus_amount: string | null;
  effective_from: string;
  staff_count: number;
  processed_count: number;
  status: string;
  created_by_name: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface LeaveEncashment {
  id: number;
  staff_uid: string;
  staff_name: string;
  employee_id: string;
  encashment_type: string;
  leave_days: number;
  daily_rate: string;
  amount: string;
  financial_year: string | null;
  status: string;
  created_at: string;
}

export const getComplianceCalendar = <
  T = {
    deadlines: ComplianceDeadline[];
    current_month: number;
    current_year: number;
  },
>() => getJSON<T>("/api/v1/staff/admin/payroll/compliance-calendar");

export const getFnFList = <T = FnFSettlement[]>(status?: string) =>
  getJSON<T>(
    "/api/v1/staff/admin/payroll/fnf",
    status ? ({ status } as QueryParams) : undefined,
  );

export const createFnF = <T = FnFSettlement>(data: {
  staff_uid: string;
  separation_type: string;
  last_working_day: string;
  notice_shortfall_days?: number;
  bonus_payable?: number;
  other_deductions?: number;
  other_deductions_reason?: string;
  notes?: string;
}) => postJSON<T>("/api/v1/staff/admin/payroll/fnf/create", data);

export const approveFnF = <T = FnFSettlement>(id: number) =>
  postJSON<T>(`/api/v1/staff/admin/payroll/fnf/${id}/approve`, {});

export const markFnFPaid = <T = FnFSettlement>(
  id: number,
  payment_date: string,
  payment_reference: string,
) =>
  postJSON<T>(`/api/v1/staff/admin/payroll/fnf/${id}/mark-paid`, {
    payment_date,
    payment_reference,
  });

export const getGratuityStatus = <T = GratuityStatus[]>() =>
  getJSON<T>("/api/v1/staff/admin/payroll/gratuity");

export const getAllDeclarations = <T = InvestmentDeclaration[]>(params?: {
  financial_year?: string;
  status?: string;
}) =>
  getJSON<T>("/api/v1/staff/admin/payroll/declarations", params as QueryParams);

export const approveDeclaration = <T = InvestmentDeclaration>(id: number) =>
  postJSON<T>(`/api/v1/staff/admin/payroll/declarations/${id}/approve`, {});

export const getAllPayslipQueries = <T = PayslipQuery[]>(status?: string) =>
  getJSON<T>(
    "/api/v1/staff/admin/payroll/queries",
    status ? ({ status } as QueryParams) : undefined,
  );

export const replyToPayslipQuery = <T = PayslipQuery>(
  id: number,
  message: string,
  resolve?: boolean,
) =>
  postJSON<T>(`/api/v1/staff/admin/payroll/queries/${id}/reply`, {
    message,
    resolve: resolve ?? false,
  });

export const getBulkRevisions = <T = BulkRevisionJob[]>() =>
  getJSON<T>("/api/v1/staff/admin/payroll/bulk-revisions");

export const createBulkRevision = <T = BulkRevisionJob>(data: {
  description: string;
  revision_type: string;
  target_type: string;
  target_value?: string;
  increment_type?: string;
  increment_value?: number;
  bonus_amount?: number;
  effective_from: string;
}) => postJSON<T>("/api/v1/staff/admin/payroll/bulk-revisions/create", data);

export const approveBulkRevision = <T = BulkRevisionJob>(id: number) =>
  postJSON<T>(`/api/v1/staff/admin/payroll/bulk-revisions/${id}/approve`, {});

export const getLeaveEncashments = <T = LeaveEncashment[]>(
  staff_uid?: string,
) =>
  getJSON<T>(
    "/api/v1/staff/admin/payroll/leave-encashment",
    staff_uid ? ({ staff_uid } as QueryParams) : undefined,
  );

export const calculateLeaveEncashment = <T = LeaveEncashment>(data: {
  staff_uid: string;
  leave_days: number;
  encashment_type: string;
  financial_year?: string;
}) => postJSON<T>("/api/v1/staff/admin/payroll/leave-encashment/create", data);
