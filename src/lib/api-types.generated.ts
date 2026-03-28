/**
 * AUTO-GENERATED from Prisma schema: vh-health-backend/prisma/schema.prisma
 * Generated on: 2026-03-28
 *
 * These interfaces mirror the backend's database models.
 * Do NOT edit manually — re-generate from the Prisma schema when models change.
 */

// ===================================================================
// USER MANAGEMENT
// ===================================================================

export interface User {
  id: number;
  uid: string;
  phone: string;
  name: string | null;
  gender: string | null;
  address: string | null;
  email: string | null;
  birthday: string | null;
  anniversary: string | null;
  profile_picture: string | null;
  role: string | null;
  is_active: boolean;
  registered_at: string;
  updated_at: string;
}

// ===================================================================
// AUTHENTICATION & ADMIN
// ===================================================================

export interface Admin {
  id: number;
  username: string;
  email: string | null;
  name: string | null;
  role: string | null;
  status: string;
  permissions: string[];
  failed_login_attempts: number;
  last_failed_login: string | null;
  last_login: string | null;
  password_changed_at: string | null;
  created_at: string;
  created_by: string | null;
  deactivated_at: string | null;
  deactivated_by: string | null;
  deactivation_reason: string | null;
  updated_at: string | null;
}

export interface OtpSession {
  id: number;
  phone: string;
  otp: string;
  purpose: string;
  user_id: number | null;
  expires_at: string;
  attempts: number;
  verified: boolean;
  created_at: string;
}

export interface AuthLog {
  id: number;
  phone: string | null;
  user_id: string | null;
  action: string;
  success: boolean;
  failure_reason: string | null;
  auth_method: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

// ===================================================================
// HOSPITAL STRUCTURE
// ===================================================================

export interface Department {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Doctor {
  id: number;
  user_id: number | null;
  name: string;
  department_id: number | null;
  department: string;
  specialty: string | null;
  intro: string | null;
  image_url: string | null;
  is_available: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ===================================================================
// STAFF MANAGEMENT
// ===================================================================

export interface Staff {
  id: number;
  uid: string;
  user_id: number | null;
  employee_id: string | null;
  name: string | null;
  phone: string | null;
  role: string | null;
  position: string | null;
  department: string | null;
  shift: string | null;
  shift_type: string | null;
  salary: number | null;
  hire_date: string | null;
  join_date: string | null;
  supervisor_id: number | null;
  emergency_contact: Record<string, unknown> | null;
  skills: string[];
  certifications: string[];
  notes: string | null;
  is_active: boolean;
  on_leave: boolean;
  archived: boolean;
  last_login: string | null;
  pin_changed_at: string | null;
  pin_reset_by: string | null;
  updated_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ===================================================================
// APPOINTMENTS & SCHEDULING
// ===================================================================

export interface Appointment {
  id: number;
  uid: string | null;
  phone: string;
  doctor_id: number | null;
  doctor_name: string;
  patient_name: string | null;
  appointment_date: string;
  appointment_time: string;
  status: string;
  reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ===================================================================
// MEDICAL RECORDS
// ===================================================================

export interface HealthRecord {
  id: number;
  uid: string | null;
  phone: string;
  record_type: string | null;
  file_name: string;
  file_type: string;
  file_key: string | null;
  file_size: number | null;
  privacy_level: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface Investigation {
  id: number;
  uid: string | null;
  phone: string;
  test_name: string;
  test_type: string | null;
  status: string;
  result_file: string | null;
  file_key: string | null;
  priority: string | null;
  requested_by: string | null;
  requested_at: string;
  completed_at: string | null;
  updated_at: string;
}

// ===================================================================
// PHARMACY MANAGEMENT
// ===================================================================

export interface PharmacyOrder {
  id: number;
  uid: string | null;
  phone: string;
  order_note: string;
  medication: string | null;
  status: string;
  priority: string | null;
  file_key: string | null;
  prescribed_by: string | null;
  dispensed_by: string | null;
  ordered_at: string;
  dispensed_at: string | null;
  updated_at: string;
}

export interface Medication {
  id: number;
  name: string;
  generic_name: string | null;
  brand: string | null;
  category: string | null;
  dosage: string | null;
  form: string | null;
  price: number | null;
  stock_quantity: number | null;
  expiry_date: string | null;
  manufacturer: string | null;
  prescription_required: boolean;
  description: string | null;
  is_active: boolean;
  created_at: string;
  created_by: string | null;
}

// ===================================================================
// NOTIFICATIONS
// ===================================================================

export interface Notification {
  id: number;
  uid: string | null;
  phone: string;
  title: string;
  body: string;
  type: string;
  priority: string;
  data: Record<string, unknown> | null;
  is_read: boolean;
  scheduled_for: string | null;
  sent_at: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

// ===================================================================
// FEEDBACK
// ===================================================================

export interface Feedback {
  id: number;
  uid: string | null;
  phone: string;
  rating: number;
  comment: string | null;
  category: string | null;
  department_id: number | null;
  doctor_id: number | null;
  appointment_id: number | null;
  is_anonymous: boolean;
  status: string;
  created_at: string;
  updated_at: string;
}

// ===================================================================
// ENUMS (common status values from schema defaults)
// ===================================================================

export type AppointmentStatus =
  | "SCHEDULED"
  | "CONFIRMED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";

export type PharmacyOrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PREPARING"
  | "DISPATCHED"
  | "DELIVERED"
  | "CANCELLED"
  | "COMPLETED"
  | "PLACED";

export type InvestigationStatus =
  | "REQUESTED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

export type InvestigationPriority = "NORMAL" | "URGENT" | "CRITICAL";

export type UserRole =
  | "PATIENT"
  | "DOCTOR"
  | "ADMIN"
  | "HR"
  | "STAFF"
  | "NURSE"
  | "PHARMACIST"
  | "TECHNICIAN"
  | "RECEPTIONIST";

export type NotificationType =
  | "GENERAL"
  | "APPOINTMENT"
  | "PHARMACY"
  | "INVESTIGATION"
  | "SOS"
  | "SYSTEM";

export type NotificationPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

export type FeedbackCategory = "GENERAL" | "DOCTOR" | "DEPARTMENT" | "SERVICE";

export type FeedbackStatus = "PENDING" | "REVIEWED" | "RESOLVED" | "DISMISSED";

export type PrivacyLevel = "PUBLIC" | "RESTRICTED" | "CONFIDENTIAL";
