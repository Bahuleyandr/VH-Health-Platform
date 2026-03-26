// src/lib/types.ts
import { z } from "zod";
import {
  UserSchema,
  AdminUserSchema,
  DepartmentSchema,
  DoctorSchema,
  PatientSchema,
  AppointmentSchema,
  DashboardDataSchema,
  DashboardDataBackendSchema,
  AdminRoleEnum,
  AppointmentStatusEnum,
} from "./schemas";

/* =========================
 * Shared / Utility Types
 * ========================= */

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Generic list response shape */
export interface ApiList<T> {
  items: T[];
  pagination: Pagination;
}

/** Common API "message" envelope */
export interface ApiMessage {
  message: string;
}

/* =========================
 * Roles (non-admin domain roles)
 * ========================= */

export type Role =
  | "PATIENT"
  | "DOCTOR"
  | "ADMIN"
  | "HR"
  | "STAFF"
  | "NURSE"
  | "PHARMACIST"
  | "TECHNICIAN"
  | "RECEPTIONIST";

/** Portal role union (from schemas) — includes staff roles */
export type AdminRole = z.infer<typeof AdminRoleEnum>;

/* =========================
 * Domain Types (from Zod)
 * ========================= */

export type User = z.infer<typeof UserSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type Department = z.infer<typeof DepartmentSchema>;
export type Doctor = z.infer<typeof DoctorSchema>;
export type Patient = z.infer<typeof PatientSchema>;

export type Appointment = z.infer<typeof AppointmentSchema>;
export type AppointmentStatus = z.infer<typeof AppointmentStatusEnum>;

export type DashboardData = z.infer<typeof DashboardDataSchema>;
export type DashboardDataBackend = z.infer<typeof DashboardDataBackendSchema>;

/* =========================
 * API Response Helpers
 * ========================= */

export interface UsersAPIResponse extends ApiMessage {
  users: User[];
  pagination: Pagination;
}

/* =========================
 * Notifications / Settings
 * ========================= */

export interface Notification {
  id: number;
  title: string;
  body: string;
  type: string;
  created_at: string; // ISO date string
  recipient_id?: number;
  is_read?: boolean;
}

export interface SystemSetting {
  setting_key: string;
  setting_value: string;
  description?: string;
  created_at?: string; // ISO date string
  updated_at?: string; // ISO date string
}

/* =========================
 * Pharmacy (kept as TS-only)
 * ========================= */

export interface PharmacyOrder {
  id: number;
  order_number: string;
  patient_name: string;
  phone: string;
  order_note: string | null;
  prescription_photo_key: string | null;
  prescription_photo_url: string | null;
  delivery_type: "delivery" | "pickup";
  delivery_address: string | null;
  delivery_phone: string | null;
  status: "PLACED" | "CONFIRMED" | "PREPARING" | "DISPATCHED" | "DELIVERED" | "CANCELLED" | "PENDING" | "COMPLETED";
  total_cost: number | null;
  items_list: Array<{ name: string; qty: number; price: number }> | null;
  confirmed_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  delivery_person: string | null;
  delivery_person_phone: string | null;
  sla_breached: boolean;
  mins_since_placed: number;
  created_at: string;
  // Legacy compat
  doctor_name?: string;
  order_date?: string;
  total_amount?: number;
  items?: Array<{ name: string; quantity: number }>;
}

export interface PharmacyAnalytics {
  total_revenue: number;
  total_orders: number;
  pending_orders: number;
  top_selling_medicines: Array<{ name: string; total_quantity: number }>;
}

export interface PharmacyCatalogItem {
  id: number;
  name: string;
  generic_name: string | null;
  category: string;
  manufacturer: string | null;
  unit_price: number | null;
  pack_size: string | null;
  requires_prescription: boolean;
  in_stock: boolean;
  stock_quantity: number;
  reorder_level: number;
  is_active: boolean;
}

/* =========================
 * Logs
 * ========================= */

export interface AuditLog {
  id: number;
  user_id: number;
  action: string;
  details: string;
  ip_address: string;
  user_agent: string;
  created_at: string; // ISO date string
}

export interface SystemLog {
  id: number;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG";
  message: string;
  timestamp: string; // ISO date string
  user_id?: number;
  action?: string;
}

/** Extended logs used in UI tables */
export interface ExtendedAuditLog extends AuditLog {
  user_name?: string;
}

export interface ExtendedSystemLog extends SystemLog {
  service?: string;
  module?: string;
  metadata?: Record<string, unknown>;
}

/* =========================
 * Filtering Helpers
 * ========================= */

export interface LogFilters {
  dateRange?: string;
  search?: string;
  level?: string;
  action?: string;
}
