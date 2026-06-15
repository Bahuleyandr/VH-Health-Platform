/**
 * Security regression guard for the clinician results-inbox surface.
 *
 * The /api/v1/clinical-inbox mount (clinical-staff-gated) must expose ONLY the
 * two safety-net endpoints — NOT the full admin tasks/workflow/escalation-rules
 * router. A prior iteration mounted the whole admin router there, which let any
 * clinical-staff role read any task by id (cross-patient PHI) and disable
 * escalation rules. This test fails if that surface ever creeps back in.
 */

import router from '../../routes/clinicalInboxRoutes.js';

function registeredRoutes(expressRouter) {
  return expressRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .sort(),
    }));
}

describe('clinicalInboxRoutes — minimal clinician surface', () => {
  const routes = registeredRoutes(router);

  it('exposes ONLY GET /tasks/inbox and POST /tasks/:id/acknowledge', () => {
    expect(routes).toEqual([
      { path: '/tasks/inbox', methods: ['get'] },
      { path: '/tasks/:id/acknowledge', methods: ['post'] },
    ]);
  });

  it('does NOT expose the admin task/escalation surface (PHI + privilege escalation)', () => {
    const paths = routes.map((r) => r.path);
    // getTask by id — cross-patient PHI read.
    expect(paths).not.toContain('/tasks/:id');
    // listTasks — enumerate any tenant/patient tasks.
    expect(paths).not.toContain('/tasks');
    // upsertEscalationRule — disable the safety net itself.
    expect(paths).not.toContain('/escalation-rules');
    expect(paths).not.toContain('/sla-definitions');
    expect(paths).not.toContain('/automation-rules');
    // No mutation of arbitrary tasks (create / transition / assign).
    expect(paths.some((p) => p.includes('transition'))).toBe(false);
    expect(paths.some((p) => p.includes('assign'))).toBe(false);
  });
});
