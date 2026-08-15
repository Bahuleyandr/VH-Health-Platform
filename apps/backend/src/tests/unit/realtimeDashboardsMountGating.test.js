// Mount-order gating guards (2026-08-14 findings, backend-HTTP P3 #7).
//
// 1. The realtime channel-catalog/health router must be mounted BEHIND
//    validateApiKey + jwtAuth. It used to sit in the public pre-API-key
//    section, handing the full WS channel inventory and the live connection
//    count to unauthenticated callers.
// 2. /api/v1/dashboards must carry the same network-tier gate as its admin
//    siblings (adminIpAllowlist + adminRateLimiter); it was the one
//    ADMIN_ROUTE_ROLES surface without them.
//
// Pinned against the app.js source the same way the probe-limiter test pins
// its mounts: mount ORDER in app.js is the security property.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const appSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app.js'),
  'utf8',
);

describe('app.js mount gating', () => {
  it('mounts the realtime catalog router after validateApiKey and jwtAuth', () => {
    const realtimeCatalogMount = appSource.indexOf(
      "app.use('/api/v1/realtime', genericLimiter, realtimeRoutes)",
    );
    const apiKeyMount = appSource.indexOf('rawHl7RecoveryResponses(validateApiKey)');
    const jwtMount = appSource.indexOf('app.use(jwtAuth)');

    expect(realtimeCatalogMount).toBeGreaterThan(-1);
    expect(apiKeyMount).toBeGreaterThan(-1);
    expect(jwtMount).toBeGreaterThan(-1);
    expect(realtimeCatalogMount).toBeGreaterThan(apiKeyMount);
    expect(realtimeCatalogMount).toBeGreaterThan(jwtMount);
  });

  it('keeps the WS ticket exchange mounted for authenticated clients', () => {
    // The ticket flow must survive the catalog move: same mount path, behind
    // jwtAuth, disjoint route paths (/ticket vs /channels, /health).
    const ticketMount = appSource.indexOf(
      "app.use('/api/v1/realtime', genericLimiter, realtimeTicketRoutes)",
    );
    expect(ticketMount).toBeGreaterThan(appSource.indexOf('app.use(jwtAuth)'));
  });

  it('gates /api/v1/dashboards with adminIpAllowlist + adminRateLimiter like its admin siblings', () => {
    expect(appSource).toMatch(
      /app\.use\('\/api\/v1\/dashboards',\s*requireRole\(\.\.\.ADMIN_ROUTE_ROLES\),\s*adminIpAllowlist,\s*adminRateLimiter,\s*dashboardsRoutes\)/,
    );
  });
});
