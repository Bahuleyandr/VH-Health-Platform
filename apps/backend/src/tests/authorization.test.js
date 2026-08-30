// src/tests/authorization.test.js
// Integration tests for authorization (IDOR protection), JWT validation, and rate limiting.
//
// This file covers the DENIAL half of the contract: no IDOR-protected endpoint
// returns 200 for a cross-user request, plus the JWT / API-key / rate-limit
// gates. It seeds nothing, so each IDOR case here targets either an id that does
// not exist (asserting the exact 404) or an RBAC gate that fires before any
// lookup at all.
//
// The ALLOW half — a legitimate owner still gets through — needs seeded
// ownership and lives in src/tests/appointment-record-owner-access.deep.test.js.
// It used to sit here as three empty `it.skip` stubs labelled "requires test
// DB"; the DB was never the blocker (the exact-404 assertions below already
// query a real Postgres), the missing fixture ownership was. Do not re-add
// bodiless placeholders here: a skipped empty test reads as coverage and is not.

import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../app.js';
import { generateToken } from '../utils/jwtUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const PATIENT_A_UID = '11111111-1111-4111-8111-111111111111';
const PATIENT_B_UID = '22222222-2222-4222-8222-222222222222';
const STAFF_UID = '33333333-3333-4333-8333-333333333333';

function uniqueTestUuid() {
  const suffix = Date.now().toString(16).padStart(12, '0').slice(-12);
  return `44444444-4444-4444-8444-${suffix}`;
}

// ── Test tokens ─────────────────────────────────────────────────────────────
const patientAToken = generateToken({
  uid: PATIENT_A_UID,
  id: 1,
  phone: '1234567890',
  role: 'PATIENT'
});

const patientBToken = generateToken({
  uid: PATIENT_B_UID,
  id: 2,
  phone: '0987654321',
  role: 'PATIENT'
});

