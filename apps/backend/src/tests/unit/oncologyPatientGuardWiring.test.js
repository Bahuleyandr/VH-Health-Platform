import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../routes/oncology/oncologyRoutes.js', import.meta.url),
  'utf8',
);

describe('oncology patient guard wiring', () => {
  test.each([
    ["router.get('/plans/:id', guardPlanView"],
    ["router.post('/plans/:id/cycles', guardPlanWrite"],
    ["router.post('/chair-bookings', guardCycleBodyWrite"],
    ["router.post('/chair-bookings/:id/cancel', guardBookingWrite"],
    ["router.post('/administrations/:id/verify', guardAdministrationWrite"],
    ["router.post('/administrations/:id/administer', guardAdministrationWrite"],
    ["router.post('/administrations/:id/withhold', guardAdministrationWrite"],
    ["router.get('/diagnoses', guardOncologyPatientView"],
    ["router.post('/diagnoses', guardPathologyReportBodyWrite"],
    ["router.post('/diagnoses/:id/staging', guardDiagnosisWrite"],
    ["router.post('/staging/:id/sign', guardStagingWrite"],
    ["router.get('/toxicity-events', guardOncologyPatientView"],
    ["router.post('/toxicity-events', guardDiagnosisBodyWrite"],
    ["router.post('/toxicity-events/:id/sign', guardToxicityWrite"],
    ["router.post('/tumor-board/cases', guardDiagnosisBodyWrite"],
    ["router.patch('/tumor-board/cases/:id/state', guardTumorBoardCaseWrite"],
    ["router.post('/tumor-board/cases/:id/recommendations', guardTumorBoardCaseWrite"],
    ["router.patch('/tumor-board/recommendations/:id/status', guardTumorBoardRecommendationWrite"],
  ])('%s is patient-context guarded', (routePrefix) => {
    expect(source).toContain(routePrefix);
  });

  test('patient-list guards require context when care-team enforcement is active', () => {
    expect(source).toMatch(
      /const guardOncologyPatientView = patientAccessGuard\([\s\S]*?requirePatientContext: true,[\s\S]*?careTeamModeGoverned: true/,
    );
    expect(source).toMatch(
      /const guardOncologyPatientWrite = patientAccessGuard\([\s\S]*?requirePatientContext: true,[\s\S]*?careTeamModeGoverned: true/,
    );
  });

  test('derived-patient create guards fail closed when neither direct nor resource context is present', () => {
    expect(source).toMatch(
      /const guardPathologyReportBodyWrite = oncologyResourceGuard\('pathology_report',[\s\S]*?requirePatientContext: true/,
    );
    expect(source).toMatch(
      /const guardDiagnosisBodyWrite = oncologyResourceGuard\('oncology_diagnosis',[\s\S]*?requirePatientContext: true/,
    );
  });
});
