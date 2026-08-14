import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import rbacConfig from '../apps/backend/src/config/rbacConfig.js';
import {
  getStaffRosterRoleCodes,
  ROLE_POLICY_GRAPH,
} from '../apps/backend/src/config/rolePolicyGraph.js';
import {
  ADMIN_ROUTE_ROLES,
  ADMISSION_SURFACE_ROUTE_ROLES,
  ALL_STAFF_MESSAGING_ROUTE_ROLES,
  APPOINTMENT_STAFF_ROUTE_ROLES,
  BED_PARENT_ROUTE_ROLES,
  BILLING_V2_ROUTE_ROLES,
  BLOOD_BANK_ROUTE_ROLES,
  CARE_PATHWAY_ROUTE_ROLES,
  CATH_LAB_ROUTE_ROLES,
  CLINICAL_STAFF_ROUTE_ROLES,
  CLINICAL_INBOX_ROUTE_ROLES,
  DIETARY_ROUTE_ROLES,
  ED_ROUTE_ROLES,
  FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES,
  HOUSEKEEPING_ROUTE_ROLES,
  HOUSEKEEPING_VISIBILITY_ROUTE_ROLES,
  INVESTIGATION_ROUTE_ROLES,
  LAB_ROUTE_ROLES,
  MATERNITY_ROUTE_ROLES,
  OP_FLOW_ROUTE_ROLES,
  PATIENT_LOOKUP_ROUTE_ROLES,
  PEOPLE_OPERATIONS_ROUTE_ROLES,
  PHARMACY_ORDER_ROUTE_ROLES,
  PHYSIO_ROUTE_ROLES,
  RADIOLOGY_ROUTE_ROLES,
  RECORD_ROUTE_ROLES,
  STAFF_GOVERNANCE_ROUTE_ROLES,
  STAFF_PHONE_SELF_SERVICE_ROUTE_ROLES,
  STROKE_ROUTE_ROLES,
  THEATRE_ROUTE_ROLES,
} from '../apps/backend/src/config/routeRolePolicy.js';
import { ROSTER_DEPARTMENT_POLICIES } from '../apps/backend/src/config/rosterDepartmentConfig.js';
import {
  CATH_LAB_WORKFLOW_ROLES,
  DEVICE_ASSOCIATION_OPERATOR_ROLES,
} from '../apps/backend/src/utils/roleHelpers.js';
import { normalizeRole } from '../apps/backend/src/utils/roles.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const generatedStaffRoleContractPath = resolve(
  repoRoot,
  'apps/staff/lib/core/config/staff_role_contract.g.dart',
);
const staffRoleConfigPath = resolve(
  repoRoot,
  'apps/staff/lib/core/config/role_config.dart',
);
const clinicalAiUseRoutesPath = resolve(
  repoRoot,
  'apps/backend/src/routes/admin/clinicalAi/clinicalUseRoutes.js',
);
const biomedCmmsRoutesPath = resolve(
  repoRoot,
  'apps/backend/src/routes/admin/clinicalAi/biomedCmmsRoutes.js',
);
const clinicalAiSharedPath = resolve(
  repoRoot,
  'apps/backend/src/routes/admin/clinicalAi/shared.js',
);

function readStaffEnumRoleCodes() {
  const source = readFileSync(staffRoleConfigPath, 'utf8');
  const start = source.indexOf('enum StaffRole {');
  const end = source.indexOf('  final String value;', start);
  if (start < 0 || end < 0) {
    throw new Error('Unable to locate StaffRole enum values in role_config.dart');
  }
  const values = [...source.slice(start, end).matchAll(/\w+\('([A-Z_]+)'\)/g)]
    .map((match) => match[1]);
  if (values.length === 0) {
    throw new Error('StaffRole enum contains no parseable backend codes');
  }
  return new Set(values);
}

