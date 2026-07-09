import {
  DEFAULT_DEMO_TENANT_ID,
  assertLocalOnlyDatabaseUrl,
  buildDemoTenantScenarioPack,
  buildGeneratedLoginSmoke,
  scanDemoPackForPhi,
} from '../../services/demo/demoTenantScenarioPackService.js';

describe('demo tenant scenario pack service', () => {
  it('rejects non-local database URLs before stateful generation', () => {
    expect(() => assertLocalOnlyDatabaseUrl(
      'postgresql://vhhealth:pw@db.prod.internal:5432/vhhealth'
    )).toThrow(/non-local database/i);
  });

  it('accepts the local VH Health test database shape', () => {
    const context = assertLocalOnlyDatabaseUrl(
      'postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test'
    );
    expect(context).toMatchObject({
      host: '127.0.0.1',
      database: 'vhhealth_test',
      localOnly: true,
    });
  });

  it('replays deterministically for the same tenant, date, pack, and seed', () => {
    const options = {
      tenantId: DEFAULT_DEMO_TENANT_ID,
      tenantSlug: 'buyer-demo',
      scenarioDate: '2026-07-07',
      packId: 'sales-core',
      seed: 'repeatable',
    };
    const first = buildDemoTenantScenarioPack(options);
    const second = buildDemoTenantScenarioPack(options);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.packFingerprint).toBe(second.packFingerprint);
    expect(first.finalFingerprint).toBe(second.finalFingerprint);
  });

  it('builds persona journeys, tour anchors, and a passing generated-login smoke', () => {
    const pack = buildDemoTenantScenarioPack({ tenantSlug: 'login-smoke' });
    const smoke = buildGeneratedLoginSmoke(pack);

    expect(pack.personas.length).toBeGreaterThanOrEqual(8);
    expect(pack.journeys.length).toBeGreaterThanOrEqual(6);
    expect(pack.tourAnchors.length).toBeGreaterThanOrEqual(10);
    expect(smoke).toEqual({
      status: 'pass',
      checkedPersonas: pack.personas.length,
      failures: [],
    });
  });

  it('passes the no-PHI content scan for generated demo content', () => {
    const pack = buildDemoTenantScenarioPack({ tenantSlug: 'phi-clean' });

    expect(scanDemoPackForPhi(pack)).toEqual([]);
    expect(pack.contentSafety).toMatchObject({
      scanner: 'demo-pack-no-phi-v1',
      status: 'pass',
      findings: [],
    });
  });

  it('flags non-demo patient identifiers and contact details', () => {
    const pack = buildDemoTenantScenarioPack({ tenantSlug: 'phi-dirty-probe' });
    const dirty = {
      ...pack,
      patients: [
        ...pack.patients,
        {
          key: 'bad',
          displayName: 'Ravi Real',
          hospitalNumber: 'VH-123456',
          phone: '+919876543210',
          narrative: 'real note',
        },
      ],
    };
    const findings = scanDemoPackForPhi(dirty);

    expect(findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'PHONE_DETECTED',
      'REAL_HOSPITAL_ID_PATTERN',
      'PATIENT_NAME_NOT_SYNTHETIC',
      'NARRATIVE_NOT_SYNTHETIC',
    ]));
  });
});
