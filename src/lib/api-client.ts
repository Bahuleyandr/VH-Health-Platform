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

  const data = await response.json();
  
  // Store token in localStorage for client-side use
  if (data.token) {
    localStorage.setItem('adminToken', data.token);
  }

  return data;
}