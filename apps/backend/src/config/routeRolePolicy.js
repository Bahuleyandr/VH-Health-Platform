import {
  getRolesForCapabilityGroups,
  getStaffRosterRoleCodes,
} from './rolePolicyGraph.js';

const rolesFrom = (roles) => getRolesForCapabilityGroups([], { include: roles });
const mergeRoles = (...groups) => [...new Set(groups.flat().filter(Boolean))];

export const ADMIN_ROUTE_ROLES = getRolesForCapabilityGroups('platform_admin');
export const TECHNICAL_ADMIN_ROUTE_ROLES = getRolesForCapabilityGroups([
  'platform_admin',
  'technical_admin',
]);
export const PEOPLE_OPERATIONS_ROUTE_ROLES = getRolesForCapabilityGroups('people_operations');
export const STAFF_GOVERNANCE_ROUTE_ROLES = getRolesForCapabilityGroups('staff_governance');

export const OP_FLOW_ROUTE_ROLES = getRolesForCapabilityGroups('op_flow');
export const IP_FLOW_ROUTE_ROLES = getRolesForCapabilityGroups(['ip_flow', 'emergency']);
export const BILLING_ROUTE_ROLES = getRolesForCapabilityGroups('billing');
export const DIAGNOSTICS_ROUTE_ROLES = getRolesForCapabilityGroups('diagnostics');
export const RADIOLOGY_ROUTE_ROLES = mergeRoles(
  DIAGNOSTICS_ROUTE_ROLES,
  rolesFrom(['DOCTOR', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OP_STAFF_NURSE']),
);
export const MICROBIOLOGY_ROUTE_ROLES = mergeRoles(
  DIAGNOSTICS_ROUTE_ROLES,
  rolesFrom(['DOCTOR', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OP_STAFF_NURSE']),
);
export const PATHOLOGY_ROUTE_ROLES = mergeRoles(
  DIAGNOSTICS_ROUTE_ROLES,
  rolesFrom(['DOCTOR', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OP_STAFF_NURSE']),
);
export const PCPNDT_ROUTE_ROLES = mergeRoles(
  DIAGNOSTICS_ROUTE_ROLES,
  rolesFrom(['DOCTOR', 'NURSING_STAFF']),
);
export const LAB_ROUTE_ROLES = mergeRoles(
  DIAGNOSTICS_ROUTE_ROLES,
  rolesFrom(['DOCTOR', 'NURSING_STAFF', 'IP_STAFF_NURSE', 'OP_STAFF_NURSE', 'CATH_LAB_STAFF']),
);
export const PHARMACY_ROUTE_ROLES = getRolesForCapabilityGroups('pharmacy');
export const PHARMACY_SUPPLY_ROUTE_ROLES = getRolesForCapabilityGroups('supply_chain', {
  includeAdmin: true,
});
export const THEATRE_ROUTE_ROLES = getRolesForCapabilityGroups('theatre', {
  include: ['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT', 'NURSING_STAFF'],
});
export const CATH_LAB_ROUTE_ROLES = getRolesForCapabilityGroups('cath_lab', {
  include: ['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT', 'NURSING_STAFF'],
});
export const HOUSEKEEPING_ROUTE_ROLES = getRolesForCapabilityGroups('housekeeping');
export const NOTIFICATION_AUDIT_ROUTE_ROLES = getRolesForCapabilityGroups('notifications_audit');

export const CLINICAL_STAFF_ROUTE_ROLES = getRolesForCapabilityGroups([
  'op_flow',
  'ip_flow',
  'nursing_governance',
  'theatre',
  'cath_lab',
  'pharmacy',
  'emergency',
], {
  include: ['CMO', 'MEDICAL_SUPERINTENDENT', 'MEDICAL_RECORDS'],
  exclude: ['RECEPTIONIST', 'RECEPTION_INCHARGE'],
});

export const PHYSIO_ROUTE_ROLES = mergeRoles(
  CLINICAL_STAFF_ROUTE_ROLES,
  rolesFrom(['PHYSIOTHERAPIST']),
);

export const EMR_TIMELINE_READ_ROUTE_ROLES = mergeRoles(
  CLINICAL_STAFF_ROUTE_ROLES,
  rolesFrom(['RECEPTIONIST', 'RECEPTION_INCHARGE']),
);

export const ADMISSION_SURFACE_ROUTE_ROLES = mergeRoles(
  CLINICAL_STAFF_ROUTE_ROLES,
  OP_FLOW_ROUTE_ROLES,
  BILLING_ROUTE_ROLES,
  getRolesForCapabilityGroups('dietary'),
  rolesFrom(['PHYSIOTHERAPIST', 'COUNSELLOR', 'SOCIAL_WORKER', 'CARE_COORDINATOR']),
);

export const ADMISSION_OCCUPANCY_ROUTE_ROLES = mergeRoles(
  ADMISSION_SURFACE_ROUTE_ROLES,
  HOUSEKEEPING_ROUTE_ROLES,
);

export const BED_PARENT_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'nursing_governance', 'emergency']),
  PHARMACY_ROUTE_ROLES,
  HOUSEKEEPING_ROUTE_ROLES,
  rolesFrom([
    'DOCTOR',
    'DUTY_DOCTOR',
    'ANAESTHETIST',
    'ANESTHETIST',
    'CMO',
    'MEDICAL_SUPERINTENDENT',
    'RECEPTIONIST',
    'RECEPTION_INCHARGE',
    'ADMISSION_OFFICER',
    'IPD_COUNSELLOR',
  ]),
);

export const BED_CLINICAL_ROUTE_ROLES = getRolesForCapabilityGroups(['ip_flow', 'emergency'], {
  include: ['CMO', 'MEDICAL_SUPERINTENDENT', 'CNO'],
  exclude: ['ADMISSION_OFFICER', 'IPD_COUNSELLOR'],
});

export const BED_ALLOCATION_ROUTE_ROLES = getRolesForCapabilityGroups(['ip_flow', 'emergency'], {
  include: ['RECEPTIONIST', 'RECEPTION_INCHARGE'],
});

export const BED_INSPECTION_ROUTE_ROLES = getRolesForCapabilityGroups(['ip_flow'], {
  include: ['RECEPTIONIST'],
});

export const INVESTIGATION_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['diagnostics', 'ip_flow', 'op_flow', 'nursing_governance', 'theatre', 'cath_lab']),
  rolesFrom(['CMO', 'MEDICAL_SUPERINTENDENT', 'MEDICAL_RECORDS', 'PATIENT']),
);

export const PATIENT_LOOKUP_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'op_flow', 'nursing_governance', 'theatre', 'cath_lab', 'billing']),
  rolesFrom(['CMO', 'MEDICAL_SUPERINTENDENT', 'MEDICAL_RECORDS']),
);

