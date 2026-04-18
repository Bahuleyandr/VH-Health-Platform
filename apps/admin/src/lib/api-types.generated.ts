/**
 * AUTO-GENERATED from live PostgreSQL schema — vh-health-backend
 * Last regenerated: 2026-04-04
 *
 * These interfaces mirror the backend's database models.
 * Do NOT edit manually — re-generate from the Prisma schema when models change.
 *
 * Source of truth: live DB columns + backend prisma/schema.prisma
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
  // Extended columns (added by migrations)
  pan_number: string | null;
  abha_number: string | null;
  abha_address: string | null;
  status: string | null;
  device_token: string | null;
  created_by: string | null;
  updated_by: string | null;
}

// ===================================================================
// AUTHENTICATION & ADMIN
// ===================================================================

export interface Admin {
  // PK is uid (UUID), NOT a numeric id
  uid: string;
  username: string;
  email: string | null;
  name: string | null;
  role: string | null;
  permissions: string[];
  is_active: boolean;
  status: string;           // 'active' | 'inactive' — mirrors is_active as string
  failed_login_attempts: number;
  last_failed_login: string | null;
  totp_enabled: boolean;
  password_changed_at: string | null;
  last_login: string | null;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  deactivated_by: string | null;
  deactivated_at: string | null;
  deactivation_reason: string | null;
  reactivated_by: string | null;
  reactivated_at: string | null;
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
  user_id: string | null;        // UUID — references users.uid
  employee_id: string | null;
  name: string | null;           // Denormalized from users.name
  designation: string | null;
  position: string | null;
  department: string | null;
  shift: string | null;
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
  performance_rating: number | null;
  last_review_date: string | null;
  updated_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * StaffWithUser — shape returned by payroll and HR endpoints that JOIN users.
 * Backend queries return users.uid as 'uid', users.name, users.phone, users.role.
 * Use this type for payroll/HR list responses, NOT the raw staff table shape.
 */
export interface StaffWithUser extends Staff {
  uid: string;                   // users.uid (from JOIN to users table)
  phone: string | null;          // users.phone
  role: string | null;           // users.role
}

// ===================================================================
// APPOINTMENTS & SCHEDULING
// ===================================================================

export interface Appointment {
  id: number;
  uid: string | null;
  phone: string;
  patient_id: number | null;  // FK to users.id
  doctor_id: number | null;
  doctor_name: string;
  patient_name: string | null;
  appointment_date: string;
  appointment_time: string;
  status: string;
  reason: string | null;
  notes: string | null;
  department: string | null;
  token_number: number | null;
  confirmed_by: number | null;
  confirmed_at: string | null;
  confirmation_notes: string | null;
  no_show_at: string | null;
  cancellation_reason: string | null;
  reschedule_count: number | null;
  sla_target_at: string | null;
  first_contact_at: string | null;
  completed_at: string | null;
  reminder_24h_sent: boolean | null;
  reminder_1h_sent: boolean | null;
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
  patient_id: number | null;  // FK to users.id
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
  notified: boolean | null;
  notified_at: string | null;
  turnaround_target_hours: number | null;
  result_uploaded_at: string | null;
  urgent_alert_sent: boolean | null;
  patient_notified_at: string | null;
}

// ===================================================================
// PHARMACY MANAGEMENT
// ===================================================================

export interface PharmacyOrder {
  id: number;
  uid: string | null;
  phone: string;
  patient_id: number | null;  // FK to users.id
  patient_name: string | null;
  order_note: string;
  medication: string | null;
  status: string;
  priority: string | null;
  file_key: string | null;
  prescription_url: string | null;
  prescription_photo_url: string | null;
  order_number: string | null;
  total_amount: number | null;
  payment_status: string | null;
  assigned_pharmacist: string | null;
  token_number: string | null;
  delivery_type: string | null;
  delivery_address: string | null;
  delivery_landmark: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  delivery_phone: string | null;
  delivery_person: string | null;
  delivery_person_phone: string | null;
  estimated_delivery_mins: number | null;
  delivery_tracking_active: boolean | null;
  delivery_distance_km: number | null;
  prescribed_by: string | null;
  dispensed_by: string | null;
  confirmed_by: number | null;
  confirmed_at: string | null;
  preparing_at: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  ordered_at: string;
  dispensed_at: string | null;
  created_at: string | null;
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
  responded_at: string | null;
  response_status: string | null;
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

export type AdminRole = "ADMIN" | "SUPER_ADMIN" | "MANAGER";
