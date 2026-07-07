// CI coverage gate for backend route-level RBAC (Phase 3 of the 2026-06-10
// remediation plan — "the highest-leverage upgrade"). Findings H1 and H2 both
// happened because a mount silently lacked a role gate. This test freezes the
// exemption list: any NEW `/api/v1/*` mount registered after the global
// jwtAuth that has no `requireRole(...)` in its middleware chain FAILS CI
// unless it is consciously added to EXEMPT_MOUNTS with a justification.
//
// Static analysis of src/app.js (no DB needed).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_JS = path.resolve(__dirname, '..', 'app.js');

/**
 * Mounts allowed to omit a mount-level requireRole. Every entry MUST state
 * where its authorization actually lives. Review before extending.
 */
const EXEMPT_MOUNTS = {
  '/api/v1/realtime': 'JWT-authed ticket exchange; issues short-lived WS-scoped tokens (self-scoped)',
  '/api/v1/chatbot': 'patient AI symptom checker; self-scoped to req.user, no cross-patient reads',
  '/api/v1/users': 'wrapAutoRBAC inside routes/user/index.js (userRoutes/lookupRoutes keys + ADMIN wrap)',
  '/api/v1/departments': 'wrapAutoRBAC(departmentRoutes) inside the router; read-mostly directory',
  '/api/v1/doctors': 'wrapAutoRBAC(doctorRoutes) inside the router',
  '/api/v1/notifications': 'wrapAutoRBAC(notificationRoutes) inside the router — every authed role may read own notifications',
  '/api/v1/upload': 'self-scoped upload surface; per-route guards + ClamAV pipeline inside router',
  '/api/v1/reminders': 'patient medication reminders; self-scoped to req.user',
  '/api/v1/steps': 'patient health-sync (own data only)',
  '/api/v1/rewards': 'patient gamification (own data only)',
  '/api/v1/gamification': 'patient gamification (own data only)',
  '/api/v1/devices': 'legacy/mobile FCM registration uses wrapAutoRBAC(deviceRoutes); clinical vitals is a later same-path mount with requireRole',
  '/api/v1/feedback': 'wrapAutoRBAC(feedbackRoutes) inside the router',
  '/api/v1/sos': 'wrapAutoRBAC(sosRoutes) inside the router; emergency surface must stay broad',
  '/api/v1/patient-access/break-glass': 'wrapAutoRBAC(patientAccessBreakGlassRoutes) inside breakGlassRoutes.js — gated to SUPER_ADMIN/ADMIN/CMO/MEDICAL_SUPERINTENDENT (break-glass eligible roles)',
  '/api/v1/search': 'staff search router applies per-route guards internally',
  '/api/v1/data-export': 'GDPR self-export; strictly self-scoped to req.user + rate-limited',
  '/api/v1/gdpr': 'GDPR self-service; strictly self-scoped to req.user',
  '/api/v1/sessions': 'own-session management; self-scoped to req.user',
  '/api/v1/abdm': 'ABDM patient consent flows; self-scoped + signature-verified callbacks',
  // NOTE: '/api/v1/staff' is NOT exempt — its first mount (app.js:678) is
  // requireRole(...STAFF_PHONE_SELF_SERVICE_ROUTE_ROLES) + staffPhoneRoutes,
  // so the path is mount-level gated. The later app.use('/api/v1/staff',
  // staffRoutes) inherits that first gate (Express runs same-path mounts in order).
  '/api/v1/admin/ed': 'pure 308 redirect to the role-gated /api/v1/ed mount',
  '/api/v1/admin/surgical': 'pure 308 redirect to the role-gated /api/v1/surgical mount',
  '/api/v1/quality': 'controller-level isStaff/isClinical/isAdmin checks (roleHelpers) — candidate for mount-level requireRole, tracked in PLATFORM_REMEDIATION_PLAN',
  '/api/v1/referrals': 'route-level role checks inside referralRoutes — candidate for mount-level requireRole, tracked in PLATFORM_REMEDIATION_PLAN',
};

