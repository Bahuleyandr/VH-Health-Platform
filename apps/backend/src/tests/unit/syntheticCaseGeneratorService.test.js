import {
  hashSeed,
  createPrng,
  generatePersona,
  generateVitals,
  generateLabs,
  generateTimeline,
  detectEdgeFlags,
  buildCaseLabel,
  buildSyntheticNarrative,
  generateSyntheticCase,
} from '../../services/ai/syntheticCaseGeneratorService.js';

describe('synthetic case generator helpers', () => {
  describe('hashSeed', () => {
    it('is deterministic for the same seed', () => {
      expect(hashSeed('abc')).toBe(hashSeed('abc'));
    });

    it('produces different integers for different seeds', () => {
      expect(hashSeed('abc')).not.toBe(hashSeed('xyz'));
    });
  });

  describe('createPrng', () => {
    it('two instances with the same seed produce the same first three nextInt outputs', () => {
      const a = createPrng('seed-1');
      const b = createPrng('seed-1');
      const aOut = [a.nextInt(0, 100), a.nextInt(0, 100), a.nextInt(0, 100)];
      const bOut = [b.nextInt(0, 100), b.nextInt(0, 100), b.nextInt(0, 100)];
      expect(aOut).toEqual(bOut);
    });
  });

  describe('generatePersona', () => {
    it('pediatric_fever pathway produces age between 1 and 12', () => {
      const persona = generatePersona({
        prng: createPrng('p1'),
        complexity: 'standard',
        pathway: 'pediatric_fever',
      });
      expect(persona.age_years).toBeGreaterThanOrEqual(1);
      expect(persona.age_years).toBeLessThanOrEqual(12);
    });

    it('geriatric_fall pathway produces age between 70 and 95', () => {
      const persona = generatePersona({
        prng: createPrng('p2'),
        complexity: 'standard',
        pathway: 'geriatric_fall',
      });
      expect(persona.age_years).toBeGreaterThanOrEqual(70);
      expect(persona.age_years).toBeLessThanOrEqual(95);
    });

    it('complex complexity produces at least 2 comorbidities', () => {
      const persona = generatePersona({
        prng: createPrng('p3'),
        complexity: 'complex',
        pathway: 'sepsis',
      });
      expect(persona.comorbidity_codes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('generateVitals', () => {
    it('simple complexity produces 2 snapshots', () => {
      const persona = generatePersona({ prng: createPrng('v1'), complexity: 'simple', pathway: 'sepsis' });
      const vitals = generateVitals({ prng: createPrng('v1'), pathway: 'sepsis', complexity: 'simple', persona });
      expect(vitals).toHaveLength(2);
    });

    it('standard complexity produces 4 snapshots', () => {
      const persona = generatePersona({ prng: createPrng('v2'), complexity: 'standard', pathway: 'sepsis' });
      const vitals = generateVitals({ prng: createPrng('v2'), pathway: 'sepsis', complexity: 'standard', persona });
      expect(vitals).toHaveLength(4);
    });

    it('complex complexity produces 6 snapshots', () => {
      const persona = generatePersona({ prng: createPrng('v3'), complexity: 'complex', pathway: 'sepsis' });
      const vitals = generateVitals({ prng: createPrng('v3'), pathway: 'sepsis', complexity: 'complex', persona });
      expect(vitals).toHaveLength(6);
    });

    it('edge complexity produces 8 snapshots', () => {
      const persona = generatePersona({ prng: createPrng('v4'), complexity: 'edge', pathway: 'sepsis' });
      const vitals = generateVitals({ prng: createPrng('v4'), pathway: 'sepsis', complexity: 'edge', persona });
      expect(vitals).toHaveLength(8);
    });

    it('sepsis pathway has at least one snapshot with sbp < 100 or hr > 100', () => {
      const persona = generatePersona({ prng: createPrng('v5'), complexity: 'standard', pathway: 'sepsis' });
      const vitals = generateVitals({ prng: createPrng('v5'), pathway: 'sepsis', complexity: 'standard', persona });
      const hasIndicator = vitals.some((v) => v.sbp < 100 || v.hr > 100);
      expect(hasIndicator).toBe(true);
    });
  });

  describe('generateLabs', () => {
    it('chest_pain_acs pathway includes a troponin lab', () => {
      const persona = generatePersona({ prng: createPrng('l1'), complexity: 'standard', pathway: 'chest_pain_acs' });
      const labs = generateLabs({ prng: createPrng('l1'), pathway: 'chest_pain_acs', persona, complexity: 'standard' });
      expect(labs.some((l) => /troponin/i.test(l.name))).toBe(true);
    });

    it('sepsis pathway includes a lactate lab', () => {
      const persona = generatePersona({ prng: createPrng('l2'), complexity: 'standard', pathway: 'sepsis' });
      const labs = generateLabs({ prng: createPrng('l2'), pathway: 'sepsis', persona, complexity: 'standard' });
      expect(labs.some((l) => /lactate/i.test(l.name))).toBe(true);
    });
  });

  describe('generateTimeline', () => {
    it('standard complexity begins with arrival at t=0', () => {
      const timeline = generateTimeline({ prng: createPrng('t1'), pathway: 'sepsis', complexity: 'standard' });
      expect(timeline[0].t_offset_minutes).toBe(0);
      expect(timeline[0].event_type).toBe('arrival');
    });

    it('edge complexity contains at least one escalation event', () => {
      const timeline = generateTimeline({ prng: createPrng('t2'), pathway: 'sepsis', complexity: 'edge' });
      expect(timeline.some((e) => e.event_type === 'escalation')).toBe(true);
    });
  });

  describe('detectEdgeFlags', () => {
    it('flags EXTREME_AGE for age 100', () => {
      const flags = detectEdgeFlags({
        persona: { age_years: 100, comorbidity_codes: [], allergies: [] },
        vitals: [],
        labs: [],
      });
      expect(flags.some((f) => f.code === 'EXTREME_AGE')).toBe(true);
    });

    it('flags CRITICAL_VITAL for low spo2 snapshot', () => {
      const flags = detectEdgeFlags({
        persona: { age_years: 40 },
        vitals: [{ spo2: 80 }],
        labs: [],
      });
      expect(flags.some((f) => f.code === 'CRITICAL_VITAL')).toBe(true);
    });
  });

  describe('buildCaseLabel', () => {
    it('returns a label prefixed with synthetic-', () => {
      const label = buildCaseLabel({ pathway: 'sepsis', complexity: 'edge', seed: 'x' });
      expect(label.startsWith('synthetic-')).toBe(true);
    });
  });

  describe('buildSyntheticNarrative', () => {
    it('returns a string prefixed with [synthetic]', () => {
      const narrative = buildSyntheticNarrative({
        persona: { age_years: 40, gender: 'female', ethnicity_code: 'south_asian', comorbidity_codes: [] },
        pathway: 'sepsis',
        complexity: 'standard',
        vitals: [],
        labs: [],
        timeline: [],
      });
      expect(narrative.startsWith('[synthetic]')).toBe(true);
    });
  });

  describe('generateSyntheticCase', () => {
    it('is deterministic for the same pathway+complexity+seed', () => {
      const a = generateSyntheticCase({ pathway: 'sepsis', complexity: 'standard', seed: 's1' });
      const b = generateSyntheticCase({ pathway: 'sepsis', complexity: 'standard', seed: 's1' });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });
});
