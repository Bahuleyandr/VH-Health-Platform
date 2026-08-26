// src/tests/staffPrefixGateScope.test.js
//
// Regression pin for the 2026-08-22 staff-namespace lockout — the second
// instance of the #905 prefix-mount shape:
//
//   app.use('/api/v1/staff', requireRole(...STAFF_PHONE_SELF_SERVICE_ROUTE_ROLES), staffPhoneRoutes);
//   app.use('/api/v1/staff', staffRoutes);
//
// Express runs a mount's middleware for every URL under the prefix before it
// knows whether the router matches, so the narrow phone-self-service gate
// became a ceiling over the ENTIRE staff namespace: CMO, CNO,
// MEDICAL_SUPERINTENDENT, ANAESTHETIST and ~20 more roles were 403'd on their
// own attendance, leave and payslips, and on the staff-admin console that
// rbacConfig.staffAdminRoutes grants them BY NAME. The gate now lives inside
// phoneRoutes.js, scoped to that router's own path families.
//
// These pins are BEHAVIORAL and run in plain test env — the bug was not
// production-conditional (requireRole fires in every environment); it shipped
// green only because no test exercised these roles on these routes.

import request from 'supertest';
import app from '../app.js';
import rbacConfig from '../config/rbacConfig.js';
import staffRouter from '../routes/staff/index.js';
import { generateToken } from '../utils/jwtUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

const tokenFor = (role, id) => generateToken({
  uid: `dddddddd-0000-4000-8000-${String(id).padStart(12, '0')}`,
  id,
  role,
});

const get = (path, token) => request(app)
  .get(path)
  .set('x-api-key', API_KEY)
  .set('x-forwarded-proto', 'https')
  .set('Authorization', `Bearer ${token}`);

const post = (path, token, body = {}) => request(app)
  .post(path)
  .set('x-api-key', API_KEY)
  .set('x-forwarded-proto', 'https')
  .set('Authorization', `Bearer ${token}`)
  .send(body);

// The exact deny the prefix gate produced. Anything else — 200, 404, 500 from
// a missing fixture row, or a richer structured 403 from a deeper guard — means
// the request got PAST the mount-level rbac ceiling, which is what this pins.
const isBareRbacForbidden = (res) =>
  res.status === 403 && res.body?.error === 'Forbidden' && res.body?.code === undefined;

function directRouteGuard(method, path) {
  const routeLayer = (staffRouter.stack ?? []).find(
    (layer) => layer.route?.path === path && layer.route?.methods?.[method],
  );
  return routeLayer?.route?.stack?.[0]?.handle;
}

function runRoleGuard(guard, role) {
  const req = {
    user: { role },
    headers: {},
    ip: '127.0.0.1',
    method: 'GET',
    originalUrl: '/api/v1/staff/replacements/my',
  };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let nexted = false;
  guard(req, res, () => { nexted = true; });
  return { nexted, res };
}

describe('staff namespace prefix-gate scope', () => {
  // Roles the phone-self-service capability group EXCLUDES but the staff
  // sub-routers' own rbacConfig keys ADMIT. Under the bug, every one of these
  // was denied at the mount before its own router's policy could run.
  const lockedOutRoles = ['CMO', 'CNO', 'MEDICAL_SUPERINTENDENT', 'ANAESTHETIST'];

  describe.each(lockedOutRoles)('%s', (role) => {
    const token = tokenFor(role, 8100 + lockedOutRoles.indexOf(role));

    it('reaches own attendance (staffAttendanceRoutes admits it)', async () => {
      const res = await get('/api/v1/staff/attendance/my', token);
      expect(isBareRbacForbidden(res)).toBe(false);
    });

    it('reaches own payslips (staffHRRoutes admits it)', async () => {
      const res = await get('/api/v1/staff/hr/payroll/my-payslips', token);
      expect(isBareRbacForbidden(res)).toBe(false);
    });
  });

  it('CMO reaches the staff-admin console (staffAdminRoutes names CMO explicitly)', async () => {
    const res = await get('/api/v1/staff/admin/dashboard', tokenFor('CMO', 8100));
    expect(isBareRbacForbidden(res)).toBe(false);
  });

  it('staffAdminRoutes stays narrow: DOCTOR is still refused the staff-admin console', async () => {
    // Removing the ceiling must not have widened anything — the sub-router's
    // own gate (which excludes DOCTOR) is now the effective policy.
    const res = await get('/api/v1/staff/admin/dashboard', tokenFor('DOCTOR', 8200));
    expect(isBareRbacForbidden(res)).toBe(true);
  });

  it('the phone gate still guards its own routes: PATIENT is refused /staff/phone/home', async () => {
    const res = await get('/api/v1/staff/phone/home', tokenFor('PATIENT', 8300));
    expect(isBareRbacForbidden(res)).toBe(true);
  });

  // The bare barrel routes /replacements/my + /replacements have no sub-router
  // wrapAutoRBAC key — #906 removed the prefix ceiling that had implicitly gated
  // them, letting any authenticated principal incl. PATIENT write staff
  // replacement rows (2026-08-25 reaudit AZ-1). They now carry an explicit
  // requireRole(...rbacConfig.staffHRRoutes), matching the canonical routes. The static
  // route-role-coverage gate cannot see barrel routes, so these behavioral pins
  // are the regression catch.
  it('PATIENT is refused POST /staff/replacements (AZ-1 write regression)', async () => {
    const res = await post('/api/v1/staff/replacements', tokenFor('PATIENT', 8400), {
      replacement_staff_id: 1,
      dates: ['2026-09-01'],
    });
    expect(isBareRbacForbidden(res)).toBe(true);
  });

  it('PATIENT is refused GET /staff/replacements/my', async () => {
    const res = await get('/api/v1/staff/replacements/my', tokenFor('PATIENT', 8400));
    expect(isBareRbacForbidden(res)).toBe(true);
  });

  it('a canonical staff-HR role passes the replacements gate', async () => {
    // NURSING_STAFF is in rbacConfig.staffHRRoutes; without a DB row
    // the handler may 404/500, but it must not be rbac-denied at the gate.
    const res = await get('/api/v1/staff/replacements/my', tokenFor('NURSING_STAFF', 8500));
    expect(isBareRbacForbidden(res)).toBe(false);
  });

  it.each([
    ['get', '/replacements/my'],
    ['post', '/replacements'],
  ])('%s %s has exact role parity with the canonical staff-HR policy', (method, path) => {
    const guard = directRouteGuard(method, path);
    expect(guard).toEqual(expect.any(Function));

    for (const role of rbacConfig.staffHRRoutes) {
      const out = runRoleGuard(guard, role);
      expect({ method, path, role, nexted: out.nexted }).toEqual({
        method,
        path,
        role,
        nexted: true,
      });
    }

    const patient = runRoleGuard(guard, 'PATIENT');
    expect(patient.nexted).toBe(false);
    expect(patient.res.statusCode).toBe(403);
    expect(patient.res.body).toEqual({ success: false, error: 'Forbidden' });
  });

  it('a phone-list role passes the scoped gate on /staff/phone/home', async () => {
    const res = await get('/api/v1/staff/phone/home', tokenFor('DOCTOR', 8200));
    // DOCTOR is in STAFF_PHONE_SELF_SERVICE_ROUTE_ROLES; without a DB row the
    // handler may 500, but it must not be rbac-denied.
    expect(isBareRbacForbidden(res)).toBe(false);
  });
});
