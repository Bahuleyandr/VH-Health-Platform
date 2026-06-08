import crypto from 'crypto';
import {
  CLINICAL_ROLES,
  DOCTOR_TIERS,
  LEADERSHIP_ROLES,
  MACHINE_ROLES,
  PLATFORM_ROLES,
  ROLES,
  SUPPORT_ROLES,
} from '../utils/roleHelpers.js';
import { ALL_ROLES as LEGACY_ALL_ROLES } from '../utils/roles.js';
import {
  HIERARCHY_RELATIONSHIP_TYPES,
  ORGANIZATION_GUARDRAILS,
  ORGANIZATION_HIERARCHY_EDGES,
  ORGANIZATION_HIERARCHY_LANES,
  ORGANIZATION_HIERARCHY_NODES,
  ORGANIZATION_HIERARCHY_VERSION,
  ORGANIZATION_ROLE_BOUNDARIES,
} from './organizationHierarchyConfig.js';

export const ROLE_POLICY_VERSION = 'vh-role-policy-2026-06-v1';

export const PHI_ACCESS_LEVELS = {
  NONE: 'none',
  OPERATIONAL_ONLY: 'operational_only',
  STAFF_ONLY: 'staff_only',
  BASIC_PATIENT_CONTEXT: 'basic_patient_context',
  PATIENT_RELATIONSHIP: 'patient_relationship_required',
  CLINICAL_LEADERSHIP: 'clinical_leadership_relationship_required',
  ADMIN_BREAK_GLASS: 'admin_break_glass',
  OWN_RECORD: 'own_record',
};

export const ROLE_POLICY_CAPABILITY_GROUPS = {
  platform_admin: {
    title: 'Platform administration',
    description: 'System setup, governance, role policy, audit, and hospital-wide overrides.',
    roles: ['SUPER_ADMIN', 'ADMIN'],
  },
  people_operations: {
    title: 'People operations',
    description: 'Staff files, attendance, leave, payroll inputs, HR reporting, and grievances workflow.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'HR_STAFF'],
  },
  staff_governance: {
    title: 'Staff governance',
    description: 'Staff hierarchy, role picker, roster visibility, and management-chain views.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'HR_STAFF', 'CMO', 'CNO', 'MEDICAL_SUPERINTENDENT'],
  },
  op_flow: {
    title: 'OP flow',
    description: 'Patient search/create, appointment booking, check-in, OP queue, OP billing draft, and OP handoff.',
    roles: [
      'SUPER_ADMIN',
      'ADMIN',
      'RECEPTIONIST',
      'RECEPTION_INCHARGE',
      'OP_STAFF_NURSE',
      'OP_INCHARGE',
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'RESIDENT',
    ],
  },
  ip_flow: {
    title: 'IP flow',
    description: 'Admissions, bed allocation, ward board, patient command board, vitals, I/O, MAR, and discharge readiness.',
    roles: [
      'SUPER_ADMIN',
      'ADMIN',
      'DOCTOR',
      'DUTY_DOCTOR',
      'CONSULTANT',
      'SENIOR_DOCTOR',
      'JUNIOR_DOCTOR',
      'RESIDENT',
      'NURSING_STAFF',
      'NURSING_INCHARGE',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'ICU_NURSE',
      'ICU_INCHARGE',
      'ICU_STAFF',
      'ADMISSION_OFFICER',
      'IPD_COUNSELLOR',
    ],
  },
  nursing_governance: {
    title: 'Nursing governance',
    description: 'CNO and branch incharge supervision of OP, IP, OT, and Cath Lab nursing units.',
    roles: [
      'SUPER_ADMIN',
      'ADMIN',
      'CNO',
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      'OP_INCHARGE',
      'OT_INCHARGE',
      'CATH_LAB_INCHARGE',
    ],
  },
  diagnostics: {
    title: 'Diagnostics',
    description: 'Lab, radiology, investigations, and result-processing workflows.',
    roles: [
      'SUPER_ADMIN',
      'ADMIN',
      'LAB_STAFF',
      'RADIOLOGIST',
      'RADIOLOGY_STAFF',
      'PATHOLOGIST',
      'LAB_INCHARGE',
      'BLOOD_BANK_STAFF',
      'BLOOD_BANK_TECHNICIAN',
    ],
  },
  pharmacy: {
    title: 'Pharmacy',
    description: 'Prescription review, ward dispensing, inventory, and medication handover.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST'],
  },
  supply_chain: {
    title: 'Stores and purchase',
    description: 'Supplier master, purchase orders, goods receipt, batches, stock movement, reorder and expiry oversight.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'PHARMACY_INCHARGE', 'STORES_PURCHASE_INCHARGE'],
  },
  theatre: {
    title: 'Operating theatre',
    description: 'OT case readiness, theatre nursing workflow, and anaesthesia surfaces.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'OT_INCHARGE', 'OT_NURSE', 'OT_STAFF', 'ANAESTHETIST', 'ANESTHETIST'],
  },
  cath_lab: {
    title: 'Cath Lab',
    description: 'Cath Lab case readiness, staff allocation, and procedure support.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'CATH_LAB_INCHARGE', 'CATH_LAB_STAFF'],
  },
  housekeeping: {
    title: 'Housekeeping',
    description: 'Cleaning worklist, task assignment, bed turnover, and SLA tracking.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'HOUSEKEEPING_INCHARGE', 'HOUSEKEEPING_STAFF'],
  },
  dietary: {
    title: 'Dietary and nutrition',
    description: 'Dietary orders, nutrition consults, and inpatient meal planning.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'DIETITIAN', 'DIETARY_STAFF'],
  },
  emergency: {
    title: 'Emergency and ICU',
    description: 'Emergency triage, ICU admission support, and urgent patient movement.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'ER_STAFF', 'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF'],
  },
  specialty_services: {
    title: 'Specialty services',
    description: 'Dialysis, blood bank, and other procedural support surfaces.',
    roles: [
      'SUPER_ADMIN',
      'ADMIN',
      'DIALYSIS_TECHNICIAN',
      'BLOOD_BANK_STAFF',
      'BLOOD_BANK_TECHNICIAN',
    ],
  },
  billing: {
    title: 'Billing and insurance',
    description: 'Billing queue, OP/IP invoice drafts, insurance desk, and financial clearance.',
    roles: [
      'SUPER_ADMIN',
      'ADMIN',
      'BILLING_STAFF',
      'BILLING_INCHARGE',
      'FINANCE_INCHARGE',
      'INSURANCE_COORDINATOR',
      'CLAIMS_MANAGER',
    ],
  },
  notifications_audit: {
    title: 'Notifications and audit',
    description: 'Alerts, acknowledgements, audit explorer, and operational traceability.',
    roles: [
      'SUPER_ADMIN',
      'ADMIN',
      'HR_STAFF',
      'QUALITY_OFFICER',
      'INFECTION_CONTROL_OFFICER',
      'DATA_PROTECTION_OFFICER',
      'COMPLIANCE_OFFICER',
    ],
  },
  technical_admin: {
    title: 'Technical administration',
    description: 'Technical control-plane access for IT and integration operators.',
    roles: [
      'SUPER_ADMIN',
      'ADMIN',
      'IT',
      'IT_STAFF',
      'IT_ADMIN',
      'SYSTEM_ADMIN',
      'INTEGRATION_ADMIN',
      'AI_GOVERNANCE_ADMIN',
      'DATA_PROTECTION_OFFICER',
    ],
  },
};

const FUTURE_OR_RECOMMENDED_ROLES = [
  'HR_MANAGER',
  'NURSING_SUPERINTENDENT',
  'SENIOR_DOCTOR',
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ICU_STAFF',
  'ER_STAFF',
  'OPERATIONS_INCHARGE',
  'MAINTENANCE_INCHARGE',
  'PHARMACIST',
  'PATHOLOGIST',
  'LAB_INCHARGE',
  'DIETARY_STAFF',
  'COMPLIANCE_OFFICER',
  'DIALYSIS_TECHNICIAN',
  'BLOOD_BANK_STAFF',
];

