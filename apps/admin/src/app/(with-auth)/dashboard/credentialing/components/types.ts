export type CredentialType =
  | "registration"
  | "qualification"
  | "privilege"
  | "training"
  | "immunization";

export type CredentialStatus = "active" | "suspended" | "revoked";
export type CatalogStatus = "active" | "paused" | "retired";
export type AlertSeverity = "low" | "medium" | "high" | "critical";

export interface PrivilegeCatalogEntry {
  id: number;
  privilege_key: string;
  display_name: string;
  description?: string | null;
  required_credential_types?: string[];
  review_cadence_days: number;
  enforcement_scope?: string | null;
  status: CatalogStatus;
  created_at?: string;
  updated_at?: string;
}

export interface StaffCredential {
  id: number;
  staff_uid: string;
  staff_name?: string | null;
  staff_role?: string | null;
  credential_type: CredentialType;
  name: string;
  issuing_body?: string | null;
  registration_number?: string | null;
  valid_from?: string | null;
  valid_until?: string | null;
  status: CredentialStatus;
  document_ref?: string | null;
  document_storage_key?: string | null;
  document_uploaded_at?: string | null;
  notes?: string | null;
  privilege_catalog_id?: number | null;
  privilege_key?: string | null;
  privilege_display_name?: string | null;
  renewal_due_at?: string | null;
  renewal_status?: string | null;
  expired?: boolean;
  created_at?: string;
}

export interface PrivilegeApproval {
  id: number;
  subject_resource_id: string;
  required_role?: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  rejection_reason?: string | null;
  decided_at?: string | null;
  created_at?: string;
  staff_uid?: string | null;
  staff_name?: string | null;
  staff_role?: string | null;
  privilege_key?: string | null;
}

export interface CredentialExpiryAlert {
  id: number;
  staff_credential_id: number;
  staff_uid: string;
  alert_kind: "credential_expiry" | "renewal_due";
  due_date: string;
  days_remaining: number;
  severity: AlertSeverity;
  status: "open" | "acknowledged" | "resolved" | "cancelled";
  acknowledged_at?: string | null;
  resolution?: string | null;
  credential_name?: string | null;
  credential_type?: CredentialType;
  staff_name?: string | null;
  staff_role?: string | null;
}

export interface CatalogResponse {
  catalog: PrivilegeCatalogEntry[];
  count: number;
}

export interface CredentialsResponse {
  credentials: StaffCredential[];
  count: number;
}

export interface ApprovalsResponse {
  approvals: PrivilegeApproval[];
  count: number;
}

export interface AlertsResponse {
  alerts: CredentialExpiryAlert[];
  count: number;
}