// Every canonical code without a one-to-one StaffRole enum value must be
// deliberately assigned an existing presentation archetype. Authorization
// never uses this map: generated raw-role route sets below remain authoritative.
const roleArchetypeOverrides = {
  CONSULTANT: 'DOCTOR',
  JUNIOR_DOCTOR: 'DOCTOR',
  RESIDENT: 'DOCTOR',
  SENIOR_DOCTOR: 'DOCTOR',
  ANAESTHETIST: 'ANESTHETIST',
  RADIOLOGIST: 'RADIOLOGY_STAFF',
  OT_STAFF: 'OT_NURSE',
  CMO: 'MEDICAL_SUPERINTENDENT',
  NURSING_SUPERINTENDENT: 'CNO',
  ICU_NURSE: 'IP_STAFF_NURSE',
  ICU_STAFF: 'IP_STAFF_NURSE',
  ICU_INCHARGE: 'IP_INCHARGE',
  TECHNICIAN: 'CATH_LAB_STAFF',
  LAB_INCHARGE: 'LAB_STAFF',
  PATHOLOGIST: 'LAB_STAFF',
  DELIVERY_STAFF: 'DRIVER',
  MEDICAL_RECORDS: 'GENERAL_STAFF',
  DIETITIAN: 'GENERAL_STAFF',
  SOCIAL_WORKER: 'GENERAL_STAFF',
  QUALITY_OFFICER: 'GENERAL_STAFF',
  INFECTION_CONTROL_OFFICER: 'GENERAL_STAFF',
  BLOOD_BANK_TECHNICIAN: 'LAB_STAFF',
  DEPARTMENT_HEAD: 'GENERAL_STAFF',
  COUNSELLOR: 'GENERAL_STAFF',
  CARE_COORDINATOR: 'GENERAL_STAFF',
  CLAIMS_MANAGER: 'INSURANCE_COORDINATOR',
  AMBULANCE_COORDINATOR: 'DRIVER',
  INTEGRATION_ADMIN: 'GENERAL_STAFF',
  AI_GOVERNANCE_ADMIN: 'GENERAL_STAFF',
  DATA_PROTECTION_OFFICER: 'GENERAL_STAFF',
  IT: 'GENERAL_STAFF',
  IT_STAFF: 'GENERAL_STAFF',
  IT_ADMIN: 'GENERAL_STAFF',
  SYSTEM_ADMIN: 'GENERAL_STAFF',
  HR_MANAGER: 'GENERAL_STAFF',
  ER_STAFF: 'EMERGENCY_RESPONDER',
  OPERATIONS_INCHARGE: 'GENERAL_STAFF',
  MAINTENANCE_INCHARGE: 'MAINTENANCE',
  PHARMACIST: 'PHARMACY_STAFF',
  DIETARY_STAFF: 'GENERAL_STAFF',
  COMPLIANCE_OFFICER: 'GENERAL_STAFF',
  DIALYSIS_TECHNICIAN: 'GENERAL_STAFF',
  BLOOD_BANK_STAFF: 'LAB_STAFF',
};

function uniqueStaff(values, staffRoleCodes) {
  const allowed = new Set(values.map(normalizeRole).filter(Boolean));
  return staffRoleCodes.filter((role) => allowed.has(normalizeRole(role)));
}

function intersectRoles(...groups) {
  if (groups.length === 0) return [];
  const normalizedGroups = groups.slice(1).map(
    (group) => new Set(group.map(normalizeRole).filter(Boolean)),
  );
  return groups[0].filter((role) => {
    const normalized = normalizeRole(role);
    return normalized && normalizedGroups.every((group) => group.has(normalized));
  });
}

function mergeRoles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