/** Extracts complete `app.use(...)` statements with balanced parentheses. */
function extractMounts(source) {
  const mounts = [];
  const useRe = /app\.use\(/g;
  let match;
  while ((match = useRe.exec(source)) !== null) {
    let depth = 0;
    let end = match.index + 'app.use'.length;
    for (let i = end; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    const statement = source.slice(match.index, end);
    const pathMatch = statement.match(/app\.use\(\s*'([^']+)'/);
    mounts.push({
      index: match.index,
      path: pathMatch ? pathMatch[1] : null,
      statement,
    });
  }
  return mounts;
}

describe('Phase-3 CI gate — every authenticated /api/v1 mount carries a role gate', () => {
  const source = fs.readFileSync(APP_JS, 'utf8');
  const jwtAuthIndex = source.indexOf('app.use(jwtAuth)');

  test('app.js still has the global jwtAuth gate', () => {
    expect(jwtAuthIndex).toBeGreaterThan(0);
  });

  const apiMounts = extractMounts(source).filter(
    (m) => m.index > jwtAuthIndex && m.path && m.path.startsWith('/api/v1'),
  );

  // Express runs mounts for the same path in registration order, so a path is
  // protected when its FIRST mount carries requireRole (subsequent mounts —
  // e.g. the per-path phiAccessLogger stack on /api/v1/emr — inherit it).
  const firstMountByPath = new Map();
  for (const mount of apiMounts) {
    if (!firstMountByPath.has(mount.path)) firstMountByPath.set(mount.path, mount);
  }
  const uniqueMounts = [...firstMountByPath.entries()];

  test('found a sane number of authenticated /api/v1 mounts', () => {
    expect(uniqueMounts.length).toBeGreaterThan(60);
  });

  test.each(uniqueMounts)(
    'mount %s has requireRole or a documented exemption',
    (mountPath, mount) => {
      const hasRoleGate = /requireRole\s*\(/.test(mount.statement);
      const isExempt = mountPath in EXEMPT_MOUNTS;
      if (!hasRoleGate && !isExempt) {
        throw new Error(
          `Mount ${mountPath} is registered after jwtAuth WITHOUT requireRole(...) ` +
            `and has no documented exemption. Either add requireRole(...) at the ` +
            `mount (preferred — see audit findings H1/H2) or add an entry to ` +
            `EXEMPT_MOUNTS in ${path.basename(__filename)} stating where its ` +
            `authorization lives.`,
        );
      }
      expect(hasRoleGate || isExempt).toBe(true);
    },
  );

  test('exemption list contains no stale entries', () => {
    const mountedPaths = new Set(apiMounts.map((m) => m.path));
    const stale = Object.keys(EXEMPT_MOUNTS).filter((p) => !mountedPaths.has(p));
    if (stale.length > 0) {
      throw new Error(
        `EXEMPT_MOUNTS entries no longer mounted (remove them): ${stale.join(', ')}`,
      );
    }
    expect(stale).toEqual([]);
  });

  test('no first-mount with requireRole is ALSO needlessly exempted (keep the list honest)', () => {
    const doubled = uniqueMounts
      .filter(([p, m]) => /requireRole\s*\(/.test(m.statement) && p in EXEMPT_MOUNTS)
      .map(([p]) => p);
    expect(doubled).toEqual([]);
  });

  test('clinical device-vitals mount includes the DEVICE_GATEWAY role', () => {
    const deviceMounts = apiMounts.filter((m) => m.path === '/api/v1/devices');
    const clinicalMount = deviceMounts.find((m) => /deviceVitalsRoutes/.test(m.statement));
    expect(clinicalMount).toBeTruthy();
    expect(clinicalMount.statement).toMatch(/requireRole\s*\(/);
    expect(clinicalMount.statement).toContain("'DEVICE_GATEWAY'");
  });
});
