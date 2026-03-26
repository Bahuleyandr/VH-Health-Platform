// src/lib/api/payroll.ts
import { getJSON, postJSON, QueryParams } from "./core";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PayrollRun {
  id: number;
  month: number;
  year: number;
  status: "draft" | "processing" | "completed" | "locked";
  total_staff: number;
  total_gross: string;
  total_net: string;
  total_deductions: string;
  generated_by: string | null;
  generated_by_name: string | null;
  generated_at: string | null;
  locked_at: string | null;
  notes: string | null;
  created_at: string;
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
  revision_type: "increment" | "bonus" | "deduction_change" | "component_change";
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

export const getPayrollRunDetail = <T = { run: PayrollRun; payslips: Payslip[] }>(
  runId: string | number
) => getJSON<T>(`/api/v1/staff/admin/payroll/runs/${runId}`);

export const runPayroll = <T = unknown>(data: { month: number; year: number }) =>
  postJSON<T>("/api/v1/staff/admin/payroll/run", data);

export const issuePayslips = <T = unknown>(data: {
  month: number;
  year: number;
}) => postJSON<T>("/api/v1/staff/admin/payroll/issue", data);

export const getStaffForPayroll = <T = StaffForPayroll[]>(params?: {
  search?: string;
  department?: string;
}) => getJSON<T>("/api/v1/staff/admin/payroll/staff", params as QueryParams | undefined);

export const getStaffSalaryConfig = <T = StaffSalaryConfig>(staffUid: string) =>
  getJSON<T>(`/api/v1/staff/admin/payroll/salary/${staffUid}`);

export const upsertSalaryConfig = <T = StaffSalaryConfig>(
  staffUid: string,
  data: Record<string, unknown>
) => postJSON<T>(`/api/v1/staff/admin/payroll/salary/${staffUid}`, data);

export const getRevisions = <T = SalaryRevision[]>(params?: {
  status?: string;
  staff_uid?: string;
  limit?: number;
}) => getJSON<T>("/api/v1/staff/admin/payroll/revisions", params as QueryParams | undefined);

export const getRevisionDetail = <T = SalaryRevision>(id: string | number) =>
  getJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}`);

export const getAnnualReviewStatus = <T = { year: number; staff: AnnualReviewStaff[] }>() =>
  getJSON<T>("/api/v1/staff/admin/payroll/annual-review");

export const proposeRevision = <T = SalaryRevision>(
  data: Record<string, unknown>
) => postJSON<T>("/api/v1/staff/admin/payroll/revisions/propose", data);

export const hrSignRevision = <T = SalaryRevision>(
  id: string | number,
  data: { comment?: string }
) => postJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}/hr-sign`, data);

export const adminSignRevision = <T = SalaryRevision>(
  id: string | number,
  data: { comment?: string }
) => postJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}/admin-sign`, data);

export const applyRevision = <T = unknown>(id: string | number) =>
  postJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}/apply`, {});

export const rejectRevision = <T = unknown>(
  id: string | number,
  data: { reason?: string }
) => postJSON<T>(`/api/v1/staff/admin/payroll/revisions/${id}/reject`, data);
