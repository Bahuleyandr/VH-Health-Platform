/**
 * Route drift guard for admin clinical-governance endpoints.
 * Full Express/RBAC integration is covered by the /api/v1/admin parent
 * mount; this test keeps the governance router wired into that surface.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_INDEX_PATH = path.resolve(__dirname, '../../routes/admin/index.js');
const ROUTE_PATH = path.resolve(__dirname, '../../routes/admin/clinicalGovernanceRoutes.js');

describe('admin clinical governance routes', () => {
  let adminIndex;
  let routeFile;

  beforeAll(() => {
    adminIndex = fs.readFileSync(ADMIN_INDEX_PATH, 'utf8');
    routeFile = fs.readFileSync(ROUTE_PATH, 'utf8');
  });

  it('is mounted under the admin RBAC surface', () => {
    expect(adminIndex).toMatch(/import clinicalGovernanceRoutes from '\.\/clinicalGovernanceRoutes\.js';/);
    expect(adminIndex).toMatch(/router\.use\('\/clinical-governance', clinicalGovernanceRoutes\);/);
  });

  it('declares care-team and patient-access governance endpoints', () => {
    expect(routeFile).toMatch(/router\.post\('\/care-teams'/);
    expect(routeFile).toMatch(/router\.post\('\/care-teams\/:id\/members'/);
    expect(routeFile).toMatch(/router\.patch\('\/care-teams\/:id\/members\/:memberId\/transition'/);
    expect(routeFile).toMatch(/router\.post\('\/patient-access\/break-glass'/);
    expect(routeFile).toMatch(/router\.get\('\/patient-access\/audit'/);
  });

  it('declares lab specimen, analyzer, and QC endpoints', () => {
    expect(routeFile).toMatch(/router\.post\('\/lab\/specimens'/);
    expect(routeFile).toMatch(/router\.patch\('\/lab\/specimens\/:id\/transition'/);
    expect(routeFile).toMatch(/router\.put\('\/lab\/analyzers'/);
    expect(routeFile).toMatch(/router\.post\('\/lab\/analyzers\/:id\/qc-runs'/);
  });
});
