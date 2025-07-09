// src/lib/api.ts
import * as Sentry from "@sentry/nextjs";
import {
  DepartmentSchema,
  PatientSchema,
  AppointmentSchema,
  UserSchema,
  DoctorSchema,
  DashboardDataSchema,
  DashboardDataBackendSchema,
  type Department,
  type Patient,
  type Appointment,
  type User,
  type Doctor,
  type DashboardData,
} from './schemas';

// API Configuration with proper URL handling
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://vh-health-backend.onrender.com/api/v1';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || 'vhhealth123';

// Ensure URL is properly formatted
const getApiUrl = (endpoint: string) => {
  // Remove any leading slash from endpoint
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  
  // Ensure base URL doesn't end with a slash
  const cleanBaseUrl = API_BASE_URL.endsWith('/') ? API_BASE_URL.slice(0, -1) : API_BASE_URL;
  
  return `${cleanBaseUrl}${cleanEndpoint}`;
};

// Client-side token management
export const getAuthToken = (): string | null => {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('adminToken');
};

export const setAuthToken = (token: string): void => {
  if (typeof window === 'undefined') return;
  localStorage.setItem('adminToken', token);
};

export const removeAuthToken = (): void => {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('adminToken');
};

// Base fetch function for client-side requests
export const fetchAdminAPI = async (endpoint: string, options: RequestInit = {}) => {
  const authToken = getAuthToken();
  
  if (!authToken && !endpoint.includes('/auth/admin/login')) {
    throw new Error('No authentication token');
  }

  try {
    const url = getApiUrl(endpoint);
    console.log('Fetching from URL:', url); // Debug log
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        ...(authToken && { 'Authorization': `Bearer ${authToken}` }),
        ...options.headers,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        removeAuthToken();
        // Redirect to login page
        if (typeof window !== 'undefined') {
          window.location.href = '/login';
        }
      }
      
      const errorText = await response.text();
      console.error('API Error:', response.status, errorText);
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Fetch error:', error);
    Sentry.captureException(error);
    throw error;
  }
};

