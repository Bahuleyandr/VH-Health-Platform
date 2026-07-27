import { readFileSync } from 'node:fs';

const routeSource = readFileSync(
  new URL('../../routes/admin/edRoutes.js', import.meta.url),
  'utf8',
).replaceAll('\r', '');

test('ED continuity resolves patient context before the governed care-team guard', () => {
  const routeStart = routeSource.indexOf(
    "router.get(\n  '/visits/:id/continuity'",
  );
  const nextRoute = routeSource.indexOf(
    "router.post('/visits/:id/closure-evidence'",
    routeStart,
  );
  const route = routeSource.slice(routeStart, nextRoute);

  expect(routeStart).toBeGreaterThan(-1);
  expect(route).toContain('resolveEdVisitContext');
  expect(route).toContain(
    "patientAccessGuard('ED_CONTINUITY', { careTeamModeGoverned: true })",
  );
  expect(route.indexOf('resolveEdVisitContext'))
    .toBeLessThan(route.indexOf("patientAccessGuard('ED_CONTINUITY'"));
  expect(route.indexOf("patientAccessGuard('ED_CONTINUITY'"))
    .toBeLessThan(route.indexOf('getEdContinuity'));
});