export const PATIENT_REGISTRY_WRITE_ROUTE_ROLES = mergeRoles(
  ADMIN_ROUTE_ROLES,
  BILLING_ROUTE_ROLES,
  rolesFrom([
    'MEDICAL_RECORDS',
    'RECEPTIONIST',
    'RECEPTION_INCHARGE',
    'ADMISSION_OFFICER',
    'IPD_COUNSELLOR',
  ]),
);

// /api/v1/appointments mount-level gate (audit finding H2 2026-06-10: the
// router previously relied on a dead wrapAutoRBAC call and had NO role gate,
// so any authenticated user could reach cross-patient list/admin surfaces).
// PATIENT is included at the mount because booking / own-appointment reads are
// patient-facing; staff-only and admin-only sub-routes re-narrow below.
// Billing/diagnostics/pharmacy are included because the appointment list is a
// declared read surface for them (APPOINTMENT_CONFIG.PERMISSIONS.VIEW_ALL and
// the role access matrix both grant appointments:read to billing desk, lab,
// and pharmacy staff); controller-level permission checks re-narrow further.
export const APPOINTMENT_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups([
    'op_flow',
    'ip_flow',
    'nursing_governance',
    'emergency',
    'billing',
    'diagnostics',
    'pharmacy',
  ]),
  rolesFrom(['PATIENT', 'CMO', 'MEDICAL_SUPERINTENDENT', 'CNO', 'MEDICAL_RECORDS']),
);