const ROLE_CODES = unique([
  'SUPER_ADMIN',
  ...Object.values(ROLES),
  ...LEGACY_ALL_ROLES,
  ...FUTURE_OR_RECOMMENDED_ROLES,
  ...ORGANIZATION_HIERARCHY_NODES.flatMap((node) => [
    ...(node.role_codes || []),
    ...(node.recommended_role_codes || []),
  ]),
  ...ORGANIZATION_ROLE_BOUNDARIES.flatMap((boundary) => boundary.role_codes || []),
]);

const CLINICAL_ROLE_SET = new Set([
  ...CLINICAL_ROLES,
  'SENIOR_DOCTOR',
  'ANAESTHETIST',
  'ANESTHETIST',
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ICU_STAFF',
  'ER_STAFF',
  'DIALYSIS_TECHNICIAN',
  'RADIOLOGY_STAFF',
  'PATHOLOGIST',
  'LAB_INCHARGE',
  'BLOOD_BANK_STAFF',
  'BLOOD_BANK_TECHNICIAN',
]);
const LEADERSHIP_ROLE_SET = new Set(['SUPER_ADMIN', 'ADMIN', ...LEADERSHIP_ROLES]);
const SUPPORT_ROLE_SET = new Set([
  ...SUPPORT_ROLES,
  'RECEPTIONIST',
  'PHARMACY_INCHARGE',
  'STORES_PURCHASE_INCHARGE',
  'PHARMACIST',
  'LAB_INCHARGE',
  'DIETARY_STAFF',
  'COMPLIANCE_OFFICER',
]);
const PLATFORM_ROLE_SET = new Set(PLATFORM_ROLES);
const MACHINE_ROLE_SET = new Set(MACHINE_ROLES);
const DOCTOR_TIER_SET = new Set([...DOCTOR_TIERS, 'SENIOR_DOCTOR', 'ANAESTHETIST', 'ANESTHETIST']);

const NON_ASSIGNABLE_HUMAN_ROLES = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'PATIENT',
  'HR_MANAGER',
  'NURSING_SUPERINTENDENT',
  'SENIOR_DOCTOR',
  'ICU_NURSE',
  'ICU_INCHARGE',
  'ICU_STAFF',
  'ER_STAFF',
  'OPERATIONS_INCHARGE',
  'MAINTENANCE_INCHARGE',
  'PHARMACIST',
  'PATHOLOGIST',
  'LAB_INCHARGE',
  'DIETARY_STAFF',
  'COMPLIANCE_OFFICER',
  'DIALYSIS_TECHNICIAN',
  'BLOOD_BANK_STAFF',
]);

const DISPLAY_TITLE_OVERRIDES = {
  CMO: 'Chief Medical Officer',
  CNO: 'Nursing Superintendent',
  DOCTOR: 'Doctor',
  DUTY_DOCTOR: 'Duty Doctor',
  SENIOR_DOCTOR: 'Senior Doctor',
  IP_STAFF_NURSE: 'IP Staff Nurse',
  IP_INCHARGE: 'IP Nursing Incharge',
  ICU_NURSE: 'ICU Nurse',
  ICU_INCHARGE: 'ICU Incharge',
  ICU_STAFF: 'ICU Staff',
  ER_STAFF: 'Emergency Staff',
  OP_STAFF_NURSE: 'OP Staff Nurse',
  OP_INCHARGE: 'OP Nursing Incharge',
  OT_NURSE: 'OT Nurse',
  OT_STAFF: 'OT Staff',
  OT_INCHARGE: 'OT Nursing Incharge',
  CATH_LAB_STAFF: 'Cath Lab Staff',
  CATH_LAB_INCHARGE: 'Cath Lab Incharge',
  NURSING_INCHARGE: 'IP / Ward Nursing Incharge',
  NURSING_STAFF: 'IP Nursing Staff',
  RECEPTIONIST: 'Receptionist',
  RECEPTION_INCHARGE: 'Reception / Admission Incharge',
  MEDICAL_SUPERINTENDENT: 'Medical Superintendent',
  HR_STAFF: 'HR Staff',
  STORES_PURCHASE_INCHARGE: 'Stores / Purchase Incharge',
  WEBHOOK_CLIENT: 'Webhook Client',
  AI_GOVERNANCE_ADMIN: 'AI Governance Admin',
  DATA_PROTECTION_OFFICER: 'Data Protection Officer',
};

const DEPARTMENT_OVERRIDES = {
  SUPER_ADMIN: 'Executive',
  ADMIN: 'Administration',
  CMO: 'Clinical Governance',
  CNO: 'Nursing',
  MEDICAL_SUPERINTENDENT: 'Clinical Governance',
  DEPARTMENT_HEAD: 'Clinical Governance',
  HR_STAFF: 'HR',
  HR_MANAGER: 'HR',
  DOCTOR: 'Medical',
  DUTY_DOCTOR: 'Medical',
  CONSULTANT: 'Medical',
  JUNIOR_DOCTOR: 'Medical',
  RESIDENT: 'Medical',
  ANAESTHETIST: 'Anaesthesia',
  ANESTHETIST: 'Anaesthesia',
  NURSING_INCHARGE: 'Nursing',
  NURSING_STAFF: 'Nursing',
  IP_INCHARGE: 'IP Nursing',
  IP_STAFF_NURSE: 'IP Nursing',
  OP_INCHARGE: 'OP Nursing',
  OP_STAFF_NURSE: 'OP Nursing',
  OT_INCHARGE: 'OT Nursing',
  OT_NURSE: 'OT Nursing',
  OT_STAFF: 'OT Nursing',
  CATH_LAB_INCHARGE: 'Cath Lab',
  CATH_LAB_STAFF: 'Cath Lab',
  LAB_STAFF: 'Diagnostics',
  RADIOLOGIST: 'Radiology',
  RADIOLOGY_STAFF: 'Radiology',
  PHARMACY_STAFF: 'Pharmacy',
  PHARMACY_INCHARGE: 'Pharmacy',
  STORES_PURCHASE_INCHARGE: 'Stores / Purchase',
  PHARMACIST: 'Pharmacy',
  RECEPTIONIST: 'Front Office',
  RECEPTION_INCHARGE: 'Front Office',
  ADMISSION_OFFICER: 'Admissions',
  IPD_COUNSELLOR: 'Admissions',
  ICU_NURSE: 'ICU',
  ICU_INCHARGE: 'ICU',
  ICU_STAFF: 'ICU',
  ER_STAFF: 'Emergency',
  DIETARY_STAFF: 'Dietary',
  COMPLIANCE_OFFICER: 'Compliance',
  DIALYSIS_TECHNICIAN: 'Dialysis',
  BLOOD_BANK_STAFF: 'Blood Bank',
  BILLING_STAFF: 'Billing',
  BILLING_INCHARGE: 'Billing',
  FINANCE_INCHARGE: 'Finance',
  INSURANCE_COORDINATOR: 'Insurance',
  HOUSEKEEPING_STAFF: 'Housekeeping',
  HOUSEKEEPING_INCHARGE: 'Housekeeping',
  MAINTENANCE: 'Maintenance',
  SECURITY: 'Security',
  DRIVER: 'Transport',
};

