// apps/backend/scripts/openapi/schemas/payroll.mjs
// OpenAPI Phase 5 — Payroll admin overlay (PASS A): payroll-runs, salary-config,
// salary-revisions sub-domains of /api/v1/staff/admin/payroll/*. Typed
// request/response schemas authored from the scout's per-field ground truth
// (exact SELECT columns + Decimal/number/integer classification). Mirrors the
// money.mjs / discharge.mjs slice shape (top-level null-free const enums + a
// `schemas` map + an `operations` map). Pass B adds the remaining 3 sub-domains.
import { envelope, listEnvelope } from './_helpers.mjs';

// Money JSON type. Every payroll amount column is NUMERIC(p,s) (rupees, no
// *_minor/*_paise integer-money columns exist in this cluster). A NUMERIC column
// read back via Prisma select / SELECT * serializes to a JSON STRING.
const MT = 'string';

// ---- Status enums (exact values + casing, verified against DDL defaults +
// every branch literal). NULL-FREE on purpose: Spectral 6.16 CRASHES on a null
// enum value, so even where a status field is nullable we keep the committed
// enum array null-free and pair it with `nullable: true`. ----
//
// payroll_runs.status lifecycle: draft -> processing -> completed -> approved -> locked
const PAYROLL_RUN_STATUS = ['draft', 'processing', 'completed', 'approved', 'locked'];
// payslips.status lifecycle: draft -> issued -> viewed -> downloaded
const PAYSLIP_STATUS = ['draft', 'issued', 'viewed', 'downloaded'];
// salary_revisions.status lifecycle: pending_hr -> pending_admin -> approved -> applied; rejected from either pending state
const REVISION_STATUS = ['pending_hr', 'pending_admin', 'approved', 'applied', 'rejected'];
// salary_revisions.revision_type (validated in proposeRevision)
const REVISION_TYPE = ['increment', 'bonus', 'deduction_change', 'component_change'];
// bulk_revision_jobs.status DB lifecycle: draft -> approved -> completed | failed.
// (approveBulkRevision's HTTP response reports a SYNTHETIC 'processing' that is
// NOT a DB value — typed as a free string there, not against this enum.)
const BULK_REVISION_STATUS = ['draft', 'approved', 'completed', 'failed'];
// salary_arrears.status: pending (default) -> paid
const ARREARS_STATUS = ['pending', 'paid'];