const staffToken = generateToken({
  uid: STAFF_UID,
  id: 100,
  phone: '5551112222',
  role: 'ADMIN'
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Authenticated supertest request with API key + Bearer token */
const authRequest = (method, path, token) => {
  return request(app)[method](path)
    .set('X-API-Key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. APPOINTMENT IDOR PROTECTION
// ═════════════════════════════════════════════════════════════════════════════

describe('Appointment IDOR Protection', () => {
  // The appointment CRUD controller fetches the appointment first, then runs
  // checkAppointmentPermission(). Without a DB, the service call fails (500).
  // With a real DB, a non-existent appointment returns 404, and a cross-user
  // appointment returns 403. All three outcomes (403, 404, 500) confirm the
  // request is NOT blindly accepted.

  describe('PUT /api/v1/appointments/:id — update appointment', () => {
    it('should NOT return 200 when updating a non-owned appointment', async () => {
      // Use a date 1 year from now to avoid validation rejection (past-date check)
      // so the request reaches IDOR/auth checks.
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      const futureDateStr = futureDate.toISOString().split('T')[0]; // YYYY-MM-DD

      const res = await authRequest('put', '/api/v1/appointments/999999', patientBToken)
        .send({
          appointment_date: futureDateStr,
          appointment_time: '10:00',
          reason: 'Checkup'
        });

      // Appointment 999999 does not exist on the seeded CI DB: exact 404.
      expect(res.statusCode).toBe(404);
    });

    // Owner-allowed counterpart: appointment-record-owner-access.deep.test.js
  });

  describe('DELETE /api/v1/appointments/:id — cancel appointment', () => {
    it('should NOT return 200 when cancelling a non-owned appointment', async () => {
      const res = await authRequest('delete', '/api/v1/appointments/999999', patientBToken);

      expect(res.statusCode).toBe(404);
    });

    // Owner-allowed counterpart: appointment-record-owner-access.deep.test.js
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. PATIENT RECORD IDOR PROTECTION
// ═════════════════════════════════════════════════════════════════════════════

describe('Patient Record IDOR Protection', () => {
  describe('DELETE /api/v1/appointments/patient/records/:id', () => {
    it('should NOT return 200 when deleting a non-owned record', async () => {
      const res = await authRequest('delete', '/api/v1/appointments/patient/records/999999', patientBToken);

      expect(res.statusCode).toBe(404);
    });

    // Owner-allowed counterpart: appointment-record-owner-access.deep.test.js
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. PHARMACY ORDER AUTHORIZATION
// ═════════════════════════════════════════════════════════════════════════════

describe('Pharmacy Order Authorization', () => {
  // The legacy pharmacy order routes (pharmacyOrderRoutes) are RBAC-gated to
  // PHARMACY_STAFF, DOCTOR, ADMIN only. Patients use the newer
  // pharmacyPatientOrderRoutes (/orders/my, /orders/place).

  describe('GET /api/v1/pharmacy-orders/orders/:phone (legacy) — RBAC blocks patients', () => {
    it('should reject a PATIENT accessing the legacy orders-by-phone endpoint', async () => {
      // RBAC config: pharmacyOrderRoutes does not include PATIENT role.
      const res = await authRequest('get', '/api/v1/pharmacy-orders/orders/0987654321', patientAToken);
      expect(res.statusCode).toBe(403);
    });

    it('should reject a patient even for their own phone on the legacy endpoint', async () => {
      // The RBAC gate fires before the controller, so even own-phone is blocked.
      const res = await authRequest('get', '/api/v1/pharmacy-orders/orders/1234567890', patientAToken);
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/v1/pharmacy-orders/orders/my — patient own orders (new endpoint)', () => {
    it('should allow a PATIENT to access /orders/my which is under pharmacyPatientOrderRoutes', async () => {
      // NOTE: Due to Express route ordering, the legacy `/:phone` pattern
      // may match "my" first if mounted before the /my route. In the current
      // router setup, wrapAutoRBAC for pharmacyPatientOrderRoutes registers
      // /my before the legacy /:phone. If this test returns 403, it indicates
      // a route ordering issue where /:phone (RBAC: no PATIENT) catches "my".
      const res = await authRequest('get', '/api/v1/pharmacy-orders/orders/my', patientAToken);

      // The historical /:phone-shadows-/my route-ordering bug is fixed: /my
      // resolves for PATIENT and returns the caller's (empty) order list.
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/v1/pharmacy-orders/orders/:id/confirm — RBAC blocks patients', () => {
    it('should reject a PATIENT confirming a pharmacy order', async () => {
      const res = await authRequest(
        'post',
        '/api/v1/pharmacy-orders/orders/1/confirm',
        patientAToken,
      );

      expect(res.statusCode).toBe(403);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. NOTIFICATION AUTHORIZATION
// ═════════════════════════════════════════════════════════════════════════════

describe('Notification Authorization', () => {
  // The notificationRoutes RBAC config is [GENERAL_STAFF, ADMIN].
  // PATIENT is NOT in the allowed roles, so all notification endpoints
  // (including /my and /:phone) return 403 for patients at the RBAC level.
  // This is a stronger protection than IDOR: patients cannot access any
  // notification endpoint via the general notification routes.

  describe('GET /api/v1/notifications/my — own notifications', () => {
    it('allows PATIENT through RBAC and returns the exact missing-user contract', async () => {
      const res = await authRequest('get', '/api/v1/notifications/my', patientAToken);

      expect(res.statusCode).toBe(404);
    });

    it('allows ADMIN through RBAC and returns the exact missing-user contract', async () => {
      const res = await authRequest('get', '/api/v1/notifications/my', staffToken);

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/notifications/:phone — notifications by phone', () => {
    it('should block PATIENT from accessing any phone notifications', async () => {
      const res = await authRequest('get', '/api/v1/notifications/0987654321', patientAToken);

      // Legacy phone-number notification routes are intentionally gone because
      // PII in URLs is unsafe.
      expect(res.statusCode).toBe(410);
      expect(res.body.success).toBe(false);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. JWT VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

describe('JWT Validation', () => {
  it('should return 401 with TOKEN_EXPIRED for expired tokens', async () => {
    const expiredToken = jwt.sign(
      { sub: 'test-user', role: 'PATIENT', phone: '1234567890' },
      process.env.JWT_SECRET,
      { expiresIn: '-1s' } // already expired
    );

    const res = await request(app)
      .get('/api/v1/appointments')
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('should return 401 with TOKEN_INVALID for tampered tokens', async () => {
    const tamperedToken = jwt.sign(
      { sub: 'test-user', role: 'PATIENT' },
      'wrong-secret-key',
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/v1/appointments')
      .set('X-API-Key', API_KEY)
      .set('Authorization', `Bearer ${tamperedToken}`);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('should return 401 for missing Authorization header', async () => {
    const res = await request(app)
      .get('/api/v1/appointments')
      .set('X-API-Key', API_KEY);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/token missing|authorization/i);
  });

  it('should return 401 for missing API key', async () => {
    const res = await request(app)
      .get('/api/v1/appointments')
      .set('Authorization', `Bearer ${patientAToken}`);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for invalid API key', async () => {
    const res = await request(app)
      .get('/api/v1/appointments')
      .set('X-API-Key', 'totally-wrong-key')
      .set('Authorization', `Bearer ${patientAToken}`);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 for malformed Bearer token', async () => {
    const res = await request(app)
      .get('/api/v1/appointments')
      .set('X-API-Key', API_KEY)
      .set('Authorization', 'Bearer not.a.valid.jwt.at.all');

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. RATE LIMITING
// ═════════════════════════════════════════════════════════════════════════════

describe('Rate Limiting', () => {
  describe('OTP endpoint rate limiting (3 requests per 10 minutes)', () => {
    it('should return 429 after exceeding OTP rate limit', async () => {
      // Use a unique phone per test run so rate limit counters are fresh.
      const phone = `rate-limit-test-${Date.now()}`;
      let lastRes;

      // Send 4 requests — the 4th should be rate-limited (limit is 3)
      for (let i = 0; i < 4; i++) {
        lastRes = await request(app)
          .post('/api/v1/otp/request-otp')
          .send({ phone });
      }

      // After exceeding the limit, expect 429
      expect(lastRes.statusCode).toBe(429);
      expect(lastRes.body.code).toBe('RATE_LIMITED');
    });
  });

  describe('SOS endpoint rate limiting (3 requests per hour)', () => {
    it('should return 429 after exceeding SOS rate limit', async () => {
      // Use a unique UID so the rate limit counter is fresh for this test.
      const uniqueUid = uniqueTestUuid();
      const sosToken = generateToken({
        uid: uniqueUid,
        id: 99999,
        phone: '9876543210',
        role: 'PATIENT'
      });

      let lastRes;

      // The SOS route uses wrapAutoRBAC with requireUID and requirePhone
      // defaults (both true). The validateUID middleware checks for uid in
      // body/query/params, and validatePhone checks for a valid 10-digit phone.
      // We include both in the request body.
      for (let i = 0; i < 4; i++) {
        lastRes = await authRequest('post', '/api/v1/sos/', sosToken)
          .send({
            uid: uniqueUid,
            phone: '9876543210',
            latitude: 10.0,
            longitude: 76.0,
            alert_type: 'MEDICAL',
            description: 'Rate limit test'
          });
      }

      // After exceeding the limit, expect 429.
      // The sosRateLimiter keys by req.user.uid, so all 4 requests from the
      // same UID share the same bucket.
      expect(lastRes.statusCode).toBe(429);
      expect(lastRes.body.code).toBe('RATE_LIMITED');
    });
  });
});
