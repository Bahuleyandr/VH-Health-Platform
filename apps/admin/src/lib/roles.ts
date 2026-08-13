// Canonical human roles accepted by the Admin portal. Keep this list aligned
// with the backend role-policy graph; machine and patient principals are
// deliberately excluded because they must never acquire a portal session.
export const PORTAL_ROLE_VALUES = [
  "SUPER_ADMIN",
  "ADMIN",
  "DOCTOR",
  "DUTY_DOCTOR",
  "MEDICAL_SUPERINTENDENT",
  "NURSING_STAFF",
  "NURSING_INCHARGE",
  "OP_STAFF_NURSE",
  "OP_INCHARGE",
  "IP_STAFF_NURSE",
  "IP_INCHARGE",
  "OT_NURSE",
  "OT_INCHARGE",
  "CATH_LAB_STAFF",
  "CATH_LAB_INCHARGE",
  "TECHNICIAN",
  "PHARMACY_STAFF",
  "PHARMACY_INCHARGE",
  "STORES_PURCHASE_INCHARGE",
  "LAB_STAFF",
  "LAB_INCHARGE",
  "LAB_TECHNICIAN",
  "PATHOLOGIST",
  "HR_STAFF",
  "GENERAL_STAFF",
  "HOUSEKEEPING_STAFF",
  "HOUSEKEEPING_INCHARGE",
  "MAINTENANCE",
  "BIOMEDICAL_STAFF",
  "DELIVERY_STAFF",
  "MEDICAL_RECORDS",
  "RECEPTIONIST",
  "RECEPTION_INCHARGE",
  "DRIVER",
  "SECURITY",
  "EMERGENCY_RESPONDER",
  "RADIOLOGIST",
  "RADIOLOGY_STAFF",
  "ANESTHETIST",
  "ANAESTHETIST",
  "DIETITIAN",
  "PHYSIOTHERAPIST",
  "SOCIAL_WORKER",
  "BILLING_STAFF",
  "BILLING_INCHARGE",
  "FINANCE_INCHARGE",
  "INSURANCE_COORDINATOR",
  "ADMISSION_OFFICER",
  "IPD_COUNSELLOR",
  "QUALITY_OFFICER",
  "INFECTION_CONTROL_OFFICER",
  "OT_STAFF",
  "BLOOD_BANK_TECHNICIAN",
  "DEPARTMENT_HEAD",
  "CMO",
  "CNO",
  "CONSULTANT",
  "JUNIOR_DOCTOR",
  "RESIDENT",
  "COUNSELLOR",
  "CARE_COORDINATOR",
  "CLAIMS_MANAGER",
  "AMBULANCE_COORDINATOR",
  "INTEGRATION_ADMIN",
  "AI_GOVERNANCE_ADMIN",
  "DATA_PROTECTION_OFFICER",
  "IT",
  "IT_STAFF",
  "IT_ADMIN",
  "SYSTEM_ADMIN",
  "HR_MANAGER",
  "NURSING_SUPERINTENDENT",
  "SENIOR_DOCTOR",
  "ICU_NURSE",
  "ICU_INCHARGE",
  "ICU_STAFF",
  "ER_STAFF",
  "OPERATIONS_INCHARGE",
  "MAINTENANCE_INCHARGE",
  "PHARMACIST",
  "DIETARY_STAFF",
  "COMPLIANCE_OFFICER",
  "DIALYSIS_TECHNICIAN",
  "BLOOD_BANK_STAFF",
  // Transitional values still issued by older test/local environments.
  "STAFF",
  "HR",
  "NURSE",
] as const;

export type PortalRole = (typeof PORTAL_ROLE_VALUES)[number];
export type PortalAccessLevel =
  | "STAFF"
  | "DOCTOR"
  | "HR"
  | "ADMIN"
  | "SUPER_ADMIN";

const PORTAL_ROLE_SET = new Set<string>(PORTAL_ROLE_VALUES);

const CLINICAL_LEAD_ROLES = new Set<PortalRole>([
  "DOCTOR",
  "DUTY_DOCTOR",
  "MEDICAL_SUPERINTENDENT",
  "ANESTHETIST",
  "ANAESTHETIST",
  "DEPARTMENT_HEAD",
  "CMO",
  "CNO",
  "CONSULTANT",
  "JUNIOR_DOCTOR",
  "RESIDENT",
  "NURSING_SUPERINTENDENT",
  "SENIOR_DOCTOR",
]);

const HR_ROLES = new Set<PortalRole>(["HR", "HR_STAFF", "HR_MANAGER"]);

export function normalizePortalRole(value: unknown): PortalRole | null {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return PORTAL_ROLE_SET.has(normalized) ? (normalized as PortalRole) : null;
}

export function portalAccessLevel(role: unknown): PortalAccessLevel | null {
  const normalized = normalizePortalRole(role);
  if (!normalized) return null;
  if (normalized === "SUPER_ADMIN") return "SUPER_ADMIN";
  if (normalized === "ADMIN") return "ADMIN";
  if (HR_ROLES.has(normalized)) return "HR";
  if (CLINICAL_LEAD_ROLES.has(normalized)) return "DOCTOR";
  return "STAFF";
}

export function portalRoleRank(role: unknown): number {
  switch (portalAccessLevel(role)) {
    case "SUPER_ADMIN":
      return 4;
    case "ADMIN":
      return 3;
    case "HR":
      return 2;
    case "DOCTOR":
      return 1;
    case "STAFF":
      return 0;
    default:
      return -1;
  }
}

export const PORTAL_ROLE_RANK: Readonly<Record<PortalRole, number>> =
  Object.freeze(
    Object.fromEntries(
      PORTAL_ROLE_VALUES.map((role) => [role, portalRoleRank(role)]),
    ) as Record<PortalRole, number>,
  );
