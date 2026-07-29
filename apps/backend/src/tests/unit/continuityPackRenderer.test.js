import {
  buildContinuityPackHtml,
  formatFacilityLocalTimestamp,
} from '../../services/downtime/continuityPackRenderer.js';

const GENERATED_AT = '2026-12-31T23:45:00.000Z';
const EXPIRES_AT = '2027-01-01T01:00:00.000Z';
const TRUSTED_NOW = '2027-01-01T00:00:00.000Z';

function field(value, recordedAt = GENERATED_AT, state = 'known') {
  return {
    state,
    value,
    recorded_at: recordedAt,
    timestamp_basis: recordedAt ? 'field' : 'not_available',
  };
}

function patient(overrides = {}) {
  return {
    identity: {
      name: field('Asha Nair'),
      mrn: field('MRN-1001'),
      uid: field('patient-uid-1'),
      dob: field('2014-06-10'),
    },
    allergies: field([{ allergen: 'Penicillin', severity: 'severe', reaction: 'rash' }]),
    code_status: field('full_code'),
    isolation: field({ required: false, status: 'none' }),
    location: field({
      ward_id: 'ward-1',
      ward_name: 'Ward A',
      bed_id: 'bed-12',
      bed_number: '12',
    }),
    attending: field('Dr Rao'),
    diagnosis: field('Pneumonia'),
    latest_vitals: field({
      systolic_bp: 110,
      diastolic_bp: 70,
      heart_rate: 88,
      respiratory_rate: 18,
      spo2: 98,
      temperature: 37.1,
    }),
    news2: field(1),
    medications_due: field([]),
    active_medication_orders: field([]),
    recently_administered_medications: field([]),
    unresolved_critical_results: field([]),
    recent_released_results: field([]),
    care_team: field([{ name: 'Nurse Devi', status: 'on duty' }]),
    ...overrides,
  };
}

function pack(overrides = {}) {
  return {
    scope: 'continuity_pack',
    tenant_id: 'tenant-1',
    facility: {
      id: 'facility-1',
      code: 'VH-CHN',
      name: 'VH Chennai',
      timezone: 'Asia/Kolkata',
    },
    location: {
      type: 'ward',
      id: 'ward-1',
      label: 'Ward A',
    },
    pack_schema_version: 1,
    policy_version: 1,
    manifest_version: 1,
    source_watermark: GENERATED_AT,
    generated_at: GENERATED_AT,
    fresh_until: '2027-01-01T00:15:00.000Z',
    expires_at: EXPIRES_AT,
    patients: [patient()],
    ...overrides,
  };
}

function render(value, now = TRUSTED_NOW, options = {}) {
  return buildContinuityPackHtml(value, { trustedNow: now, ...options });
}

function alertClasses(html, visibleText) {
  const alerts = [...html.matchAll(/<p class="([^"]+)" role="alert">([\s\S]*?)<\/p>/g)];
  const match = alerts.find((entry) => entry[2].includes(visibleText));
  if (!match) throw new Error(`Alert text not found: ${visibleText}`);
  return match[1];
}

function fieldCard(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(
    new RegExp(`<section class="field-card [^"]*">\\s*<h3>${escaped}<\\/h3>[\\s\\S]*?<\\/section>`),
  );
  if (!match) throw new Error(`Field card not found: ${label}`);
  return match[0];
}

