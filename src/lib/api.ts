// src/lib/api.ts

import { toast } from 'react-hot-toast';
import { authenticatedFetch } from './api-client';
import { API_BASE_URL, API_ENDPOINTS, ENDPOINT_MAPPING } from './api-config';

// Helper function to build query strings without URLSearchParams
function buildQueryString(params: Record<string, any>): string {
  const parts: string[] = [];
  
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

// Enhanced error handling
class APIError extends Error {
  status: number;
  data?: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.data = data;
  }
}

export async function fetchAdminAPI<T = any>(
  endpoint: string, 
  options: RequestInit = {}
): Promise<T> {
  // Check if we need to map the endpoint
  const mappedEndpoint = ENDPOINT_MAPPING[endpoint] || endpoint;
  const url = `${API_BASE_URL}${mappedEndpoint}`;
  
  console.log('Fetching from URL:', url);
  if (endpoint !== mappedEndpoint) {
    console.log('Endpoint mapped from', endpoint, 'to', mappedEndpoint);
  }

  const defaultOptions: RequestInit = {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    },
    ...options,
  };

  try {
    const response = await fetch(url, defaultOptions);
    
    const contentType = response.headers.get('content-type');
    const isJson = contentType && contentType.includes('application/json');
    
    let data;
    if (isJson) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      console.error('API Error:', response.status, data);
      
      if (response.status === 401) {
        // For OTP-based auth, redirect to login
        toast.error('Session expired. Please login again.');
        window.location.href = '/login';
        throw new APIError('Unauthorized', response.status, data);
      } else if (response.status === 403) {
        toast.error('You do not have permission to perform this action');
        throw new APIError('Forbidden', response.status, data);
      }
      
      throw new APIError(
        data?.message || `API Error: ${response.status}`,
        response.status,
        data
      );
    }

    return data;
  } catch (error) {
    console.error('Fetch error:', error);
    
    if (error instanceof APIError) {
      throw error;
    }
    
    toast.error('Network error. Please check your connection.');
    throw new APIError('Network error', 0, error);
  }
}

// ===== AUTHENTICATION FUNCTIONS =====
// Note: Your backend seems to use OTP-based authentication

export async function generateOTP(phoneNumber: string) {
  return fetchAdminAPI(API_ENDPOINTS.auth.generateOtp, {
    method: 'POST',
    body: JSON.stringify({ phone: phoneNumber }),
  });
}

export async function verifyOTP(phoneNumber: string, otp: string) {
  return fetchAdminAPI(API_ENDPOINTS.auth.verifyOtp, {
    method: 'POST',
    body: JSON.stringify({ phone: phoneNumber, otp }),
  });
}

