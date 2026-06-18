// adminIpAllowlistLogs.deep.test.js
//
// Audit finding #5: /api/v1/logs (audit + system logs) and /api/v1/system
// (system settings) were admin-role-gated + rate-limited but, unlike
// /api/v1/admin, did NOT apply adminIpAllowlist — so in production they were
// reachable with an admin token from any IP. This proves both mounts now sit
// behind the same admin IP allowlist (403 ADMIN_IP_NOT_ALLOWED when the caller
// is off-allowlist) while staying transparent when no allowlist is configured
// (dev/test parity — the middleware only fails closed in production).
//
// The allowlist is read per-request from ADMIN_IP_ALLOWLIST, so toggling the
// env var around each request flips behaviour without re-importing the app.

import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { generateTestToken, API_KEY } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const adminHeaders = () => ({
  'x-api-key': API_KEY,
  Authorization: `Bearer ${generateTestToken('ADMIN')}`,
});

d('Admin IP allowlist gates /logs and /system (#5)', () => {
  const original = process.env.ADMIN_IP_ALLOWLIST;

  afterAll(async () => {
    if (original === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
    else process.env.ADMIN_IP_ALLOWLIST = original;
    await prisma.$disconnect().catch(() => {});
  });

  describe('allowlist set but excluding the test client (loopback)', () => {
    beforeAll(() => {
      // A CIDR that does not contain 127.0.0.1 / ::1, so the supertest client
      // is off-allowlist and the IP check runs regardless of NODE_ENV.
      process.env.ADMIN_IP_ALLOWLIST = '10.99.99.0/24';
    });

    test('/api/v1/logs is blocked by the admin IP allowlist', async () => {
      const res = await request(app).get('/api/v1/logs').set(adminHeaders());
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('ADMIN_IP_NOT_ALLOWED');
    });

    test('/api/v1/system is blocked by the admin IP allowlist', async () => {
      const res = await request(app).get('/api/v1/system').set(adminHeaders());
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('ADMIN_IP_NOT_ALLOWED');
    });
  });

  describe('no allowlist configured (dev/test parity — must not over-block)', () => {
    beforeAll(() => {
      delete process.env.ADMIN_IP_ALLOWLIST;
    });

    test('/api/v1/logs is not blocked by the allowlist when unset in non-prod', async () => {
      const res = await request(app).get('/api/v1/logs').set(adminHeaders());
      // Whatever logRoutes returns (200/404/etc), it must NOT be an allowlist denial.
      expect(res.body.code).not.toBe('ADMIN_IP_NOT_ALLOWED');
      expect(res.body.code).not.toBe('ADMIN_IP_ALLOWLIST_REQUIRED');
    });
  });
});
