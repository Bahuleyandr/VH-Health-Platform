const API_BASE = "https://vh-health-backend.onrender.com/api/v1";

export async function adminLogin(username: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/admin/login`, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "x-api-key": "vhhealth123"  // THIS IS REQUIRED!
    },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error?.message || "Login failed");
  }
  return res.json();
}