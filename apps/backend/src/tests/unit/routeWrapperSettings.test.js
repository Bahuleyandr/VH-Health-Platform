// Guard: every rate-limit profile name referenced by the route wrapper's
// per-route override map must exist in RATE_LIMIT_PROFILES. Historically
// getRateLimiter fell back silently to the generic `default` profile for
// unknown names (finding 2026-08-14: the phantom 'strict'/'relaxed' mappings
// routed appointment/feedback writes to `default` for their whole life);
// since 873-F8 it THROWS at construction, so a phantom name here would crash
// route registration at boot. This test keeps failing earlier and clearer —
// in CI, naming the offending mapping — before anything tries to boot.

import { ROUTE_RATE_PROFILES } from '../../config/routeWrapperSettings.js';
import { RATE_LIMIT_PROFILES } from '../../config/rateLimitProfiles.js';

describe('routeWrapperSettings', () => {
  it('names only rate-limit profiles that actually exist', () => {
    const known = new Set(Object.keys(RATE_LIMIT_PROFILES));
    const phantoms = Object.entries(ROUTE_RATE_PROFILES)
      .filter(([, profileName]) => !known.has(profileName))
      .map(([routeKey, profileName]) => `${routeKey} -> ${profileName}`);

    expect(phantoms).toEqual([]);
  });

  it('maps routeKey.method strings to profile-name strings', () => {
    for (const [routeKey, profileName] of Object.entries(ROUTE_RATE_PROFILES)) {
      expect(routeKey).toMatch(/^[A-Za-z0-9]+\.(get|post|put|patch|delete)$/);
      expect(typeof profileName).toBe('string');
    }
  });
});
