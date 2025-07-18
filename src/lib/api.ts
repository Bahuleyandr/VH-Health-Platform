// src/lib/api.ts
// Updated API functions using the correct endpoints from your backend

import { toast } from 'react-hot-toast';
import { API_BASE_URL, API_ENDPOINTS, ENDPOINT_MAPPING } from './api-config';

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

// Enhanced fetch wrapper
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
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.append('page', params.page.toString());
  if (params?.limit) queryParams.append('limit', params.limit.toString());
  if (params?.search) queryParams.append('search', params.search);
  if (params?.role) queryParams.append('role', params.role);
  
  const query = queryParams.toString() ? `?${queryParams.toString()}` : '';
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
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.append('page', params.page.toString());
  if (params?.limit) queryParams.append('limit', params.limit.toString());
  if (params?.search) queryParams.append('search', params.search);
  if (params?.department) queryParams.append('department', params.department);
  if (params?.status) queryParams.append('status', params.status);
  
  const query = queryParams.toString() ? `?${queryParams.toString()}` : '';
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

export async function getDepartmentAnalytics(departmentId: string) {
  return fetchAdminAPI(API_ENDPOINTS.departments.analytics.replace(':id', departmentId));
}

export async function getDepartmentsOverview() {
  return fetchAdminAPI(API_ENDPOINTS.departments.overview);
}

// ===== PHARMACY =====

export async function getPharmacyCategories() {
  return fetchAdminAPI(API_ENDPOINTS.pharmacy.categories);
}

// Note: These pharmacy endpoints are protected and might need special handling
export async function getPharmacyAdminData() {
  return fetchAdminAPI(API_ENDPOINTS.pharmacy.adminRoutes);
}

export async function getPharmacyOrders() {
  return fetchAdminAPI(API_ENDPOINTS.pharmacy.orderRoutes);
}

export async function createPharmacyOrder(orderData: any) {
  return fetchAdminAPI(API_ENDPOINTS.pharmacy.orderRoutes, {
    method: 'POST',
    body: JSON.stringify(orderData),
  });
}

export async function getPharmacyInventory() {
  return fetchAdminAPI(API_ENDPOINTS.pharmacy.inventoryRoutes);
}

export async function getPharmacyMedications() {
  return fetchAdminAPI(API_ENDPOINTS.pharmacy.medicationRoutes.staff);
}

// ===== APPOINTMENTS =====

export async function getAppointments() {
  return fetchAdminAPI(API_ENDPOINTS.appointments.list);
}

export async function getTodaysAppointments() {
  return fetchAdminAPI(API_ENDPOINTS.appointments.todayList);
}

export async function bookAppointment(appointmentData: any) {
  return fetchAdminAPI(API_ENDPOINTS.appointments.book, {
    method: 'POST',
    body: JSON.stringify(appointmentData),
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