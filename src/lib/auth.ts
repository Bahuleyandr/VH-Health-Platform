// src/lib/auth.ts
import axios from 'axios';
import { config } from './config';

// Use relative URLs when in browser, full URLs for server-side
const API_BASE_URL = typeof window !== 'undefined' ? '' : config.apiUrl;

const api = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  timeout: config.timeouts.default,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add request interceptor to include token if stored in localStorage
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Add response interceptor to handle token from response
api.interceptors.response.use(
  (response) => {
    // If the response includes a token, store it
    if (response.data?.token) {
      localStorage.setItem('authToken', response.data.token);
    }
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      // Clear token and redirect to login
      localStorage.removeItem('authToken');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface User {
  id: string;
  username: string;
  email?: string;
  role?: string;
  [key: string]: any;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  user?: User;
  message?: string;
}

export const auth = {
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    try {
      // Use relative URL - Next.js will rewrite it
      const response = await api.post('/api/v1/auth/admin/login', credentials);
      
      const { data } = response;
      
      if (data.token) {
        localStorage.setItem(config.storage.authToken, data.token);
      }
      
      return {
        success: true,
        token: data.token,
        user: data.user || data.admin || data.data,
      };
    } catch (error: any) {
      console.error('Login error:', error);
      return {
        success: false,
        message: error.response?.data?.message || 'Login failed',
      };
    }
  },

  async getProfile(): Promise<User | null> {
    try {
      const response = await api.get(config.endpoints.auth.profile);
      return response.data.user || response.data.admin || response.data.data || response.data;
    } catch (error) {
      console.error('Get profile error:', error);
      return null;
    }
  },

  async logout(): Promise<void> {
    try {
      await api.post(config.endpoints.auth.logout).catch(() => {});
    } finally {
      localStorage.removeItem(config.storage.authToken);
    }
  },

  isAuthenticated(): boolean {
    return !!localStorage.getItem(config.storage.authToken);
  },

  getToken(): string | null {
    return localStorage.getItem(config.storage.authToken);
  },
};

export const dashboardApi = {
  async getDashboardData() {
    try {
      const response = await api.get(config.endpoints.users.dashboard);
      return response.data;
    } catch (error) {
      console.error('Dashboard data error:', error);
      throw error;
    }
  },

  async getUsers() {
    try {
      const response = await api.get(config.endpoints.users.list);
      return response.data;
    } catch (error) {
      console.error('Get users error:', error);
      throw error;
    }
  },

  async getDoctors() {
    try {
      const response = await api.get(config.endpoints.doctors.list);
      return response.data;
    } catch (error) {
      console.error('Get doctors error:', error);
      throw error;
    }
  },
};