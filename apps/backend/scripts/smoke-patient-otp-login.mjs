#!/usr/bin/env node

const BACKEND_BASE_URL = stripTrailingSlash(process.env.BACKEND_URL || 'http://127.0.0.1:5206');
const API_KEY = process.env.API_KEY || process.env.NEXT_PUBLIC_X_API_KEY || '';
const PATIENT_PHONE = process.env.SMOKE_PATIENT_PHONE || '+918888880001';

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function fail(message, details) {
  const suffix = details ? `\n${typeof details === 'string' ? details : JSON.stringify(details, null, 2)}` : '';
  throw new Error(`[smoke-patient-otp-login] ${message}${suffix}`);
}

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    method,
    headers: {
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'x-forwarded-proto': 'https',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { response, data, text };
}

function payload(envelope) {
  return envelope?.data ?? envelope ?? {};
}

const otpRequest = await request('/api/v1/auth/request-otp', {
  method: 'POST',
  body: { phone: PATIENT_PHONE, purpose: 'login' },
});
if (!otpRequest.response.ok) {
  fail(`OTP request failed with HTTP ${otpRequest.response.status}`, otpRequest.data || otpRequest.text);
}

const otp = payload(otpRequest.data).devOtp;
if (!otp) {
  fail('OTP request did not return devOtp; set ALLOW_DEV_OTP=true for this smoke job', otpRequest.data);
}

const otpVerify = await request('/api/v1/auth/verify-otp', {
  method: 'POST',
  body: { phone: PATIENT_PHONE, otp },
});
if (!otpVerify.response.ok) {
  fail(`OTP verify failed with HTTP ${otpVerify.response.status}`, otpVerify.data || otpVerify.text);
}

const token = payload(otpVerify.data).token ?? payload(otpVerify.data).accessToken;
if (!token) fail('OTP verify response did not include an access token', otpVerify.data);

const notifications = await request('/api/v1/notifications/my', { token });
if (!notifications.response.ok) {
  fail(`GET /api/v1/notifications/my failed with HTTP ${notifications.response.status}`, notifications.data || notifications.text);
}
if (notifications.data?.success === false) {
  fail('GET /api/v1/notifications/my returned an unsuccessful envelope', notifications.data);
}

const data = payload(notifications.data);
const count = Array.isArray(data?.notifications) ? data.notifications.length : 'unknown';
console.log(`[smoke-patient-otp-login] OTP token issued for ${PATIENT_PHONE}; notifications/my returned ${count} notification(s)`);
