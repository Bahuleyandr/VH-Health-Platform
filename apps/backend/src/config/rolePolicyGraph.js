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
      'JUNIOR_DOCTOR',
      'RESIDENT',
      'NURSING_STAFF',
      'NURSING_INCHARGE',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
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
    roles: ['SUPER_ADMIN', 'ADMIN', 'LAB_STAFF', 'RADIOLOGIST', 'RADIOLOGY_STAFF', 'PATHOLOGIST'],
  },
  pharmacy: {
    title: 'Pharmacy',
    description: 'Prescription review, ward dispensing, inventory, and medication handover.',
    roles: ['SUPER_ADMIN', 'ADMIN', 'PHARMACY_STAFF', 'PHARMACY_INCHARGE'],
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
    roles: ['SUPER_ADMIN', 'ADMIN', 'HR_STAFF', 'QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'DATA_PROTECTION_OFFICER'],
  },
};

const FUTURE_OR_RECOMMENDED_ROLES = [
  'HR_MANAGER',
  'NURSING_SUPERINTENDENT',
  'ICU_NURSE',
  'OPERATIONS_INCHARGE',
  'MAINTENANCE_INCHARGE',
  'PHARMACY_INCHARGE',
  'PATHOLOGIST',
  'LAB_INCHARGE',
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
  'ANAESTHETIST',
  'ANESTHETIST',
  'RADIOLOGY_STAFF',
  'PATHOLOGIST',
  'LAB_INCHARGE',
  'ICU_NURSE',
  'BLOOD_BANK_TECHNICIAN',
]);
const LEADERSHIP_ROLE_SET = new Set(['SUPER_ADMIN', 'ADMIN', ...LEADERSHIP_ROLES]);
const SUPPORT_ROLE_SET = new Set([...SUPPORT_ROLES, 'RECEPTIONIST', 'PHARMACY_INCHARGE', 'LAB_INCHARGE']);
const PLATFORM_ROLE_SET = new Set(PLATFORM_ROLES);
const MACHINE_ROLE_SET = new Set(MACHINE_ROLES);
const DOCTOR_TIER_SET = new Set([...DOCTOR_TIERS, 'ANAESTHETIST', 'ANESTHETIST']);

const NON_ASSIGNABLE_HUMAN_ROLES = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'PATIENT',
  'HR_MANAGER',
  'NURSING_SUPERINTENDENT',
  'ICU_NURSE',
  'OPERATIONS_INCHARGE',
  'MAINTENANCE_INCHARGE',
  'PHARMACY_INCHARGE',
  'PATHOLOGIST',
  'LAB_INCHARGE',
]);

const DISPLAY_TITLE_OVERRIDES = {
  CMO: 'Chief Medical Officer',
  CNO: 'Nursing Superintendent',
  DOCTOR: 'Doctor',
  DUTY_DOCTOR: 'Duty Doctor',
  IP_STAFF_NURSE: 'IP Staff Nurse',
  IP_INCHARGE: 'IP Nursing Incharge',
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
  RECEPTIONIST: 'Front Office',
  RECEPTION_INCHARGE: 'Front Office',
  ADMISSION_OFFICER: 'Admissions',
  IPD_COUNSELLOR: 'Admissions',
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
  ADMIN: ['front_office_workbench', 'admissions', 'billing_desk', 'staff_management', 'organization_hierarchy', 'safety_center', 'audit_logs', 'bed_board'],
  SUPER_ADMIN: ['front_office_workbench', 'admissions', 'billing_desk', 'staff_management', 'organization_hierarchy', 'safety_center', 'audit_logs', 'bed_board'],
  HR_STAFF: ['staff_management', 'organization_hierarchy', 'hr_dashboard', 'leave_approvals', 'staff_directory', 'reports_grievances', 'audit_logs'],
  CNO: ['organization_hierarchy', 'nursing_roster', 'op_nursing_roster', 'staff_roster', 'patient_command_board', 'bed_board', 'safety_center'],
  RECEPTIONIST: ['front_office_workbench', 'appointments', 'patient_records', 'billing_desk', 'admissions'],
  RECEPTION_INCHARGE: ['front_office_workbench', 'appointments', 'patient_records', 'billing_desk', 'admissions', 'reception_roster'],
  OP_STAFF_NURSE: ['front_office_workbench', 'appointments', 'patient_records', 'lab_bookings', 'nursing_notes'],
  OP_INCHARGE: ['front_office_workbench', 'appointments', 'patient_records', 'lab_bookings', 'nursing_notes', 'op_nursing_roster'],
  NURSING_STAFF: ['patient_command_board', 'bed_board', 'nursing_notes', 'handover', 'discharge_hub'],
  IP_STAFF_NURSE: ['patient_command_board', 'bed_board', 'nursing_notes', 'handover', 'discharge_hub'],
  NURSING_INCHARGE: ['patient_command_board', 'bed_board', 'nursing_notes', 'handover', 'discharge_hub', 'nursing_roster'],
  IP_INCHARGE: ['patient_command_board', 'bed_board', 'nursing_notes', 'handover', 'discharge_hub', 'nursing_roster'],
  OT_NURSE: ['theatre', 'patient_command_board', 'handover'],
  OT_STAFF: ['theatre', 'handover'],
  OT_INCHARGE: ['theatre', 'patient_command_board', 'handover', 'staff_roster'],
  CATH_LAB_STAFF: ['cath_lab', 'patient_command_board', 'handover'],
  CATH_LAB_INCHARGE: ['cath_lab', 'patient_command_board', 'handover', 'staff_roster'],
  DOCTOR: ['front_office_workbench', 'appointments', 'patient_command_board', 'patient_records', 'prescriptions', 'investigation_results', 'discharge_hub'],
  DUTY_DOCTOR: ['front_office_workbench', 'appointments', 'patient_command_board', 'patient_records', 'prescriptions', 'investigation_results', 'discharge_hub'],
  CONSULTANT: ['front_office_workbench', 'appointments', 'patient_command_board', 'patient_records', 'prescriptions', 'investigation_results', 'discharge_hub'],
  PHARMACY_STAFF: ['pharmacy_orders', 'pharmacy_roster'],
  LAB_STAFF: ['investigations_upload', 'investigation_results', 'lab_bookings'],
  HOUSEKEEPING_STAFF: ['housekeeping_tasks'],
  HOUSEKEEPING_INCHARGE: ['housekeeping_hub', 'housekeeping_command', 'housekeeping_roster'],
};

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
  if (['HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE', 'MAINTENANCE', 'DRIVER', 'SECURITY'].includes(roleCode)) {
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
