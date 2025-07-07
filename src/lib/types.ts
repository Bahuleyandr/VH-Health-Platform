// src/lib/types.ts

export interface User {
  id: number;
  uid: string;
  name: string;
  email: string;
  phone: string;
  role: 'PATIENT' | 'DOCTOR' | 'ADMIN' | 'NURSE' | 'PHARMACIST' | 'TECHNICIAN' | 'RECEPTIONIST';
  is_active: boolean;
  registered_at: string; // ISO date string
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface UsersAPIResponse {
  message: string;
  users: User[];
  pagination: Pagination;
}

// Add this interface to src/lib/types.ts

export interface Department {
  id: number;
  name: string;
  description?: string;
  is_active?: boolean;
  // Add other fields as you see fit from your DB schema
  head_of_department_id?: number;
  staff_count?: number;
}

export interface Appointment {
  id: number;
  appointment_date: string; // ISO date string
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'PENDING';
  patient_name: string; // Assuming the API will provide joined data
  doctor_name: string;  // Assuming the API will provide joined data
  department: string;
  consultation_fee?: number;
}

export interface AppointmentsAPIResponse {
  message: string;
  appointments: Appointment[];
  pagination: Pagination; // Re-using the pagination type
}

export interface Notification {
  id: number;
  title: string;
  body: string;
  type: 'general' | 'announcement' | 'targeted';
  created_at: string; // ISO date string
  read: boolean;
}

export interface SystemSetting {
  setting_key: string;
  setting_value: string;
  description: string;
  updated_at: string;
}

export interface Doctor {
  user_id: number;
  name: string;
  email: string;
  phone: string;
  specialization: string;
  department: string;
  is_available: boolean;
  consultation_fee: number;
}

export interface PharmacyOrder {
  id: number;
  patient_name: string;
  doctor_name: string;
  order_date: string; // ISO date string
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED';
  total_amount: number;
  items: Array<{ name: string; quantity: number }>;
}

export interface PharmacyAnalytics {
  total_revenue: number;
  total_orders: number;
  pending_orders: number;
  top_selling_medicines: Array<{ name: string; total_quantity: number }>;
}

export interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: string; // e.g., 'SUPER_ADMIN', 'ADMIN'
  permissions: string[];
  last_login: string; // ISO date string
  is_active: boolean;
}

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
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  message: string;
  timestamp: string; // ISO date string
  user_id?: number;
  action?: string;
}