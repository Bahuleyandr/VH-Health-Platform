import {
  clinicalContinuityPacksEnabled,
  getClinicalContinuityPublicationRoot,
  getDowntimeMirrorDir,
} from '../../config/downtimeConfig.js';

describe('clinical continuity publication configuration', () => {
  test('is inert by default without resolving the legacy mirror fallback', () => {
    const env = {};

    expect(clinicalContinuityPacksEnabled(env)).toBe(false);
    expect(getClinicalContinuityPublicationRoot(env)).toBeNull();
    expect(getDowntimeMirrorDir(env)).toContain('vhhealth-downtime-mirror');
  });

  test('requires an explicit operator-owned root when enabled', () => {
    expect(() => getClinicalContinuityPublicationRoot({
      CLINICAL_CONTINUITY_PACKS_ENABLED: 'true',
      DOWNTIME_MIRROR_DIR: '   ',
    })).toThrow(
      'DOWNTIME_MIRROR_DIR is required when CLINICAL_CONTINUITY_PACKS_ENABLED=true',
    );
  });

  test('returns the trimmed explicit root only when enabled', () => {
    const env = {
      CLINICAL_CONTINUITY_PACKS_ENABLED: ' TRUE ',
      DOWNTIME_MIRROR_DIR: ' D:\\continuity-packs ',
    };

    expect(clinicalContinuityPacksEnabled(env)).toBe(true);
    expect(getClinicalContinuityPublicationRoot(env)).toBe('D:\\continuity-packs');
  });
});
