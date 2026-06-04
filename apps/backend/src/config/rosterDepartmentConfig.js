const EXECUTIVE_ROSTER_ROLES = ['ADMIN', 'SUPER_ADMIN'];
const HR_PROCESS_ROLES = ['HR_STAFF'];

function uniqueRoles(roles = []) {
  return [...new Set(roles.map(role => String(role || '').trim().toUpperCase()).filter(Boolean))];
}

export function normalizeRosterDepartment(department) {
  const key = String(department || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key === 'drivers' ? 'ambulance' : key;
}

const BASE_DEPARTMENT_POLICIES = {
  housekeeping: {
    department: 'housekeeping',
    label: 'Housekeeping',
    staffRoles: ['HOUSEKEEPING_STAFF', 'HOUSEKEEPING_INCHARGE'],
    workManagerRoles: [...EXECUTIVE_ROSTER_ROLES, 'HOUSEKEEPING_INCHARGE'],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'housekeeping_zone',
    governanceNote: 'Housekeeping Incharge owns floor deployment; HR owns leave records and policy process.'
  },
  nursing: {
    department: 'nursing',
    label: 'IP Nursing',
    staffRoles: ['NURSING_STAFF', 'NURSING_INCHARGE', 'IP_STAFF_NURSE', 'IP_INCHARGE', 'ICU_NURSE'],
    workManagerRoles: [
      ...EXECUTIVE_ROSTER_ROLES,
      'NURSING_INCHARGE',
      'IP_INCHARGE',
      'DUTY_DOCTOR',
      'MEDICAL_SUPERINTENDENT',
      'CNO'
    ],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'ward',
    governanceNote: 'Nursing deployment stays with nursing/medical leadership; HR supports leave records.'
  },
  op_nursing: {
    department: 'op_nursing',
    label: 'OP Staff Nursing',
    staffRoles: ['OP_STAFF_NURSE', 'OP_INCHARGE'],
    workManagerRoles: [
      ...EXECUTIVE_ROSTER_ROLES,
      'OP_INCHARGE',
      'NURSING_INCHARGE',
      'MEDICAL_SUPERINTENDENT',
      'CNO'
    ],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'op_area',
    governanceNote: 'OP nursing is assigned by OP/Nursing leadership with HR leave-process support.'
  },
  ot_nursing: {
    department: 'ot_nursing',
    label: 'OT Nursing',
    staffRoles: ['OT_NURSE', 'OT_STAFF', 'OT_INCHARGE'],
    workManagerRoles: [
      ...EXECUTIVE_ROSTER_ROLES,
      'OT_INCHARGE',
      'NURSING_INCHARGE',
      'MEDICAL_SUPERINTENDENT',
      'CNO'
    ],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'operating_theatre',
    governanceNote: 'OT nursing is assigned by theatre/nursing leadership with HR leave-process support.'
  },
  cath_lab: {
    department: 'cath_lab',
    label: 'Cath Lab',
    staffRoles: ['CATH_LAB_STAFF', 'CATH_LAB_INCHARGE'],
    workManagerRoles: [
      ...EXECUTIVE_ROSTER_ROLES,
      'CATH_LAB_INCHARGE',
      'MEDICAL_SUPERINTENDENT',
      'CNO'
    ],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'cath_lab_suite',
    governanceNote: 'Cath Lab deployment is owned by Cath Lab/Nursing leadership with HR leave-process support.'
  },
  reception: {
    department: 'reception',
    label: 'Reception',
    staffRoles: ['RECEPTIONIST', 'RECEPTION_INCHARGE', 'ADMISSION_OFFICER'],
    workManagerRoles: [...EXECUTIVE_ROSTER_ROLES, 'RECEPTION_INCHARGE'],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'reception_desk',
    governanceNote: 'Reception Incharge owns desk deployment; HR supports leave records.'
  },
  pharmacy: {
    department: 'pharmacy',
    label: 'Pharmacy',
    staffRoles: ['PHARMACY_STAFF'],
    workManagerRoles: [...EXECUTIVE_ROSTER_ROLES, 'PHARMACY_STAFF'],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'pharmacy_counter',
    governanceNote: 'Pharmacy roster is operational; HR remains a leave-process reviewer.'
  },
  ambulance: {
    department: 'ambulance',
    label: 'Ambulance / Drivers',
    staffRoles: [
      'DRIVER',
      'AMBULANCE_DRIVER',
      'DELIVERY_STAFF',
      'EMERGENCY_RESPONDER',
      'AMBULANCE_COORDINATOR'
    ],
    workManagerRoles: [...EXECUTIVE_ROSTER_ROLES, 'HR_STAFF'],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'ambulance_unit',
    governanceNote: 'Drivers are rostered through HR/operations until a dedicated transport incharge role is added.'
  },
  maintenance: {
    department: 'maintenance',
    label: 'Maintenance',
    staffRoles: ['MAINTENANCE'],
    workManagerRoles: [...EXECUTIVE_ROSTER_ROLES, 'MAINTENANCE'],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'maintenance_zone',
    governanceNote: 'Maintenance work allocation is separate from HR leave processing.'
  },
  medical: {
    department: 'medical',
    label: 'Duty Doctors',
    staffRoles: ['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT'],
    workManagerRoles: [...EXECUTIVE_ROSTER_ROLES, 'MEDICAL_SUPERINTENDENT', 'CMO'],
    hrProcessRoles: HR_PROCESS_ROLES,
    targetType: 'clinical_unit',
    governanceNote: 'Doctor duty placement is owned by Medical Superintendent/CMO with HR leave-process support.'
  }
};

export const ROSTER_DEPARTMENT_POLICIES = Object.fromEntries(
  Object.entries(BASE_DEPARTMENT_POLICIES).map(([key, policy]) => [
    key,
    {
      ...policy,
      staffRoles: uniqueRoles(policy.staffRoles),
      workManagerRoles: uniqueRoles(policy.workManagerRoles),
      hrProcessRoles: uniqueRoles(policy.hrProcessRoles),
      managerRoles: uniqueRoles([
        ...policy.workManagerRoles,
        ...policy.hrProcessRoles
      ]),
      preferenceReviewerRoles: uniqueRoles([
        ...policy.workManagerRoles,
        ...policy.hrProcessRoles
      ]),
      forecastRoles: uniqueRoles([
        ...policy.workManagerRoles,
        ...policy.hrProcessRoles
      ])
    }
  ])
);

export function getRosterDepartmentPolicy(department) {
  return ROSTER_DEPARTMENT_POLICIES[normalizeRosterDepartment(department)] || null;
}

function actorRole(user) {
  return String(user?.rawRole || user?.role || '').trim().toUpperCase();
}

function roleAllowed(user, roles = []) {
  return uniqueRoles(roles).includes(actorRole(user));
}

export function canViewRosterDepartment(user, department) {
  const policy = getRosterDepartmentPolicy(department);
  return Boolean(policy && roleAllowed(user, policy.managerRoles));
}

export function canManageRosterDepartmentWork(user, department) {
  const policy = getRosterDepartmentPolicy(department);
  return Boolean(policy && roleAllowed(user, policy.workManagerRoles));
}

export function canReviewRosterDepartmentRequest(user, department) {
  const policy = getRosterDepartmentPolicy(department);
  return Boolean(policy && roleAllowed(user, policy.preferenceReviewerRoles));
}

export function canPlanRosterForecast(user, department) {
  const policy = getRosterDepartmentPolicy(department);
  return Boolean(policy && roleAllowed(user, policy.forecastRoles));
}

export function getRosterDepartmentStaffRoles(department) {
  return getRosterDepartmentPolicy(department)?.staffRoles || [];
}
