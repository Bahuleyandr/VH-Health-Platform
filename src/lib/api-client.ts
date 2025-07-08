// src/lib/api-client.ts

// This MUST be at the top of the file
const API_BASE = "https://vh-health-backend.onrender.com/api/v1";

/**
 * Logs in an admin user. This is a public route and can be called from the client.
 */
export async function adminLogin(email: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      username: email.includes('@') ? email.split('@')[0] : email,
      password 
    }),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error?.message || "Login failed");
  }
  return res.json();
}