describe('continuity pack timestamp formatting', () => {
  it('formats UTC input in facility-local time with date rollover and the IANA zone label', () => {
    const input = '2026-12-31T23:45:00.000Z';

    expect(formatFacilityLocalTimestamp(input, 'Asia/Kolkata'))
      .toBe('01 Jan 2027, 05:15 (Asia/Kolkata)');
    expect(input).toBe('2026-12-31T23:45:00.000Z');

    expect(formatFacilityLocalTimestamp('2026-03-08T06:30:00.000Z', 'America/New_York'))
      .toBe('08 Mar 2026, 01:30 (America/New_York)');
    expect(formatFacilityLocalTimestamp('2026-03-08T07:30:00.000Z', 'America/New_York'))
      .toBe('08 Mar 2026, 03:30 (America/New_York)');
  });

  it('throws for a missing or invalid facility IANA time zone', () => {
    expect(() => formatFacilityLocalTimestamp(GENERATED_AT)).toThrow(
      'Facility IANA time zone is required',
    );
    expect(() => formatFacilityLocalTimestamp(GENERATED_AT, 'Mars/Olympus_Mons')).toThrow(
      'Invalid facility IANA time zone',
    );
    expect(() => render(pack({ facility: { name: 'VH Chennai' } }))).toThrow(
      'Facility IANA time zone is required',
    );
  });

  it('renders date of birth as a civil date without facility-timezone shifting', () => {
    const dateOnlyHtml = render(pack({
      facility: {
        id: 'facility-1',
        code: 'VH-LAX',
        name: 'VH Los Angeles',
        timezone: 'America/Los_Angeles',
      },
      patients: [patient({
        identity: {
          name: field('Asha Nair'),
          mrn: field('MRN-1001'),
          uid: field('patient-uid-1'),
          dob: field('2014-06-10'),
        },
      })],
    }));
    const dateObjectHtml = render(pack({
      facility: {
        id: 'facility-1',
        code: 'VH-LAX',
        name: 'VH Los Angeles',
        timezone: 'America/Los_Angeles',
      },
      patients: [patient({
        identity: {
          name: field('Asha Nair'),
          mrn: field('MRN-1001'),
          uid: field('patient-uid-1'),
          dob: field(new Date('2014-06-10T00:00:00.000Z')),
        },
      })],
    }));

    for (const html of [dateOnlyHtml, dateObjectHtml]) {
      expect(fieldCard(html, 'Date of birth')).toContain(
        '<div class="field-value"><span>10 Jun 2014</span></div>',
      );
      expect(fieldCard(html, 'Date of birth')).not.toContain('09 Jun 2014');
    }
  });
});

