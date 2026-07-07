// src/tests/unit/deathCertification.test.js — Sprint 21

import { _internal } from '../../services/clinical/deathCertificationService.js';

const {
  STATUS_TRANSITIONS,
  validateForCertification,
  VALID_PLACES,
  VALID_MANNERS,
  SLOT_STATUSES,
  CUSTODY_EVENT_TYPES,
  RELEASE_METHODS,
  validateCustodyEventInput,
} = _internal;

describe('Death certification status walk', () => {
  it('pending → certified or cancelled', () => {
    expect(STATUS_TRANSITIONS.pending).toEqual(
      expect.arrayContaining(['certified', 'cancelled']),
    );
  });

  it('certified → submitted_to_registrar (no skip back)', () => {
    expect(STATUS_TRANSITIONS.certified).toEqual(['submitted_to_registrar']);
  });

  it('submitted → registered (no other path)', () => {
    expect(STATUS_TRANSITIONS.submitted_to_registrar).toEqual(['registered']);
  });

  it('registered + cancelled are terminal', () => {
    expect(STATUS_TRANSITIONS.registered).toEqual([]);
    expect(STATUS_TRANSITIONS.cancelled).toEqual([]);
  });

  it('cannot go back from certified to pending', () => {
    expect(STATUS_TRANSITIONS.certified).not.toContain('pending');
  });

  it('cannot cancel after registrar submission', () => {
    expect(STATUS_TRANSITIONS.submitted_to_registrar).not.toContain('cancelled');
    expect(STATUS_TRANSITIONS.registered).not.toContain('cancelled');
  });
});

describe('MCCD validation before certification', () => {
  it('passes a clean natural death', () => {
    expect(validateForCertification({
      cause_part_1a: 'Acute myocardial infarction',
      manner_of_death: 'natural',
    })).toEqual([]);
  });

  it('rejects missing immediate cause', () => {
    expect(validateForCertification({
      cause_part_1a: '',
      manner_of_death: 'natural',
    })).toContain('Part Ia (immediate cause) required');
  });

  it('rejects whitespace-only immediate cause', () => {
    expect(validateForCertification({
      cause_part_1a: '   ',
      manner_of_death: 'natural',
    })).toContain('Part Ia (immediate cause) required');
  });

  it('rejects medicolegal without police station', () => {
    const errs = validateForCertification({
      cause_part_1a: 'Multi-organ failure',
      manner_of_death: 'accident',
      is_medicolegal: true,
    });
    expect(errs).toContain('police_station required when medicolegal');
    expect(errs).toContain('police_fir_no required when medicolegal');
  });

  it('passes medicolegal with police info', () => {
    expect(validateForCertification({
      cause_part_1a: 'Head injury',
      manner_of_death: 'accident',
      is_medicolegal: true,
      police_station: 'Velachery PS',
      police_fir_no: 'FIR/2026/2345',
    })).toEqual([]);
  });

  it('rejects pregnancy-related without stage', () => {
    expect(validateForCertification({
      cause_part_1a: 'PPH',
      manner_of_death: 'natural',
      was_pregnancy_related: true,
    })).toContain('pregnancy_stage required when was_pregnancy_related');
  });

  it('passes pregnancy-related with stage', () => {
    expect(validateForCertification({
      cause_part_1a: 'PPH',
      manner_of_death: 'natural',
      was_pregnancy_related: true,
      pregnancy_stage: 'postpartum_42d',
    })).toEqual([]);
  });
});

describe('place + manner allowlists', () => {
  it('place includes all standard hospital surfaces', () => {
    expect(VALID_PLACES).toEqual(expect.arrayContaining([
      'inpatient', 'emergency', 'icu', 'or', 'home_brought_dead',
    ]));
  });

  it('manner covers WHO-required categories', () => {
    expect(VALID_MANNERS).toEqual(expect.arrayContaining([
      'natural', 'accident', 'suicide', 'homicide', 'pending', 'undetermined',
    ]));
  });
});

describe('Mortuary custody chain validation', () => {
  it('keeps slot statuses operational and finite', () => {
    expect(SLOT_STATUSES).toEqual(expect.arrayContaining([
      'available', 'occupied', 'cleaning', 'maintenance', 'retired',
    ]));
  });

  it('keeps custody event types to receive/store/release', () => {
    expect(CUSTODY_EVENT_TYPES).toEqual(['receive', 'store', 'release']);
  });

  it('requires a slot for store events', () => {
    expect(validateCustodyEventInput('store', {})).toContain('slot_id required for store events');
    expect(validateCustodyEventInput('store', { slot_id: 1 })).toEqual([]);
  });

  it('requires release handover fields for family release events', () => {
    const errs = validateCustodyEventInput('release', { release_method: 'family' });
    expect(errs).toEqual(expect.arrayContaining([
      'body_released_to_name required for release events',
      'body_released_to_relation required for release events',
    ]));
  });

  it('accepts only the release methods used by death_records', () => {
    expect(RELEASE_METHODS).toEqual(expect.arrayContaining([
      'family', 'mortuary_van', 'unclaimed_to_municipality',
    ]));
    expect(validateCustodyEventInput('release', {
      body_released_to_name: 'Relative',
      body_released_to_relation: 'son',
      release_method: 'courier',
    })).toContain('release_method must be one of: family, mortuary_van, unclaimed_to_municipality');
  });
});
