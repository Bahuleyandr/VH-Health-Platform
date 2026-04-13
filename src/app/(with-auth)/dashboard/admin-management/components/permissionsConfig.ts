// Shared configuration for the admin Permissions Matrix UI.

export interface RoleTemplate {
  label: string;
  permissions: string[];
}

export interface AuditEntry {
  timestamp: string;
  action: string;
  adminName: string;
  details?: string;
}

export const PERMISSION_CATEGORIES: Record<
  string,
  { label: string; permissions: string[] }
> = {
  users: {
    label: "User Management",
    permissions: ["userManagement"],
  },
  doctors: {
    label: "Doctor Management",
    permissions: ["doctorManagement"],
  },
  departments: {
    label: "Department Management",
    permissions: ["departmentManagement"],
  },
  appointments: {
    label: "Appointments",
    permissions: ["appointmentManagement"],
  },
  pharmacy: {
    label: "Pharmacy",
    permissions: ["pharmacyAdminRoutes"],
  },
  notifications: {
    label: "Notifications",
    permissions: ["notificationManagement"],
  },
  admin: {
    label: "Admin & Audit",
    permissions: ["adminManagement", "viewAuditLogs"],
  },
};

export const ALL_PERMISSIONS = Object.values(PERMISSION_CATEGORIES).flatMap(
  (c) => c.permissions,
);

export const PERMISSION_DISPLAY: Record<string, string> = {
  adminManagement: "Admin Mgmt",
  userManagement: "User Mgmt",
  doctorManagement: "Doctor Mgmt",
  departmentManagement: "Dept Mgmt",
  appointmentManagement: "Appt Mgmt",
  pharmacyAdminRoutes: "Pharmacy",
  notificationManagement: "Notifications",
  viewAuditLogs: "Audit Logs",
};

export const ROLE_TEMPLATES: Record<string, RoleTemplate> = {
  superAdmin: {
    label: "Super Admin",
    permissions: [...ALL_PERMISSIONS],
  },
  departmentHead: {
    label: "Department Head",
    permissions: [
      "doctorManagement",
      "departmentManagement",
      "appointmentManagement",
      "notificationManagement",
    ],
  },
  receptionist: {
    label: "Receptionist",
    permissions: ["appointmentManagement", "userManagement"],
  },
  pharmacist: {
    label: "Pharmacist",
    permissions: ["pharmacyAdminRoutes"],
  },
  hrManager: {
    label: "HR Manager",
    permissions: ["userManagement", "departmentManagement", "viewAuditLogs"],
  },
};
