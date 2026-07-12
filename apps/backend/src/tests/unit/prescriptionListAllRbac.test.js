// Regression guard for Sol Ultra audit #11: the PATIENT role could call
// GET /prescriptions/all (getAllPrescriptions is unscoped — WHERE 1=1 + optional
// filters), enumerating every other patient's prescription PHI, because /all
// shared the ePrescriptionPatientRoutes RBAC key (which includes PATIENT) with
// the self-scoped /patient/my route.
//
// This test resolves, from the route source, which RBAC config key governs the
// /all route and asserts that key does NOT grant PATIENT — while /patient/my
// stays patient-accessible.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import rbacConfig from '../../config/rbacConfig.js';
import { PATIENT } from '../../utils/roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../routes/prescription/index.js'), 'utf8');

// The wrapAutoRBAC(router, 'KEY', {...}) config key of the block that registers `route`.
function rbacKeyGoverning(route) {
  const pos = ROUTE_SRC.indexOf(`'${route}'`);
  if (pos === -1) throw new Error(`route ${route} not found in prescription/index.js`);
  const before = ROUTE_SRC.slice(0, pos);
  const callIdx = before.lastIndexOf('wrapAutoRBAC(');
  if (callIdx === -1) throw new Error(`no wrapAutoRBAC governing ${route}`);
  const m = before.slice(callIdx).match(/wrapAutoRBAC\(\s*router\s*,\s*'([^']+)'/);
  if (!m) throw new Error(`no wrapAutoRBAC governing ${route}`);
  return m[1];
}

describe('prescription /all RBAC (Sol Ultra #11)', () => {
  it('the RBAC key governing GET /prescriptions/all does not grant PATIENT', () => {
    const key = rbacKeyGoverning('/all');
    expect(rbacConfig[key]).toBeDefined();
    expect(rbacConfig[key]).not.toContain(PATIENT);
  });

  it('patients can still reach their own /patient/my prescriptions', () => {
    const key = rbacKeyGoverning('/patient/my');
    expect(rbacConfig[key]).toContain(PATIENT);
  });
});
