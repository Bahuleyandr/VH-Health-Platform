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

// ---- PASS B enums (separations + queries-compliance). Same null-free rule:
// nullable status fields keep a null-free enum + nullable:true. ----
// salary_advances.status: pending (default) -> approved -> cleared
const ADVANCE_STATUS = ['pending', 'approved', 'cleared'];
// full_final_settlements.status: draft (default) -> hr_approved -> admin_approved -> paid
const FNF_STATUS = ['draft', 'hr_approved', 'admin_approved', 'paid'];
// leave_encashments.status: pending (default) -> approved
const LEAVE_ENCASHMENT_STATUS = ['pending', 'approved'];
// investment_declarations.status: draft (default) -> submitted -> locked -> approved
const DECLARATION_STATUS = ['draft', 'submitted', 'locked', 'approved'];
// payslip_queries.status: open (default) -> in_review -> resolved
const PAYSLIP_QUERY_STATUS = ['open', 'in_review', 'resolved'];
// compliance-calendar deadline.status — JS literal (NOT a DB column)
const COMPLIANCE_DEADLINE_STATUS = ['ready', 'pending', 'manual'];
// compliance-calendar deadline.type — JS literal
const COMPLIANCE_DEADLINE_TYPE = ['pf', 'esi', 'tds', 'annual_tds', 'form16'];
// ComparisonPayslip reuses PAYSLIP_STATUS (draft/issued/viewed/downloaded), already declared above.

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
      date_of_joining: { type: 'string', format: 'date-time', nullable: true },
      pan_number: { type: 'string', nullable: true },
      pf_uan: { type: 'string', nullable: true },
      bank_account: { type: 'string', nullable: true },
      bank_name: { type: 'string', nullable: true },
      bank_ifsc: { type: 'string', nullable: true },
      effective_from: { type: 'string', format: 'date-time', nullable: true },
      is_active: { type: 'boolean', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      notice_period_days: { type: 'integer', nullable: true },
      dob: { type: 'string', format: 'date-time', nullable: true },
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
      date_of_joining: { type: 'string', format: 'date-time', nullable: true },
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
      // effective_from (@db.Date NOT NULL) + reason (String NOT NULL) are
      // non-null columns — correctly NOT nullable here (review fix 2026-06-26).
      effective_from: { type: 'string', format: 'date-time' },
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
      effective_from: { type: 'string', format: 'date-time' },
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
      date_of_joining: { type: 'string', format: 'date-time', nullable: true },
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
      effective_from: { type: 'string', format: 'date-time' },
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

  // =====================================================================
  // SUB-DOMAIN: separations  (advances / fnf / gratuity / leave-encashment)
  // PASS B.
  // =====================================================================

  // ---- getAllAdvances GET /payroll/advances item: SELECT sa.* + staff_name,
  // department + computed balance_remaining. SELECT * → leaks tenant_id → LOOSE.
  // TRAP: balance_remaining = (sa.amount - sa.total_deducted) computed in SQL →
  // serializes as a Decimal STRING, NOT a JS number. amount/monthly_deduction
  // (NOT NULL) → required strings. (PayrollAdvance* prefix avoids the money.mjs
  // `Advance` collision.) ----
  PayrollAdvanceListItem: {
    type: 'object', additionalProperties: true,
    required: ['id', 'amount', 'reason', 'monthly_deduction', 'balance_remaining'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      amount: { type: MT },
      reason: { type: 'string' },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', nullable: true, enum: ADVANCE_STATUS },
      monthly_deduction: { type: MT },
      total_deducted: { type: MT, nullable: true },
      months_remaining: { type: 'integer', nullable: true },
      deduction_start_month: { type: 'integer', nullable: true },
      deduction_start_year: { type: 'integer', nullable: true },
      fully_cleared_at: { type: 'string', format: 'date-time', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      staff_name: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      balance_remaining: { type: MT },
    },
  },
  PayrollAdvancesResponse: listEnvelope('PayrollAdvanceListItem'),

  // ---- createAdvance RETURNING subset (explicit list, no tenant_id/updated_at/
  // fully_cleared_at) → STRICT. amount/monthly_deduction Decimal-from-column →
  // string. status hardcoded 'approved'. ----
  PayrollAdvance: {
    type: 'object', additionalProperties: false,
    required: ['id', 'amount', 'reason', 'monthly_deduction'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      amount: { type: MT },
      reason: { type: 'string' },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', nullable: true, enum: ADVANCE_STATUS },
      monthly_deduction: { type: MT },
      months_remaining: { type: 'integer', nullable: true },
      total_deducted: { type: MT, nullable: true },
      deduction_start_month: { type: 'integer', nullable: true },
      deduction_start_year: { type: 'integer', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  PayrollAdvanceResponse: envelope('PayrollAdvance'),

  // ---- getFnFList GET /payroll/fnf item: SELECT f.* + staff_name, department,
  // designation, employee_id. SELECT * → leaks tenant_id → LOOSE. Every money
  // column Decimal → string; years_of_service Decimal(5,2) → string. ----
  FnFListItem: {
    type: 'object', additionalProperties: true,
    required: ['id', 'separation_type', 'last_working_day'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      separation_type: { type: 'string' },
      last_working_day: { type: 'string', format: 'date-time' },
      last_month_days_worked: { type: 'integer', nullable: true },
      last_month_basic: { type: MT, nullable: true },
      last_month_allowances: { type: MT, nullable: true },
      earned_leave_balance: { type: 'integer', nullable: true },
      leave_encashment_amount: { type: MT, nullable: true },
      notice_period_days: { type: 'integer', nullable: true },
      notice_shortfall_days: { type: 'integer', nullable: true },
      notice_recovery_amount: { type: MT, nullable: true },
      years_of_service: { type: MT, nullable: true },
      gratuity_eligible: { type: 'boolean', nullable: true },
      gratuity_amount: { type: MT, nullable: true },
      bonus_payable: { type: MT, nullable: true },
      other_deductions: { type: MT, nullable: true },
      other_deductions_reason: { type: 'string', nullable: true },
      gross_payable: { type: MT, nullable: true },
      total_deductions: { type: MT, nullable: true },
      net_payable: { type: MT, nullable: true },
      status: { type: 'string', nullable: true, enum: FNF_STATUS },
      hr_approved_by: { type: 'string', format: 'uuid', nullable: true },
      hr_approved_at: { type: 'string', format: 'date-time', nullable: true },
      admin_approved_by: { type: 'string', format: 'uuid', nullable: true },
      admin_approved_at: { type: 'string', format: 'date-time', nullable: true },
      payment_date: { type: 'string', format: 'date-time', nullable: true },
      payment_reference: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      created_by: { type: 'string', format: 'uuid', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      staff_name: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      designation: { type: 'string', nullable: true },
      employee_id: { type: 'string', nullable: true },
    },
  },
  FnFListResponse: listEnvelope('FnFListItem'),

  // ---- FNF_DETAIL_SELECT — shared by createFnF / approveFnF / markFnFPaid.
  // Curated subset (excludes earned_leave_balance, leave_encashment_amount,
  // created_by, tenant_id) → STRICT. All money columns Decimal → string EVEN
  // though JS-computed (they round-trip through the NUMERIC column + are read
  // back via select). ----
  FnFDetail: {
    type: 'object', additionalProperties: false,
    required: ['id', 'separation_type', 'last_working_day'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      separation_type: { type: 'string' },
      last_working_day: { type: 'string', format: 'date-time' },
      last_month_days_worked: { type: 'integer', nullable: true },
      last_month_basic: { type: MT, nullable: true },
      last_month_allowances: { type: MT, nullable: true },
      notice_period_days: { type: 'integer', nullable: true },
      notice_shortfall_days: { type: 'integer', nullable: true },
      notice_recovery_amount: { type: MT, nullable: true },
      years_of_service: { type: MT, nullable: true },
      gratuity_eligible: { type: 'boolean', nullable: true },
      gratuity_amount: { type: MT, nullable: true },
      bonus_payable: { type: MT, nullable: true },
      other_deductions: { type: MT, nullable: true },
      other_deductions_reason: { type: 'string', nullable: true },
      gross_payable: { type: MT, nullable: true },
      total_deductions: { type: MT, nullable: true },
      net_payable: { type: MT, nullable: true },
      status: { type: 'string', nullable: true, enum: FNF_STATUS },
      hr_approved_by: { type: 'string', format: 'uuid', nullable: true },
      hr_approved_at: { type: 'string', format: 'date-time', nullable: true },
      admin_approved_by: { type: 'string', format: 'uuid', nullable: true },
      admin_approved_at: { type: 'string', format: 'date-time', nullable: true },
      payment_date: { type: 'string', format: 'date-time', nullable: true },
      payment_reference: { type: 'string', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  FnFDetailResponse: envelope('FnFDetail'),

  // ---- getAllGratuityStatus GET /payroll/gratuity item. FULLY JS-computed
  // object (no DB row, no tenant_id) → STRICT. TRAP: years_of_service &
  // projected_gratuity are JS Math.round NUMBERS (not Decimal strings);
  // days_to_five_years integer. No status string — gratuity_eligible boolean. ----
  GratuityStatus: {
    type: 'object', additionalProperties: false,
    required: ['staff_uid', 'date_of_joining', 'years_of_service', 'gratuity_eligible', 'projected_gratuity', 'days_to_five_years'],
    properties: {
      staff_uid: { type: 'string', format: 'uuid' },
      name: { type: 'string', nullable: true },
      employee_id: { type: 'string', nullable: true },
      designation: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      date_of_joining: { type: 'string', format: 'date-time' },
      years_of_service: { type: 'number' },
      gratuity_eligible: { type: 'boolean' },
      projected_gratuity: { type: 'number' },
      days_to_five_years: { type: 'integer' },
    },
  },
  GratuityStatusResponse: listEnvelope('GratuityStatus'),

  // ---- getLeaveEncashments GET /payroll/leave-encashment item: SELECT le.* +
  // staff_name, employee_id. SELECT * → leaks tenant_id → LOOSE. daily_rate/
  // amount are NOT NULL Decimal columns → required strings. leave_days integer.
  // No updated_at column on this table. ----
  LeaveEncashmentListItem: {
    type: 'object', additionalProperties: true,
    required: ['id', 'encashment_type', 'leave_days', 'daily_rate', 'amount'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      encashment_type: { type: 'string' },
      leave_days: { type: 'integer' },
      daily_rate: { type: MT },
      amount: { type: MT },
      financial_year: { type: 'string', nullable: true },
      payslip_id: { type: 'integer', nullable: true },
      fnf_id: { type: 'integer', nullable: true },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', nullable: true, enum: LEAVE_ENCASHMENT_STATUS },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      staff_name: { type: 'string', nullable: true },
      employee_id: { type: 'string', nullable: true },
    },
  },
  LeaveEncashmentListResponse: listEnvelope('LeaveEncashmentListItem'),

  // ---- calculateLeaveEncashment curated select (no payslip_id/fnf_id/tenant_id)
  // → STRICT. TRAP: daily_rate/amount JS-computed but round-trip through Decimal
  // columns + read back via select → STRINGS (not numbers). status='approved'. ----
  LeaveEncashment: {
    type: 'object', additionalProperties: false,
    required: ['id', 'encashment_type', 'leave_days', 'daily_rate', 'amount'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      encashment_type: { type: 'string' },
      leave_days: { type: 'integer' },
      daily_rate: { type: MT },
      amount: { type: MT },
      financial_year: { type: 'string', nullable: true },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', nullable: true, enum: LEAVE_ENCASHMENT_STATUS },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  LeaveEncashmentResponse: envelope('LeaveEncashment'),

  // ---- separations request bodies (no express-validator → permissive). ----
  CreateAdvanceRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.createAdvance; not validator-backed.',
    properties: {
      staff_uid: { type: 'string', format: 'uuid' },
      amount: { type: 'number' },
      reason: { type: 'string' },
      monthly_deduction: { type: 'number' },
      deduction_start_month: { type: 'integer' },
      deduction_start_year: { type: 'integer' },
      notes: { type: 'string' },
    },
  },
  CreateFnFRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.createFnF; not validator-backed.',
    properties: {
      staff_uid: { type: 'string', format: 'uuid' },
      separation_type: { type: 'string' },
      last_working_day: { type: 'string', format: 'date' },
      notice_period_days: { type: 'integer' },
      notice_shortfall_days: { type: 'integer' },
      bonus_payable: { type: 'number' },
      other_deductions: { type: 'number' },
      other_deductions_reason: { type: 'string' },
      notes: { type: 'string' },
    },
  },
  FnFApproveRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.approveFnF; not validator-backed.',
    properties: { comment: { type: 'string' } },
  },
  FnFMarkPaidRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.markFnFPaid; not validator-backed.',
    properties: {
      payment_date: { type: 'string', format: 'date' },
      payment_reference: { type: 'string' },
    },
  },
  CreateLeaveEncashmentRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.calculateLeaveEncashment; not validator-backed.',
    properties: {
      staff_uid: { type: 'string', format: 'uuid' },
      encashment_type: { type: 'string' },
      leave_days: { type: 'integer' },
      financial_year: { type: 'string' },
    },
  },

  // =====================================================================
  // SUB-DOMAIN: queries-compliance
  // (tax-summary/all, comparison, generate-payroll-data, declarations(+approve),
  //  queries(+reply), compliance-calendar)
  // PASS B.
  // =====================================================================

  // ---- generateAllTaxSummaries POST /payroll/tax-summary/all. JS counters. ----
  GenerateTaxSummariesResult: {
    type: 'object', additionalProperties: false,
    required: ['generated', 'failed'],
    properties: {
      generated: { type: 'integer' },
      failed: { type: 'integer' },
    },
  },
  GenerateTaxSummariesResponse: envelope('GenerateTaxSummariesResult'),
  GenerateTaxSummariesRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.generateAllTaxSummaries; not validator-backed.',
    properties: { financial_year: { type: 'string' } },
  },

  // ---- getPayrollComparison GET /payroll/comparison. TRAP: ComparisonPayslip
  // money fields are parseFloat'd in JS → NUMBERS (basic_earned..net_salary,
  // pf, esi, tds, advance_deduction, bonus, arrears), BUT lop_days/overtime_hours
  // are emitted RAW from the Decimal column → STRINGS. days_present/days_absent
  // raw int columns. The outer wrapper is LOOSE (nested JS object). ----
  ComparisonPayslip: {
    type: 'object', additionalProperties: false,
    required: ['month', 'year', 'basic_earned', 'gross_salary', 'net_salary', 'total_deductions', 'status'],
    properties: {
      month: { type: 'integer' },
      year: { type: 'integer' },
      days_present: { type: 'integer', nullable: true },
      days_absent: { type: 'integer', nullable: true },
      lop_days: { type: MT, nullable: true },
      overtime_hours: { type: MT, nullable: true },
      basic_earned: { type: 'number' },
      hra_earned: { type: 'number' },
      da_earned: { type: 'number' },
      special_allowance: { type: 'number' },
      transport_allowance: { type: 'number' },
      medical_allowance: { type: 'number' },
      overtime_pay: { type: 'number' },
      bonus: { type: 'number' },
      arrears: { type: 'number' },
      gross_salary: { type: 'number' },
      pf: { type: 'number' },
      esi: { type: 'number' },
      professional_tax: { type: 'number' },
      tds: { type: 'number' },
      advance_deduction: { type: 'number' },
      total_deductions: { type: 'number' },
      net_salary: { type: 'number' },
      status: { type: 'string', enum: PAYSLIP_STATUS },
    },
  },
  PayrollComparisonStaff: {
    type: 'object', additionalProperties: false,
    required: ['staff_uid', 'payslips'],
    properties: {
      staff_uid: { type: 'string', format: 'uuid' },
      name: { type: 'string', nullable: true },
      employee_id: { type: 'string', nullable: true },
      designation: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      payslips: { type: 'array', items: { $ref: '#/components/schemas/ComparisonPayslip' } },
    },
  },
  PayrollComparisonMonth: {
    type: 'object', additionalProperties: false,
    required: ['month', 'year'],
    properties: {
      month: { type: 'integer' },
      year: { type: 'integer' },
    },
  },
  PayrollComparison: {
    type: 'object', additionalProperties: true,
    required: ['month_range', 'staff', 'total_staff', 'total_payslips'],
    properties: {
      month_range: { type: 'array', items: { $ref: '#/components/schemas/PayrollComparisonMonth' } },
      staff: { type: 'array', items: { $ref: '#/components/schemas/PayrollComparisonStaff' } },
      total_staff: { type: 'integer' },
      total_payslips: { type: 'integer' },
    },
  },
  PayrollComparisonResponse: envelope('PayrollComparison'),

  // ---- generatePayrollData POST /generate-payroll-data (NB: top-level
  // staff-admin route, NO /payroll prefix). Aggregate query. TRAP: base_salary =
  // staff.base_salary Decimal → string; days_worked/leaves_taken = bigint COUNT
  // → INTEGER. Prisma yields a JS BigInt, and the app's BigInt.prototype.toJSON
  // serializer (bin/www.js in prod, jest.setup.cjs in test) emits a NUMBER for
  // every safe-integer value — and a COUNT is always a small safe integer — so
  // these serialize as JSON numbers, NOT strings. overtime_hours = numeric
  // aggregate → string|null. month/year echoed raw from req.body (untyped). LOOSE. ----
  PayrollDataRow: {
    type: 'object', additionalProperties: true,
    required: ['days_worked', 'leaves_taken'],
    properties: {
      employee_id: { type: 'string', nullable: true },
      name: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      base_salary: { type: MT, nullable: true },
      days_worked: { type: 'integer' },
      overtime_hours: { type: MT, nullable: true },
      leaves_taken: { type: 'integer' },
    },
  },
  GeneratePayrollDataResult: {
    type: 'object', additionalProperties: true,
    required: ['payrollData', 'generatedAt'],
    properties: {
      payrollData: { type: 'array', items: { $ref: '#/components/schemas/PayrollDataRow' } },
      // month/year echoed from req.body with no coercion — type unconstrained.
      month: {},
      year: {},
      generatedAt: { type: 'string', format: 'date-time' },
    },
  },
  GeneratePayrollDataResponse: envelope('GeneratePayrollDataResult'),
  GeneratePayrollDataRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from POST /api/v1/staff/admin/generate-payroll-data; not validator-backed.',
    properties: {
      month: { type: 'integer' },
      year: { type: 'integer' },
    },
  },

  // ---- getAllDeclarations GET /payroll/declarations item: SELECT d.* +
  // staff_name, department, designation, employee_id. SELECT * → leaks tenant_id
  // → LOOSE. 15 investment amounts Decimal(10,2) → string|null. The admin handler
  // does NOT add the computed section_80c/etc fields. ----
  DeclarationListItem: {
    type: 'object', additionalProperties: true,
    required: ['id', 'financial_year'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      financial_year: { type: 'string' },
      ppf: { type: MT, nullable: true },
      epf_voluntary: { type: MT, nullable: true },
      elss: { type: MT, nullable: true },
      lic_premium: { type: MT, nullable: true },
      nsc: { type: MT, nullable: true },
      home_loan_principal: { type: MT, nullable: true },
      tuition_fees: { type: MT, nullable: true },
      other_80c: { type: MT, nullable: true },
      health_insurance_self: { type: MT, nullable: true },
      health_insurance_parents: { type: MT, nullable: true },
      education_loan_interest: { type: MT, nullable: true },
      rent_paid_monthly: { type: MT, nullable: true },
      rent_receipt_provided: { type: 'boolean', nullable: true },
      home_loan_interest: { type: MT, nullable: true },
      nps_contribution: { type: MT, nullable: true },
      status: { type: 'string', nullable: true, enum: DECLARATION_STATUS },
      submitted_at: { type: 'string', format: 'date-time', nullable: true },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      proof_submitted: { type: 'boolean', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      staff_name: { type: 'string', nullable: true },
      department: { type: 'string', nullable: true },
      designation: { type: 'string', nullable: true },
      employee_id: { type: 'string', nullable: true },
    },
  },
  DeclarationListResponse: listEnvelope('DeclarationListItem'),

  // ---- approveDeclaration via DECLARATION_SELECT (excludes proof_submitted,
  // tenant_id, joins) → STRICT. NOT the same schema as DeclarationListItem.
  // 15 amounts string|null. status='approved'. ----
  Declaration: {
    type: 'object', additionalProperties: false,
    required: ['id', 'financial_year'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      financial_year: { type: 'string' },
      ppf: { type: MT, nullable: true },
      epf_voluntary: { type: MT, nullable: true },
      elss: { type: MT, nullable: true },
      lic_premium: { type: MT, nullable: true },
      nsc: { type: MT, nullable: true },
      home_loan_principal: { type: MT, nullable: true },
      tuition_fees: { type: MT, nullable: true },
      other_80c: { type: MT, nullable: true },
      health_insurance_self: { type: MT, nullable: true },
      health_insurance_parents: { type: MT, nullable: true },
      education_loan_interest: { type: MT, nullable: true },
      rent_paid_monthly: { type: MT, nullable: true },
      rent_receipt_provided: { type: 'boolean', nullable: true },
      home_loan_interest: { type: MT, nullable: true },
      nps_contribution: { type: MT, nullable: true },
      notes: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true, enum: DECLARATION_STATUS },
      submitted_at: { type: 'string', format: 'date-time', nullable: true },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  DeclarationResponse: envelope('Declaration'),
  ApproveDeclarationRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.approveDeclaration; not validator-backed.',
    properties: { notes: { type: 'string' } },
  },

  // ---- getAllPayslipQueries GET /payroll/queries item: SELECT pq.* + month,
  // year, net_salary(joined p.net_salary Decimal → string), staff_name,
  // employee_id + replies. SELECT * → leaks tenant_id → LOOSE. TRAP: replies is a
  // json_agg subquery → array OR null (json_agg returns NULL on empty). ----
  PayslipQueryReply: {
    type: 'object', additionalProperties: true,
    required: ['id'],
    properties: {
      id: { type: 'integer' },
      query_id: { type: 'integer', nullable: true },
      author_uid: { type: 'string', format: 'uuid', nullable: true },
      author_role: { type: 'string', nullable: true },
      message: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid', nullable: true },
    },
  },
  PayslipQueryListItem: {
    type: 'object', additionalProperties: true,
    required: ['id', 'staff_uid', 'subject', 'description'],
    properties: {
      id: { type: 'integer' },
      payslip_id: { type: 'integer', nullable: true },
      staff_uid: { type: 'string', format: 'uuid' },
      subject: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true, enum: PAYSLIP_QUERY_STATUS },
      resolved_by: { type: 'string', format: 'uuid', nullable: true },
      resolved_at: { type: 'string', format: 'date-time', nullable: true },
      resolution_note: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      month: { type: 'integer', nullable: true },
      year: { type: 'integer', nullable: true },
      net_salary: { type: MT, nullable: true },
      staff_name: { type: 'string', nullable: true },
      employee_id: { type: 'string', nullable: true },
      replies: { type: 'array', nullable: true, items: { $ref: '#/components/schemas/PayslipQueryReply' } },
    },
  },
  PayslipQueryListResponse: listEnvelope('PayslipQueryListItem'),

  // ---- replyToPayslipQuery findUnique subset (no money/tenant_id/replies) →
  // STRICT. NOT the same schema as the list item. status='resolved'|'in_review'. ----
  PayslipQuery: {
    type: 'object', additionalProperties: false,
    required: ['id', 'staff_uid', 'subject', 'description'],
    properties: {
      id: { type: 'integer' },
      payslip_id: { type: 'integer', nullable: true },
      staff_uid: { type: 'string', format: 'uuid' },
      subject: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true, enum: PAYSLIP_QUERY_STATUS },
      resolved_by: { type: 'string', format: 'uuid', nullable: true },
      resolved_at: { type: 'string', format: 'date-time', nullable: true },
      resolution_note: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  PayslipQueryResponse: envelope('PayslipQuery'),
  PayslipQueryReplyRequest: {
    type: 'object', additionalProperties: true,
    description: 'Reverse-engineered from payrollController.replyToPayslipQuery; not validator-backed.',
    required: ['message'],
    properties: {
      message: { type: 'string' },
      resolve: { type: 'boolean' },
    },
  },

  // ---- getComplianceCalendar GET /payroll/compliance-calendar. FULLY
  // JS-computed wrapper { deadlines[], current_month, current_year }. The
  // deadline status/type are JS literals (NULL-FREE enums, not DB columns); note
  // is optional (only on the TDS quarterly entry). All numerics JS → integer. ----
  ComplianceDeadline: {
    type: 'object', additionalProperties: false,
    required: ['label', 'due_date', 'due_in_days', 'status', 'type'],
    properties: {
      label: { type: 'string' },
      due_date: { type: 'string', format: 'date' },
      due_in_days: { type: 'integer' },
      status: { type: 'string', enum: COMPLIANCE_DEADLINE_STATUS },
      type: { type: 'string', enum: COMPLIANCE_DEADLINE_TYPE },
      note: { type: 'string' },
    },
  },
  ComplianceCalendar: {
    type: 'object', additionalProperties: false,
    required: ['deadlines', 'current_month', 'current_year'],
    properties: {
      deadlines: { type: 'array', items: { $ref: '#/components/schemas/ComplianceDeadline' } },
      current_month: { type: 'integer' },
      current_year: { type: 'integer' },
    },
  },
  ComplianceCalendarResponse: envelope('ComplianceCalendar'),

  // ---- statutory-exports (GET /payroll/export/{summary,pf,esi}): these 3
  // endpoints return a text/csv body via res.send(), NOT a JSON envelope, so they
  // are INTENTIONALLY LEFT UNTYPED — not keyed in operations{} below. The generic
  // 200 already in openapi.json is the correct representation for a CSV body. ----

  // =====================================================================
  // SUB-DOMAIN: hr-self-service  (/api/v1/staff/hr/payroll/* — the staff's
  // OWN payslips / advances / declarations / queries / tax-summary). PASS C
  // (final sub-domain). Same null-free-enum + Decimal-string rules as the
  // admin overlay above; reuses PAYSLIP_STATUS / ADVANCE_STATUS /
  // DECLARATION_STATUS / PAYSLIP_QUERY_STATUS. ----
  // =====================================================================

  // ---- getMyPayslips GET /payroll/my-payslips item. Curated explicit SELECT
  // (p.id..p.pf_employee, no tenant_id) → STRICT. Every money column is
  // Decimal-from-column → string; days_present/days_absent raw int columns. ----
  MyPayslipListItem: {
    type: 'object', additionalProperties: false,
    required: ['id', 'month', 'year', 'status'],
    properties: {
      id: { type: 'integer' },
      month: { type: 'integer' },
      year: { type: 'integer' },
      gross_salary: { type: MT },
      net_salary: { type: MT },
      total_deductions: { type: MT },
      days_present: { type: 'integer', nullable: true },
      days_absent: { type: 'integer', nullable: true },
      status: { type: 'string', enum: PAYSLIP_STATUS },
      issued_at: { type: 'string', format: 'date-time', nullable: true },
      pdf_key: { type: 'string', nullable: true },
      basic_earned: { type: MT },
      overtime_pay: { type: MT },
      pf_employee: { type: MT },
    },
  },
  MyPayslipListResponse: listEnvelope('MyPayslipListItem'),

  // ---- getPayslipDetail GET /payroll/my-payslips/{id}. Curated explicit
  // SELECT (no tenant_id) + JS-spread pdf_url. LIST != detail — adds 11 columns
  // (staff_uid, payroll_run_id, the hra/da/special/.../esi/professional_tax/tds
  // breakdown, pdf_url) and DROPS days_present/days_absent/issued_at. STRICT.
  // gross_salary/total_deductions/net_salary read BACK from the NUMERIC column
  // → string. ----
  MyPayslipDetail: {
    type: 'object', additionalProperties: false,
    required: ['id', 'staff_uid', 'month', 'year', 'status'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid' },
      month: { type: 'integer' },
      year: { type: 'integer' },
      payroll_run_id: { type: 'integer', nullable: true },
      basic_earned: { type: MT },
      hra_earned: { type: MT },
      da_earned: { type: MT },
      special_allowance_earned: { type: MT },
      transport_allowance_earned: { type: MT },
      medical_allowance_earned: { type: MT },
      overtime_pay: { type: MT },
      gross_salary: { type: MT },
      pf_employee: { type: MT },
      esi_employee: { type: MT },
      professional_tax: { type: MT },
      tds: { type: MT },
      total_deductions: { type: MT },
      net_salary: { type: MT },
      status: { type: 'string', enum: PAYSLIP_STATUS },
      pdf_key: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      pdf_url: { type: 'string', nullable: true },
    },
  },
  MyPayslipDetailResponse: envelope('MyPayslipDetail'),

  // ---- getMyAdvances GET /payroll/advances item: SELECT sa.* + approved_by_name
  // + computed balance_remaining. SELECT * → leaks tenant_id → LOOSE. TRAP:
  // balance_remaining = (sa.amount - sa.total_deducted) computed in SQL →
  // Decimal STRING. amount NOT NULL → required string. ----
  OwnAdvanceItem: {
    type: 'object', additionalProperties: true,
    required: ['id', 'amount'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      amount: { type: MT },
      reason: { type: 'string' },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      status: { type: 'string', nullable: true, enum: ADVANCE_STATUS },
      monthly_deduction: { type: MT },
      total_deducted: { type: MT, nullable: true },
      months_remaining: { type: 'integer', nullable: true },
      deduction_start_month: { type: 'integer', nullable: true },
      deduction_start_year: { type: 'integer', nullable: true },
      fully_cleared_at: { type: 'string', format: 'date-time', nullable: true },
      notes: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      approved_by_name: { type: 'string', nullable: true },
      balance_remaining: { type: MT },
    },
  },
  OwnAdvancesResponse: listEnvelope('OwnAdvanceItem'),

  // ---- getMyDeclarations GET /payroll/declarations item. Curated explicit
  // SELECT (no tenant_id) + 5 SQL-computed string aggregates (section_80c,
  // section_80d, hra_exemption, lta, other_deductions). STRICT. The 14 investment
  // amounts are Decimal(10,2) columns → string|null; the 5 computed are
  // SUM/COALESCE/0::numeric expressions → Decimal STRING. ----
  MyDeclaration: {
    type: 'object', additionalProperties: false,
    required: ['id', 'financial_year'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      financial_year: { type: 'string' },
      ppf: { type: MT, nullable: true },
      epf_voluntary: { type: MT, nullable: true },
      elss: { type: MT, nullable: true },
      lic_premium: { type: MT, nullable: true },
      nsc: { type: MT, nullable: true },
      home_loan_principal: { type: MT, nullable: true },
      tuition_fees: { type: MT, nullable: true },
      other_80c: { type: MT, nullable: true },
      health_insurance_self: { type: MT, nullable: true },
      health_insurance_parents: { type: MT, nullable: true },
      education_loan_interest: { type: MT, nullable: true },
      rent_paid_monthly: { type: MT, nullable: true },
      home_loan_interest: { type: MT, nullable: true },
      nps_contribution: { type: MT, nullable: true },
      rent_receipt_provided: { type: 'boolean', nullable: true },
      notes: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true, enum: DECLARATION_STATUS },
      submitted_at: { type: 'string', format: 'date-time', nullable: true },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      proof_submitted: { type: 'boolean', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      section_80c: { type: MT },
      section_80d: { type: MT },
      hra_exemption: { type: MT },
      lta: { type: MT },
      other_deductions: { type: MT },
    },
  },
  MyDeclarationsResponse: listEnvelope('MyDeclaration'),

  // ---- upsertDeclaration POST /payroll/declarations/submit via
  // DECLARATION_SELECT. DIFFERENT from MyDeclaration: NO 5 computed aggregates,
  // NO proof_submitted, NO tenant_id. STRICT. status='submitted' (unless an
  // existing row was 'locked'). ----
  SubmitDeclarationResult: {
    type: 'object', additionalProperties: false,
    required: ['id', 'financial_year'],
    properties: {
      id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      financial_year: { type: 'string' },
      ppf: { type: MT, nullable: true },
      epf_voluntary: { type: MT, nullable: true },
      elss: { type: MT, nullable: true },
      lic_premium: { type: MT, nullable: true },
      nsc: { type: MT, nullable: true },
      home_loan_principal: { type: MT, nullable: true },
      tuition_fees: { type: MT, nullable: true },
      other_80c: { type: MT, nullable: true },
      health_insurance_self: { type: MT, nullable: true },
      health_insurance_parents: { type: MT, nullable: true },
      education_loan_interest: { type: MT, nullable: true },
      rent_paid_monthly: { type: MT, nullable: true },
      home_loan_interest: { type: MT, nullable: true },
      nps_contribution: { type: MT, nullable: true },
      rent_receipt_provided: { type: 'boolean', nullable: true },
      notes: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true, enum: DECLARATION_STATUS },
      submitted_at: { type: 'string', format: 'date-time', nullable: true },
      approved_by: { type: 'string', format: 'uuid', nullable: true },
      approved_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  SubmitDeclarationResponse: envelope('SubmitDeclarationResult'),

  // ---- getMyPayslipQueries GET /payroll/queries item: SELECT pq.* + p.month,
  // p.year, p.net_salary(Decimal → string) + replies json_agg. SELECT * → leaks
  // tenant_id → LOOSE. (No staff_name/employee_id here — those are admin-only.)
  // TRAP: replies = json_agg → array OR null (NULL on empty). ----
  MyPayslipQuery: {
    type: 'object', additionalProperties: true,
    required: ['id', 'staff_uid', 'subject'],
    properties: {
      id: { type: 'integer' },
      payslip_id: { type: 'integer', nullable: true },
      staff_uid: { type: 'string', format: 'uuid' },
      subject: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true, enum: PAYSLIP_QUERY_STATUS },
      resolved_by: { type: 'string', format: 'uuid', nullable: true },
      resolved_at: { type: 'string', format: 'date-time', nullable: true },
      resolution_note: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time', nullable: true },
      updated_at: { type: 'string', format: 'date-time', nullable: true },
      tenant_id: { type: 'string', format: 'uuid' },
      month: { type: 'integer' },
      year: { type: 'integer' },
      net_salary: { type: MT },
      replies: { type: 'array', nullable: true, items: { $ref: '#/components/schemas/PayslipQueryReply' } },
    },
  },
  MyPayslipQueriesResponse: listEnvelope('MyPayslipQuery'),

  // ---- raisePayslipQuery POST /payroll/queries/raise. Curated create select
  // (id, payslip_id, staff_uid, subject, description, category, status,
  // created_at) → STRICT. status defaults 'open'. ----
  RaiseQueryResult: {
    type: 'object', additionalProperties: false,
    required: ['id', 'staff_uid', 'subject', 'status'],
    properties: {
      id: { type: 'integer' },
      payslip_id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid' },
      subject: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
      status: { type: 'string', enum: PAYSLIP_QUERY_STATUS },
      created_at: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  RaiseQueryResponse: envelope('RaiseQueryResult'),

  // ---- getMyTaxSummary GET /payroll/tax-summary. THREE divergent branches:
  //   (A) existing annual_tax_summaries row → every total_* is a Decimal column
  //       → STRING; status is the DB column value; + pdf_url (signed | null).
  //   (B) freshly generateAnnualTaxSummary'd → a subset object.
  //   (C) 'unavailable' (no issued payslips) → JS NUMBER literals (total_income:0
  //       etc) + the SYNTHETIC status const 'unavailable' (NOT a DB enum value) +
  //       pdf_url:null.
  // Because branches mix string (A) and number (C) for the same total_* keys and
  // 'unavailable' is not a DB status, this is deliberately LOOSE
  // (additionalProperties:true) with a permissive untyped status (string|null,
  // NO enum so it accepts both 'draft'/'approved' AND 'unavailable') and the
  // total_* fields left to additionalProperties (string|number both pass).
  // required minimal [financial_year] (the only key present in every branch). ----
  OwnTaxSummary: {
    type: 'object', additionalProperties: true,
    required: ['financial_year'],
    properties: {
      financial_year: { type: 'string' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      status: { type: 'string', nullable: true },
      pdf_url: { type: 'string', nullable: true },
    },
  },
  OwnTaxSummaryResponse: envelope('OwnTaxSummary'),

  // ---- hr-self-service request bodies. submit-declaration HAS a destructured
  // body with the 14 numeric amounts + rent_receipt_provided + notes (financial_year
  // is the only required field). raise-query requires payslip_id/subject/description. ----
  SubmitDeclarationRequest: {
    type: 'object', additionalProperties: false,
    required: ['financial_year'],
    properties: {
      financial_year: { type: 'string' },
      ppf: { type: 'number' },
      epf_voluntary: { type: 'number' },
      elss: { type: 'number' },
      lic_premium: { type: 'number' },
      nsc: { type: 'number' },
      home_loan_principal: { type: 'number' },
      tuition_fees: { type: 'number' },
      other_80c: { type: 'number' },
      health_insurance_self: { type: 'number' },
      health_insurance_parents: { type: 'number' },
      education_loan_interest: { type: 'number' },
      rent_paid_monthly: { type: 'number' },
      home_loan_interest: { type: 'number' },
      nps_contribution: { type: 'number' },
      rent_receipt_provided: { type: 'boolean' },
      notes: { type: 'string' },
    },
  },
  RaiseQueryRequest: {
    type: 'object', additionalProperties: false,
    required: ['payslip_id', 'subject', 'description'],
    properties: {
      payslip_id: { type: 'integer' },
      subject: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
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

  // ---- separations ----
  'GET /api/v1/staff/admin/payroll/advances': { response: 'PayrollAdvancesResponse' },
  'POST /api/v1/staff/admin/payroll/advances/create': { request: 'CreateAdvanceRequest', response: 'PayrollAdvanceResponse' },
  'GET /api/v1/staff/admin/payroll/fnf': { response: 'FnFListResponse' },
  'POST /api/v1/staff/admin/payroll/fnf/create': { request: 'CreateFnFRequest', response: 'FnFDetailResponse' },
  'POST /api/v1/staff/admin/payroll/fnf/{id}/approve': { request: 'FnFApproveRequest', response: 'FnFDetailResponse' },
  'POST /api/v1/staff/admin/payroll/fnf/{id}/mark-paid': { request: 'FnFMarkPaidRequest', response: 'FnFDetailResponse' },
  'GET /api/v1/staff/admin/payroll/gratuity': { response: 'GratuityStatusResponse' },
  'GET /api/v1/staff/admin/payroll/leave-encashment': { response: 'LeaveEncashmentListResponse' },
  'POST /api/v1/staff/admin/payroll/leave-encashment/create': { request: 'CreateLeaveEncashmentRequest', response: 'LeaveEncashmentResponse' },

  // ---- queries-compliance ----
  'POST /api/v1/staff/admin/payroll/tax-summary/all': { request: 'GenerateTaxSummariesRequest', response: 'GenerateTaxSummariesResponse' },
  'GET /api/v1/staff/admin/payroll/comparison': { response: 'PayrollComparisonResponse' },
  'POST /api/v1/staff/admin/generate-payroll-data': { request: 'GeneratePayrollDataRequest', response: 'GeneratePayrollDataResponse' },
  'GET /api/v1/staff/admin/payroll/declarations': { response: 'DeclarationListResponse' },
  'POST /api/v1/staff/admin/payroll/declarations/{id}/approve': { request: 'ApproveDeclarationRequest', response: 'DeclarationResponse' },
  'GET /api/v1/staff/admin/payroll/queries': { response: 'PayslipQueryListResponse' },
  'POST /api/v1/staff/admin/payroll/queries/{id}/reply': { request: 'PayslipQueryReplyRequest', response: 'PayslipQueryResponse' },
  'GET /api/v1/staff/admin/payroll/compliance-calendar': { response: 'ComplianceCalendarResponse' },

  // ---- statutory-exports (GET /payroll/export/{summary,pf,esi}) — INTENTIONALLY
  // NOT KEYED: these return a text/csv body via res.send(), not a JSON envelope;
  // the generic 200 in openapi.json is the correct (untyped) representation. ----

  // ---- hr-self-service (/api/v1/staff/hr/payroll/*) ----
  'GET /api/v1/staff/hr/payroll/my-payslips': { response: 'MyPayslipListResponse' },
  'GET /api/v1/staff/hr/payroll/my-payslips/{id}': { response: 'MyPayslipDetailResponse' },
  'GET /api/v1/staff/hr/payroll/advances': { response: 'OwnAdvancesResponse' },
  'GET /api/v1/staff/hr/payroll/declarations': { response: 'MyDeclarationsResponse' },
  'GET /api/v1/staff/hr/payroll/queries': { response: 'MyPayslipQueriesResponse' },
  'GET /api/v1/staff/hr/payroll/tax-summary': { response: 'OwnTaxSummaryResponse' },
  'POST /api/v1/staff/hr/payroll/declarations/submit': { request: 'SubmitDeclarationRequest', response: 'SubmitDeclarationResponse' },
  'POST /api/v1/staff/hr/payroll/queries/raise': { request: 'RaiseQueryRequest', response: 'RaiseQueryResponse' },
  // ---- GET /api/v1/staff/hr/payroll/my-payslips/{id}/download — INTENTIONALLY
  // NOT KEYED: downloadPayslip returns a 302 redirect to a signed R2 PDF URL (no
  // JSON body), so the generic 200 in openapi.json is the correct (untyped)
  // representation — mirrors the 3 CSV-export endpoints above. ----
};