// Staff-only appointment surfaces (cross-patient reads: /pending,
// /completed/recent, queue boards). Everything in the mount set EXCEPT
// PATIENT — a patient must never read other patients' appointment data.
export const APPOINTMENT_STAFF_ROUTE_ROLES = APPOINTMENT_ROUTE_ROLES.filter(
  (role) => role !== 'PATIENT',
);

export const PATIENT_FLOW_SUPERVISED_ROUTE_ROLES = mergeRoles(
  APPOINTMENT_STAFF_ROUTE_ROLES,
  rolesFrom([
    'RECEPTIONIST',
    'RECEPTION_INCHARGE',
    'ADMISSION_OFFICER',
    'MEDICAL_RECORDS',
  ]),
);

export const PATIENT_FLOW_ROUTE_ROLES = mergeRoles(
  PATIENT_FLOW_SUPERVISED_ROUTE_ROLES,
  rolesFrom([
    'PATIENT',
    'DRIVER',
    'DELIVERY_STAFF',
    'EMERGENCY_RESPONDER',
    'AMBULANCE_COORDINATOR',
  ]),
);

export const PATIENT_FLOW_SETTINGS_ROUTE_ROLES = mergeRoles(
  ADMIN_ROUTE_ROLES,
  rolesFrom([
    'RECEPTION_INCHARGE',
    'ADMISSION_OFFICER',
    'CMO',
    'MEDICAL_SUPERINTENDENT',
  ]),
);

export const PATIENT_TRANSPORT_ROUTE_ROLES = mergeRoles(
  PATIENT_FLOW_SUPERVISED_ROUTE_ROLES,
  getRolesForCapabilityGroups(['ip_flow', 'diagnostics', 'emergency', 'people_operations']),
  rolesFrom([
    'DRIVER',
    'DELIVERY_STAFF',
    'EMERGENCY_RESPONDER',
    'AMBULANCE_COORDINATOR',
    'HR_STAFF',
    'MEDICAL_SUPERINTENDENT',
  ]),
);

export const PATIENT_TRANSPORT_SETTINGS_ROUTE_ROLES = mergeRoles(
  ADMIN_ROUTE_ROLES,
  rolesFrom([
    'RECEPTION_INCHARGE',
    'ADMISSION_OFFICER',
    'IP_INCHARGE',
    'HR_STAFF',
    'MEDICAL_SUPERINTENDENT',
  ]),
);

export const PHARMACY_ORDER_ROUTE_ROLES = mergeRoles(
  PHARMACY_ROUTE_ROLES,
  getRolesForCapabilityGroups(['ip_flow', 'op_flow']),
  rolesFrom(['PATIENT']),
);

export const DELIVERY_ROUTE_ROLES = mergeRoles(
  PHARMACY_ROUTE_ROLES,
  rolesFrom(['DELIVERY_STAFF', 'PATIENT']),
);

export const CONSENT_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'op_flow']),
  rolesFrom(['PATIENT']),
);

export const RECORD_ROUTE_ROLES = mergeRoles(
  CONSENT_ROUTE_ROLES,
  rolesFrom(['MEDICAL_RECORDS']),
);

export const VIRTUAL_WARD_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'nursing_governance']),
  rolesFrom(['PATIENT']),
);

export const CLINICAL_ASSESSMENT_ROUTE_ROLES = getRolesForCapabilityGroups([
  'ip_flow',
  'op_flow',
  'theatre',
  'cath_lab',
], {
  exclude: [
    'RECEPTIONIST',
    'RECEPTION_INCHARGE',
    'ADMISSION_OFFICER',
    'IPD_COUNSELLOR',
  ],
});

export const FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES = getRolesForCapabilityGroups(['ip_flow'], {
  include: ['MEDICAL_RECORDS'],
  exclude: ['ADMISSION_OFFICER', 'IPD_COUNSELLOR', 'ICU_NURSE', 'ICU_INCHARGE', 'ICU_STAFF'],
});