// Auth functions
export const login = async (username: string, password: string) => {
  try {
    const response = await fetchAdminAPI('/auth/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    
    if (response.token) {
      setAuthToken(response.token);
    }
    
    return response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const logout = async () => {
  try {
    await fetchAdminAPI('/auth/logout', {
      method: 'POST',
    });
    removeAuthToken();
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Dashboard data - with better error handling
export const getDashboardData = async () => {
  try {
    console.log('Fetching dashboard data...'); // Debug log
    
    // Try the main endpoint
    let response;
    try {
      response = await fetchAdminAPI('/admin/dashboard');
    } catch (err) {
      console.log('Dashboard endpoint failed, trying alternative...');
      // Try without /admin prefix
      try {
        response = await fetchAdminAPI('/dashboard');
      } catch (err2) {
        console.error('Both dashboard endpoints failed');
        throw err; // Throw original error
      }
    }
    
    console.log('Dashboard response:', response); // Debug log
    
    // Handle wrapped response
    if (response.success && response.data) {
      response = response.data;
    }
    
    // Handle different response formats
    if (response.stats) {
      // If stats are nested
      return {
        stats: {
          totalUsers: response.stats.totalUsers || 0,
          totalDoctors: response.stats.totalDoctors || 0,
          totalAppointments: response.stats.totalAppointments || 0,
          revenue: response.stats.revenue || 0,
        },
        recentActivity: response.recentActivity || []
      };
    }
    
    // Direct response format - transform to match UI expectations
    return {
      stats: {
        totalUsers: response.totalUsers || 0,
        totalDoctors: response.totalDoctors || 0,
        totalAppointments: response.totalAppointments || 0,
        revenue: response.revenue || 0,
      },
      recentActivity: response.recentActivity || []
    };
  } catch (error) {
    console.error('Dashboard data fetch error:', error);
    Sentry.captureException(error);
    
    // Return default data on error
    return {
      stats: {
        totalUsers: 0,
        totalDoctors: 0,
        totalAppointments: 0,
        revenue: 0,
      },
      recentActivity: []
    };
  }
};

// Departments
export async function getDepartments() {
  const response = await fetchAdminAPI('/departments');
  // Handle wrapped response
  if (response.success && response.data) {
    return response.data;
  }
  return response;
}

export async function createDepartment(data: { name: string; description?: string }) {
  return fetchAdminAPI('/departments', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateDepartment(id: string, data: { name: string; description?: string }) {
  return fetchAdminAPI(`/departments/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteDepartment(id: string) {
  return fetchAdminAPI(`/departments/${id}`, {
    method: 'DELETE',
  });
}

// Doctor functions
export const getDoctors = async (): Promise<Doctor[]> => {
  try {
    const response = await fetchAdminAPI('/doctors');
    // Handle wrapped response
    if (response.success && response.data) {
      const doctors = response.data.doctors || response.data;
      return doctors.map((doc: unknown) => DoctorSchema.parse(doc));
    }
    const doctors = response.doctors || response;
    return doctors.map((doc: unknown) => DoctorSchema.parse(doc));
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const deleteDoctor = async (id: number) => {
  try {
    await fetchAdminAPI(`/doctors/${id}`, {
      method: 'DELETE',
    });
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Patient functions
export const getPatients = async (): Promise<Patient[]> => {
  try {
    const response = await fetchAdminAPI('/patients/manage');
    const patients = response.patients || response;
    return patients.map((patient: unknown) => PatientSchema.parse(patient));
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const getPatient = async (id: string): Promise<Patient> => {
  try {
    const response = await fetchAdminAPI(`/patients/manage/${id}`);
    return PatientSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const createPatient = async (data: unknown) => {
  try {
    const response = await fetchAdminAPI('/patients/manage', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return PatientSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const updatePatient = async (id: string, data: unknown) => {
  try {
    const response = await fetchAdminAPI(`/patients/manage/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return PatientSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const deletePatient = async (id: string) => {
  try {
    await fetchAdminAPI(`/patients/manage/${id}`, {
      method: 'DELETE',
    });
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Appointment functions
export const getAppointments = async (): Promise<Appointment[]> => {
  try {
    const response = await fetchAdminAPI('/appointments/manage');
    const appointments = response.appointments || response;
    return appointments.map((apt: unknown) => AppointmentSchema.parse(apt));
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const getAppointment = async (id: string): Promise<Appointment> => {
  try {
    const response = await fetchAdminAPI(`/appointments/manage/${id}`);
    return AppointmentSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const createAppointment = async (data: unknown) => {
  try {
    const response = await fetchAdminAPI('/appointments/manage', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return AppointmentSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const updateAppointment = async (id: string, data: unknown) => {
  try {
    const response = await fetchAdminAPI(`/appointments/manage/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return AppointmentSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const deleteAppointment = async (id: string) => {
  try {
    await fetchAdminAPI(`/appointments/manage/${id}`, {
      method: 'DELETE',
    });
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// User functions
export const getUsers = async (): Promise<User[]> => {
  try {
    const response = await fetchAdminAPI('/admin/users');
    // Handle wrapped response
    if (response.success && response.data) {
      const users = response.data.users || response.data;
      return users.map((user: unknown) => UserSchema.parse(user));
    }
    const users = response.users || response;
    return users.map((user: unknown) => UserSchema.parse(user));
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const getUser = async (id: string): Promise<User> => {
  try {
    const response = await fetchAdminAPI(`/admin/users/${id}`);
    return UserSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const createUser = async (data: unknown) => {
  try {
    const response = await fetchAdminAPI('/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return UserSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const updateUser = async (id: string, data: unknown) => {
  try {
    const response = await fetchAdminAPI(`/admin/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return UserSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const deleteUser = async (id: string) => {
  try {
    await fetchAdminAPI(`/admin/users/${id}`, {
      method: 'DELETE',
    });
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Admin Management functions
export const listAdmins = async () => {
  try {
    const response = await fetchAdminAPI('/admin/list');
    return response.admins || response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const createAdminUser = async (data: {
  username: string;
  email: string;
  password: string;
  role: string;
  permissions?: string[];
}) => {
  try {
    const response = await fetchAdminAPI('/admin/create', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const deactivateAdmin = async (adminId: string) => {
  try {
    const response = await fetchAdminAPI(`/admin/${adminId}/deactivate`, {
      method: 'PUT',
    });
    return response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const reactivateAdmin = async (adminId: string) => {
  try {
    const response = await fetchAdminAPI(`/admin/${adminId}/reactivate`, {
      method: 'PUT',
    });
    return response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const updateAdminPermissions = async (adminId: string, permissions: string[]) => {
  try {
    const response = await fetchAdminAPI(`/admin/${adminId}/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions }),
    });
    return response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Notification functions
export const getNotifications = async () => {
  try {
    const response = await fetchAdminAPI('/notifications');
    return response.notifications || response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const sendAnnouncement = async (data: {
  title: string;
  message: string;
  recipients: string[];
  priority?: string;
}) => {
  try {
    const response = await fetchAdminAPI('/notifications/announce', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Pharmacy functions
export const getPharmacyAnalytics = async () => {
  try {
    const response = await fetchAdminAPI('/pharmacy/analytics');
    return response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const getPharmacyOrders = async () => {
  try {
    const response = await fetchAdminAPI('/pharmacy/orders');
    return response.orders || response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// System Settings functions
export const getSystemSettings = async () => {
  try {
    const response = await fetchAdminAPI('/system/settings');
    return response.settings || response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const updateSystemSetting = async (key: string, value: unknown) => {
  try {
    const response = await fetchAdminAPI('/system/settings', {
      method: 'PUT',
      body: JSON.stringify({ key, value }),
    });
    return response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// System Logs functions
export const getSystemLogs = async (params?: {
  startDate?: string;
  endDate?: string;
  level?: string;
}) => {
  try {
    const queryString = params ? new URLSearchParams(params).toString() : '';
    const response = await fetchAdminAPI(`/system/logs${queryString ? `?${queryString}` : ''}`);
    return response.logs || response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const getAuditLogs = async (params?: {
  startDate?: string;
  endDate?: string;
  userId?: string;
  action?: string;
}) => {
  try {
    const queryString = params ? new URLSearchParams(params).toString() : '';
    const response = await fetchAdminAPI(`/system/audit-logs${queryString ? `?${queryString}` : ''}`);
    return response.logs || response;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Doctor functions (additional)
export const createDoctor = async (data: {
  name: string;
  email: string;
  password: string;
  phone: string;
  department: string;
  specialization: string;
  consultation_fee: number;
}) => {
  try {
    const response = await fetchAdminAPI('/doctors', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return DoctorSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const updateDoctorProfile = async (doctorId: number, data: Partial<{
  name: string;
  email: string;
  phone: string;
  department: string;
  specialization: string;
  consultation_fee: number;
  is_available: boolean;
}>) => {
  try {
    const response = await fetchAdminAPI(`/doctors/${doctorId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return DoctorSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Generic API helper functions (for departments/actions.ts)
export const postAdminAPI = async (endpoint: string, data: unknown) => {
  return fetchAdminAPI(endpoint, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

export const putAdminAPI = async (endpoint: string, data: unknown) => {
  return fetchAdminAPI(endpoint, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
};

export const deleteAdminAPI = async (endpoint: string) => {
  return fetchAdminAPI(endpoint, {
    method: 'DELETE',
  });
};