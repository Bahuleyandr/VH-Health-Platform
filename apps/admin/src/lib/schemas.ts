// src/lib/schemas.ts
import { z } from "zod";

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

export const AdminRoleEnum = z.enum([
  "SUPER_ADMIN",
  "ADMIN",
  "HR",
  "STAFF",
  "DOCTOR",
  "IT",
  "IT_ADMIN",
  "IT_STAFF",
  "SYSTEM_ADMIN",
]);

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
 */
export const StoredAdminUserSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    role: z.enum([
      "SUPER_ADMIN",
      "ADMIN",
      "HR",
      "STAFF",
      "DOCTOR",
      "IT",
      "IT_ADMIN",
      "IT_STAFF",
      "SYSTEM_ADMIN",
      "NURSE",
      "PHARMACIST",
      "TECHNICIAN",
      "LAB_TECHNICIAN",
      "RECEPTIONIST",
      "PATIENT",
    ]),
    permissions: z.array(z.string()).optional().default([]),
    name: z.string().optional(),
    email: z.string().optional(),
    employee_id: z.string().optional(),
    department: z.string().optional(),
    position: z.string().optional(),
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
  available_hours: z.record(z.string(), z.object({
    start: z.string(),
    end: z.string(),
  })).optional().nullable(),
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
 * Form Schemas
 * ========================= */

export const LoginFormSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number")
    .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),
});

export const CreateDoctorFormSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().regex(/^[0-9]{10}$/, "Phone must be 10 digits"),
  department: z.string().min(1, "Department is required"),
  specialization: z.string().min(1, "Specialization is required"),
  consultation_fee: z.number().min(0, "Fee must be positive"),
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
export type LoginForm = z.infer<typeof LoginFormSchema>;
export type CreateDoctorForm = z.infer<typeof CreateDoctorFormSchema>;
