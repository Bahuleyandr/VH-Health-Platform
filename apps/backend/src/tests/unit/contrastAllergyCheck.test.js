import {
  CONTRAST_PRESUMED_MODALITIES,
  assertContrastOrderAllowed,
  deriveContrastRenalWarnings,
  isContrastPresumedModality,
  resolveContrastAgentClass,
  screenContrastAllergies,
  validateRadiologyContrastSafety,
} from '../../utils/clinical/contrastAllergyCheck.js';
import { AppError } from '../../utils/AppError.js';

describe('radiology contrast/allergy screening (migration 678)', () => {
  describe('resolveContrastAgentClass', () => {
    it('maps modality defaults: CT/X-ray/fluoro/mammo → iodinated, MRI → gadolinium, USG → microbubble', () => {
      expect(resolveContrastAgentClass('ct')).toBe('iodinated');
      expect(resolveContrastAgentClass('xray')).toBe('iodinated');
      expect(resolveContrastAgentClass('fluoroscopy')).toBe('iodinated');
      expect(resolveContrastAgentClass('mammography')).toBe('iodinated');
      expect(resolveContrastAgentClass('mri')).toBe('gadolinium');
      expect(resolveContrastAgentClass('ultrasound')).toBe('microbubble');
    });

    it('lets a named agent override the modality default', () => {
      expect(resolveContrastAgentClass('ct', 'Dotarem 0.5 mmol/ml')).toBe('gadolinium');
      expect(resolveContrastAgentClass('mri', 'iohexol 350')).toBe('iodinated');
      expect(resolveContrastAgentClass('fluoroscopy', 'Gastrografin oral')).toBe('iodinated');
    });

    it('falls back to generic gadolin/iod token sniffing for unlisted agents', () => {
      expect(resolveContrastAgentClass('ct', 'gadolinium-based agent')).toBe('gadolinium');
      expect(resolveContrastAgentClass('mri', 'experimental iodinated tracer')).toBe('iodinated');
    });
  });

  describe('screenContrastAllergies', () => {
    it('blocks a documented same-class contrast allergy (hit path)', () => {
      const result = screenContrastAllergies(
        [{ allergen: 'Iodinated contrast', severity: 'ANAPHYLAXIS', sources: ['patient_allergies'] }],
        { modality: 'ct' },
      );
      expect(result.safe).toBe(false);
      expect(result.agent_class).toBe('iodinated');
      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0]).toMatchObject({
        type: 'CONTRAST_ALLERGY_CONFLICT',
        allergy: 'Iodinated contrast',
        severity: 'ANAPHYLAXIS',
        agent_class: 'iodinated',
        sources: ['patient_allergies'],
      });
    });

    it('blocks generic free-text "contrast dye" phrasing regardless of planned class', () => {
      const ct = screenContrastAllergies([{ allergen: 'contrast dye', severity: null }], { modality: 'ct' });
      const mr = screenContrastAllergies([{ allergen: 'Contrast media', severity: 'SEVERE' }], { modality: 'mri' });
      expect(ct.safe).toBe(false);
      expect(mr.safe).toBe(false);
    });

    it('blocks on a direct agent-name match even when the class terms miss', () => {
      const result = screenContrastAllergies(
        [{ allergen: 'iohexol', severity: 'MODERATE' }],
        { modality: 'ct', contrastAgent: 'Iohexol 350 mg/ml' },
      );
      expect(result.safe).toBe(false);
      expect(result.blockers[0].medication).toBe('Iohexol 350 mg/ml');
    });

    it('warns (does not block) on a cross-class contrast history', () => {
      const result = screenContrastAllergies(
        [{ allergen: 'gadolinium', severity: 'SEVERE' }],
        { modality: 'ct' },
      );
      expect(result.safe).toBe(true);
      expect(result.blockers).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatchObject({
        type: 'CONTRAST_CROSS_CLASS_ALLERGY',
        allergy: 'gadolinium',
        agent_class: 'iodinated',
      });
    });

    it('blocks the same gadolinium allergy when the planned study is MR contrast', () => {
      const result = screenContrastAllergies(
        [{ allergen: 'gadolinium', severity: 'SEVERE' }],
        { modality: 'mri' },
      );
      expect(result.safe).toBe(false);
      expect(result.blockers[0].type).toBe('CONTRAST_ALLERGY_CONFLICT');
    });

    it('passes clean when no contrast-relevant allergy exists (no-hit path)', () => {
      const result = screenContrastAllergies(
        [
          { allergen: 'Penicillin', severity: 'SEVERE' },
          { allergen: 'peanuts', severity: 'ANAPHYLAXIS' },
        ],
        { modality: 'ct', contrastAgent: 'iohexol' },
      );
      expect(result.safe).toBe(true);
      expect(result.blockers).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('ignores empty allergen rows and tolerates a non-array input', () => {
      expect(screenContrastAllergies([{ allergen: '' }, {}], { modality: 'ct' }).safe).toBe(true);
      expect(screenContrastAllergies(null, { modality: 'ct' }).safe).toBe(true);
    });
  });

  describe('contrast intent presumption (default-on screening, PR #875 R9)', () => {
    it('presumes contrast for CT, MRI, and fluoroscopy only', () => {
      expect(CONTRAST_PRESUMED_MODALITIES).toEqual(['ct', 'mri', 'fluoroscopy']);
      expect(isContrastPresumedModality('ct')).toBe(true);
      expect(isContrastPresumedModality('MRI')).toBe(true);
      expect(isContrastPresumedModality('fluoroscopy')).toBe(true);
      expect(isContrastPresumedModality('xray')).toBe(false);
      expect(isContrastPresumedModality('ultrasound')).toBe(false);
      expect(isContrastPresumedModality('mammography')).toBe(false);
      expect(isContrastPresumedModality(null)).toBe(false);
    });
  });

  describe('validateRadiologyContrastSafety — honest screen status + fail-closed (PR #875 R10)', () => {
    const PATIENT_UID = 'cf000000-0000-4000-8000-00000000c001';

    // Fake prisma-compatible client keyed on table names in the SQL the
    // unified allergy fetch + renal lookup issue. Unlisted tables return [].
    function makeDb(handlers = {}) {
      return {
        $queryRawUnsafe: async (sql) => {
          for (const [needle, handler] of Object.entries(handlers)) {
            if (sql.includes(needle)) return handler();
          }
          if (sql.includes('FROM users')) {
            return [{ id: 1, uid: PATIENT_UID, allergies: '' }];
          }
          return [];
        },
      };
    }

    it('reports status completed when the patient resolves and every store answers', async () => {
      const db = makeDb({
        'FROM patient_allergies': () => [{ allergen: 'Iodinated contrast', severity: 'SEVERE' }],
      });
      const screen = await validateRadiologyContrastSafety(
        { patientUid: PATIENT_UID, modality: 'ct' }, { db },
      );
      expect(screen.status).toBe('completed');
      expect(screen.sources_failed).toEqual([]);
      expect(screen.patient_resolved).toBe(true);
      expect(screen.safe).toBe(false);
      expect(screen.blockers).toHaveLength(1);
      expect(screen.blockers[0].type).toBe('CONTRAST_ALLERGY_CONFLICT');
    });

    it('fails CLOSED on a degraded lookup: a failed store adds a SCREEN_INCOMPLETE blocker even with zero hits', async () => {
      const db = makeDb({
        'FROM patient_allergies': () => { throw new Error('relation missing'); },
      });
      const screen = await validateRadiologyContrastSafety(
        { patientUid: PATIENT_UID, modality: 'ct' }, { db },
      );
      expect(screen.status).toBe('degraded');
      expect(screen.sources_failed).toEqual(['patient_allergies']);
      expect(screen.safe).toBe(false);
      expect(screen.blockers).toEqual([
        expect.objectContaining({
          type: 'CONTRAST_ALLERGY_SCREEN_INCOMPLETE',
          screen_status: 'degraded',
          sources_failed: ['patient_allergies'],
        }),
      ]);
    });

    it('fails CLOSED when the patient cannot be resolved at all (status failed)', async () => {
      const db = makeDb({ 'FROM users': () => [] });
      const screen = await validateRadiologyContrastSafety(
        { patientUid: PATIENT_UID, modality: 'mri' }, { db },
      );
      expect(screen.status).toBe('failed');
      expect(screen.safe).toBe(false);
      expect(screen.blockers[0]).toMatchObject({
        type: 'CONTRAST_ALLERGY_SCREEN_INCOMPLETE',
        screen_status: 'failed',
        agent_class: 'gadolinium',
      });
    });

    it('keeps a failed RENAL lookup advisory but records it honestly in the evidence', async () => {
      const db = makeDb({
        'FROM lab_results': () => { throw new Error('lab feed down'); },
      });
      const screen = await validateRadiologyContrastSafety(
        { patientUid: PATIENT_UID, modality: 'ct' }, { db },
      );
      expect(screen.status).toBe('completed');
      expect(screen.safe).toBe(true); // renal never blocks
      expect(screen.renal).toMatchObject({ evidenceFound: false, lookup_failed: true });
    });
  });

  describe('deriveContrastRenalWarnings', () => {
    it('returns no warning without renal evidence or impairment', () => {
      expect(deriveContrastRenalWarnings(null, 'iodinated')).toEqual([]);
      expect(deriveContrastRenalWarnings({ evidenceFound: false }, 'iodinated')).toEqual([]);
      expect(deriveContrastRenalWarnings(
        { evidenceFound: true, impaired: false, egfr: 90 },
        'iodinated',
      )).toEqual([]);
    });

    it('flags impaired renal function as MODERATE and severe as HIGH', () => {
      const moderate = deriveContrastRenalWarnings(
        { evidenceFound: true, impaired: true, severe: false, egfr: 45, creatinine: 1.7 },
        'iodinated',
      );
      expect(moderate).toHaveLength(1);
      expect(moderate[0]).toMatchObject({
        type: 'CONTRAST_RENAL_RISK',
        severity: 'MODERATE',
        latest_egfr: 45,
        latest_creatinine: 1.7,
      });

      const high = deriveContrastRenalWarnings(
        { evidenceFound: true, impaired: true, severe: true, egfr: 22, creatinine: 3.1 },
        'gadolinium',
      );
      expect(high[0].severity).toBe('HIGH');
      expect(high[0].message).toContain('nephrogenic systemic fibrosis');
    });
  });

  describe('assertContrastOrderAllowed (override gate)', () => {
    const blockedScreen = {
      safe: false,
      blockers: [{ type: 'CONTRAST_ALLERGY_CONFLICT', allergy: 'contrast dye', severity: 'SEVERE' }],
      warnings: [],
    };

    it('returns null for a safe screen (no override needed)', () => {
      expect(assertContrastOrderAllowed({ safe: true, blockers: [], warnings: [] }, null)).toBeNull();
      expect(assertContrastOrderAllowed(null, null)).toBeNull();
    });

    it('throws a structured 409 with the matched allergy when blocked without an override', () => {
      let caught;
      try {
        assertContrastOrderAllowed(blockedScreen, null, 'doctor-uid');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught.statusCode).toBe(409);
      expect(caught.code).toBe('RADIOLOGY_CONTRAST_ALLERGY_BLOCKED');
      expect(caught.details.requiresOverride).toBe(true);
      expect(caught.details.blockers[0].allergy).toBe('contrast dye');
    });

    it('rejects an override reason shorter than 5 trimmed characters', () => {
      expect(() => assertContrastOrderAllowed(blockedScreen, { reason: ' abc ' }, 'doctor-uid'))
        .toThrow(AppError);
    });

    it('accepts a valid override only when an authenticated actor is supplied', () => {
      const override = assertContrastOrderAllowed(
        blockedScreen,
        { reason: '  Premedicated with steroids per protocol  ' },
        'ce000000-0000-4000-8000-0000000000bb',
      );
      expect(override).toEqual({
        reason: 'Premedicated with steroids per protocol',
        approvedBy: 'ce000000-0000-4000-8000-0000000000bb',
      });
    });

    it('ignores a caller-selected approver and binds attribution to the authenticated actor', () => {
      const override = assertContrastOrderAllowed(
        blockedScreen,
        {
          reason: 'Radiologist approved low-osmolar switch',
          approvedBy: 'ce000000-0000-4000-8000-0000000000aa',
        },
        'ce000000-0000-4000-8000-0000000000bb',
      );
      expect(override.approvedBy).toBe('ce000000-0000-4000-8000-0000000000bb');
    });

    it('rejects an override when no authenticated actor can be bound', () => {
      expect(() => assertContrastOrderAllowed(
        blockedScreen,
        { reason: 'Radiologist approved low-osmolar switch', approvedBy: 'radiologist<script>' },
        null,
      )).toThrow(expect.objectContaining({
        statusCode: 403,
        code: 'RADIOLOGY_CONTRAST_OVERRIDE_ACTOR_REQUIRED',
      }));
    });
  });
});