describe('continuity pack safety rendering', () => {
  it('renders the exact generated and hard-validity instruction', () => {
    const html = render(pack());

    expect(html).toContain(
      'Generated 01 Jan 2027, 05:15 (Asia/Kolkata) — NOT VALID AFTER 01 Jan 2027, 06:30 (Asia/Kolkata), then use paper and phone.',
    );
  });

  it('uses exact unknown allergy and code-status wording with alert parity to positive findings', () => {
    const unknownHtml = render(pack({
      patients: [patient({
        allergies: field(null, null, 'unknown'),
        code_status: field(null, null, 'not_recorded'),
        isolation: field(null, null, 'not_recorded'),
      })],
    }));
    const positiveHtml = render(pack({
      patients: [patient({
        allergies: field([{ allergen: 'Latex' }]),
        code_status: field('do_not_resuscitate'),
        isolation: field({ required: true, precaution_type: 'contact', status: 'active' }),
      })],
    }));
    const emptyAllergyHtml = render(pack({
      patients: [patient({ allergies: field([]) })],
    }));

    expect(unknownHtml).toContain('Allergy status UNKNOWN — not recorded');
    expect(unknownHtml).toContain('Code status NOT RECORDED — confirm per hospital policy');
    expect(unknownHtml).toContain('Isolation status NOT RECORDED — confirm precautions');
    expect(emptyAllergyHtml).toContain('Allergy status UNKNOWN — not recorded');
    expect(emptyAllergyHtml).not.toContain('NKDA');
    expect(alertClasses(unknownHtml, 'Allergy status UNKNOWN — not recorded'))
      .toBe(alertClasses(positiveHtml, 'Latex'));
    expect(alertClasses(unknownHtml, 'Code status NOT RECORDED — confirm per hospital policy'))
      .toBe(alertClasses(positiveHtml, 'do_not_resuscitate'));
    expect(alertClasses(unknownHtml, 'Isolation status NOT RECORDED — confirm precautions'))
      .toBe(alertClasses(positiveHtml, 'Isolation required:'));
  });

  it('prints a facility-local recorded-at value or the literal unavailable state for every field', () => {
    const html = render(pack({
      patients: [patient({
        attending: field('Dr Rao', '2026-12-31T23:50:00.000Z'),
        diagnosis: {
          ...field('Pneumonia', '2026-12-31T23:50:00.000Z'),
          timestamp_basis: 'not_available',
        },
      })],
    }));

    expect(html).toMatch(
      /<h3>Attending<\/h3>[\s\S]*?Recorded at 01 Jan 2027, 05:20 \(Asia\/Kolkata\)/,
    );
    expect(html).toMatch(
      /<h3>Diagnosis \/ reason for care<\/h3>[\s\S]*?Recorded at unavailable/,
    );
  });

  it('adds pack and field age badges only after the 15-minute boundary', () => {
    const boundaryPack = pack({
      generated_at: '2027-01-01T00:00:00.000Z',
      expires_at: '2027-01-01T01:00:00.000Z',
      patients: [{
        attending: field('Dr Rao', '2027-01-01T00:00:00.000Z'),
      }],
    });

    const atBoundary = render(boundaryPack, '2027-01-01T00:15:00.000Z');
    const afterBoundary = render(boundaryPack, '2027-01-01T00:15:00.001Z');
    const independentlyAgedField = render(pack({
      generated_at: '2027-01-01T00:05:00.000Z',
      expires_at: '2027-01-01T01:00:00.000Z',
      patients: [{
        attending: field('Dr Rao', '2026-12-31T23:55:00.000Z'),
      }],
    }), '2027-01-01T00:15:00.000Z');

    expect(atBoundary).not.toContain('PACK AGE');
    expect(atBoundary).not.toContain('FIELD AGE');
    expect(afterBoundary).toContain('PACK AGE 15m');
    expect(afterBoundary).toContain('FIELD AGE 15m');
    expect(independentlyAgedField).not.toContain('PACK AGE');
    expect(independentlyAgedField).toContain('FIELD AGE 20m');
  });

  it('shows independent recorded-at truth and age for every safety-critical floor field', () => {
    const html = render(pack({
      generated_at: '2027-01-01T00:05:00.000Z',
      expires_at: '2027-01-01T01:00:00.000Z',
      patients: [{
        identity: {
          name: field('Asha Nair', '2026-12-31T23:50:00.000Z'),
          mrn: field('MRN-1001', '2027-01-01T00:10:00.000Z'),
          uid: {
            ...field('patient-uid-1', '2027-01-01T00:10:00.000Z'),
            timestamp_basis: 'not_available',
          },
          dob: field('2014-06-10T00:00:00.000Z', '2026-12-31T23:55:00.000Z'),
        },
        allergies: field([{ allergen: 'Penicillin' }], '2026-12-31T23:50:00.000Z'),
        code_status: field('full_code', '2027-01-01T00:10:00.000Z'),
        isolation: {
          ...field({ required: false, status: 'none' }, '2027-01-01T00:10:00.000Z'),
          timestamp_basis: 'not_available',
        },
        medications_due: field(
          [{ medication_name: 'Ceftriaxone' }],
          '2026-12-31T23:45:00.000Z',
        ),
        active_medication_orders: field(
          [{ medication_name: 'Azithromycin' }],
          '2027-01-01T00:10:00.000Z',
        ),
        recently_administered_medications: field(
          [{ medication_name: 'Paracetamol', administered_at: '2026-12-31T23:35:00.000Z' }],
          '2026-12-31T23:40:00.000Z',
        ),
        unresolved_critical_results: field(
          [{ item_name: 'Serum potassium', value_snapshot: '6.5 mmol/L' }],
          '2026-12-31T23:35:00.000Z',
        ),
      }],
    }), '2027-01-01T00:15:00.000Z');

    expect(html).not.toContain('PACK AGE');
    for (const label of [
      'Name',
      'Date of birth',
      'Allergies',
      'Medications due',
      'Recently administered medications (last 12 hours)',
      'Unresolved critical results',
    ]) {
      expect(fieldCard(html, label)).toContain('FIELD AGE');
    }
    for (const label of ['MRN', 'Code status', 'Active medication orders']) {
      const card = fieldCard(html, label);
      expect(card).toContain('Recorded at ');
      expect(card).not.toContain('FIELD AGE');
    }
    expect(fieldCard(html, 'UID')).toContain('Recorded at unavailable');
    expect(fieldCard(html, 'Isolation precautions')).toContain('Recorded at unavailable');
  });

  it('consumes canonical CURRENT/AGED freshness without consulting an ambient clock', () => {
    expect(() => buildContinuityPackHtml(pack())).toThrow(
      'A trusted current time or canonical freshness age is required',
    );

    const currentHtml = buildContinuityPackHtml(pack(), {
      state: 'CURRENT',
      ageMs: 15 * 60 * 1000,
      packAccess: { display: true, print: true },
    });
    const agedHtml = buildContinuityPackHtml(pack(), {
      freshness: {
        state: 'AGED',
        ageMs: 16 * 60 * 1000,
        packAccess: { display: true, print: true },
        fallback: { paper: true, phone: true },
      },
    });
    const deniedHtml = buildContinuityPackHtml(pack(), {
      freshness: {
        state: 'CURRENT',
        ageMs: 10 * 60 * 1000,
        packAccess: { display: true, print: false },
      },
    });

    expect(currentHtml).not.toContain('PACK AGE');
    expect(currentHtml).toContain('Asha Nair');
    expect(agedHtml).toContain('PACK AGE 16m');
    expect(agedHtml).toContain('Asha Nair');
    expect(deniedHtml).toContain('PACK VERIFICATION FAILED');
    expect(deniedHtml).not.toContain('Asha Nair');
    expect(deniedHtml).not.toContain('class="patient"');
  });

  it.each([
    [
      '24-hour hard expiry',
      {
        generated_at: '2026-12-31T00:00:00.000Z',
        expires_at: '2027-01-01T00:00:00.000Z',
      },
      {},
      'PACK EXPIRED — this continuity pack cannot be displayed.',
    ],
    [
      'uncertain clock',
      { freshness: { state: 'CLOCK_UNCERTAIN' } },
      {},
      'CLOCK UNCERTAIN — this continuity pack cannot be displayed.',
    ],
    [
      'canonical EXPIRED state',
      {
        freshness: {
          state: 'EXPIRED',
          ageMs: 24 * 60 * 60 * 1000,
          packAccess: { display: false, print: false },
        },
      },
      {},
      'PACK EXPIRED — this continuity pack cannot be displayed.',
    ],
    [
      'missing hard expiry metadata',
      { expires_at: null, not_valid_after: null },
      {},
      'PACK VERIFICATION FAILED — this continuity pack cannot be displayed.',
    ],
  ])(
    'returns a refusal-only paper/phone page for %s and hides PHI',
    (_label, packOverrides, options, expectedReason) => {
      const sensitivePack = pack({
        ...packOverrides,
        facility: {
          name: 'Sensitive Hospital',
          timezone: 'Asia/Kolkata',
        },
        patients: [patient({
          identity: {
            name: field('TOP SECRET PATIENT'),
            mrn: field('SECRET-MRN'),
            uid: field('SECRET-UID'),
            dob: field('2000-01-01T00:00:00.000Z'),
          },
          allergies: field([{ allergen: 'SECRET ALLERGEN' }]),
        })],
      });

      const html = render(sensitivePack, TRUSTED_NOW, options);

      expect(html).toContain('CONTINUITY PACK REFUSED');
      expect(html).toContain(expectedReason);
      expect(html).toContain('Use paper and phone.');
      expect(html).not.toContain('TOP SECRET PATIENT');
      expect(html).not.toContain('SECRET-MRN');
      expect(html).not.toContain('SECRET-UID');
      expect(html).not.toContain('SECRET ALLERGEN');
      expect(html).not.toContain('Sensitive Hospital');
      expect(html).not.toContain('WARD CONTINUITY PACK');
      expect(html).not.toContain('class="patient"');
      expect(html).not.toContain('class="field-card');
    },
  );
});