function readBackendStringSet(path, variableName) {
  const source = readFileSync(path, 'utf8');
  const pattern = new RegExp(
    `const\\s+${variableName}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\);`,
  );
  const body = source.match(pattern)?.[1];
  if (!body) throw new Error(`Unable to locate ${variableName} in ${path}`);
  const values = [...body.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
  if (values.length === 0) throw new Error(`${variableName} contains no roles`);
  return values;
}

function readBackendStringArray(path, variableName) {
  const source = readFileSync(path, 'utf8');
  const pattern = new RegExp(
    `(?:export\\s+)?const\\s+${variableName}\\s*=\\s*\\[([\\s\\S]*?)\\];`,
  );
  const body = source.match(pattern)?.[1];
  if (!body) throw new Error(`Unable to locate ${variableName} in ${path}`);
  const values = [...body.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
  if (values.length === 0) throw new Error(`${variableName} contains no roles`);
  return values;
}

function dartString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function renderSet(name, values) {
  const rows = values.map((value) => `  ${dartString(value)},`).join('\n');
  return `const Set<String> ${name} = {\n${rows}\n};`;
}

function renderMap(name, entries) {
  const rows = Object.entries(entries)
    .map(([key, value]) => `  ${dartString(key)}: ${dartString(value)},`)
    .join('\n');
  return `const Map<String, String> ${name} = {\n${rows}\n};`;
}

function renderSetMap(name, entries) {
  const rows = Object.entries(entries)
    .map(([key, values]) => {
      const set = values.map(dartString).join(', ');
      return `  ${dartString(key)}: {${set}},`;
    })
    .join('\n');
  return `const Map<String, Set<String>> ${name} = {\n${rows}\n};`;
}

export function buildStaffRoleContract() {
  const staffRoleCodes = getStaffRosterRoleCodes({ includeAdmin: true });
  const staffEnumRoleCodes = readStaffEnumRoleCodes();
  const archetypes = Object.fromEntries(staffRoleCodes.map((roleCode) => {
    const archetype = staffEnumRoleCodes.has(roleCode)
      ? roleCode
      : roleArchetypeOverrides[roleCode];
    if (!archetype || !staffEnumRoleCodes.has(archetype)) {
      throw new Error(
        `Canonical staff role ${roleCode} needs an explicit StaffRole archetype`,
      );
    }
    return [roleCode, archetype];
  }));

  const rosterManagers = Object.values(ROSTER_DEPARTMENT_POLICIES)
    .flatMap((policy) => policy.managerRoles);
  const phoneStaffRoutes = STAFF_PHONE_SELF_SERVICE_ROUTE_ROLES;
  const staffAttendanceRoles = intersectRoles(
    rbacConfig.staffAttendanceRoutes,
    phoneStaffRoutes,
  );
  const staffRosterRoles = intersectRoles(
    rbacConfig.staffRosterBoardRoutes,
    phoneStaffRoutes,
  );
  const housekeepingSelfServiceRoles = mergeRoles(
    intersectRoles(
      HOUSEKEEPING_VISIBILITY_ROUTE_ROLES,
      rbacConfig.housekeepingRoutes,
    ),
    ['SUPER_ADMIN'],
  );
  const housekeepingAdminRoles = mergeRoles(
    intersectRoles(
      HOUSEKEEPING_VISIBILITY_ROUTE_ROLES,
      rbacConfig.housekeepingAdminRoutes,
    ),
    ['SUPER_ADMIN'],
  );
  const clinicalAiUserRoles = readBackendStringArray(
    clinicalAiSharedPath,
    'CLINICAL_AI_USER_ROLES_LIST',
  );
  const biomedCmmsRoles = intersectRoles(
    clinicalAiUserRoles,
    readBackendStringSet(biomedCmmsRoutesPath, 'CMMS_ROLES'),
  );
  const opAiAssistRoles = readBackendStringSet(
    clinicalAiUseRoutesPath,
    'OP_AI_ASSIST_ROLES',
  );
  const doctorWorkspaceRoles = ROLE_POLICY_GRAPH.roles
    .filter((role) => role.human && (
      role.role_code.includes('DOCTOR')
      || ['CONSULTANT', 'RESIDENT', 'CMO', 'MEDICAL_SUPERINTENDENT', 'ADMIN', 'SUPER_ADMIN']
        .includes(role.role_code)
    ))
    .map((role) => role.role_code);
  const featureRoleSources = {
    admissions: ADMISSION_SURFACE_ROUTE_ROLES,
    appointments: APPOINTMENT_STAFF_ROUTE_ROLES,
    attendance: staffAttendanceRoles,
    audit_logs: ADMIN_ROUTE_ROLES,
    bed_board: BED_PARENT_ROUTE_ROLES,
    billing_desk: BILLING_V2_ROUTE_ROLES,
    biomed_work_orders: biomedCmmsRoles,
    blood_bank: BLOOD_BANK_ROUTE_ROLES,
    cath_lab: CATH_LAB_ROUTE_ROLES,
    clinical_ai_review_queue: clinicalAiUserRoles,
    clinical_inbox: CLINICAL_INBOX_ROUTE_ROLES,
    dental_charting: CLINICAL_STAFF_ROUTE_ROLES,
    device_association: DEVICE_ASSOCIATION_OPERATOR_ROLES,
    dietary: DIETARY_ROUTE_ROLES,
    discharge_hub: FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES,
    duty_preference: staffRosterRoles,
    ed_trauma_workbench: ED_ROUTE_ROLES,
    front_office_workbench: OP_FLOW_ROUTE_ROLES,
    handover: CLINICAL_STAFF_ROUTE_ROLES,
    housekeeping_command: housekeepingAdminRoles,
    housekeeping_hub: HOUSEKEEPING_ROUTE_ROLES,
    housekeeping_roster: ROSTER_DEPARTMENT_POLICIES.housekeeping.managerRoles,
    housekeeping_tasks: housekeepingSelfServiceRoles,
    hr_dashboard: PEOPLE_OPERATIONS_ROUTE_ROLES,
    investigation_results: INVESTIGATION_ROUTE_ROLES,
    investigations_upload: intersectRoles(
      INVESTIGATION_ROUTE_ROLES,
      rbacConfig.investigationRoutes,
    ),
    lab_bookings: LAB_ROUTE_ROLES,
    leave: phoneStaffRoutes,
    leave_approvals: mergeRoles(PEOPLE_OPERATIONS_ROUTE_ROLES, rosterManagers),
    maintenance_roster: ROSTER_DEPARTMENT_POLICIES.maintenance.managerRoles,
    messaging: ALL_STAFF_MESSAGING_ROUTE_ROLES,
    nursing_roster: ROSTER_DEPARTMENT_POLICIES.nursing.managerRoles,
    oncology: CLINICAL_STAFF_ROUTE_ROLES,
    op_ai_assist: opAiAssistRoles,
    op_doctor_workspace: doctorWorkspaceRoles,
    op_nursing_dashboard: OP_FLOW_ROUTE_ROLES,
    op_nursing_roster: ROSTER_DEPARTMENT_POLICIES.op_nursing.managerRoles,
    ophthalmology: CLINICAL_STAFF_ROUTE_ROLES,
    organization_hierarchy: STAFF_GOVERNANCE_ROUTE_ROLES,
    patient_command_board: ADMISSION_SURFACE_ROUTE_ROLES,
    patient_records: RECORD_ROUTE_ROLES,
    payroll: phoneStaffRoutes,
    performance: mergeRoles(PEOPLE_OPERATIONS_ROUTE_ROLES, rosterManagers),
    pharmacy_orders: PHARMACY_ORDER_ROUTE_ROLES,
    pharmacy_roster: ROSTER_DEPARTMENT_POLICIES.pharmacy.managerRoles,
    physiotherapy: PHYSIO_ROUTE_ROLES,
    prescriptions: PHARMACY_ORDER_ROUTE_ROLES,
    profile: phoneStaffRoutes,
    queue: APPOINTMENT_STAFF_ROUTE_ROLES,
    radiation_oncology: CLINICAL_STAFF_ROUTE_ROLES,
    radiology: RADIOLOGY_ROUTE_ROLES,
    reception_roster: ROSTER_DEPARTMENT_POLICIES.reception.managerRoles,
    referrals: CARE_PATHWAY_ROUTE_ROLES,
    reports_grievances: phoneStaffRoutes,
    safety_center: phoneStaffRoutes,
    schedule: staffRosterRoles,
    settings: staffRoleCodes,
    staff_diagnostics: ADMIN_ROUTE_ROLES,
    staff_directory: phoneStaffRoutes,
    staff_management: PEOPLE_OPERATIONS_ROUTE_ROLES,
    staff_roster: rosterManagers,
    stroke_pathway: STROKE_ROUTE_ROLES,
    theatre: THEATRE_ROUTE_ROLES,
    transplant_program: CLINICAL_STAFF_ROUTE_ROLES,
    ward_mode: ADMISSION_SURFACE_ROUTE_ROLES,
  };
  const featureRouteRoles = Object.fromEntries(
    Object.entries(featureRoleSources).map(([featureId, roles]) => [
      featureId,
      uniqueStaff(roles, staffRoleCodes),
    ]),
  );

  return {
    staffRoleCodes,
    archetypes,
    featureRouteRoles,
    clinicalStaffRouteRoles: uniqueStaff(CLINICAL_STAFF_ROUTE_ROLES, staffRoleCodes),
    patientLookupRouteRoles: uniqueStaff(PATIENT_LOOKUP_ROUTE_ROLES, staffRoleCodes),
    maternityRouteRoles: uniqueStaff(MATERNITY_ROUTE_ROLES, staffRoleCodes),
    clinicalDocumentRouteRoles: uniqueStaff(
      FHIR_CLINICAL_DOCUMENT_ROUTE_ROLES,
      staffRoleCodes,
    ),
    cathLabWorkflowRoles: uniqueStaff(CATH_LAB_WORKFLOW_ROLES, staffRoleCodes),
    peopleOperationsRouteRoles: uniqueStaff(
      PEOPLE_OPERATIONS_ROUTE_ROLES,
      staffRoleCodes,
    ),
  };
}

export function renderStaffRoleContractDart() {
  const contract = buildStaffRoleContract();
  const sourceSha256 = createHash('sha256')
    .update(JSON.stringify(contract))
    .digest('hex');

  return `// GENERATED CODE - DO NOT EDIT.\n`
    + `// Sources: backend role, route, RBAC, roster, and clinical-AI policies.\n`
    + `// Regenerate: node scripts/generate-staff-role-contract.mjs\n\n`
    + `// dart format off\n\n`
    + `const String staffRoleContractSourceSha256 = '${sourceSha256}';\n\n`
    + `${renderSet('canonicalStaffRoleCodes', contract.staffRoleCodes)}\n\n`
    + `${renderMap('canonicalStaffRoleArchetypeCodes', contract.archetypes)}\n\n`
    + `${renderSetMap('canonicalStaffFeatureRouteRoleCodes', contract.featureRouteRoles)}\n\n`
    + `${renderSet('canonicalClinicalStaffRouteRoleCodes', contract.clinicalStaffRouteRoles)}\n\n`
    + `${renderSet('canonicalPatientLookupRouteRoleCodes', contract.patientLookupRouteRoles)}\n\n`
    + `${renderSet('canonicalMaternityRouteRoleCodes', contract.maternityRouteRoles)}\n\n`
    + `${renderSet('canonicalClinicalDocumentRouteRoleCodes', contract.clinicalDocumentRouteRoles)}\n\n`
    + `${renderSet('canonicalCathLabWorkflowRoleCodes', contract.cathLabWorkflowRoles)}\n\n`
    + `${renderSet('canonicalPeopleOperationsRouteRoleCodes', contract.peopleOperationsRouteRoles)}\n\n`
    + `// dart format on\n`;
}

const expected = renderStaffRoleContractDart();
if (process.argv.includes('--check')) {
  if (!existsSync(generatedStaffRoleContractPath)) {
    console.error(`Staff role contract is missing: ${generatedStaffRoleContractPath}`);
    process.exit(1);
  }
  const actual = readFileSync(generatedStaffRoleContractPath, 'utf8');
  if (actual !== expected) {
    console.error(
      'Staff role contract drifted from the backend source. '
        + 'Run: node scripts/generate-staff-role-contract.mjs',
    );
    process.exit(1);
  }
  console.log('Staff role contract matches the backend role and route policies.');
} else {
  writeFileSync(generatedStaffRoleContractPath, expected, 'utf8');
  console.log(`Generated ${generatedStaffRoleContractPath}`);
}
