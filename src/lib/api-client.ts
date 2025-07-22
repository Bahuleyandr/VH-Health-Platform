// src/lib/api-client.ts

import { API_ENDPOINTS } from './api-config';
import { apiPost, apiGet } from './api-fetch';

// Admin Authentication Functions
export async function adminLogin(username: string, password: string) {
  try {
    const response = await apiPost(API_ENDPOINTS.auth.admin.login, {
      username,
      password
    });

    const responseData = await response.json();

    if (!response.ok) {
      throw new Error(responseData.message || `Login failed with status ${response.status}`);
    }

    if (responseData.success && responseData.data) {
      const { token, admin } = responseData.data;
      
      if (!token) {
        throw new Error('No token received from server');
      }
      
      localStorage.setItem('adminToken', token);
      if (admin) {
        localStorage.setItem('adminUser', JSON.stringify(admin));
      }
      
      return { token, admin, success: true };
    }

    throw new Error(responseData.message || 'Invalid response format from server');
  } catch (error: any) {
    console.error('Admin login error:', error);
    throw error;
  }
}

// Update getAdminProfile to use apiGet
export async function getAdminProfile() {
  const token = localStorage.getItem('adminToken');
  if (!token) {
    throw new Error('No authentication token found');
  }

  try {
    const response = await apiGet(API_ENDPOINTS.auth.admin.profile, token);
    const responseData = await response.json();

    if (!response.ok) {
      if (response.status === 401) {
        clearAuthData();
        throw new Error('Session expired. Please login again.');
      }
      throw new Error(responseData.message || 'Failed to fetch profile');
    }

    return responseData.data;
  } catch (error: any) {
    console.error('Get profile error:', error);
    throw error;
  }
}

// Update adminLogout to use apiPost
export async function adminLogout() {
  const token = localStorage.getItem('adminToken');
  
  try {
    if (token) {
      await apiPost(API_ENDPOINTS.auth.admin.logout, {}, token);
    }
  } catch (error) {
    console.error('Logout API error:', error);
  } finally {
    clearAuthData();
  }
}

// Update refreshToken to use apiPost
export async function refreshToken() {
  const token = localStorage.getItem('adminToken');
  if (!token) {
    throw new Error('No token to refresh');
  }

  try {
    const response = await apiPost(API_ENDPOINTS.auth.refreshToken, {}, token);
    const responseData = await response.json();

    if (!response.ok) {
      throw new Error(responseData.message || 'Failed to refresh token');
    }

    if (responseData.data && responseData.data.token) {
      localStorage.setItem('adminToken', responseData.data.token);
      return responseData.data.token;
    }

    throw new Error('No token in refresh response');
  } catch (error: any) {
    console.error('Token refresh error:', error);
    clearAuthData();
    throw error;
  }
}

// Helper functions
export function getAuthToken(): string | null {
  return localStorage.getItem('adminToken');
}

export function getAdminUser() {
  const userStr = localStorage.getItem('adminUser');
  if (!userStr) return null;
  
  try {
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return !!localStorage.getItem('adminToken');
}

export function clearAuthData() {
  localStorage.removeItem('adminToken');
  localStorage.removeItem('adminUser');
}

// API helper with auth
export async function authenticatedFetch(endpoint: string, options: RequestInit = {}) {
  const token = getAuthToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const { headers, ...otherOptions } = options;
  
  const response = await apiFetch(endpoint, {
    ...otherOptions,
    token,
    headers: headers as HeadersInit,
  });

  if (response.status === 401) {
    try {
      const newToken = await refreshToken();
      return apiFetch(endpoint, {
        ...otherOptions,
        token: newToken,
        headers: headers as HeadersInit,
      });
    } catch {
      clearAuthData();
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  return response;
}