describe('continuity pack area sections', () => {
  it('renders ward and paediatric safety details, including structured isolation and latest weight', () => {
    const wardHtml = render(pack({
      patients: [patient({
        medications_due: field([{
          medication_name: 'Ceftriaxone',
          dose: '1 g',
          route: 'IV',
          status: 'due',
          scheduled_time: '2027-01-01T00:20:00.000Z',
        }]),
        active_medication_orders: field([{
          medication_name: 'Azithromycin',
          dose: '500 mg',
          route: 'oral',
          status: 'active',
        }]),
        recently_administered_medications: field([{
          medication_name: 'Amoxicillin',
          dose: '250 mg',
          route: 'oral',
          status: 'administered',
          administered_at: '2026-12-31T23:40:00.000Z',
        }]),
        unresolved_critical_results: field([{
          item_name: 'Serum potassium',
          value_snapshot: '6.5 mmol/L',
          severity: 'critical',
        }]),
        recent_released_results: field([{
          item_name: 'Chest X-ray',
          value_snapshot: {
            value: 'Right basal opacity',
            status: 'released',
          },
          status: 'released',
        }]),
        care_team: field([{
          member_name: 'Nurse Devi',
          role: 'nurse',
          relationship: 'primary',
        }]),
      })],
    }));
    const paedsHtml = render(pack({
      location: {
        type: 'ward',
        area_profile: 'paediatric',
        id: 'paeds-1',
        label: 'Paediatric Ward',
      },
      patients: [patient({
        isolation: field({
          required: true,
          precaution_type: 'contact',
          status: 'active',
          reason: 'UNSTRUCTURED-REASON-SENTINEL',
          notes: 'UNSTRUCTURED-NOTES-SENTINEL',
        }),
        latest_weight: field({ weight_kg: 18.4, unit: 'kg' }, '2026-12-31T23:55:00.000Z'),
      })],
    }));

    expect(wardHtml).toContain('WARD CONTINUITY PACK');
    expect(wardHtml).toContain('Asha Nair');
    expect(wardHtml).toContain('MRN-1001');
    expect(wardHtml).toContain('patient-uid-1');
    expect(fieldCard(wardHtml, 'Date of birth')).toContain(
      '<div class="field-value"><span>10 Jun 2014</span></div>',
    );
    expect(wardHtml).toContain('Penicillin');
    expect(wardHtml).toContain('Code status: full_code');
    expect(wardHtml).toContain('<h3>Location</h3>');
    expect(fieldCard(wardHtml, 'Location')).toContain(
      '<span>Ward: Ward A · Bed: 12</span>',
    );
    expect(wardHtml).toContain('Dr Rao');
    expect(wardHtml).toContain('Pneumonia');
    expect(wardHtml).toContain('<h3>Latest vitals</h3>');
    expect(wardHtml).toContain('SpO₂ 98');
    expect(wardHtml).toContain('<h3>NEWS2</h3>');
    expect(wardHtml).toContain('<h3>Medications due</h3>');
    expect(wardHtml).toContain('Ceftriaxone');
    expect(wardHtml).toContain('<h3>Active medication orders</h3>');
    expect(wardHtml).toContain('Azithromycin');
    expect(wardHtml).toContain('<h3>Recently administered medications (last 12 hours)</h3>');
    expect(wardHtml).toContain('Amoxicillin');
    expect(wardHtml).toContain('Administered: 01 Jan 2027, 05:10 (Asia/Kolkata)');
    expect(wardHtml).toContain('Serum potassium');
    expect(wardHtml).toContain('6.5 mmol/L');
    expect(wardHtml).toContain('Chest X-ray');
    expect(wardHtml).toContain('Right basal opacity');
    expect(wardHtml).not.toContain('[object Object]');
    expect(wardHtml).toContain('Nurse Devi');
    expect(wardHtml).toContain('primary');
    expect(paedsHtml).toContain('PAEDS CONTINUITY PACK');
    expect(paedsHtml).toContain('<h3>Latest weight</h3>');
    expect(paedsHtml).toContain('18.4 kg');
    expect(paedsHtml).toMatch(
      /<h3>Latest weight<\/h3>[\s\S]*?Recorded at 01 Jan 2027, 05:25 \(Asia\/Kolkata\)/,
    );
    expect(paedsHtml).toContain('Isolation required:');
    expect(paedsHtml).toContain('contact');
    expect(paedsHtml).toContain('Status:');
    expect(paedsHtml).toContain('active');
    expect(paedsHtml).not.toContain('UNSTRUCTURED-REASON-SENTINEL');
    expect(paedsHtml).not.toContain('UNSTRUCTURED-NOTES-SENTINEL');
  });

  it('renders ED arrival, triage, and time in department', () => {
    const html = render(pack({
      location: { type: 'ed_board', id: 'ed-1', label: 'ED Board' },
      patients: [patient({
        location: field({
          board: 'ED-MAIN',
          visit_number: 'ED-2027-0007',
          status: 'triaged',
        }),
        arrival_at: field('2026-12-31T23:30:00.000Z'),
        triage_priority: field('ESI 2'),
        triage_assessment: field('High risk'),
        time_in_department: field({ minutes: 45 }),
      })],
    }));

    expect(html).toContain('ED CONTINUITY PACK');
    expect(fieldCard(html, 'Location')).toContain(
      '<span>ED board: ED-MAIN · Visit: ED-2027-0007 · Status: triaged</span>',
    );
    expect(html).toContain('<h3>ED arrival</h3>');
    expect(html).toContain('01 Jan 2027, 05:00 (Asia/Kolkata)');
    expect(html).toContain('<h3>Triage</h3>');
    expect(html).toContain('ESI 2');
    expect(html).toContain('High risk');
    expect(html).toContain('<h3>Time in department (TID)</h3>');
    expect(html).toContain('45 minutes');
    expect(html).toContain('Penicillin');
    expect(html).toContain('<h3>Code status</h3>');
  });

  it('renders the OPD phone field and the exact clinic-day destruction line', () => {
    const html = render(pack({
      location: { type: 'opd_day', id: 'opd-1', label: 'Clinic 3' },
      patients: [patient({
        location: field({
          clinic_day: '2027-01-01',
          queue_id: 'queue-3',
          queue_label: 'General Medicine',
          department_name: 'Medicine',
          appointment_id: 'appointment-42',
        }),
        appointment_time: field('2027-01-01T00:10:00.000Z'),
        appointment_status: field('checked in'),
        phone: field('+91 98765 43210'),
        active_medication_orders: field([{
          medication_name: 'Metformin',
          dose: '500 mg',
          status: 'active',
        }]),
      })],
    }));

    expect(html).toContain('OPD CONTINUITY PACK');
    expect(fieldCard(html, 'Location')).toContain(
      '<span>Department: Medicine · Queue: General Medicine · Appointment: appointment-42 · Clinic day: 2027-01-01</span>',
    );
    expect(html).toContain('<h3>Phone</h3>');
    expect(html).toContain('+91 98765 43210');
    expect(html).toContain('<h3>Appointment time</h3>');
    expect(html).toContain('01 Jan 2027, 05:40 (Asia/Kolkata)');
    expect(html).toContain('<h3>Appointment status</h3>');
    expect(html).toContain('checked in');
    expect(html).toContain('Penicillin');
    expect(html).toContain('<h3>Active medication orders</h3>');
    expect(html).toContain('Metformin');
    expect(html).toContain('Destroy after clinic day');
  });
});

