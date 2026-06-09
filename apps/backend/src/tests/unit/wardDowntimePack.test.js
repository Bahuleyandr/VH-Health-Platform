/**
 * Unit tests for the ward downtime pack renderer (roadmap A3).
 * The renderer must be a pure, dependency-free function producing a fully
 * self-contained printable HTML document — it is the artifact a ward runs
 * on during an outage, so correctness of the safety-critical lines
 * (allergies, code status, MAR due) is pinned here.
 */

import { buildWardPackHtml } from '../../services/downtime/wardDowntimePackService.js';

const basePack = {
  ward_name: 'ICU-1',
  generated_at: '2026-06-10T05:00:00.000Z',
  beds: [
    {
      bed_number: 'ICU-1-03',
      patient_uid: 'aaaa1111-2222-4333-8444-555566667777',
      patient_name: 'Test Patient',
      age: 64,
      gender: 'male',
      code_status: 'dnr',
      attending_name: 'Dr Attending',
      admitting_diagnosis: 'Septic shock',
      allergies: [
        { allergen: 'Penicillin', severity: 'SEVERE', sources: ['patient_allergies'] },
        { allergen: 'Latex', severity: null, sources: ['users.allergies'] },
      ],
      mar_due: [
        { scheduled_time: '2026-06-10T06:00:00Z', medication_name: 'Meropenem', dose: '1g', route: 'IV', status: 'scheduled' },
      ],
      active_orders: [
        { order_type: 'investigation', summary: 'Blood culture x2', priority: 'urgent', status: 'ordered' },
      ],
      latest_vitals: {
        bp: '90/60', heart_rate: 118, respiratory_rate: 26, spo2: 91,
        temperature: 38.9, news2: 9, recorded_at: '2026-06-10T04:45:00Z',
      },
    },
  ],
};

describe('buildWardPackHtml', () => {
  it('renders a self-contained document with the safety-critical fields', () => {
    const html = buildWardPackHtml(basePack);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('DOWNTIME PACK — ICU-1');
    expect(html).toContain('Bed ICU-1-03');
    expect(html).toContain('Penicillin (SEVERE)');
    expect(html).toContain('Latex');
    expect(html).toContain('Code: dnr');
    expect(html).toContain('Meropenem');
    expect(html).toContain('Blood culture x2');
    expect(html).toContain('NEWS2 9');
    // Self-contained: no external requests, no scripts.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src=|href=/i);
  });

  it('escapes HTML in patient-controlled fields', () => {
    const evil = JSON.parse(JSON.stringify(basePack));
    evil.beds[0].patient_name = '<img src=x onerror=alert(1)>';
    evil.beds[0].allergies = [{ allergen: '<b>Sulfa</b>', severity: null, sources: [] }];
    const html = buildWardPackHtml(evil);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<b>Sulfa</b>');
  });

  it('renders an empty-census pack and NKDA fallbacks without crashing', () => {
    const html = buildWardPackHtml({ ward_name: 'GW-2', generated_at: null, beds: [] });
    expect(html).toContain('No occupied beds at generation time.');
    const sparse = buildWardPackHtml({
      ward_name: 'GW-2',
      generated_at: '2026-06-10T05:00:00Z',
      beds: [{ bed_number: 'GW-2-01', allergies: [], mar_due: [], active_orders: [], latest_vitals: null }],
    });
    expect(sparse).toContain('NKDA / none recorded');
    expect(sparse).toContain('No doses scheduled in window');
    expect(sparse).toContain('No vitals recorded');
  });
});
