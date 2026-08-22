// src/tests/auditRoleListRegression.test.js
//
// Pins for the 2026-08-22 audit's role-list corrections. Each of these was a
// role the platform treats as first-class (selectable, seeded, listed in other
// rbacConfig keys) that a stale or hand-grown list silently excluded:
//
//  - ANAESTHETIST (British/Indian spelling) was missing from roleHelpers'
//    ROLES map, so isClinical()/isStaff() rejected it across ~25 route files.
//  - notificationRoutes was a hand-grown 27-role subset of a self-scoped
//    surface, 403'ing the bell for 31 roles.
//  - RADIOLOGIST and BIOMEDICAL_STAFF were absent from
//    staffAttendanceRoutes/staffHRRoutes while their direct peers were present.

import request from 'supertest';
import app from '../app.js';
import { generateToken } from '../utils/jwtUtils.js';
import { isClinical, isStaff } from '../utils/roleHelpers.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

const tokenFor = (role, id) => generateToken({
  uid: `ffffffff-0000-4000-8000-${String(id).padStart(12, '0')}`,
  id,
  role,
});

const get = (path, token) => request(app)
  .get(path)
  .set('x-api-key', API_KEY)
  .set('x-forwarded-proto', 'https')
  .set('Authorization', `Bearer ${token}`);

const isBareRbacForbidden = (res) =>
  res.status === 403 && res.body?.error === 'Forbidden' && res.body?.code === undefined;

describe('ANAESTHETIST is clinical staff in the role helpers', () => {
  it('isClinical accepts both spellings', () => {
    expect(isClinical('ANESTHETIST')).toBe(true);
    expect(isClinical('ANAESTHETIST')).toBe(true);
  });

  it('isStaff accepts both spellings', () => {
    expect(isStaff('ANESTHETIST')).toBe(true);
    expect(isStaff('ANAESTHETIST')).toBe(true);
  });
});

describe('notification bell is reachable by every role (self-scoped surface)', () => {
  // A sample spanning the 31 previously-denied roles.
  const roles = ['DUTY_DOCTOR', 'NURSING_INCHARGE', 'CATH_LAB_INCHARGE', 'CMO', 'CNO', 'MEDICAL_SUPERINTENDENT', 'DRIVER', 'SECURITY'];

  it.each(roles)('%s is not rbac-denied on /notifications/my', async (role) => {
    const res = await get('/api/v1/notifications/my', tokenFor(role, 9600 + roles.indexOf(role)));
    expect(isBareRbacForbidden(res)).toBe(false);
  });
});

describe('radiologists and biomedical engineers reach their own HR self-service', () => {
  const roles = ['RADIOLOGIST', 'BIOMEDICAL_STAFF'];

  it.each(roles)('%s is not rbac-denied on own attendance', async (role) => {
    const res = await get('/api/v1/staff/attendance/my', tokenFor(role, 9700 + roles.indexOf(role)));
    expect(isBareRbacForbidden(res)).toBe(false);
  });

  it.each(roles)('%s is not rbac-denied on own payslips', async (role) => {
    const res = await get('/api/v1/staff/hr/payroll/my-payslips', tokenFor(role, 9700 + roles.indexOf(role)));
    expect(isBareRbacForbidden(res)).toBe(false);
  });
});

describe('nothing was widened beyond intent', () => {
  it('PATIENT is still refused staff attendance', async () => {
    const res = await get('/api/v1/staff/attendance/my', tokenFor('PATIENT', 9800));
    expect(isBareRbacForbidden(res)).toBe(true);
  });

  it('machine roles are not in the notification list (ALL_ROLES excludes them)', async () => {
    const res = await get('/api/v1/notifications/my', tokenFor('WEBHOOK_CLIENT', 9801));
    expect(isBareRbacForbidden(res)).toBe(true);
  });
});