describe('continuity pack output hardening', () => {
  it('escapes all normalized content and emits no scripts or external assets', () => {
    const html = render(pack({
      facility: {
        name: '<script>alert("facility")</script>',
        timezone: 'Asia/Kolkata',
      },
      location: {
        type: 'ward',
        label: '<img src=x onerror=alert(1)>',
      },
      patients: [patient({
        identity: {
          name: field('<img src=x onerror=alert(2)>'),
          mrn: field('MRN<&>'),
          uid: field('UID"quoted'),
          dob: field('2014-06-10T00:00:00.000Z'),
        },
        allergies: field([{ allergen: '<b>Latex</b>', reaction: '"rash"' }]),
        location: field({
          ward_name: '<img src=x onerror=alert(3)>',
          bed_number: '12<&>',
          notes: 'UNSTRUCTURED-LOCATION-NOTES-SENTINEL',
        }),
        attending: field("Dr O'Neil"),
      })],
    }));

    expect(html).toContain('&lt;script&gt;alert(&quot;facility&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain(
      'Ward: &lt;img src=x onerror=alert(3)&gt; · Bed: 12&lt;&amp;&gt;',
    );
    expect(html).toContain('&lt;b&gt;Latex&lt;/b&gt;');
    expect(html).toContain('Dr O&#39;Neil');
    expect(html).not.toContain('UNSTRUCTURED-LOCATION-NOTES-SENTINEL');
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<(?:img|link|iframe|object|embed|audio|video|source|svg)\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\s*\(/i);
  });

  it('never renders a blood-group property or its value', () => {
    const html = render(pack({
      blood_group: 'TOP-LEVEL-BLOOD-SENTINEL',
      patients: [patient({
        blood_group: 'PATIENT-BLOOD-SENTINEL',
        bloodGroup: 'PATIENT-CAMEL-BLOOD-SENTINEL',
        identity: {
          name: field('Asha Nair'),
          mrn: field('MRN-1001'),
          uid: field('patient-uid-1'),
          dob: field('2014-06-10T00:00:00.000Z'),
          blood_group: field('IDENTITY-BLOOD-SENTINEL'),
          bloodGroup: field('IDENTITY-CAMEL-BLOOD-SENTINEL'),
        },
      })],
    }));

    expect(html).not.toMatch(/blood(?:_|-|\s)*group|bloodGroup/i);
    expect(html).not.toContain('TOP-LEVEL-BLOOD-SENTINEL');
    expect(html).not.toContain('PATIENT-BLOOD-SENTINEL');
    expect(html).not.toContain('PATIENT-CAMEL-BLOOD-SENTINEL');
    expect(html).not.toContain('IDENTITY-BLOOD-SENTINEL');
    expect(html).not.toContain('IDENTITY-CAMEL-BLOOD-SENTINEL');
  });
});
