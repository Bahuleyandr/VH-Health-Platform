// src/lib/schemas.ts
import { z } from "zod";
import { PORTAL_ROLE_VALUES } from "./roles";

/* =========================
 * User / Admin Schemas
 * ========================= */

export const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
  phone: z.string(),
  is_active: z.boolean(),
  created_at: z.string(), // ISO date string
  date_of_birth: z.string().optional(),
});

export const AdminRoleEnum = z.enum(PORTAL_ROLE_VALUES);

export const AdminUserSchema = UserSchema.extend({
  username: z.string().optional(),
  uid: z.string(), // UUID primary key for admins
  role: AdminRoleEnum,
  permissions: z.array(z.string()),
  last_login: z.string().optional(), // ISO date string (optional for staff tokens)
  employee_id: z.string().optional(),
  department: z.string().optional(),
  position: z.string().optional(),
});

/**
 * Lenient schema for parsing admin user data from localStorage.
 * Uses .passthrough() so extra fields are preserved, and optional
 * fields won't fail on incomplete cached data.
 *
 * Admin accounts use `uid` (UUID) as their primary key; staff accounts
 * use `id` (integer). Accept both but don't require either — the
 * downstream `role` check is what actually matters for the session.
 */
export const StoredAdminUserSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    uid: z.string().optional(),
    role: AdminRoleEnum,
    permissions: z.array(z.string()).optional().default([]),
    name: z.string().optional(),
    email: z.string().optional(),
    employee_id: z.string().optional(),
    department: z.string().optional(),
    position: z.string().optional(),
    _cachedAt: z.number().finite().positive().optional(),
  })
  .passthrough();

/* =========================
 * Domain Schemas
 * ========================= */

export const DepartmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
  created_at: z.string().optional(),
});

export const DoctorSchema = z.object({
  user_id: z.number(),
  name: z.string(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  department: z.string(),
  specialization: z.string(),
  consultation_fee: z.number(),
  is_available: z.boolean(),
  rating: z.number().optional(),
  experience_years: z.number().optional(),
  bio: z.string().optional().nullable(),
  education: z.string().optional().nullable(),
  qualifications: z.array(z.string()).optional().nullable(),
  available_days: z.array(z.string()).optional().nullable(),
  available_hours: z
    .record(
      z.string(),
      z.object({
        start: z.string(),
        end: z.string(),
      }),
    )
    .optional()
    .nullable(),
});

export const PatientSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
  phone: z.string(),
  date_of_birth: z.string().optional(),
  address: z.string().optional(),
  created_at: z.string(),
});

export const AppointmentStatusEnum = z.enum([
  "SCHEDULED",
  "COMPLETED",
  "CANCELLED",
]);

export const AppointmentSchema = z.object({
  id: z.number(),
  patient_id: z.number(),
  doctor_id: z.number(),
  appointment_date: z.string(), // ISO date string
  appointment_time: z.string(), // e.g., "14:30"
  status: AppointmentStatusEnum,
  notes: z.string().optional(),
  created_at: z.string(),
});

/* =========================
 * Dashboard / Backend Schemas
 * ========================= */

// What the backend returns (example)
export const DashboardDataBackendSchema = z.object({
  totalUsers: z.number(),
  activeUsers: z.number(),
  totalDoctors: z.number(),
  totalAppointments: z.number(),
  recentActivity: z
    .array(
      z.object({
        id: z.number(),
        action: z.string(),
        timestamp: z.string(), // ISO date string
        user: z.string(),
      }),
    )
    .optional(),
});

// What the frontend UI expects
export const DashboardDataSchema = z.object({
  totalPatients: z.number(),
  totalAppointments: z.number(),
  activeDepartments: z.number(),
  totalStaff: z.number(),
});

/* =========================
 * Type Exports (from schemas)
 * ========================= */

export type User = z.infer<typeof UserSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type Department = z.infer<typeof DepartmentSchema>;
export type Doctor = z.infer<typeof DoctorSchema>;
export type Patient = z.infer<typeof PatientSchema>;
export type Appointment = z.infer<typeof AppointmentSchema>;
export type DashboardDataBackend = z.infer<typeof DashboardDataBackendSchema>;
export type DashboardData = z.infer<typeof DashboardDataSchema>;
