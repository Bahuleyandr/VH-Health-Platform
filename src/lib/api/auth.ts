// src/lib/api/auth.ts
import { postJSON, getJSON } from "./core";
import { API_ENDPOINTS } from "../api-config";

export function generateOTP(phoneNumber: string) {
  return postJSON(
    API_ENDPOINTS.auth.generateOtp,
    { phone: phoneNumber },
    false,
  );
}

export function verifyOTP(phoneNumber: string, otp: string) {
  return postJSON(
    API_ENDPOINTS.auth.verifyOtp,
    { phone: phoneNumber, otp },
    false,
  );
}

export function loginAdmin(username: string, password: string) {
  return postJSON(
    API_ENDPOINTS.auth.admin.login,
    { username, password },
    false,
  );
}

export function getAuthStats() {
  return getJSON(API_ENDPOINTS.auth.stats);
}
