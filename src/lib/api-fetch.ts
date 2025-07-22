// src/lib/api-fetch.ts
import { API_BASE_URL } from './api-config';

interface FetchOptions extends RequestInit {
  token?: string;
}

export async function apiFetch(endpoint: string, options: FetchOptions = {}) {
  const { token, headers: customHeaders, ...fetchOptions } = options;
  
  // Ensure Origin is always included
  const origin = typeof window !== 'undefined' 
    ? window.location.origin 
    : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const headers = new Headers({
    'Content-Type': 'application/json',
    'x-api-key': 'vhhealth123',
    'Origin': origin,
    ...customHeaders,
  });

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers,
    });

    // Log for debugging in development
    if (process.env.NODE_ENV === 'development') {
      console.log(`API ${fetchOptions.method || 'GET'} ${endpoint}:`, response.status);
    }

    return response;
  } catch (error) {
    console.error(`API fetch error for ${endpoint}:`, error);
    throw error;
  }
}

// Convenience methods
export const apiGet = (endpoint: string, token?: string) => 
  apiFetch(endpoint, { method: 'GET', token });

export const apiPost = (endpoint: string, body: any, token?: string) => 
  apiFetch(endpoint, { method: 'POST', body: JSON.stringify(body), token });

export const apiPut = (endpoint: string, body: any, token?: string) => 
  apiFetch(endpoint, { method: 'PUT', body: JSON.stringify(body), token });

export const apiDelete = (endpoint: string, token?: string) => 
  apiFetch(endpoint, { method: 'DELETE', token });