export const schemas = {
  // =====================================================================
  // SUB-DOMAIN: payroll-runs
  // =====================================================================

  // ---- getPayrollRuns GET /payroll/runs item: SELECT pr.* + generated_by_name.
  // SELECT * → leaks tenant_id + all payroll_runs columns → LOOSE
  // (additionalProperties:true) with a typed required core. ----
  PayrollRunListItem: {
    type: 'object', additionalProperties: true,
    required: ['id', 'month', 'year', 'status'],
    properties: {
      id: { type: 'integer' },
      month: { type: 'integer' },
      year: { type: 'integer' },
      status: { type: 'string', nullable: true, enum: PAYROLL_RUN_STATUS },
      total_staff: { type: 'integer', nullable: true },
      total_gross: { type: MT, nullable: true },
      total_net: { type: MT, nullable: true },
      total_deductions: { type: MT, nullable: true },
      generated_by: { type: 'string', format: 'uuid', nullable: true },
      generated_at: { type: 'string', format: 'date-time', nullable: true },
      locked_by: { type: 'string', format: 'uuid', nullable: true },
      locked_at: { type: 'string', format: 'date-time', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      employee_count: { type: 'integer', nullable: true },
      hr_approved_by: { type: 'string', format: 'uuid', nullable: true },
      hr_approved_at: { type: 'string', format: 'date-time', nullable: true },
      hr_comment: { type: 'string', nullable: true },
      admin_approved_by: { type: 'string', format: 'uuid', nullable: true },
      admin_approved_at: { type: 'string', format: 'date-time', nullable: true },
      admin_comment: { type: 'string', nullable: true },
      approval_hash: { type: 'string', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      generated_by_name: { type: 'string', nullable: true },
    },
  },
  PayrollRunsResponse: listEnvelope('PayrollRunListItem'),

  // ---- PAYROLL_RUN_SELECT — curated (no tenant_id), shared by hr-sign +
  // admin-sign (identical shape, only values differ). STRICT. ----
  PayrollRun: {
    type: 'object', additionalProperties: false,
    required: ['id', 'month', 'year', 'status'],
    properties: {
      id: { type: 'integer' },
      month: { type: 'integer' },
      year: { type: 'integer' },
      status: { type: 'string', nullable: true, enum: PAYROLL_RUN_STATUS },
      total_staff: { type: 'integer', nullable: true },
      total_gross: { type: MT, nullable: true },
      total_net: { type: MT, nullable: true },
      total_deductions: { type: MT, nullable: true },
      generated_by: { type: 'string', format: 'uuid', nullable: true },
      generated_at: { type: 'string', format: 'date-time', nullable: true },
      employee_count: { type: 'integer', nullable: true },
      hr_approved_by: { type: 'string', format: 'uuid', nullable: true },
      hr_approved_at: { type: 'string', format: 'date-time', nullable: true },
      hr_comment: { type: 'string', nullable: true },
      admin_approved_by: { type: 'string', format: 'uuid', nullable: true },
      admin_approved_at: { type: 'string', format: 'date-time', nullable: true },
      admin_comment: { type: 'string', nullable: true },
      approval_hash: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  PayrollRunResponse: envelope('PayrollRun'),

  // ---- payslips array item inside run detail: SELECT p.* + 4 joins. SELECT *
  // → leaks tenant_id + all payslips columns → LOOSE. Every amount column is
  // Decimal-from-column → string; overtime_hours/overtime_rate/lop_days are
  // NUMERIC quantity columns → also string. ----
  PayslipListItem: {
    type: 'object', additionalProperties: true,
    required: ['id', 'month', 'year', 'status'],
    properties: {
      id: { type: 'integer' },
      payroll_run_id: { type: 'integer', nullable: true },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      month: { type: 'integer' },
      year: { type: 'integer' },
      total_working_days: { type: 'integer', nullable: true },
      days_present: { type: 'integer', nullable: true },
      days_absent: { type: 'integer', nullable: true },
      days_leave: { type: 'integer', nullable: true },
      days_half: { type: 'integer', nullable: true },
      overtime_hours: { type: MT, nullable: true },
      overtime_rate: { type: MT, nullable: true },
      basic_earned: { type: MT, nullable: true },
      hra_earned: { type: MT, nullable: true },
      da_earned: { type: MT, nullable: true },
      special_allowance_earned: { type: MT, nullable: true },
      transport_allowance_earned: { type: MT, nullable: true },
      medical_allowance_earned: { type: MT, nullable: true },
      overtime_pay: { type: MT, nullable: true },
      bonus_this_month: { type: MT, nullable: true },
      gross_salary: { type: MT, nullable: true },
      pf_employee: { type: MT, nullable: true },
      esi_employee: { type: MT, nullable: true },
      professional_tax: { type: MT, nullable: true },
      tds: { type: MT, nullable: true },
      other_deductions: { type: MT, nullable: true },
      total_deductions: { type: MT, nullable: true },
      net_salary: { type: MT, nullable: true },
      pdf_key: { type: 'string', nullable: true },
      pdf_generated_at: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', nullable: true, enum: PAYSLIP_STATUS },
      viewed_at: { type: 'string', format: 'date-time', nullable: true },
      downloaded_at: { type: 'string', format: 'date-time', nullable: true },
      issued_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      lop_days: { type: MT, nullable: true },
      lop_deduction: { type: MT, nullable: true },
      arrears_amount: { type: MT, nullable: true },
      advance_deduction: { type: MT, nullable: true },
      revision_note: { type: 'string', nullable: true },
      manually_edited: { type: 'boolean', nullable: true },
      edit_reason: { type: 'string', nullable: true },
      edited_by: { type: 'string', format: 'uuid', nullable: true },
      edited_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      staff_name: { type: 'string', nullable: true },
      email: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      role: { type: 'string', nullable: true },
    },
  },

  // ---- getPayrollRunDetail GET /payroll/runs/{runId}: { run: curated header,
  // payslips: [PayslipListItem] }. LIST != detail — nests a single run header +
  // payslip array. run is a curated explicit-column SELECT (no tenant_id), but
  // payslips leak via p.* → keep the wrapper LOOSE. ----
  PayrollRunDetailHeader: {
    type: 'object', additionalProperties: true,
    required: ['id', 'month', 'year', 'status'],
    properties: {
      id: { type: 'integer' },
      month: { type: 'integer' },
      year: { type: 'integer' },
      status: { type: 'string', nullable: true, enum: PAYROLL_RUN_STATUS },
      generated_by: { type: 'string', format: 'uuid', nullable: true },
      generated_at: { type: 'string', format: 'date-time', nullable: true },
      hr_approved_by: { type: 'string', format: 'uuid', nullable: true },
      hr_approved_at: { type: 'string', format: 'date-time', nullable: true },
      admin_approved_by: { type: 'string', format: 'uuid', nullable: true },
      admin_approved_at: { type: 'string', format: 'date-time', nullable: true },
      total_gross: { type: MT, nullable: true },
      total_deductions: { type: MT, nullable: true },
      total_net: { type: MT, nullable: true },
      employee_count: { type: 'integer', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  PayrollRunDetail: {
    type: 'object', additionalProperties: true,
    required: ['run', 'payslips'],
    properties: {
      run: { $ref: '#/components/schemas/PayrollRunDetailHeader' },
      payslips: { type: 'array', items: { $ref: '#/components/schemas/PayslipListItem' } },
    },
  },
  PayrollRunDetailResponse: envelope('PayrollRunDetail'),

  // ---- PAYSLIP_DETAIL_SELECT — manualEditPayslip return. Curated select →
  // STRICT. gross_salary/total_deductions/net_salary are JS-recomputed but read
  // BACK from the NUMERIC column via the select → string (the trap). ----
  PayslipDetail: {
    type: 'object', additionalProperties: false,
    required: ['id', 'month', 'year', 'status'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      month: { type: 'integer' },
      year: { type: 'integer' },
      payroll_run_id: { type: 'integer', nullable: true },
      basic_earned: { type: MT, nullable: true },
      hra_earned: { type: MT, nullable: true },
      da_earned: { type: MT, nullable: true },
      special_allowance_earned: { type: MT, nullable: true },
      transport_allowance_earned: { type: MT, nullable: true },
      medical_allowance_earned: { type: MT, nullable: true },
      overtime_pay: { type: MT, nullable: true },
      gross_salary: { type: MT, nullable: true },
      pf_employee: { type: MT, nullable: true },
      esi_employee: { type: MT, nullable: true },
      professional_tax: { type: MT, nullable: true },
      tds: { type: MT, nullable: true },
      total_deductions: { type: MT, nullable: true },
      net_salary: { type: MT, nullable: true },
      status: { type: 'string', nullable: true, enum: PAYSLIP_STATUS },
      pdf_key: { type: 'string', nullable: true },
      manually_edited: { type: 'boolean', nullable: true },
      edit_reason: { type: 'string', nullable: true },
      edited_by: { type: 'string', format: 'uuid', nullable: true },
      edited_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  PayslipDetailResponse: envelope('PayslipDetail'),

  // ---- runPayroll JS summary. total_gross/total_net are .toFixed(2) → JS
  // STRINGS (formatting, not Decimal column). run_id/processed/failed integers. ----
  PayrollRunResult: {
    type: 'object', additionalProperties: false,
    required: ['run_id', 'processed', 'failed', 'total_gross', 'total_net'],
    properties: {
      run_id: { type: 'integer' },
      processed: { type: 'integer' },
      failed: { type: 'integer' },
      total_gross: { type: 'string', example: '125000.00' },
      total_net: { type: 'string', example: '110000.00' },
    },
  },
  PayrollRunResultResponse: envelope('PayrollRunResult'),

  // ---- issuePayslips { issued } — JS-side updateMany().count → integer. ----
  IssuePayslipsResult: {
    type: 'object', additionalProperties: false,
    required: ['issued'],
    properties: { issued: { type: 'integer' } },
  },
  IssuePayslipsResponse: envelope('IssuePayslipsResult'),

  // ---- payroll-runs request bodies (no express-validator → permissive). ----
  RunPayrollRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.runPayroll; not validator-backed.',
    properties: { month: { type: 'integer' }, year: { type: 'integer' } },
  },
  IssuePayslipsRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.issuePayslips; not validator-backed.',
    properties: { month: { type: 'integer' }, year: { type: 'integer' }, run_id: { type: 'integer' } },
  },
  EditPayslipRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.manualEditPayslip; not validator-backed. Per-component overrides + edit_reason.',
    properties: {
      basic_earned: { type: 'number' },
      hra_earned: { type: 'number' },
      da_earned: { type: 'number' },
      special_allowance_earned: { type: 'number' },
      transport_allowance_earned: { type: 'number' },
      medical_allowance_earned: { type: 'number' },
      overtime_pay: { type: 'number' },
      pf_employee: { type: 'number' },
      esi_employee: { type: 'number' },
      professional_tax: { type: 'number' },
      tds: { type: 'number' },
      edit_reason: { type: 'string' },
    },
  },
  SignPayrollRunRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.hrSignPayrollRun / adminSignPayrollRun; not validator-backed.',
    properties: { comment: { type: 'string' } },
  },

  // =====================================================================
  // SUB-DOMAIN: salary-config
  // =====================================================================

  // ---- getStaffForPayroll GET /payroll/staff item. Curated explicit SELECT →
  // STRICT. basic_salary Decimal-from-column nullable (LEFT JOIN). ----
  StaffForPayrollItem: {
    type: 'object', additionalProperties: false,
    required: ['uid', 'has_salary_config'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      name: { type: 'string', nullable: true },
      role: { type: 'string', nullable: true },
      phone: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      employee_id: { type: 'string', nullable: true },
      has_salary_config: { type: 'boolean' },
      basic_salary: { type: MT, nullable: true },
      designation: { type: 'string', nullable: true },
    },
  },
  StaffForPayrollResponse: listEnvelope('StaffForPayrollItem'),

  // ---- getStaffSalaryConfig GET /payroll/salary/{staffUid}. 3-way union:
  //   (A) ss.* config object (leaks tenant_id, masked pan/bank) ;
  //   (B) { uid, name, role, phone, no_config: true } ;
  //   (C) null (envelope data is nullable).
  // Modelled as ONE loose object (additionalProperties:true) covering both
  // non-null shapes, with the envelope's `data` typed nullable. ----
  StaffSalaryConfigView: {
    type: 'object', additionalProperties: true,
    properties: {
      // shape B discriminator + its fields
      no_config: { type: 'boolean' },
      uid: { type: 'string', format: 'uuid' },
      // shape A fields (ss.* + joins)
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid' },
      basic_salary: { type: MT, nullable: true },
      hra_pct: { type: MT, nullable: true },
      da_pct: { type: MT, nullable: true },
      special_allowance: { type: MT, nullable: true },
      transport_allowance: { type: MT, nullable: true },
      medical_allowance: { type: MT, nullable: true },
      pf_employee_pct: { type: MT, nullable: true },
      pf_employer_pct: { type: MT, nullable: true },
      esi_applicable: { type: 'boolean', nullable: true },
      professional_tax: { type: MT, nullable: true },
      tds_monthly: { type: MT, nullable: true },
      designation: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      employee_id: { type: 'string', nullable: true },
      date_of_joining: { type: 'string', format: 'date', nullable: true },
      pan_number: { type: 'string', nullable: true },
      pf_uan: { type: 'string', nullable: true },
      bank_account: { type: 'string', nullable: true },
      bank_name: { type: 'string', nullable: true },
      bank_ifsc: { type: 'string', nullable: true },
      effective_from: { type: 'string', format: 'date', nullable: true },
      is_active: { type: 'boolean', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      notice_period_days: { type: 'integer', nullable: true },
      dob: { type: 'string', format: 'date', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      name: { type: 'string', nullable: true },
      role: { type: 'string', nullable: true },
      phone: { type: 'string', nullable: true },
      dept: { type: 'string', nullable: true },
    },
  },
  // envelope.data is nullable (shape C) — can't use the plain envelope() helper.
  StaffSalaryConfigViewResponse: {
    type: 'object',
    required: ['success'],
    properties: {
      success: { type: 'boolean', example: true },
      message: { type: 'string' },
      data: { nullable: true, allOf: [{ $ref: '#/components/schemas/StaffSalaryConfigView' }] },
    },
  },

  // ---- upsertStaffSalaryConfig POST /payroll/salary/{staffUid}. Curated select
  // (no tenant_id, no is_active) → STRICT. basic_salary required; pan/bank masked. ----
  StaffSalaryConfig: {
    type: 'object', additionalProperties: false,
    required: ['id', 'staff_uid', 'basic_salary'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid' },
      basic_salary: { type: MT },
      hra_pct: { type: MT, nullable: true },
      da_pct: { type: MT, nullable: true },
      special_allowance: { type: MT, nullable: true },
      transport_allowance: { type: MT, nullable: true },
      medical_allowance: { type: MT, nullable: true },
      pf_employee_pct: { type: MT, nullable: true },
      esi_applicable: { type: 'boolean', nullable: true },
      professional_tax: { type: MT, nullable: true },
      tds_monthly: { type: MT, nullable: true },
      designation: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      employee_id: { type: 'string', nullable: true },
      date_of_joining: { type: 'string', format: 'date', nullable: true },
      pan_number: { type: 'string', nullable: true },
      pf_uan: { type: 'string', nullable: true },
      bank_account: { type: 'string', nullable: true },
      bank_name: { type: 'string', nullable: true },
      bank_ifsc: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  StaffSalaryConfigResponse: envelope('StaffSalaryConfig'),

  UpsertSalaryConfigRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.upsertStaffSalaryConfig; not validator-backed.',
    properties: {
      basic_salary: { type: 'number' },
      hra_pct: { type: 'number' },
      da_pct: { type: 'number' },
      special_allowance: { type: 'number' },
      transport_allowance: { type: 'number' },
      medical_allowance: { type: 'number' },
      pf_employee_pct: { type: 'number' },
      esi_applicable: { type: 'boolean' },
      professional_tax: { type: 'number' },
      tds_monthly: { type: 'number' },
      designation: { type: 'string' },
      department: { type: 'string' },
      employee_id: { type: 'string' },
      date_of_joining: { type: 'string', format: 'date' },
      pan_number: { type: 'string' },
      pf_uan: { type: 'string' },
      bank_account: { type: 'string' },
      bank_name: { type: 'string' },
      bank_ifsc: { type: 'string' },
    },
  },

  // =====================================================================
  // SUB-DOMAIN: salary-revisions
  // =====================================================================

  // ---- getRevisions GET /payroll/revisions item. Curated join cols (no
  // tenant_id) but HAS rejected_by_name → STRICT. 4 money fields Decimal|null. ----
  SalaryRevisionListItem: {
    type: 'object', additionalProperties: false,
    required: ['id', 'staff_uid', 'revision_type', 'status'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid' },
      revision_type: { type: 'string', enum: REVISION_TYPE },
      current_basic: { type: MT, nullable: true },
      proposed_basic: { type: MT, nullable: true },
      current_gross: { type: MT, nullable: true },
      proposed_gross: { type: MT, nullable: true },
      effective_from: { type: 'string', format: 'date' },
      status: { type: 'string', enum: REVISION_STATUS },
      reason: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
      staff_name: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      proposed_by_name: { type: 'string', nullable: true },
      hr_signed_by_name: { type: 'string', nullable: true },
      admin_signed_by_name: { type: 'string', nullable: true },
      rejected_by_name: { type: 'string', nullable: true },
    },
  },
  SalaryRevisionsResponse: listEnvelope('SalaryRevisionListItem'),

  // ---- getRevisionDetail GET /payroll/revisions/{id}. LIST != detail: same
  // columns MINUS rejected_by_name (only 4 person-name joins). STRICT. ----
  SalaryRevisionDetail: {
    type: 'object', additionalProperties: false,
    required: ['id', 'staff_uid', 'revision_type', 'status'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid' },
      revision_type: { type: 'string', enum: REVISION_TYPE },
      current_basic: { type: MT, nullable: true },
      proposed_basic: { type: MT, nullable: true },
      current_gross: { type: MT, nullable: true },
      proposed_gross: { type: MT, nullable: true },
      effective_from: { type: 'string', format: 'date' },
      status: { type: 'string', enum: REVISION_STATUS },
      reason: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
      staff_name: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      proposed_by_name: { type: 'string', nullable: true },
      hr_signed_by_name: { type: 'string', nullable: true },
      admin_signed_by_name: { type: 'string', nullable: true },
    },
  },
  SalaryRevisionDetailResponse: envelope('SalaryRevisionDetail'),

  // ---- proposeRevision RETURNING — WIDEST single-row tier (has
  // revision_number). status defaults pending_hr. STRICT. ----
  SalaryRevisionProposeResult: {
    type: 'object', additionalProperties: false,
    required: ['id', 'staff_uid', 'revision_type', 'status', 'revision_number'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid' },
      revision_type: { type: 'string', enum: REVISION_TYPE },
      current_basic: { type: MT, nullable: true },
      proposed_basic: { type: MT, nullable: true },
      status: { type: 'string', enum: REVISION_STATUS },
      reason: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
      revision_number: { type: 'string' },
    },
  },
  SalaryRevisionProposeResponse: envelope('SalaryRevisionProposeResult'),

  // ---- hr-sign / admin-sign / reject RETURNING — shared shape, propose MINUS
  // revision_number. STRICT. (status reaches pending_admin/approved/rejected; we
  // keep the full revision enum + the field non-null since RETURNING always
  // yields it.) ----
  SalaryRevisionSignResult: {
    type: 'object', additionalProperties: false,
    required: ['id', 'staff_uid', 'revision_type', 'status'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid' },
      revision_type: { type: 'string', enum: REVISION_TYPE },
      current_basic: { type: MT, nullable: true },
      proposed_basic: { type: MT, nullable: true },
      status: { type: 'string', enum: REVISION_STATUS },
      reason: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  SalaryRevisionSignResponse: envelope('SalaryRevisionSignResult'),

  // ---- applyRevision { revision_id, staff_uid }. TRAP: revision_id is the raw
  // req.params.id STRING (NOT the int column). STRICT. ----
  ApplyRevisionResult: {
    type: 'object', additionalProperties: false,
    required: ['revision_id', 'staff_uid'],
    properties: {
      revision_id: { type: 'string' },
      staff_uid: { type: 'string', format: 'uuid' },
    },
  },
  ApplyRevisionResponse: envelope('ApplyRevisionResult'),

  // ---- annual-review status. year is JS-computed → integer. ----
  // AnnualReviewItem: TRAP — years_of_service is SQL EXTRACT numeric →
  // serialized STRING (not a JS number). basic_salary Decimal|null. STRICT.
  AnnualReviewItem: {
    type: 'object', additionalProperties: false,
    required: ['uid'],
    properties: {
      uid: { type: 'string', format: 'uuid' },
      name: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      role: { type: 'string', nullable: true },
      basic_salary: { type: MT, nullable: true },
      date_of_joining: { type: 'string', format: 'date', nullable: true },
      years_of_service: { type: 'string', nullable: true },
      review_status: { type: 'string', nullable: true },
      reminder_id: { type: 'integer', nullable: true },
      revision_this_year: { type: 'string', nullable: true },
    },
  },
  AnnualReviewStatus: {
    type: 'object', additionalProperties: false,
    required: ['year', 'staff'],
    properties: {
      year: { type: 'integer' },
      staff: { type: 'array', items: { $ref: '#/components/schemas/AnnualReviewItem' } },
    },
  },
  AnnualReviewStatusResponse: envelope('AnnualReviewStatus'),

  // ---- calculateRevisionArrears union/superset. TRAP: top-level
  // arrears_amount is a JS-computed NUMBER (0 or Math.round), but the nested
  // result.arrears_amount is a Decimal-from-column STRING. months integer.
  // result only present on the full-success branch → optional. LOOSE. ----
  SalaryArrearsRow: {
    type: 'object', additionalProperties: false,
    required: ['id', 'from_month', 'from_year', 'to_month', 'to_year', 'arrears_amount'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      revision_id: { type: 'integer', nullable: true },
      from_month: { type: 'integer' },
      from_year: { type: 'integer' },
      to_month: { type: 'integer' },
      to_year: { type: 'integer' },
      arrears_amount: { type: MT },
      status: { type: 'string', nullable: true, enum: ARREARS_STATUS },
      calculated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  ArrearsResult: {
    type: 'object', additionalProperties: true,
    required: ['arrears_amount'],
    properties: {
      arrears_amount: { type: 'number' },
      message: { type: 'string' },
      months: { type: 'integer' },
      result: { $ref: '#/components/schemas/SalaryArrearsRow' },
    },
  },
  ArrearsResultResponse: envelope('ArrearsResult'),

  // ---- getBulkRevisions GET /payroll/bulk-revisions item: SELECT b.* +
  // created_by_name → all columns present → LOOSE. 2 money Decimals|null. ----
  BulkRevisionJobListItem: {
    type: 'object', additionalProperties: true,
    required: ['id', 'description', 'revision_type', 'target_type', 'status'],
    properties: {
      id: { type: 'integer' },
      description: { type: 'string' },
      revision_type: { type: 'string' },
      target_type: { type: 'string' },
      target_value: { type: 'string', nullable: true },
      increment_type: { type: 'string', nullable: true },
      increment_value: { type: MT, nullable: true },
      bonus_amount: { type: MT, nullable: true },
      effective_from: { type: 'string', format: 'date' },
      staff_count: { type: 'integer', nullable: true },
      processed_count: { type: 'integer', nullable: true },
      status: { type: 'string', nullable: true, enum: BULK_REVISION_STATUS },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      completed_at: { type: 'string', format: 'date-time', nullable: true },
      error_log: { type: 'string', nullable: true },
      created_by: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
      created_by_name: { type: 'string', nullable: true },
    },
  },
  BulkRevisionsResponse: listEnvelope('BulkRevisionJobListItem'),

  // ---- createBulkRevision curated select — narrower than list (no
  // processed_count/approved_*/completed_at/error_log/updated_at). status=draft.
  // STRICT. ----
  BulkRevisionJob: {
    type: 'object', additionalProperties: false,
    required: ['id', 'description', 'revision_type', 'target_type', 'staff_count', 'status'],
    properties: {
      id: { type: 'integer' },
      description: { type: 'string' },
      revision_type: { type: 'string' },
      target_type: { type: 'string' },
      target_value: { type: 'string', nullable: true },
      increment_type: { type: 'string', nullable: true },
      increment_value: { type: MT, nullable: true },
      bonus_amount: { type: MT, nullable: true },
      effective_from: { type: 'string', format: 'date-time' },
      staff_count: { type: 'integer' },
      status: { type: 'string', nullable: true, enum: BULK_REVISION_STATUS },
      created_by: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },
  BulkRevisionJobResponse: envelope('BulkRevisionJob'),

  // ---- approveBulkRevision synthetic object. TRAPS: id is raw req.params.id
  // STRING (not int); status is the HTTP-only literal 'processing' (NOT a DB
  // enum value) → typed as a free string, not against BULK_REVISION_STATUS. ----
  ApproveBulkRevisionResult: {
    type: 'object', additionalProperties: false,
    required: ['id', 'status', 'staff_count'],
    properties: {
      id: { type: 'string' },
      status: { type: 'string', example: 'processing' },
      staff_count: { type: 'integer' },
    },
  },
  ApproveBulkRevisionResponse: envelope('ApproveBulkRevisionResult'),

  // ---- salary-revisions request bodies (no express-validator → permissive). ----
  ProposeRevisionRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from salaryRevisionController.proposeRevision; not validator-backed.',
    properties: {
      staff_uid: { type: 'string', format: 'uuid' },
      revision_type: { type: 'string', enum: REVISION_TYPE },
      proposed_basic: { type: 'number' },
      increment_amount: { type: 'number' },
      increment_pct: { type: 'number' },
      bonus_amount: { type: 'number' },
      effective_from: { type: 'string', format: 'date' },
      reason: { type: 'string' },
    },
  },
  RevisionSignRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from salaryRevisionController hr-sign / admin-sign; not validator-backed.',
    properties: { comment: { type: 'string' } },
  },
  RevisionRejectRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from salaryRevisionController.rejectRevision; not validator-backed.',
    properties: { reason: { type: 'string' } },
  },
  CreateBulkRevisionRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.createBulkRevision; not validator-backed.',
    properties: {
      description: { type: 'string' },
      revision_type: { type: 'string' },
      target_type: { type: 'string' },
      target_value: { type: 'string' },
      increment_type: { type: 'string' },
      increment_value: { type: 'number' },
      bonus_amount: { type: 'number' },
      effective_from: { type: 'string', format: 'date' },
    },
  },
};

export const operations = {
  // ---- payroll-runs ----
  'GET /api/v1/staff/admin/payroll/runs': { response: 'PayrollRunsResponse' },
  'GET /api/v1/staff/admin/payroll/runs/{runId}': { response: 'PayrollRunDetailResponse' },
  'POST /api/v1/staff/admin/payroll/run': { request: 'RunPayrollRequest', response: 'PayrollRunResultResponse' },
  'POST /api/v1/staff/admin/payroll/issue': { request: 'IssuePayslipsRequest', response: 'IssuePayslipsResponse' },
  'POST /api/v1/staff/admin/payroll/payslips/{id}/edit': { request: 'EditPayslipRequest', response: 'PayslipDetailResponse' },
  'POST /api/v1/staff/admin/payroll/runs/{runId}/hr-sign': { request: 'SignPayrollRunRequest', response: 'PayrollRunResponse' },
  'POST /api/v1/staff/admin/payroll/runs/{runId}/admin-sign': { request: 'SignPayrollRunRequest', response: 'PayrollRunResponse' },

  // ---- salary-config ----
  'GET /api/v1/staff/admin/payroll/staff': { response: 'StaffForPayrollResponse' },
  'GET /api/v1/staff/admin/payroll/salary/{staffUid}': { response: 'StaffSalaryConfigViewResponse' },
  'POST /api/v1/staff/admin/payroll/salary/{staffUid}': { request: 'UpsertSalaryConfigRequest', response: 'StaffSalaryConfigResponse' },

  // ---- salary-revisions ----
  'GET /api/v1/staff/admin/payroll/revisions': { response: 'SalaryRevisionsResponse' },
  'GET /api/v1/staff/admin/payroll/revisions/{id}': { response: 'SalaryRevisionDetailResponse' },
  'GET /api/v1/staff/admin/payroll/annual-review': { response: 'AnnualReviewStatusResponse' },
  'POST /api/v1/staff/admin/payroll/revisions/propose': { request: 'ProposeRevisionRequest', response: 'SalaryRevisionProposeResponse' },
  'POST /api/v1/staff/admin/payroll/revisions/{id}/hr-sign': { request: 'RevisionSignRequest', response: 'SalaryRevisionSignResponse' },
  'POST /api/v1/staff/admin/payroll/revisions/{id}/admin-sign': { request: 'RevisionSignRequest', response: 'SalaryRevisionSignResponse' },
  'POST /api/v1/staff/admin/payroll/revisions/{id}/apply': { response: 'ApplyRevisionResponse' },
  'POST /api/v1/staff/admin/payroll/revisions/{id}/reject': { request: 'RevisionRejectRequest', response: 'SalaryRevisionSignResponse' },
  'POST /api/v1/staff/admin/payroll/revisions/{revisionId}/arrears': { response: 'ArrearsResultResponse' },
  'GET /api/v1/staff/admin/payroll/bulk-revisions': { response: 'BulkRevisionsResponse' },
  'POST /api/v1/staff/admin/payroll/bulk-revisions/create': { request: 'CreateBulkRevisionRequest', response: 'BulkRevisionJobResponse' },
  'POST /api/v1/staff/admin/payroll/bulk-revisions/{id}/approve': { response: 'ApproveBulkRevisionResponse' },
};