const STAFF_VISIBILITY_OVERRIDES = {
  DOCTOR: ['DOCTOR', 'ANAESTHETIST', 'ANESTHETIST', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OT_NURSE', 'OT_STAFF'],
  ANAESTHETIST: ['ANAESTHETIST', 'ANESTHETIST', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OT_NURSE', 'OT_STAFF'],
  ANESTHETIST: ['ANESTHETIST', 'ANAESTHETIST', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OT_NURSE', 'OT_STAFF'],
  MEDICAL_SUPERINTENDENT: [
    'MEDICAL_SUPERINTENDENT',
    'DOCTOR',
    'DUTY_DOCTOR',
    'ANAESTHETIST',
    'ANESTHETIST',
    'NURSING_INCHARGE',
    'IP_INCHARGE',
    'NURSING_STAFF',
    'IP_STAFF_NURSE',
    'OP_INCHARGE',
    'OP_STAFF_NURSE',
    'OT_INCHARGE',
    'OT_NURSE',
    'OT_STAFF',
    'CATH_LAB_INCHARGE',
    'CATH_LAB_STAFF',
  ],
  CNO: [
    'CNO',
    'NURSING_INCHARGE',
    'IP_INCHARGE',
    'NURSING_STAFF',
    'IP_STAFF_NURSE',
    'OP_INCHARGE',
    'OP_STAFF_NURSE',
    'OT_INCHARGE',
    'OT_NURSE',
    'OT_STAFF',
    'CATH_LAB_INCHARGE',
    'CATH_LAB_STAFF',
  ],
  NURSING_INCHARGE: ['NURSING_INCHARGE', 'IP_INCHARGE', 'NURSING_STAFF', 'IP_STAFF_NURSE'],
  NURSING_STAFF: ['NURSING_STAFF'],
  IP_INCHARGE: ['IP_INCHARGE', 'NURSING_STAFF', 'IP_STAFF_NURSE'],
  IP_STAFF_NURSE: ['IP_STAFF_NURSE'],
  OP_INCHARGE: ['OP_INCHARGE', 'OP_STAFF_NURSE'],
  OP_STAFF_NURSE: ['OP_STAFF_NURSE'],
  OT_INCHARGE: ['OT_INCHARGE', 'OT_NURSE', 'OT_STAFF'],
  OT_NURSE: ['OT_NURSE', 'OT_STAFF'],
  OT_STAFF: ['OT_STAFF', 'OT_NURSE'],
  CATH_LAB_INCHARGE: ['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF'],
  CATH_LAB_STAFF: ['CATH_LAB_STAFF'],
  RADIOLOGY_STAFF: ['RADIOLOGY_STAFF'],
  PHARMACY_STAFF: ['PHARMACY_STAFF'],
  PHARMACY_INCHARGE: ['PHARMACY_INCHARGE', 'PHARMACY_STAFF', 'STORES_PURCHASE_INCHARGE'],
  STORES_PURCHASE_INCHARGE: ['STORES_PURCHASE_INCHARGE', 'PHARMACY_INCHARGE', 'PHARMACY_STAFF'],
  LAB_STAFF: ['LAB_STAFF'],
  GENERAL_STAFF: ['GENERAL_STAFF'],
  HOUSEKEEPING_STAFF: ['HOUSEKEEPING_STAFF'],
  HOUSEKEEPING_INCHARGE: ['HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE'],
  RECEPTIONIST: ['RECEPTIONIST'],
  RECEPTION_INCHARGE: ['RECEPTIONIST', 'RECEPTION_INCHARGE'],
  BILLING_STAFF: ['BILLING_STAFF'],
  BILLING_INCHARGE: ['BILLING_STAFF', 'BILLING_INCHARGE'],
  FINANCE_INCHARGE: ['BILLING_STAFF', 'BILLING_INCHARGE', 'FINANCE_INCHARGE'],
  ADMISSION_OFFICER: ['ADMISSION_OFFICER'],
  INSURANCE_COORDINATOR: ['INSURANCE_COORDINATOR'],
  IPD_COUNSELLOR: ['IPD_COUNSELLOR'],
  DRIVER: ['DRIVER'],
  SECURITY: ['SECURITY'],
  MAINTENANCE: ['MAINTENANCE'],
  EMERGENCY_RESPONDER: ['EMERGENCY_RESPONDER'],
};

const MANAGEABLE_ROLE_OVERRIDES = {
  CMO: ['MEDICAL_SUPERINTENDENT', 'DEPARTMENT_HEAD', 'DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT'],
  MEDICAL_SUPERINTENDENT: ['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT'],
  DOCTOR: ['PATIENT'],
  CNO: [
    'NURSING_INCHARGE',
    'IP_INCHARGE',
    'NURSING_STAFF',
    'IP_STAFF_NURSE',
    'OP_INCHARGE',
    'OP_STAFF_NURSE',
    'OT_INCHARGE',
    'OT_NURSE',
    'OT_STAFF',
    'CATH_LAB_INCHARGE',
    'CATH_LAB_STAFF',
  ],
  NURSING_INCHARGE: ['IP_INCHARGE', 'NURSING_STAFF', 'IP_STAFF_NURSE'],
  IP_INCHARGE: ['NURSING_STAFF', 'IP_STAFF_NURSE'],
  OP_INCHARGE: ['OP_STAFF_NURSE'],
  OT_INCHARGE: ['OT_NURSE', 'OT_STAFF'],
  CATH_LAB_INCHARGE: ['CATH_LAB_STAFF'],
  HR_STAFF: [
    'NURSING_INCHARGE',
    'IP_INCHARGE',
    'NURSING_STAFF',
    'IP_STAFF_NURSE',
    'OP_INCHARGE',
    'OP_STAFF_NURSE',
    'OT_INCHARGE',
    'OT_NURSE',
    'OT_STAFF',
    'CATH_LAB_INCHARGE',
    'CATH_LAB_STAFF',
    'GENERAL_STAFF',
    'HOUSEKEEPING_STAFF',
    'HOUSEKEEPING_INCHARGE',
    'MAINTENANCE',
    'RECEPTIONIST',
    'RECEPTION_INCHARGE',
    'BILLING_STAFF',
    'BILLING_INCHARGE',
    'FINANCE_INCHARGE',
    'ADMISSION_OFFICER',
    'IPD_COUNSELLOR',
    'DRIVER',
    'SECURITY',
    'EMERGENCY_RESPONDER',
  ],
  HOUSEKEEPING_INCHARGE: ['HOUSEKEEPING_STAFF'],
  RECEPTION_INCHARGE: ['RECEPTIONIST', 'ADMISSION_OFFICER', 'IPD_COUNSELLOR'],
  BILLING_INCHARGE: ['BILLING_STAFF', 'INSURANCE_COORDINATOR'],
  FINANCE_INCHARGE: ['BILLING_STAFF', 'BILLING_INCHARGE', 'INSURANCE_COORDINATOR', 'CLAIMS_MANAGER'],
  PHARMACY_INCHARGE: ['PHARMACY_STAFF'],
  STORES_PURCHASE_INCHARGE: [],
};

const LEGACY_ROLE_HIERARCHY_OVERRIDES = {
  ADMIN: [
    'DOCTOR',
    'DUTY_DOCTOR',
    'MEDICAL_SUPERINTENDENT',
    'CMO',
    'CNO',
    'NURSING_STAFF',
    'NURSING_INCHARGE',
    'OP_STAFF_NURSE',
    'OP_INCHARGE',
    'IP_STAFF_NURSE',
    'IP_INCHARGE',
    'OT_NURSE',
    'OT_INCHARGE',
    'OT_STAFF',
    'CATH_LAB_STAFF',
    'CATH_LAB_INCHARGE',
    'PHARMACY_STAFF',
    'PHARMACY_INCHARGE',
    'STORES_PURCHASE_INCHARGE',
    'LAB_STAFF',
    'HR_STAFF',
    'RECEPTIONIST',
    'RECEPTION_INCHARGE',
    'BILLING_STAFF',
    'BILLING_INCHARGE',
    'FINANCE_INCHARGE',
    'GENERAL_STAFF',
    'DRIVER',
    'HOUSEKEEPING_STAFF',
    'HOUSEKEEPING_INCHARGE',
    'MAINTENANCE',
    'SECURITY',
    'EMERGENCY_RESPONDER',
  ],
  CNO: MANAGEABLE_ROLE_OVERRIDES.CNO,
  NURSING_INCHARGE: MANAGEABLE_ROLE_OVERRIDES.NURSING_INCHARGE,
  OP_INCHARGE: MANAGEABLE_ROLE_OVERRIDES.OP_INCHARGE,
  IP_INCHARGE: MANAGEABLE_ROLE_OVERRIDES.IP_INCHARGE,
  OT_INCHARGE: MANAGEABLE_ROLE_OVERRIDES.OT_INCHARGE,
  CATH_LAB_INCHARGE: MANAGEABLE_ROLE_OVERRIDES.CATH_LAB_INCHARGE,
  HR_STAFF: MANAGEABLE_ROLE_OVERRIDES.HR_STAFF,
  HOUSEKEEPING_INCHARGE: MANAGEABLE_ROLE_OVERRIDES.HOUSEKEEPING_INCHARGE,
  RECEPTION_INCHARGE: MANAGEABLE_ROLE_OVERRIDES.RECEPTION_INCHARGE,
  RECEPTIONIST: ['GENERAL_STAFF'],
};

const ACCESS_MATRIX_OVERRIDES = {
  ADMIN: fullAccessMatrix(),
  SUPER_ADMIN: fullAccessMatrix(),
  DOCTOR: {
    users: ['read'],
    appointments: ['create', 'read', 'update'],
    records: ['create', 'read', 'update'],
    pharmacy: ['create', 'read'],
    investigations: ['create', 'read', 'update'],
  },
  CNO: {
    users: ['read', 'update'],
    appointments: ['read'],
    records: ['read', 'update'],
    pharmacy: ['read'],
    investigations: ['read', 'update'],
  },
  NURSING_INCHARGE: nursingAccessMatrix(),
  IP_INCHARGE: nursingAccessMatrix(),
  NURSING_STAFF: nursingAccessMatrix(),
  IP_STAFF_NURSE: nursingAccessMatrix(),
  OP_INCHARGE: opNursingAccessMatrix(),
  OP_STAFF_NURSE: opNursingAccessMatrix(),
  OT_INCHARGE: limitedClinicalAccessMatrix(),
  OT_NURSE: limitedClinicalAccessMatrix(),
  OT_STAFF: limitedClinicalAccessMatrix(),
  CATH_LAB_INCHARGE: limitedClinicalAccessMatrix(),
  CATH_LAB_STAFF: limitedClinicalAccessMatrix(),
  PHARMACY_STAFF: {
    users: ['read'],
    appointments: ['read'],
    records: ['read'],
    pharmacy: ['create', 'read', 'update'],
    investigations: [],
  },
  PHARMACY_INCHARGE: {
    users: ['read'],
    appointments: ['read'],
    records: ['read'],
    pharmacy: ['create', 'read', 'update', 'approve'],
    investigations: [],
  },
  STORES_PURCHASE_INCHARGE: {
    users: ['read'],
    appointments: [],
    records: [],
    pharmacy: ['create', 'read', 'update', 'approve'],
    investigations: [],
  },
  LAB_STAFF: {
    users: ['read'],
    appointments: ['read'],
    records: ['read'],
    pharmacy: [],
    investigations: ['create', 'read', 'update'],
  },
  RECEPTIONIST: {
    users: ['create', 'read'],
    appointments: ['create', 'read', 'update'],
    records: ['read'],
    pharmacy: [],
    investigations: ['read'],
  },
  HR_STAFF: {
    users: ['create', 'read', 'update'],
    appointments: [],
    records: [],
    pharmacy: [],
    investigations: [],
  },
  PATIENT: {
    users: ['read'],
    appointments: ['read'],
    records: ['read'],
    pharmacy: ['read'],
    investigations: ['read'],
  },
};

const RBAC_DEFAULTS = {
  clinical: {
    level: 66,
    permissions: ['view_patients', 'access_basic_records'],
    canViewData: 'assigned_clinical',
    color: '#2563eb',
    requiresApproval: true,
  },
  support: {
    level: 40,
    permissions: ['view_basic_info'],
    canViewData: 'limited',
    color: '#65a30d',
    requiresApproval: false,
  },
  platform: {
    level: 75,
    permissions: ['view_audit_logs', 'manage_platform_governance'],
    canViewData: 'governance_only',
    color: '#4f46e5',
    requiresApproval: true,
  },
  patient: {
    level: 10,
    permissions: ['view_own_records', 'book_appointments', 'view_test_results'],
    canViewData: 'own_only',
    color: '#6b7280',
    requiresApproval: false,
  },
};

const RBAC_OVERRIDES = {
  SUPER_ADMIN: {
    level: 110,
    permissions: ['*'],
    canManageRoles: [],
    canViewData: 'all',
    description: 'Super Administrator - Full Platform Access',
    color: '#991b1b',
    requiresApproval: false,
  },
  ADMIN: {
    level: 100,
    permissions: ['*'],
    canManageRoles: [],
    canViewData: 'all',
    description: 'System Administrator - Full Access',
    color: '#dc2626',
    requiresApproval: false,
  },
  CMO: {
    level: 92,
    permissions: ['view_patients', 'access_records', 'view_staff', 'manage_clinical_escalations'],
    canViewData: 'clinical_leadership',
    description: 'Chief Medical Officer - Clinical Governance',
    color: '#1e3a8a',
    requiresApproval: true,
  },
  MEDICAL_SUPERINTENDENT: {
    level: 90,
    permissions: ['view_patients', 'access_records', 'view_investigations', 'view_staff', 'manage_clinical_escalations'],
    canViewData: 'clinical_leadership',
    description: 'Medical Superintendent - Medical Leadership',
    color: '#1e40af',
    requiresApproval: true,
  },
  CNO: {
    level: 85,
    permissions: [
      'view_staff',
      'manage_nursing_roster',
      'view_nursing_workload',
      'assign_nursing_incharges',
      'approve_nursing_coverage',
      'view_patients',
      'access_basic_records',
      'update_patient_vitals',
    ],
    canViewData: 'nursing_leadership',
    description: 'Nursing Superintendent - OP/IP/OT/Cath Lab Nursing Leadership',
    color: '#0f766e',
    maxUsers: 3,
    requiresApproval: true,
  },
  DOCTOR: {
    level: 80,
    permissions: [
      'view_patients',
      'manage_appointments',
      'access_records',
      'create_prescriptions',
      'view_investigations',
      'create_consultations',
      'access_medical_records',
      'create_treatment_plans',
    ],
    canViewData: 'departmental',
    description: 'Medical Doctor - Clinical Access',
    color: '#2563eb',
    requiresApproval: true,
  },
  DUTY_DOCTOR: {
    level: 78,
    permissions: ['view_patients', 'access_records', 'view_investigations', 'create_consultations', 'access_medical_records'],
    canViewData: 'assigned_clinical',
    description: 'Duty Doctor - Assigned Clinical Access',
    color: '#1d4ed8',
    requiresApproval: true,
  },
  NURSING_INCHARGE: {
    level: 74,
    permissions: ['view_patients', 'access_basic_records', 'update_patient_vitals', 'view_staff', 'manage_ip_nursing_roster'],
    canViewData: 'ip_nursing_department',
    description: 'IP / Ward Nursing Incharge - Inpatient Nursing Supervision',
    color: '#047857',
    requiresApproval: true,
  },
  IP_INCHARGE: {
    level: 73,
    permissions: ['view_patients', 'access_basic_records', 'update_patient_vitals', 'view_staff', 'manage_ip_nursing_roster'],
    canViewData: 'ip_nursing_department',
    description: 'IP Nursing Incharge - Ward Nursing Work Allocation',
    color: '#047857',
    requiresApproval: true,
  },
  OP_INCHARGE: {
    level: 72,
    permissions: ['view_patients', 'manage_appointments', 'access_basic_records', 'view_staff', 'manage_op_nursing_roster'],
    canViewData: 'op_nursing_department',
    description: 'OP Nursing Incharge - OP Nursing Work Allocation',
    color: '#0891b2',
    requiresApproval: true,
  },
  OT_INCHARGE: {
    level: 72,
    permissions: ['view_patients', 'access_basic_records', 'view_staff', 'manage_ot_nursing_roster', 'view_theatre_workload'],
    canViewData: 'ot_nursing_department',
    description: 'OT Nursing Incharge - Theatre Nursing Work Allocation',
    color: '#7c3aed',
    requiresApproval: true,
  },
  CATH_LAB_INCHARGE: {
    level: 72,
    permissions: ['view_patients', 'access_basic_records', 'view_staff', 'manage_cath_lab_roster', 'view_cath_lab_workload'],
    canViewData: 'cath_lab_department',
    description: 'Cath Lab Incharge - Cath Lab Work Allocation',
    color: '#0284c7',
    requiresApproval: true,
  },
  NURSING_STAFF: {
    level: 70,
    permissions: ['view_patients', 'access_basic_records', 'assist_consultations', 'manage_investigations', 'update_patient_vitals'],
    canViewData: 'ward_based',
    description: 'IP Nursing Staff - Patient Care',
    color: '#059669',
    requiresApproval: true,
  },
  IP_STAFF_NURSE: {
    level: 70,
    permissions: ['view_patients', 'access_basic_records', 'assist_consultations', 'manage_investigations', 'update_patient_vitals'],
    canViewData: 'ward_based',
    description: 'IP Staff Nurse - Inpatient Care',
    color: '#059669',
    requiresApproval: true,
  },
  OP_STAFF_NURSE: {
    level: 68,
    permissions: ['view_patients', 'manage_appointments', 'access_basic_records', 'assist_consultations', 'manage_investigations'],
    canViewData: 'op_nursing_department',
    description: 'OP Staff Nurse - OP Flow Support',
    color: '#0d9488',
    requiresApproval: true,
  },
  OT_NURSE: {
    level: 68,
    permissions: ['view_patients', 'access_basic_records', 'assist_theatre_workflow', 'view_theatre_workload'],
    canViewData: 'ot_nursing_department',
    description: 'OT Nurse - Theatre Nursing Support',
    color: '#8b5cf6',
    requiresApproval: true,
  },
  OT_STAFF: {
    level: 66,
    permissions: ['view_patients', 'access_basic_records', 'assist_theatre_workflow'],
    canViewData: 'ot_nursing_department',
    description: 'OT Staff - Theatre Support',
    color: '#a855f7',
    requiresApproval: true,
  },
  CATH_LAB_STAFF: {
    level: 66,
    permissions: ['view_patients', 'access_basic_records', 'assist_cath_lab_workflow', 'view_cath_lab_workload'],
    canViewData: 'cath_lab_department',
    description: 'Cath Lab Staff - Cath Lab Support',
    color: '#0ea5e9',
    requiresApproval: true,
  },
  PHARMACY_STAFF: {
    level: 60,
    permissions: ['view_prescriptions', 'manage_pharmacy_orders', 'access_medication_history', 'dispense_medications', 'manage_inventory'],
    canViewData: 'pharmacy_only',
    description: 'Pharmacy Staff - Medication Management',
    color: '#7c3aed',
    maxUsers: 20,
    requiresApproval: true,
  },
  PHARMACY_INCHARGE: {
    level: 65,
    permissions: [
      'view_prescriptions',
      'manage_pharmacy_orders',
      'access_medication_history',
      'dispense_medications',
      'manage_inventory',
      'manage_formulary',
      'approve_pharmacy_supply',
    ],
    canViewData: 'pharmacy_lead',
    description: 'Pharmacy Incharge - Medication Supply Governance',
    color: '#7c2d12',
    maxUsers: 3,
    requiresApproval: true,
  },
  STORES_PURCHASE_INCHARGE: {
    level: 58,
    permissions: [
      'view_inventory',
      'manage_inventory',
      'manage_suppliers',
      'manage_purchase_orders',
      'record_goods_receipts',
      'review_expiry_alerts',
    ],
    canViewData: 'supply_chain_only',
    description: 'Stores / Purchase Incharge - Inventory and Procurement',
    color: '#92400e',
    maxUsers: 3,
    requiresApproval: true,
  },
  LAB_STAFF: {
    level: 60,
    permissions: ['manage_investigations', 'upload_lab_results', 'view_test_requests', 'process_specimens', 'generate_reports'],
    canViewData: 'lab_only',
    description: 'Laboratory Staff - Test Management',
    color: '#ea580c',
    maxUsers: 15,
    requiresApproval: true,
  },
  HR_STAFF: {
    level: 50,
    permissions: ['view_staff', 'manage_staff_basic', 'view_attendance', 'generate_hr_reports', 'manage_schedules', 'process_payroll', 'handle_grievances'],
    canViewData: 'hr_only',
    description: 'Human Resources - Staff Management',
    color: '#0891b2',
    maxUsers: 5,
    requiresApproval: true,
  },
  HOUSEKEEPING_INCHARGE: {
    level: 45,
    permissions: ['view_housekeeping_workload', 'assign_housekeeping_staff', 'verify_housekeeping_requests', 'redeploy_housekeeping_staff'],
    canViewData: 'housekeeping_department',
    description: 'Housekeeping Incharge - Floor Assignment',
    color: '#0f766e',
    requiresApproval: true,
  },
  HOUSEKEEPING_STAFF: {
    level: 35,
    permissions: ['view_assigned_housekeeping_requests', 'complete_housekeeping_requests', 'log_cleaning_proof'],
    canViewData: 'assigned_housekeeping_only',
    description: 'Housekeeping Staff - Cleaning Worklist',
    color: '#047857',
    requiresApproval: false,
  },
  MAINTENANCE: {
    level: 35,
    permissions: ['view_assigned_maintenance_requests', 'complete_maintenance_requests'],
    canViewData: 'assigned_maintenance_only',
    description: 'Maintenance Staff - Facilities Work',
    color: '#ca8a04',
    requiresApproval: false,
  },
  PATIENT: RBAC_DEFAULTS.patient,
};

const REPORTING_OVERRIDES = {
  ADMIN: { reports_to: 'SUPER_ADMIN', supervises_roles: [] },
  CMO: { reports_to: 'ADMIN', supervises_roles: ['MEDICAL_SUPERINTENDENT', 'DEPARTMENT_HEAD', 'DOCTOR'] },
  MEDICAL_SUPERINTENDENT: { reports_to: 'CMO', supervises_roles: ['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT'] },
  CNO: { reports_to: 'ADMIN', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.CNO },
  NURSING_INCHARGE: { reports_to: 'CNO', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.NURSING_INCHARGE },
  IP_INCHARGE: { reports_to: 'CNO', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.IP_INCHARGE },
  OP_INCHARGE: { reports_to: 'CNO', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.OP_INCHARGE },
  OT_INCHARGE: { reports_to: 'CNO', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.OT_INCHARGE },
  CATH_LAB_INCHARGE: { reports_to: 'CNO', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.CATH_LAB_INCHARGE },
  RECEPTION_INCHARGE: { reports_to: 'ADMIN', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.RECEPTION_INCHARGE },
  HOUSEKEEPING_INCHARGE: { reports_to: 'ADMIN', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.HOUSEKEEPING_INCHARGE },
  BILLING_INCHARGE: { reports_to: 'FINANCE_INCHARGE', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.BILLING_INCHARGE },
  FINANCE_INCHARGE: { reports_to: 'ADMIN', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.FINANCE_INCHARGE },
  PHARMACY_INCHARGE: { reports_to: 'ADMIN', supervises_roles: MANAGEABLE_ROLE_OVERRIDES.PHARMACY_INCHARGE },
  STORES_PURCHASE_INCHARGE: { reports_to: 'ADMIN', supervises_roles: [] },
  HR_STAFF: { reports_to: 'ADMIN', supervises_roles: [] },
};

const HR_PROCESS_OVERRIDES = {
  HR_STAFF: {
    can_process_leave_for_roles: MANAGEABLE_ROLE_OVERRIDES.HR_STAFF,
    can_recommend_leave_for_roles: [],
    can_approve_leave_for_roles: [],
    note: 'HR processing is separate from clinical, nursing, and operational work authority.',
  },
  CNO: {
    can_process_leave_for_roles: [],
    can_recommend_leave_for_roles: MANAGEABLE_ROLE_OVERRIDES.CNO,
    can_approve_leave_for_roles: [],
  },
  NURSING_INCHARGE: {
    can_process_leave_for_roles: [],
    can_recommend_leave_for_roles: MANAGEABLE_ROLE_OVERRIDES.NURSING_INCHARGE,
    can_approve_leave_for_roles: [],
  },
  OP_INCHARGE: {
    can_process_leave_for_roles: [],
    can_recommend_leave_for_roles: MANAGEABLE_ROLE_OVERRIDES.OP_INCHARGE,
    can_approve_leave_for_roles: [],
  },
  IP_INCHARGE: {
    can_process_leave_for_roles: [],
    can_recommend_leave_for_roles: MANAGEABLE_ROLE_OVERRIDES.IP_INCHARGE,
    can_approve_leave_for_roles: [],
  },
  OT_INCHARGE: {
    can_process_leave_for_roles: [],
    can_recommend_leave_for_roles: MANAGEABLE_ROLE_OVERRIDES.OT_INCHARGE,
    can_approve_leave_for_roles: [],
  },
  CATH_LAB_INCHARGE: {
    can_process_leave_for_roles: [],
    can_recommend_leave_for_roles: MANAGEABLE_ROLE_OVERRIDES.CATH_LAB_INCHARGE,
    can_approve_leave_for_roles: [],
  },
};

const UI_FEATURES_BY_ROLE = {
  ADMIN: ['front_office_workbench', 'admissions', 'billing_desk', 'staff_management', 'organization_hierarchy', 'safety_center', 'audit_logs', 'bed_board', 'referrals'],
  SUPER_ADMIN: ['front_office_workbench', 'admissions', 'billing_desk', 'staff_management', 'organization_hierarchy', 'safety_center', 'audit_logs', 'bed_board', 'referrals'],
  HR_STAFF: ['staff_management', 'organization_hierarchy', 'hr_dashboard', 'leave_approvals', 'staff_directory', 'reports_grievances', 'audit_logs'],
  CNO: ['organization_hierarchy', 'nursing_roster', 'op_nursing_roster', 'staff_roster', 'patient_command_board', 'bed_board', 'referrals', 'safety_center'],
  RECEPTIONIST: ['front_office_workbench', 'appointments', 'patient_records', 'billing_desk', 'admissions'],
  RECEPTION_INCHARGE: ['front_office_workbench', 'appointments', 'patient_records', 'billing_desk', 'admissions', 'reception_roster'],
  OP_STAFF_NURSE: ['front_office_workbench', 'appointments', 'patient_records', 'lab_bookings', 'nursing_notes'],
  OP_INCHARGE: ['front_office_workbench', 'appointments', 'patient_records', 'lab_bookings', 'nursing_notes', 'op_nursing_roster'],
  NURSING_STAFF: ['patient_command_board', 'bed_board', 'nursing_notes', 'handover', 'discharge_hub', 'referrals'],
  IP_STAFF_NURSE: ['patient_command_board', 'bed_board', 'nursing_notes', 'handover', 'discharge_hub', 'referrals'],
  NURSING_INCHARGE: ['patient_command_board', 'bed_board', 'nursing_notes', 'handover', 'discharge_hub', 'nursing_roster', 'referrals'],
  IP_INCHARGE: ['patient_command_board', 'bed_board', 'nursing_notes', 'handover', 'discharge_hub', 'nursing_roster', 'referrals'],
  OT_NURSE: ['theatre', 'patient_command_board', 'handover'],
  OT_STAFF: ['theatre', 'handover'],
  OT_INCHARGE: ['theatre', 'patient_command_board', 'handover', 'staff_roster'],
  CATH_LAB_STAFF: ['cath_lab', 'patient_command_board', 'handover'],
  CATH_LAB_INCHARGE: ['cath_lab', 'patient_command_board', 'handover', 'staff_roster'],
  DOCTOR: ['front_office_workbench', 'appointments', 'patient_command_board', 'patient_records', 'prescriptions', 'investigation_results', 'discharge_hub', 'referrals'],
  DUTY_DOCTOR: ['front_office_workbench', 'appointments', 'patient_command_board', 'patient_records', 'prescriptions', 'investigation_results', 'discharge_hub', 'referrals'],
  CONSULTANT: ['front_office_workbench', 'appointments', 'patient_command_board', 'patient_records', 'prescriptions', 'investigation_results', 'discharge_hub', 'referrals'],
  PHARMACY_STAFF: ['pharmacy_orders', 'pharmacy_roster'],
  PHARMACY_INCHARGE: ['pharmacy_orders', 'pharmacy_roster', 'staff_directory'],
  STORES_PURCHASE_INCHARGE: ['pharmacy_orders', 'staff_directory'],
  LAB_STAFF: ['investigations_upload', 'investigation_results', 'lab_bookings'],
  HOUSEKEEPING_STAFF: ['housekeeping_tasks'],
  HOUSEKEEPING_INCHARGE: ['housekeeping_hub', 'housekeeping_command', 'housekeeping_roster'],
};

const STAFF_FEATURE_CATALOG = [
  { id: 'home', title: 'Home', sidebar_label: 'Home', sidebar_order: 10, capability_group: 'op_flow' },
  { id: 'front_office_workbench', title: 'Front Office Workbench', sidebar_label: 'Front Office', sidebar_order: 20, capability_group: 'op_flow' },
  { id: 'appointments', title: 'Appointments', sidebar_label: 'Appointments', sidebar_order: 25, capability_group: 'op_flow' },
  { id: 'patient_records', title: 'Patient Records', sidebar_label: 'Patient Records', sidebar_order: 30, capability_group: 'op_flow' },
  { id: 'patient_command_board', title: 'Patient Command Board', sidebar_label: 'IP Services', sidebar_order: 40, capability_group: 'ip_flow' },
  { id: 'admissions', title: 'IP Admissions', sidebar_label: 'IP Admissions', sidebar_order: 45, capability_group: 'ip_flow' },
  { id: 'bed_board', title: 'Bed Board', sidebar_label: 'Bed Board', sidebar_order: 50, capability_group: 'ip_flow' },
  { id: 'nursing_notes', title: 'Nursing Notes', sidebar_label: 'Nursing Notes', sidebar_order: 55, capability_group: 'ip_flow' },
  { id: 'handover', title: 'Shift Handover', sidebar_label: 'Handover', sidebar_order: 60, capability_group: 'ip_flow' },
  { id: 'discharge_hub', title: 'Discharge Hub', sidebar_label: 'Discharge', sidebar_order: 65, capability_group: 'ip_flow' },
  { id: 'prescriptions', title: 'Prescriptions', sidebar_label: 'Prescriptions', sidebar_order: 70, capability_group: 'pharmacy' },
  { id: 'pharmacy_orders', title: 'Pharmacy Orders', sidebar_label: 'Pharmacy', sidebar_order: 75, capability_group: 'pharmacy' },
  { id: 'investigation_results', title: 'Investigation Results', sidebar_label: 'Investigations', sidebar_order: 80, capability_group: 'diagnostics' },
  { id: 'lab_bookings', title: 'Lab Bookings', sidebar_label: 'Lab Bookings', sidebar_order: 85, capability_group: 'diagnostics' },
  { id: 'investigations_upload', title: 'Investigation Upload', sidebar_label: 'Lab Upload', sidebar_order: 90, capability_group: 'diagnostics' },
  { id: 'referrals', title: 'Referrals', sidebar_label: 'Referrals', sidebar_order: 95, capability_group: 'ip_flow' },
  { id: 'messages', title: 'Messages', sidebar_label: 'Messages', sidebar_order: 100, capability_group: 'notifications_audit' },
  { id: 'alerts', title: 'Alerts', sidebar_label: 'Alerts', sidebar_order: 105, capability_group: 'notifications_audit' },
  { id: 'safety_center', title: 'Safety Center', sidebar_label: 'Safety', sidebar_order: 110, capability_group: 'notifications_audit' },
  { id: 'audit_logs', title: 'Audit Logs', sidebar_label: 'Audit', sidebar_order: 115, capability_group: 'notifications_audit' },
  { id: 'organization_hierarchy', title: 'Hospital Hierarchy', sidebar_label: 'Hierarchy', sidebar_order: 120, capability_group: 'staff_governance' },
  { id: 'staff_management', title: 'Staff Management', sidebar_label: 'Staff', sidebar_order: 125, capability_group: 'people_operations' },
  { id: 'staff_directory', title: 'Staff Directory', sidebar_label: 'Directory', sidebar_order: 130, capability_group: 'people_operations' },
  { id: 'hr_dashboard', title: 'HR Dashboard', sidebar_label: 'HR', sidebar_order: 135, capability_group: 'people_operations' },
  { id: 'leave_approvals', title: 'Leave Approvals', sidebar_label: 'Leave', sidebar_order: 140, capability_group: 'people_operations' },
  { id: 'reports_grievances', title: 'Reports and Grievances', sidebar_label: 'Reports', sidebar_order: 145, capability_group: 'people_operations' },
  { id: 'theatre', title: 'Operating Theatre', sidebar_label: 'Theatre', sidebar_order: 150, capability_group: 'theatre' },
  { id: 'cath_lab', title: 'Cath Lab', sidebar_label: 'Cath Lab', sidebar_order: 155, capability_group: 'cath_lab' },
  { id: 'housekeeping_tasks', title: 'Housekeeping Tasks', sidebar_label: 'Housekeeping', sidebar_order: 160, capability_group: 'housekeeping' },
  { id: 'housekeeping_hub', title: 'Housekeeping Hub', sidebar_label: 'Housekeeping', sidebar_order: 165, capability_group: 'housekeeping' },
  { id: 'housekeeping_command', title: 'Housekeeping Command', sidebar_label: 'Housekeeping', sidebar_order: 170, capability_group: 'housekeeping' },
  { id: 'housekeeping_roster', title: 'Housekeeping Roster', sidebar_label: 'Roster', sidebar_order: 175, capability_group: 'housekeeping' },
];

const ROLE_POLICY_ROLES = ROLE_CODES.map((roleCode) => buildRoleEntry(roleCode));

export const ROLE_POLICY_GRAPH = Object.freeze({
  policy_version: ROLE_POLICY_VERSION,
  hierarchy_version: ORGANIZATION_HIERARCHY_VERSION,
  roles: ROLE_POLICY_ROLES,
  org_nodes: ORGANIZATION_HIERARCHY_NODES,
  edges: ORGANIZATION_HIERARCHY_EDGES,
  hierarchy_lanes: ORGANIZATION_HIERARCHY_LANES,
  hierarchy_relationship_types: HIERARCHY_RELATIONSHIP_TYPES,
  role_boundaries: ORGANIZATION_ROLE_BOUNDARIES,
  guardrails: [
    ...ORGANIZATION_GUARDRAILS,
    'Patient PHI access must remain role plus patient relationship, care-team relationship, or break-glass reason.',
    'Reporting hierarchy and PHI access are separate policy dimensions.',
  ],
  capability_groups: ROLE_POLICY_CAPABILITY_GROUPS,
  phi_levels: PHI_ACCESS_LEVELS,
  staff_features: STAFF_FEATURE_CATALOG,
  staff_features_by_role: UI_FEATURES_BY_ROLE,
});

const ROLE_POLICY_HASH = crypto
  .createHash('sha256')
  .update(stableStringify(ROLE_POLICY_GRAPH))
  .digest('hex');

export function getRolePolicy() {
  return {
    ...ROLE_POLICY_GRAPH,
    policy_hash: ROLE_POLICY_HASH,
    generated_at: new Date().toISOString(),
  };
}

export function getRolePolicyHash() {
  return ROLE_POLICY_HASH;
}

export function getRolePolicyVersion() {
  return ROLE_POLICY_VERSION;
}

export function getRolePolicyRoleCodes() {
  return ROLE_POLICY_ROLES.map((role) => role.role_code);
}

export function getStaffRosterRoleCodes({ includeAdmin = true } = {}) {
  return ROLE_POLICY_ROLES
    .filter((role) => role.human && !role.machine && role.role_code !== 'PATIENT')
    .filter((role) => includeAdmin || !['SUPER_ADMIN', 'ADMIN'].includes(role.role_code))
    .map((role) => role.role_code);
}

export function getRolesForCapabilityGroups(capabilityGroups, {
  include = [],
  exclude = [],
  includeAdmin = true,
} = {}) {
  const groups = unique(Array.isArray(capabilityGroups) ? capabilityGroups : [capabilityGroups])
    .map((group) => group.toLowerCase());
  const knownGroups = new Set(Object.keys(ROLE_POLICY_CAPABILITY_GROUPS));
  const unknownGroups = groups.filter((group) => !knownGroups.has(group));
  if (unknownGroups.length > 0) {
    throw new Error(`Unknown role policy capability group(s): ${unknownGroups.join(', ')}`);
  }

  const roles = new Set();
  for (const group of groups) {
    for (const roleCode of ROLE_POLICY_CAPABILITY_GROUPS[group].roles || []) {
      assertKnownPolicyRole(roleCode, `capability group ${group}`);
      roles.add(normalizeRoleCode(roleCode));
    }
  }

  for (const roleCode of include) {
    assertKnownPolicyRole(roleCode, 'route policy include');
    roles.add(normalizeRoleCode(roleCode));
  }

  if (!includeAdmin) {
    roles.delete('SUPER_ADMIN');
    roles.delete('ADMIN');
  }
  for (const roleCode of exclude) {
    assertKnownPolicyRole(roleCode, 'route policy exclude');
    roles.delete(normalizeRoleCode(roleCode));
  }

  return sortPolicyRoles([...roles]);
}

export function getRolePickerOptions({ includeAdmin = false, includeMachine = false, includePatient = false } = {}) {
  return ROLE_POLICY_ROLES
    .filter((role) => {
      if (!includeAdmin && ['SUPER_ADMIN', 'ADMIN'].includes(role.role_code)) return false;
      if (!includeMachine && role.machine) return false;
      if (!includePatient && role.role_code === 'PATIENT') return false;
      return role.assignable_staff || includeAdmin || includeMachine || includePatient;
    })
    .map((role) => ({
      role: role.role_code,
      label: role.display_title,
      group: role.group,
      department: role.department,
      unit: role.unit,
      assignable_staff: role.assignable_staff,
      human: role.human,
      machine: role.machine,
      phi_access_level: role.phi.access_level,
      route_capability_groups: role.access.route_capability_groups,
    }));
}

export function getStaffVisibilityRoles(userRole) {
  const role = normalizeRoleCode(userRole);
  const allStaffRoles = getStaffRosterRoleCodes();
  const onboardableStaffRoles = getStaffRosterRoleCodes({ includeAdmin: false });

  if (role === 'SUPER_ADMIN') return unique([...allStaffRoles, 'SUPER_ADMIN']);
  if (role === 'ADMIN') return allStaffRoles;
  if (role === 'HR_STAFF') return onboardableStaffRoles;
  return STAFF_VISIBILITY_OVERRIDES[role] ? [...STAFF_VISIBILITY_OVERRIDES[role]] : [role];
}

export function getManageableRolesFromPolicy(userRole) {
  const role = normalizeRoleCode(userRole);
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
    return getRolePolicyRoleCodes().filter((targetRole) => targetRole !== 'SUPER_ADMIN');
  }
  return MANAGEABLE_ROLE_OVERRIDES[role] ? [...MANAGEABLE_ROLE_OVERRIDES[role]] : [];
}

export function getLegacyRoleHierarchyFromPolicy() {
  return Object.fromEntries(
    ROLE_POLICY_ROLES
      .map((role) => [role.role_code, role.role_code === 'SUPER_ADMIN'
        ? LEGACY_ROLE_HIERARCHY_OVERRIDES.ADMIN
        : LEGACY_ROLE_HIERARCHY_OVERRIDES[role.role_code]])
      .filter(([, hierarchy]) => Array.isArray(hierarchy))
      .map(([role, hierarchy]) => [role, [...hierarchy]])
  );
}

export function getAccessMatrixFromPolicy() {
  return Object.fromEntries(
    ROLE_POLICY_ROLES.map((role) => [role.role_code, ACCESS_MATRIX_OVERRIDES[role.role_code] || defaultAccessMatrix(role)])
  );
}

export function getRbacRoleHierarchyFromPolicy() {
  return Object.fromEntries(
    ROLE_POLICY_ROLES.map((role) => {
      const base = defaultRbacForRole(role);
      const override = RBAC_OVERRIDES[role.role_code] || {};
      const canManageRoles = role.role_code === 'SUPER_ADMIN' || role.role_code === 'ADMIN'
        ? getRolePolicyRoleCodes().filter((targetRole) => targetRole !== 'SUPER_ADMIN')
        : getManageableRolesFromPolicy(role.role_code);
      return [
        role.role_code,
        {
          ...base,
          ...override,
          canManageRoles,
          description: override.description || role.display_title,
          maxUsers: override.maxUsers ?? null,
          requiresApproval: override.requiresApproval ?? base.requiresApproval,
        },
      ];
    })
  );
}

export function getOrgHierarchyFromPolicy() {
  return {
    version: ORGANIZATION_HIERARCHY_VERSION,
    policy_version: ROLE_POLICY_VERSION,
    policy_hash: ROLE_POLICY_HASH,
    lanes: ORGANIZATION_HIERARCHY_LANES,
    nodes: ORGANIZATION_HIERARCHY_NODES,
    edges: ORGANIZATION_HIERARCHY_EDGES,
    role_boundaries: ORGANIZATION_ROLE_BOUNDARIES,
    guardrails: ROLE_POLICY_GRAPH.guardrails,
  };
}

function buildRoleEntry(roleCode) {
  const machine = MACHINE_ROLE_SET.has(roleCode);
  const human = !machine;
  const assignableStaff = human && !NON_ASSIGNABLE_HUMAN_ROLES.has(roleCode);
  const group = groupForRole(roleCode);
  const capabilityGroups = capabilityGroupsForRole(roleCode);

  return {
    role_code: roleCode,
    display_title: DISPLAY_TITLE_OVERRIDES[roleCode] || titleCase(roleCode),
    group,
    department: DEPARTMENT_OVERRIDES[roleCode] || group,
    unit: unitForRole(roleCode),
    aliases: [],
    assignable_staff: assignableStaff,
    human,
    machine,
    reporting: {
      reports_to_role: REPORTING_OVERRIDES[roleCode]?.reports_to || null,
      supervises_roles: REPORTING_OVERRIDES[roleCode]?.supervises_roles || [],
      staff_visibility_roles: STAFF_VISIBILITY_OVERRIDES[roleCode] || [],
      roster_management_scope: MANAGEABLE_ROLE_OVERRIDES[roleCode] || [],
    },
    hr_process: HR_PROCESS_OVERRIDES[roleCode] || {
      can_process_leave_for_roles: [],
      can_recommend_leave_for_roles: [],
      can_approve_leave_for_roles: [],
    },
    access: {
      route_capability_groups: capabilityGroups,
      can_manage_roles: MANAGEABLE_ROLE_OVERRIDES[roleCode] || [],
    },
    ui: {
      feature_ids: UI_FEATURES_BY_ROLE[roleCode] || [],
    },
    phi: {
      access_level: phiAccessLevelForRole(roleCode),
      requires_patient_relationship: requiresPatientRelationship(roleCode),
      can_break_glass: ['SUPER_ADMIN', 'ADMIN', 'CMO', 'MEDICAL_SUPERINTENDENT'].includes(roleCode),
    },
  };
}

function groupForRole(roleCode) {
  if (roleCode === 'PATIENT') return 'patient';
  if (LEADERSHIP_ROLE_SET.has(roleCode)) return 'leadership';
  if (CLINICAL_ROLE_SET.has(roleCode)) return 'clinical';
  if (SUPPORT_ROLE_SET.has(roleCode)) return 'support';
  if (PLATFORM_ROLE_SET.has(roleCode)) return 'platform';
  if (MACHINE_ROLE_SET.has(roleCode)) return 'machine';
  return 'operations';
}

function unitForRole(roleCode) {
  if (roleCode.includes('OP_')) return 'OP';
  if (roleCode.includes('IP_') || roleCode === 'NURSING_INCHARGE' || roleCode === 'NURSING_STAFF') return 'IP';
  if (roleCode.includes('OT_')) return 'OT';
  if (roleCode.includes('CATH_LAB')) return 'Cath Lab';
  if (roleCode.includes('HOUSEKEEPING')) return 'Housekeeping';
  if (roleCode.includes('RECEPTION') || roleCode.includes('ADMISSION')) return 'Front Office';
  return null;
}

function phiAccessLevelForRole(roleCode) {
  if (roleCode === 'PATIENT') return PHI_ACCESS_LEVELS.OWN_RECORD;
  if (roleCode === 'HR_STAFF') return PHI_ACCESS_LEVELS.STAFF_ONLY;
  if (['SUPER_ADMIN', 'ADMIN'].includes(roleCode)) return PHI_ACCESS_LEVELS.ADMIN_BREAK_GLASS;
  if ([
    'HOUSEKEEPING_STAFF',
    'HOUSEKEEPING_INCHARGE',
    'MAINTENANCE',
    'DRIVER',
    'SECURITY',
    'STORES_PURCHASE_INCHARGE',
  ].includes(roleCode)) {
    return PHI_ACCESS_LEVELS.OPERATIONAL_ONLY;
  }
  if (['RECEPTIONIST', 'RECEPTION_INCHARGE', 'BILLING_STAFF', 'BILLING_INCHARGE', 'INSURANCE_COORDINATOR'].includes(roleCode)) {
    return PHI_ACCESS_LEVELS.BASIC_PATIENT_CONTEXT;
  }
  if (roleCode === 'CNO' || roleCode === 'CMO' || roleCode === 'MEDICAL_SUPERINTENDENT') {
    return PHI_ACCESS_LEVELS.CLINICAL_LEADERSHIP;
  }
  if (['PHARMACY_STAFF', 'PHARMACY_INCHARGE'].includes(roleCode)) {
    return PHI_ACCESS_LEVELS.PATIENT_RELATIONSHIP;
  }
  if (CLINICAL_ROLE_SET.has(roleCode) || DOCTOR_TIER_SET.has(roleCode)) return PHI_ACCESS_LEVELS.PATIENT_RELATIONSHIP;
  return PHI_ACCESS_LEVELS.NONE;
}

function requiresPatientRelationship(roleCode) {
  return [
    PHI_ACCESS_LEVELS.PATIENT_RELATIONSHIP,
    PHI_ACCESS_LEVELS.CLINICAL_LEADERSHIP,
  ].includes(phiAccessLevelForRole(roleCode));
}

function capabilityGroupsForRole(roleCode) {
  return Object.entries(ROLE_POLICY_CAPABILITY_GROUPS)
    .filter(([, group]) => group.roles.includes(roleCode))
    .map(([key]) => key);
}

function defaultRbacForRole(role) {
  if (role.role_code === 'PATIENT') return RBAC_DEFAULTS.patient;
  if (role.group === 'platform') return RBAC_DEFAULTS.platform;
  if (role.group === 'clinical' || role.group === 'leadership') return RBAC_DEFAULTS.clinical;
  return RBAC_DEFAULTS.support;
}

function defaultAccessMatrix(role) {
  if (role.group === 'clinical' || role.group === 'leadership') return limitedClinicalAccessMatrix();
  if (role.group === 'platform') return {
    users: ['read'],
    appointments: [],
    records: [],
    pharmacy: [],
    investigations: [],
  };
  return {
    users: ['read'],
    appointments: [],
    records: [],
    pharmacy: [],
    investigations: [],
  };
}

function fullAccessMatrix() {
  return {
    users: ['create', 'read', 'update', 'delete'],
    appointments: ['create', 'read', 'update', 'delete'],
    records: ['create', 'read', 'update', 'delete'],
    pharmacy: ['create', 'read', 'update', 'delete'],
    investigations: ['create', 'read', 'update', 'delete'],
  };
}

function nursingAccessMatrix() {
  return {
    users: ['read'],
    appointments: ['read'],
    records: ['read', 'update'],
    pharmacy: ['read'],
    investigations: ['read', 'update'],
  };
}

function opNursingAccessMatrix() {
  return {
    users: ['read'],
    appointments: ['create', 'read', 'update'],
    records: ['read', 'update'],
    pharmacy: ['read'],
    investigations: ['create', 'read', 'update'],
  };
}

function limitedClinicalAccessMatrix() {
  return {
    users: ['read'],
    appointments: ['read'],
    records: ['read', 'update'],
    pharmacy: [],
    investigations: ['read', 'update'],
  };
}

function titleCase(roleCode) {
  return roleCode
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeRoleCode(roleCode) {
  return String(roleCode || '').trim().toUpperCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim().toUpperCase()))];
}

function assertKnownPolicyRole(roleCode, context) {
  const normalized = normalizeRoleCode(roleCode);
  if (!ROLE_POLICY_ROLES.some((role) => role.role_code === normalized)) {
    throw new Error(`Unknown role policy role '${roleCode}' in ${context}`);
  }
}

function sortPolicyRoles(values) {
  const order = new Map(ROLE_POLICY_ROLES.map((role, index) => [role.role_code, index]));
  return unique(values).sort((a, b) => {
    const ai = order.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
