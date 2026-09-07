import {
  HCV_RNA_NOT_DETECTED_REPRESENTATION,
  evaluateReuseEligibility,
  validateProtocol,
} from '../../services/clinical/reprocessableDeviceRules.js';

const baseProtocol = {
  domain: 'dialysis',
  category: 'dialyser',
  basis: 'manufacturer_ifu',
  reference: 'IFU-2026-09',
  status: 'active',
  tcv_min_pct: 80,
  baseline_tcv_required: true,
  residual_test_required: true,
  integrity_test_required: true,
  agents: [{
    agent: 'peracetic_acid',
    min_concentration_pct: 0.2,
    max_concentration_pct: 0.4,
    min_contact_minutes: 11,
  }],
  reuse_matrix: {
    hbsag: 'no_reuse', hcv: 'no_reuse', hiv: 'no_reuse', isolation_mixed: 'no_reuse',
  },
  surveillance_intervals_days: { hbsag: 90, hcv: 90, hiv: 365 },
  surveillance_overdue_blocks_reuse: true,
  prion_rule: 'discard',
};

describe('dialyser reuse matrix scope and HCV question', () => {
  test('pins locked cells and rejects applying the dialyser matrix to OT', () => {
    expect(validateProtocol(baseProtocol).reuse_matrix).toEqual(baseProtocol.reuse_matrix);
    const lockedCells = ['hbsag', 'hiv', 'isolation_mixed'];
    expect(lockedCells).toHaveLength(3);
    for (const markerClass of lockedCells) {
      expect(() => validateProtocol({
        ...baseProtocol,
        reuse_matrix: { ...baseProtocol.reuse_matrix, [markerClass]: 'dedicated_reuse' },
      })).toThrow(expect.objectContaining({ code: 'RPD_PROTOCOL_REUSE_MATRIX_INVALID' }));
    }
    expect(() => validateProtocol({
      ...baseProtocol, domain: 'ot', category: 'instrument_set', reuse_matrix: baseProtocol.reuse_matrix,
    })).toThrow(expect.objectContaining({ code: 'RPD_PROTOCOL_REUSE_MATRIX_INVALID' }));
  });

  test('defines dedicated reuse as the same physical dialyser for the same patient only', () => {
    const protocol = validateProtocol({
      ...baseProtocol,
      reuse_matrix: { ...baseProtocol.reuse_matrix, hcv: 'dedicated_reuse' },
      hcv_protocol: {
        separated_processing_arrangements: 'Unit HCV reprocessing room',
        rna_evidence_rule: 'independently_recorded',
        infection_treatment_history_rule: 'documented_separately',
      },
    });
    const input = {
      protocol,
      decision: {
        status: 'restricted', isolation_class: 'hcv', evidence_dated_on: '2026-09-07', markers: [],
      },
      device: { domain: 'dialysis', category: 'dialyser', id: 7, cycle_count: 1, max_cycles_snapshot: 4 },
      patientUid: '00000000-0000-4000-8000-00000000000a',
      dedicatedPatientUid: '00000000-0000-4000-8000-00000000000a',
      activeHolds: [],
      asOf: '2026-09-07T12:00:00.000Z',
      hcvEvidence: { rna_result: 'not_detected', recorded_independently: true },
    };
    expect(evaluateReuseEligibility(input)).toMatchObject({ verdict: 'eligible' });
    expect(evaluateReuseEligibility({
      ...input, dedicatedPatientUid: '00000000-0000-4000-8000-00000000000b',
    })).toMatchObject({ verdict: 'ineligible', reason_codes: ['RPD_DIALYSER_DEDICATION_MISMATCH'] });
  });

  test('never describes antibody reactivity as current viraemia and keeps RNA-negative safeguards independent', () => {
    expect(HCV_RNA_NOT_DETECTED_REPRESENTATION)
      .toBe('No evidence of current HCV infection on the available RNA evidence');
    expect(HCV_RNA_NOT_DETECTED_REPRESENTATION.toLowerCase()).not.toContain('antibody negative');
    expect(HCV_RNA_NOT_DETECTED_REPRESENTATION.toLowerCase()).not.toContain('resolved infection');

    const locked = evaluateReuseEligibility({
      protocol: baseProtocol,
      decision: {
        status: 'restricted', isolation_class: 'hcv', evidence_dated_on: '2026-09-07', markers: [],
      },
      device: { domain: 'dialysis', category: 'dialyser', id: 7, cycle_count: 1, max_cycles_snapshot: 4 },
      patientUid: '00000000-0000-4000-8000-00000000000a',
      dedicatedPatientUid: '00000000-0000-4000-8000-00000000000a',
      activeHolds: [],
      asOf: '2026-09-07T12:00:00.000Z',
      hcvEvidence: { rna_result: 'not_detected', recorded_independently: true },
    });
    expect(locked).toMatchObject({ verdict: 'ineligible', reason_codes: ['RPD_REUSE_MATRIX_NO_REUSE'] });

    const held = evaluateReuseEligibility({
      protocol: validateProtocol({
        ...baseProtocol,
        reuse_matrix: { ...baseProtocol.reuse_matrix, hcv: 'dedicated_reuse' },
        hcv_protocol: {
          separated_processing_arrangements: 'Unit HCV reprocessing room',
          rna_evidence_rule: 'independently_recorded',
          infection_treatment_history_rule: 'documented_separately',
        },
      }),
      decision: {
        status: 'restricted', isolation_class: 'hcv', evidence_dated_on: '2026-09-07', markers: [],
      },
      device: { domain: 'dialysis', category: 'dialyser', id: 7, cycle_count: 1, max_cycles_snapshot: 4 },
      patientUid: '00000000-0000-4000-8000-00000000000a',
      dedicatedPatientUid: '00000000-0000-4000-8000-00000000000a',
      activeHolds: [{ id: 9, status: 'active' }],
      asOf: '2026-09-07T12:00:00.000Z',
      hcvEvidence: { rna_result: 'not_detected', recorded_independently: true },
    });
    expect(held).toMatchObject({ verdict: 'ineligible', reason_codes: ['RPD_ACTIVE_HOLD'] });
  });
});
