import { z } from 'zod';

// User Schemas
export const UserSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
  phone: z.string(),
  is_active: z.boolean(),
  created_at: z.string(),
  date_of_birth: z.string().optional(),
});

export const AdminUserSchema = UserSchema.extend({
  role: z.enum(['ADMIN', 'SUPER_ADMIN']),
  permissions: z.array(z.string()),
  last_login: z.string(),
});

// Department Schema
export const DepartmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
  created_at: z.string().optional(),
});

// Doctor Schema
export const DoctorSchema = z.object({
  user_id: z.number(),
  name: z.string(),
  email: z.string().email(),
  phone: z.string(),
  department: z.string(),
  specialization: z.string(),
  consultation_fee: z.number(),
  is_available: z.boolean(),
  rating: z.number().optional(),
});

// Patient Schema
export const PatientSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
  phone: z.string(),
  date_of_birth: z.string().optional(),
  address: z.string().optional(),
  created_at: z.string(),
});

// Appointment Schema
export const AppointmentSchema = z.object({
  id: z.number(),
  patient_id: z.number(),
  doctor_id: z.number(),
  appointment_date: z.string(),
  appointment_time: z.string(),
  status: z.enum(['SCHEDULED', 'COMPLETED', 'CANCELLED']),
  notes: z.string().optional(),
  created_at: z.string(),
});

// Backend API Response Schema
export const DashboardDataBackendSchema = z.object({
  totalUsers: z.number(),
  activeUsers: z.number(),
  totalDoctors: z.number(),
  totalAppointments: z.number(),
  recentActivity: z.array(z.object({
    id: z.number(),
    action: z.string(),
    timestamp: z.string(),
    user: z.string(),
  })).optional(),
});

// Frontend Dashboard Schema (what the UI expects)
export const DashboardDataSchema = z.object({
  totalPatients: z.number(),
  totalAppointments: z.number(),
  activeDepartments: z.number(),
  totalStaff: z.number(),
});

// Form Schemas
export const LoginFormSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const CreateDoctorFormSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().regex(/^[0-9]{10}$/, 'Phone must be 10 digits'),
  department: z.string().min(1, 'Department is required'),
  specialization: z.string().min(1, 'Specialization is required'),
  consultation_fee: z.number().min(0, 'Fee must be positive'),
});

// Type exports
export type Department = z.infer<typeof DepartmentSchema>;
export type Patient = z.infer<typeof PatientSchema>;
export type Appointment = z.infer<typeof AppointmentSchema>;
export type User = z.infer<typeof UserSchema>;
export type Doctor = z.infer<typeof DoctorSchema>;
export type DashboardData = z.infer<typeof DashboardDataSchema>;