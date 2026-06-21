/**
 * Unit tests for the ward downtime pack service (roadmap A3).
 *
 * 1. buildWardPackHtml — the renderer must be a pure, dependency-free function
 *    producing a fully self-contained printable HTML document; correctness of
 *    the safety-critical lines (allergies, code status, MAR due) is pinned here.
 * 2. generateWardDowntimePacks — the MAR due-list query must PARAMETERIZE the
 *    window hours (audit §5: no interpolated INTERVAL), binding the count as a
 *    param multiplied by a unit interval rather than splicing it into the SQL.
 */

import { jest } from '@jest/globals';

// ─── Mocks for the generateWardDowntimePacks query-shape test ────────────────
const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const snapshotCreateMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $executeRawUnsafe: executeUnsafeMock,
  downtime_snapshots: { create: snapshotCreateMock },
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: __prismaDefaultMock }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies: jest.fn(async () => []),
}));
// Mirror writes hit the filesystem — stub the config so it points nowhere real
// and the helpers' fs calls are harmless (they swallow errors anyway).
jest.unstable_mockModule('../../config/downtimeConfig.js', () => ({
  getDowntimeMirrorDir: () => '/tmp/__vh_downtime_test__',
}));

const { buildWardPackHtml, generateWardDowntimePacks } = await import(
  '../../services/downtime/wardDowntimePackService.js'
);

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

describe('generateWardDowntimePacks — MAR window is parameterized (audit §5)', () => {
  beforeEach(() => {
    queryUnsafeMock.mockReset();
    executeUnsafeMock.mockReset();
    snapshotCreateMock.mockReset();
  });

  it("binds MAR_WINDOW_HOURS as a param ($N::int * INTERVAL '1 hour'), never interpolated", async () => {
    // Call sequence inside generateWardDowntimePacks:
    //   1. census query (wards + occupied beds)
    //   2-5. collectBedEntry: patient, MAR, orders, vitals (Promise.all)
    //   last. retention DELETE via $executeRawUnsafe
    queryUnsafeMock
      // 1. census → one ward, one occupied bed
      .mockResolvedValueOnce([
        {
          id: 7,
          name: 'ICU-1',
          tenant_id: '00000000-0000-4000-8000-000000000001',
          beds: [{ bed_number: 'ICU-1-03', patient_uid: 'aaaa1111-2222-4333-8444-555566667777', patient_name: 'P' }],
        },
      ])
      // 2. patient row
      .mockResolvedValueOnce([{ uid: 'aaaa1111-2222-4333-8444-555566667777', name: 'P', code_status: 'full_code' }])
      // 3. MAR due-list (the query under test)
      .mockResolvedValueOnce([])
      // 4. active orders
      .mockResolvedValueOnce([])
      // 5. latest vitals
      .mockResolvedValueOnce([]);
    snapshotCreateMock.mockResolvedValueOnce({ id: 99, ward_id: 7, created_at: new Date() });
    executeUnsafeMock.mockResolvedValueOnce(0);

    await generateWardDowntimePacks({ tenantId: '00000000-0000-4000-8000-000000000001' });

    // Find the MAR query among the recorded calls (the one hitting
    // medication_administrations).
    const marCall = queryUnsafeMock.mock.calls.find(
      ([sql]) => typeof sql === 'string' && /FROM medication_administrations/.test(sql),
    );
    expect(marCall).toBeDefined();

    const [marSql, ...marParams] = marCall;
    // Parameterized form present…
    expect(marSql).toMatch(/\$3::int \* INTERVAL '1 hour'/);
    // …and the dangerous interpolated form absent.
    expect(marSql).not.toMatch(/INTERVAL '\d+ hours'/);
    expect(marSql).not.toContain('${');
    // The window count is bound as the 3rd spread param (after uid, tenant).
    expect(marParams).toEqual([
      'aaaa1111-2222-4333-8444-555566667777',
      '00000000-0000-4000-8000-000000000001',
      12, // MAR_WINDOW_HOURS
    ]);
  });
});