export const STAFF_PATIENT_MESSAGING_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'op_flow', 'nursing_governance', 'theatre', 'cath_lab', 'billing']),
  rolesFrom(['CMO', 'MEDICAL_SUPERINTENDENT']),
);

export const ALL_STAFF_MESSAGING_ROUTE_ROLES = getStaffRosterRoleCodes({ includeAdmin: true });

export const STAFF_PHONE_SELF_SERVICE_ROUTE_ROLES = getRolesForCapabilityGroups('phone_self_service');

export const HOUSEKEEPING_VISIBILITY_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'pharmacy', 'diagnostics', 'people_operations', 'housekeeping']),
  rolesFrom(['DOCTOR']),
);

export const LINEN_LAUNDRY_ROUTE_ROLES = mergeRoles(
  HOUSEKEEPING_ROUTE_ROLES,
  PHARMACY_SUPPLY_ROUTE_ROLES,
  getRolesForCapabilityGroups('ip_flow'),
  rolesFrom(['NURSING_STAFF', 'NURSING_INCHARGE', 'STORES_PURCHASE_INCHARGE']),
);

export const ED_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'emergency']),
  rolesFrom(['MEDICAL_RECORDS']),
);

export const IPD_SUPPORT_ROUTE_ROLES = mergeRoles(
  BILLING_ROUTE_ROLES,
  getRolesForCapabilityGroups(['ip_flow', 'pharmacy']),
  rolesFrom(['RECEPTIONIST', 'ADMISSION_OFFICER']),
);

export const NURSING_ASSESSMENT_ROUTE_ROLES = getRolesForCapabilityGroups([
  'ip_flow',
  'op_flow',
  'theatre',
], {
  exclude: [
    'RECEPTIONIST',
    'RECEPTION_INCHARGE',
    'ADMISSION_OFFICER',
    'IPD_COUNSELLOR',
  ],
});

export const DIETARY_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['dietary', 'ip_flow']),
  rolesFrom(['DOCTOR']),
);

export const ICU_ROUTE_ROLES = getRolesForCapabilityGroups(['ip_flow', 'emergency'], {
  exclude: ['ADMISSION_OFFICER', 'IPD_COUNSELLOR'],
});

export const COMPLIANCE_ROUTE_ROLES = mergeRoles(
  NOTIFICATION_AUDIT_ROUTE_ROLES,
  PHARMACY_ROUTE_ROLES,
  rolesFrom(['NURSING_STAFF', 'COMPLIANCE_OFFICER']),
);

export const DIALYSIS_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'specialty_services']),
  rolesFrom(['DOCTOR']),
);

export const CSSD_ROUTE_ROLES = mergeRoles(
  THEATRE_ROUTE_ROLES,
  getRolesForCapabilityGroups(['supply_chain', 'notifications_audit']),
  rolesFrom(['STORES_PURCHASE_INCHARGE', 'QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER']),
);

export const BLOOD_BANK_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'theatre', 'cath_lab', 'specialty_services']),
  rolesFrom(['DOCTOR', 'PATHOLOGIST', 'LAB_INCHARGE']),
);

export const COLD_CHAIN_ROUTE_ROLES = mergeRoles(
  PHARMACY_ROUTE_ROLES,
  LAB_ROUTE_ROLES,
  BLOOD_BANK_ROUTE_ROLES,
  THEATRE_ROUTE_ROLES,
  rolesFrom(['NURSING_STAFF', 'NURSING_INCHARGE', 'CMO', 'CNO', 'MEDICAL_SUPERINTENDENT', 'ADMIN']),
);

export const BILLING_V2_ROUTE_ROLES = mergeRoles(
  BILLING_ROUTE_ROLES,
  getRolesForCapabilityGroups(['ip_flow', 'op_flow']),
);

export const PAEDIATRIC_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow', 'op_flow']),
  rolesFrom(['RECEPTIONIST']),
);

export const MATERNITY_ROUTE_ROLES = mergeRoles(
  getRolesForCapabilityGroups(['ip_flow']),
  rolesFrom(['PATIENT']),
);
