// src/lib/api.ts
import * as Sentry from "@sentry/nextjs";
import {
  DepartmentSchema,
  PatientSchema,
  AppointmentSchema,
  UserSchema,
  DashboardDataSchema,
  type Department,
  type Patient,
  type Appointment,
  type User,
  type DashboardData,
} from './schemas';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://vh-health-backend.onrender.com/api/v1';
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || 'vhhealth123';

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
  
  if (!authToken && !endpoint.includes('/auth/login')) {
    throw new Error('No authentication token');
  }

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
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
      throw new Error(`API Error: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Auth functions
export const login = async (username: string, password: string) => {
  try {
    const response = await fetchAdminAPI('/auth/login', {
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

// Dashboard data
export const getDashboardData = async (): Promise<DashboardData> => {
  try {
    const response = await fetchAdminAPI('/admin/dashboard');
    return DashboardDataSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

// Department functions
export const getDepartments = async (): Promise<Department[]> => {
  try {
    const response = await fetchAdminAPI('/departments/manage');
    // Validate the response
    const departments = response.departments || response;
    return departments.map((dept: any) => DepartmentSchema.parse(dept));
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const createDepartment = async (data: { name: string; description?: string }) => {
  try {
    const response = await fetchAdminAPI('/departments/manage', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return DepartmentSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const updateDepartment = async (id: string, data: { name?: string; description?: string }) => {
  try {
    const response = await fetchAdminAPI(`/departments/manage/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    return DepartmentSchema.parse(response);
  } catch (error) {
    Sentry.captureException(error);
    throw error;
  }
};

export const deleteDepartment = async (id: string) => {
  try {
    await fetchAdminAPI(`/departments/manage/${id}`, {
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
    return patients.map((patient: any) => PatientSchema.parse(patient));
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

export const createPatient = async (data: any) => {
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

export const updatePatient = async (id: string, data: any) => {
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
    return appointments.map((apt: any) => AppointmentSchema.parse(apt));
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

export const createAppointment = async (data: any) => {
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

export const updateAppointment = async (id: string, data: any) => {
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
    const users = response.users || response;
    return users.map((user: any) => UserSchema.parse(user));
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

export const createUser = async (data: any) => {
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

export const updateUser = async (id: string, data: any) => {
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