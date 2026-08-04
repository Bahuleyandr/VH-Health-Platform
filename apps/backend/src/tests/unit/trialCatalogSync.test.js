import {
  canonicalTrialQuery,
  mapStudyToTrial,
} from '../../services/ai/trialCatalogSyncService.js';

function buildStudy(overrides = {}) {
  return {
    protocolSection: {
      identificationModule: {
        nctId: 'NCT01234567',
        briefTitle: 'Short title',
        officialTitle: 'Full official title — ' + (overrides.titleSuffix || 'Pneumonia trial'),
      },
      statusModule: {
        overallStatus: 'RECRUITING',
        lastUpdatePostDateStruct: { date: '2026-08-01', type: 'ACTUAL' },
      },
      descriptionModule: { briefSummary: 'We study X in adults with Y.' },
      eligibilityModule: {
        eligibilityCriteria: 'Inclusion: age 18-65, stable Y. Exclusion: pregnancy.',
        minimumAge: '18 Years',
        maximumAge: '65 Years',
        sex: 'ALL',
      },
      conditionsModule: { conditions: ['Community-acquired pneumonia'] },
      contactsLocationsModule: { locations: [{ country: 'India', city: 'Chennai' }] },
      designModule: { phases: ['PHASE3'] },
    },
    ...overrides,
  };
}

describe('mapStudyToTrial', () => {
  it('maps a well-formed study to our catalog shape', () => {
    const out = mapStudyToTrial(buildStudy());
    expect(out).toEqual({
      nctId: 'NCT01234567',
      title: expect.stringContaining('Pneumonia trial'),
      phase: 'PHASE3',
      conditions: ['Community-acquired pneumonia'],
      eligibilitySummary: expect.stringContaining('age 18-65'),
      ageMin: 18,
      ageMax: 65,
      gender: 'all',
      location: 'India',
      status: 'recruiting',
      providerRevision: '2026-08-01',
    });
  });

  it('falls back to briefTitle when officialTitle is missing', () => {
    const study = buildStudy();
    study.protocolSection.identificationModule.officialTitle = null;
    const out = mapStudyToTrial(study);
    expect(out.title).toBe('Short title');
  });

  it('returns null when nctId is missing', () => {
    const study = buildStudy();
    study.protocolSection.identificationModule.nctId = undefined;
    expect(mapStudyToTrial(study)).toBeNull();
  });

  it('returns null when eligibility summary is empty', () => {
    const study = buildStudy();
    study.protocolSection.descriptionModule = {};
    study.protocolSection.eligibilityModule = { minimumAge: '18 Years' };
    expect(mapStudyToTrial(study)).toBeNull();
  });

  it('parses age in months to years (floor)', () => {
    const study = buildStudy();
    study.protocolSection.eligibilityModule.minimumAge = '24 Months';
    study.protocolSection.eligibilityModule.maximumAge = '15 Years';
    const out = mapStudyToTrial(study);
    expect(out.ageMin).toBe(2);
    expect(out.ageMax).toBe(15);
  });

  it('normalises sex to male | female | all', () => {
    const study = buildStudy();
    study.protocolSection.eligibilityModule.sex = 'FEMALE';
    expect(mapStudyToTrial(study).gender).toBe('female');

    study.protocolSection.eligibilityModule.sex = 'BOTH';
    expect(mapStudyToTrial(study).gender).toBe('all');

    study.protocolSection.eligibilityModule.sex = undefined;
    expect(mapStudyToTrial(study).gender).toBe('all');
  });

  it('remaps enrolling_by_invitation to recruiting', () => {
    const study = buildStudy();
    study.protocolSection.statusModule.overallStatus = 'ENROLLING_BY_INVITATION';
    expect(mapStudyToTrial(study).status).toBe('recruiting');
  });

  it('joins multiple phases with slash', () => {
    const study = buildStudy();
    study.protocolSection.designModule.phases = ['PHASE2', 'PHASE3'];
    expect(mapStudyToTrial(study).phase).toBe('PHASE2/PHASE3');
  });

  it('handles missing location gracefully', () => {
    const study = buildStudy();
    study.protocolSection.contactsLocationsModule = {};
    const out = mapStudyToTrial(study);
    expect(out.location).toBeNull();
  });
});

describe('canonicalTrialQuery', () => {
  it('uses a stable canonicalized query as the recovery partition', () => {
    expect(canonicalTrialQuery({
      condition: '  Chronic   Kidney Disease ',
      location: ' INDIA ',
    })).toEqual(canonicalTrialQuery({
      condition: 'chronic kidney disease',
      location: 'india',
    }));
    expect(canonicalTrialQuery({
      condition: 'chronic kidney disease',
      location: 'india',
    }).sourcePartition).toMatch(/^clinicaltrials_gov_v2:[0-9a-f]{64}$/);
  });
});
