// src/lib/api-client.ts
// This file contains client-side only API functions that don't need auth tokens

const API_BASE_URL = 'https://vh-health-backend.onrender.com/api/v1';
const API_KEY = 'vhhealth123';

export async function adminLogin(username: string, password: string) {
  const response = await fetch(`${API_BASE_URL}/auth/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Login failed');
  }

  const responseData = await response.json();
  
  // The backend returns: { success: true, message: "...", data: { token: "...", admin: {...} } }
  if (responseData.success && responseData.data && responseData.data.token) {
    const { token, admin } = responseData.data;
    
    // Store token in localStorage for client-side use
    localStorage.setItem('adminToken', token);
    
    // Store admin info if needed
    if (admin) {
      localStorage.setItem('adminUser', JSON.stringify(admin));
    }
    
    return { token, admin };
  }

  throw new Error('Invalid response from server');
}