// src/lib/api/staff.ts
import { getJSON, postJSON, putJSON, type QueryParams } from "./core";

export interface ShiftAssignment {
  staffId?: number;
  staff_id?: number;
  shift: string;
  dates?: string[];
}

export type StaffShift =
  | "MORNING"
  | "AFTERNOON"
  | "NIGHT"
  | "FULL_DAY"
  | "ON_CALL";

export type StaffRole =
  | "ADMIN"
  | "SUPER_ADMIN"
  | "DOCTOR"
  | "ANAESTHETIST"
  | "ANESTHETIST"
  | "DUTY_DOCTOR"
  | "CONSULTANT"
  | "JUNIOR_DOCTOR"
  | "RESIDENT"
  | "CMO"
  | "MEDICAL_SUPERINTENDENT"
  | "CNO"
  | "NURSING_STAFF"
  | "NURSING_INCHARGE"
  | "OP_STAFF_NURSE"
  | "OP_INCHARGE"
  | "IP_STAFF_NURSE"
  | "IP_INCHARGE"
  | "OT_NURSE"
  | "OT_INCHARGE"
  | "OT_STAFF"
  | "CATH_LAB_STAFF"
  | "CATH_LAB_INCHARGE"
  | "BILLING_STAFF"
  | "BILLING_INCHARGE"
  | "FINANCE_INCHARGE"
  | "ADMISSION_OFFICER"
  | "INSURANCE_COORDINATOR"
  | "IPD_COUNSELLOR"
  | "PHARMACY_STAFF"
  | "LAB_STAFF"
  | "RADIOLOGIST"
  | "RADIOLOGY_STAFF"
  | "HR_STAFF"
  | "GENERAL_STAFF"
  | "HOUSEKEEPING_STAFF"
  | "HOUSEKEEPING_INCHARGE"
  | "RECEPTIONIST"
  | "RECEPTION_INCHARGE"
  | "DRIVER"
  | "SECURITY"
  | "MAINTENANCE"
  | "EMERGENCY_RESPONDER"
  | "DIETITIAN"
  | "PHYSIOTHERAPIST"
  | "SOCIAL_WORKER"
  | "QUALITY_OFFICER"
  | "INFECTION_CONTROL_OFFICER"
  | "BLOOD_BANK_TECHNICIAN"
  | "CARE_COORDINATOR"
  | "COUNSELLOR"
  | "CLAIMS_MANAGER"
  | "AMBULANCE_COORDINATOR"
  | "INTEGRATION_ADMIN"
  | "AI_GOVERNANCE_ADMIN"
  | "DATA_PROTECTION_OFFICER";

export interface RolePolicyRole {
  role_code: string;
  display_title?: string;
  group?: string;
  department?: string | null;
  unit?: string | null;
  assignable_staff?: boolean;
  human?: boolean;
  machine?: boolean;
  access?: {
    route_capability_groups?: string[];
  };
  phi?: {
    access_level?: string;
  };
}

export interface RolePolicyResponse {
  policy_version: string;
  policy_hash: string;
  generated_at?: string;
  roles: RolePolicyRole[];
  capability_groups?: Record<string, { title?: string; description?: string }>;
  phi_levels?: Record<string, string>;
}

export interface StaffMember {
  id: number;
  uid?: string;
  employee_id?: string | null;
  name: string;
  phone?: string | null;
  email?: string | null;
  role: StaffRole | string;
  department?: string | null;
  position?: string | null;
  shift?: StaffShift | string | null;
  is_active?: boolean | null;
  current_status?: string | null;
  hire_date?: string | null;
  last_check_in?: string | null;
  last_check_out?: string | null;
}

export interface StaffListResponse {
  staff: StaffMember[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  statistics?: {
    departments?: Array<{ department: string | null; count: number | string }>;
    roles?: Array<{ role: string; count: number | string }>;
    totalActive?: number;
    currentlyCheckedIn?: number;
  };
  viewableRoles?: string[];
}

export interface HRDashboardResponse {
  overview?: {
    total_staff: number;
    active_staff: number;
    inactive_staff: number;
    new_hires_30_days: number;
    currently_checked_in: number;
    attendance_rate: number;
    average_salary?: number | null;
  };
  departmentBreakdown?: Array<{
    department: string;
    total_staff: number;
    active_staff: number;
    present_today: number;
    attendance_rate: number;
    staffing_status: string;
  }>;
  leaves?: {
    total: number;
    approved: number;
    rejected: number;
    pending: number;
    currently_on_leave: number;
  };
  alerts?: {
    low_attendance: number;
    upcoming_reviews: number;
    new_hires_need_onboarding: number;
  };
  upcomingTasks?: Array<{
    task_type: string;
    staff_name: string;
    employee_id: string;
    due_date: string;
  }>;
  lastUpdated?: string;
}

export interface CreateStaffPayload {
  employee_id?: string;
  name: string;
  phone: string;
  email?: string;
  role: StaffRole | string;
  temporary_password: string;
  position: string;
  department: string;
  shift?: StaffShift | string;
  salary?: number;
  hire_date?: string;
  notes?: string;
}

export function getStaffList<T = StaffListResponse>(params?: QueryParams) {
  return getJSON<T>("/api/v1/staff/list", params);
}

export function getRolePolicy<T = RolePolicyResponse>() {
  return getJSON<T>("/api/v1/rbac/policy");
}

export function getHRDashboard<T = HRDashboardResponse>(
  timeframe = "current_month",
) {
  return getJSON<T>("/api/v1/staff/hr/dashboard", { timeframe });
}

export function getStaffByShift<T = unknown>(
  shift: string,
  params?: QueryParams,
) {
  return getJSON<T>(`/api/v1/staff/shift/${shift.toUpperCase()}`, params);
}

export function createStaffProfile<T = unknown>(payload: CreateStaffPayload) {
  return postJSON<T>("/api/v1/staff/create", payload);
}

export function updateStaffProfile<T = unknown>(
  identifier: string | number,
  payload: Partial<CreateStaffPayload> & { is_active?: boolean },
) {
  return putJSON<T>(
    `/api/v1/staff/${encodeURIComponent(String(identifier))}`,
    payload,
  );
}

export function bulkShiftAssignment<T = unknown>(
  assignments: ShiftAssignment[],
) {
  const normalized = assignments.map((assignment) => ({
    staff_id: assignment.staff_id ?? assignment.staffId,
    shift: assignment.shift.toUpperCase(),
  }));
  return postJSON<T>("/api/v1/staff/admin/bulk/shift-assignment", {
    assignments: normalized,
  });
}