// For traditional login (if your backend supports it)
export async function loginAdmin(username: string, password: string) {
  // Your backend might use phone/OTP instead
  // Adjust based on your actual auth flow
  try {
    const response = await generateOTP(username); // username might be phone number
    return response;
  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
}

export async function getAuthStats() {
  return fetchAdminAPI(API_ENDPOINTS.auth.stats);
}

// ===== DASHBOARD & ANALYTICS =====

export async function getDashboardData() {
  // Use the correct endpoint: /api/v1/users/dashboard
  return fetchAdminAPI(API_ENDPOINTS.users.dashboard);
}

export async function getUserAnalytics() {
  return fetchAdminAPI(API_ENDPOINTS.users.analytics);
}

export async function getSystemInfo() {
  return fetchAdminAPI(API_ENDPOINTS.users.systemInfo);
}

export async function getActivityAudit() {
  return fetchAdminAPI(API_ENDPOINTS.users.activityAudit);
}

// ===== USER MANAGEMENT =====

export async function getUsers(params?: {
  page?: number;
  limit?: number;
  search?: string;
  role?: string;
}) {
  const query = buildQueryString({
    page: params?.page,
    limit: params?.limit,
    search: params?.search,
    role: params?.role
  });
  
  return fetchAdminAPI(`${API_ENDPOINTS.users.list}${query}`);
}

export async function getUsersByRole(role: string) {
  return fetchAdminAPI(API_ENDPOINTS.users.byRole.replace(':role', role));
}

export async function updateUserStatus(userId: string, status: string) {
  return fetchAdminAPI(API_ENDPOINTS.users.status.replace(':identifier', userId), {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

export async function getInactiveUsers() {
  return fetchAdminAPI(API_ENDPOINTS.users.inactiveUsers);
}

export async function reactivateUser(userId: string) {
  return fetchAdminAPI(API_ENDPOINTS.users.reactivate.replace(':userId', userId), {
    method: 'POST',
  });
}

export async function bulkImportUsers(data: any[]) {
  return fetchAdminAPI(API_ENDPOINTS.users.bulkImport, {
    method: 'POST',
    body: JSON.stringify({ users: data }),
  });
}

export async function searchUsers(query: string) {
  return fetchAdminAPI(`${API_ENDPOINTS.users.search}?q=${encodeURIComponent(query)}`);
}

// ===== DOCTORS =====

export async function getDoctors(params?: {
  page?: number;
  limit?: number;
  search?: string;
  department?: string;
  status?: string;
}) {
  const query = buildQueryString({
    page: params?.page,
    limit: params?.limit,
    search: params?.search,
    department: params?.department,
    status: params?.status
  });
  
  return fetchAdminAPI(`${API_ENDPOINTS.doctors.list}${query}`);
}

export async function getDoctorById(doctorId: string) {
  return fetchAdminAPI(API_ENDPOINTS.doctors.byId.replace(':doctorId', doctorId));
}

export async function getDoctorsByDepartment(department: string) {
  return fetchAdminAPI(API_ENDPOINTS.doctors.byDepartment.replace(':department', department));
}

export async function updateDoctorProfile(doctorId: string, data: any) {
  return fetchAdminAPI(API_ENDPOINTS.doctors.updateProfile.replace(':id', doctorId), {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function updateDoctorAvailability(doctorId: string, availability: any) {
  return fetchAdminAPI(API_ENDPOINTS.doctors.availability.replace(':id', doctorId), {
    method: 'PUT',
    body: JSON.stringify(availability),
  });
}

export async function getDoctorWorkloadAnalysis() {
  return fetchAdminAPI(API_ENDPOINTS.doctors.workloadAnalysis);
}

// ===== DEPARTMENTS =====

export async function getDepartments() {
  return fetchAdminAPI(API_ENDPOINTS.departments.list);
}

export async function getDepartmentById(departmentId: string) {
  return fetchAdminAPI(API_ENDPOINTS.departments.byId.replace(':identifier', departmentId));
}

export async function createDepartment(data: any) {
  return fetchAdminAPI(API_ENDPOINTS.departments.create, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getDepartmentsWithDoctors() {
  return fetchAdminAPI(API_ENDPOINTS.departments.withDoctors);
}

export async function getDepartmentStats(departmentId: string) {
  return fetchAdminAPI(API_ENDPOINTS.departments.stats.replace(':id', departmentId));
}

// ===== APPOINTMENTS =====

export async function getAppointmentList(params?: {
  page?: number;
  limit?: number;
  status?: string;
  date?: string;
}) {
  const query = buildQueryString({
    page: params?.page,
    limit: params?.limit,
    status: params?.status,
    date: params?.date
  });
  
  return fetchAdminAPI(`${API_ENDPOINTS.appointments.list}${query}`);
}

export async function getTodaysAppointments() {
  return fetchAdminAPI(API_ENDPOINTS.appointments.today);
}

export async function getAppointmentAnalytics() {
  return fetchAdminAPI(API_ENDPOINTS.appointments.analytics);
}

export async function updateDoctorSchedule(doctorId: string, scheduleData: any) {
  return fetchAdminAPI(API_ENDPOINTS.appointments.schedule.replace(':doctorId', doctorId), {
    method: 'PUT',
    body: JSON.stringify(scheduleData),
  });
}

export async function getAppointmentsByDoctor(doctorId: string) {
  return fetchAdminAPI(API_ENDPOINTS.appointments.byDoctor.replace(':doctor_id', doctorId));
}

export async function updateAppointmentStatus(appointmentId: string, status: string) {
  return fetchAdminAPI(API_ENDPOINTS.appointments.updateStatus.replace(':id', appointmentId), {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

// ===== NOTIFICATIONS =====

export async function getNotificationsByPhone(phone: string) {
  return fetchAdminAPI(API_ENDPOINTS.notifications.list.replace(':phone', phone));
}

export async function getNotificationTemplates() {
  return fetchAdminAPI(API_ENDPOINTS.notifications.templates);
}

export async function createNotificationTemplate(template: any) {
  return fetchAdminAPI(API_ENDPOINTS.notifications.templates, {
    method: 'POST',
    body: JSON.stringify(template),
  });
}

export async function sendBulkNotification(data: any) {
  return fetchAdminAPI(API_ENDPOINTS.notifications.bulk, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getNotificationStats() {
  return fetchAdminAPI(API_ENDPOINTS.notifications.statsSummary);
}

// ===== HEALTH & SYSTEM =====

export async function getHealthCheck() {
  return fetchAdminAPI(API_ENDPOINTS.health.check);
}

export async function getSystemStatus() {
  return fetchAdminAPI(API_ENDPOINTS.health.system);
}

export async function getAppVersion() {
  return fetchAdminAPI(API_ENDPOINTS.health.appVersion);
}

// Export types and constants
export type { APIError };
export { API_ENDPOINTS, ENDPOINT_MAPPING };
// Helper function to get auth token
export function getAuthToken(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('adminToken');
  }
  return null;
}

// Delete doctor function
export async function deleteDoctor(doctorId: string) {
  return fetchAdminAPI(API_ENDPOINTS.doctors.delete?.replace(':id', doctorId) || /doctors/, {
    method: 'DELETE',
  });
}
