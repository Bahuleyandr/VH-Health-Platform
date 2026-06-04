export const SAFE_STAFF_ACCESS_DENIAL_MESSAGE =
  'Staff record access denied: no self, HR-processing, reporting, or management relationship';

export const STAFF_ACCESS_POLICY_CODES = Object.freeze({
  STAFF_DIRECTORY_VIEW: 'staff.directory.view',
  STAFF_PROFILE_VIEW: 'staff.profile.view',
  STAFF_PROFILE_WRITE: 'staff.profile.write',
  STAFF_REPORT_VIEW: 'staff.report.view',
  STAFF_ATTENDANCE_VIEW: 'staff.attendance.view',
  STAFF_ATTENDANCE_WRITE: 'staff.attendance.write',
  STAFF_LEAVE_VIEW: 'staff.leave.view',
  STAFF_LEAVE_WRITE: 'staff.leave.write',
  STAFF_PAYROLL_VIEW: 'staff.payroll.view',
  STAFF_PAYROLL_SELF_WRITE: 'staff.payroll.self.write',
  STAFF_PAYROLL_WRITE: 'staff.payroll.write',
});

const DEFAULT_SAFE_DENIAL = Object.freeze({
  safe_denial_code: 'STAFF_ACCESS_DENIED',
  safe_denial_message: SAFE_STAFF_ACCESS_DENIAL_MESSAGE,
});

function policy({
  code,
  title,
  resourceType,
  action,
  allowSelf = false,
  allowHrProcess = true,
  allowReportingScope = false,
  allowManagementScope = false,
  collectionAccess = 'people_ops',
}) {
  return {
    code,
    title,
    resource_type: resourceType,
    action,
    allow_self: allowSelf,
    allow_hr_process: allowHrProcess,
    allow_reporting_scope: allowReportingScope,
    allow_management_scope: allowManagementScope,
    collection_access: collectionAccess,
    audit_required: true,
    ...DEFAULT_SAFE_DENIAL,
  };
}

export const STAFF_ACCESS_POLICIES = Object.freeze({
  [STAFF_ACCESS_POLICY_CODES.STAFF_DIRECTORY_VIEW]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_DIRECTORY_VIEW,
    title: 'View staff directory',
    resourceType: 'staff_directory',
    action: 'VIEW',
    allowSelf: true,
    allowReportingScope: true,
    collectionAccess: 'visibility',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_VIEW,
    title: 'View staff profile',
    resourceType: 'staff_profile',
    action: 'VIEW',
    allowSelf: true,
    allowReportingScope: true,
    collectionAccess: 'visibility',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_WRITE]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_PROFILE_WRITE,
    title: 'Create or update staff profile',
    resourceType: 'staff_profile',
    action: 'UPDATE',
    allowSelf: true,
    allowManagementScope: true,
    collectionAccess: 'people_ops',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_REPORT_VIEW]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_REPORT_VIEW,
    title: 'View staff reports and hierarchy',
    resourceType: 'staff_report',
    action: 'VIEW',
    allowReportingScope: true,
    collectionAccess: 'leadership',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_VIEW]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_VIEW,
    title: 'View staff attendance',
    resourceType: 'staff_attendance',
    action: 'VIEW',
    allowSelf: true,
    allowReportingScope: true,
    collectionAccess: 'leadership',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_WRITE]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_ATTENDANCE_WRITE,
    title: 'Record or adjust staff attendance',
    resourceType: 'staff_attendance',
    action: 'UPDATE',
    allowSelf: true,
    collectionAccess: 'people_ops',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_VIEW]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_VIEW,
    title: 'View staff leave',
    resourceType: 'staff_leave',
    action: 'VIEW',
    allowSelf: true,
    allowReportingScope: true,
    collectionAccess: 'leadership',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_WRITE]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_LEAVE_WRITE,
    title: 'Apply, recommend, or process staff leave',
    resourceType: 'staff_leave',
    action: 'UPDATE',
    allowSelf: true,
    allowReportingScope: true,
    collectionAccess: 'people_ops',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_VIEW]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_VIEW,
    title: 'View staff payroll',
    resourceType: 'staff_payroll',
    action: 'VIEW',
    allowSelf: true,
    collectionAccess: 'payroll',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_WRITE]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_WRITE,
    title: 'Create or update staff payroll',
    resourceType: 'staff_payroll',
    action: 'UPDATE',
    collectionAccess: 'payroll',
  }),
  [STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_SELF_WRITE]: policy({
    code: STAFF_ACCESS_POLICY_CODES.STAFF_PAYROLL_SELF_WRITE,
    title: 'Submit own payroll declaration or query',
    resourceType: 'staff_payroll_self_service',
    action: 'UPDATE',
    allowSelf: true,
    allowHrProcess: false,
    collectionAccess: 'self',
  }),
});

export function getStaffAccessPolicy(policyCode) {
  return STAFF_ACCESS_POLICIES[policyCode] || null;
}
