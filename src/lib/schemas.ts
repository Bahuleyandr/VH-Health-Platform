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

// API Response Schemas
export const DashboardDataSchema = z.object({
  totalUsers: z.number(),
  activeUsers: z.number(),
  totalDoctors: z.number(),
  totalAppointments: z.number(),
  recentActivity: z.array(z.object({
    id: z.number(),
    action: z.string(),
    timestamp: z.string(),
    user: z.string(),
  })),
});

// Form Schemas
export const LoginFormSchema = z.object({
  email: z.string().email('Invalid email address'),
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