// src/lib/api-client.ts

// This file contains API functions that are SAFE to call from Client Components.

// Use the default URL provided by Render for your backend service.
const API_BASE = "https://vh-health-backend.onrender.com/api/v1";

/**
 * Logs in an admin user. This is a public route and can be called from the client.
 */
export async function adminLogin(email: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error?.message || "Login failed");
  }
  return res.json();
}
