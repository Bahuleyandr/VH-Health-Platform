// Unit tests for the X12 837P generator.
//
// Locks in the *minimum-viable* segment shape: ISA/GS/ST envelope, billing
// provider HL, subscriber HL, CLM, HI diagnoses, LX/SV1/DTP service lines,
// SE/GE/IEA closers. Does NOT validate against payer-specific companion
// guides — that's deferred per the source comment + ROADMAP 3D.
//
// The audit grade for this generator is C+: it produces valid X12 syntax
// but lacks NPI/Tax-ID validation, COB, multi-claim batching, content
// escaping. These tests intentionally pin the minimum-viable behaviour
// so a future "full payer-ready" rewrite has a regression net.

import { build837P } from '../../services/billing/ediGenerator.js';

const FIXTURE = {
  submitter: { name: 'VH HEALTH', id: 'VHHEALTH001', contactName: 'AR Lead', contactPhone: '5551234' },
  receiver: { name: 'PAYER X', id: 'PAYERX0001' },
  billingProvider: {
    name: 'VH HOSPITAL',
    npi: '1234567890',
    taxId: '12-3456789',
    address: { line1: '1 Hospital Rd', city: 'Chennai', state: 'TN', postalCode: '600001' },
  },
  subscriber: {
    firstName: 'JOHN', lastName: 'DOE', memberId: 'MEM001',
    dob: '1980-01-01', gender: 'M', payerId: 'PAYERX0001',
  },
  patient: { firstName: 'JOHN', lastName: 'DOE', dob: '1980-01-01', gender: 'M' },
  claim: {
    id: 'INV-2026-001',
    total: 1500.00,
    serviceDate: '2026-04-14',
    diagnoses: [{ icd10: 'J18.9' }, { icd10: 'R05' }],
    services: [
      { cpt: '99213', charge: 800.00, units: 1, diagnosisPointers: [1] },
      { cpt: '93000', charge: 700.00, units: 1, diagnosisPointers: [1, 2] },
    ],
  },
};

function segments(edi) {
  return edi.split('~').filter(Boolean);
}

describe('build837P — envelope structure', () => {
  let edi;
  let segs;

  beforeAll(() => {
    edi = build837P(FIXTURE);
    segs = segments(edi);
  });

  it('emits an ISA envelope as the first segment', () => {
    expect(segs[0].startsWith('ISA*')).toBe(true);
    // ISA has 16 elements + the 17th sub-element separator
    const elems = segs[0].split('*');
    expect(elems.length).toBeGreaterThanOrEqual(16);
  });

  it('emits a GS functional group right after ISA', () => {
    expect(segs[1].startsWith('GS*HC*')).toBe(true);
  });

  it('emits a single ST*837 transaction-set header', () => {
    const sts = segs.filter((s) => s.startsWith('ST*'));
    expect(sts.length).toBe(1);
    expect(sts[0]).toMatch(/^ST\*837\*0001\*005010X222A1$/);
  });

  it('emits matching SE / GE / IEA closers in order', () => {
    const tail = segs.slice(-3);
    expect(tail[0].startsWith('SE*')).toBe(true);
    expect(tail[1]).toBe('GE*1*1');
    expect(tail[2]).toMatch(/^IEA\*1\*\d{9}$/);
  });

  it('SE segment count matches actual segments between ST and SE inclusive', () => {
    const stIdx = segs.findIndex((s) => s.startsWith('ST*'));
    const seIdx = segs.findIndex((s) => s.startsWith('SE*'));
    expect(stIdx).toBeGreaterThan(-1);
    expect(seIdx).toBeGreaterThan(stIdx);
    const claimedCount = parseInt(segs[seIdx].split('*')[1], 10);
    const actualCount = seIdx - stIdx + 1;
    expect(claimedCount).toBe(actualCount);
  });
});

describe('build837P — billing provider + subscriber loops', () => {
  let segs;

  beforeAll(() => {
    segs = segments(build837P(FIXTURE));
  });

  it('emits HL*1 for billing provider with NPI under NM1*85', () => {
    const hl1Idx = segs.indexOf('HL*1**20*1');
    expect(hl1Idx).toBeGreaterThan(-1);
    // NM1*85 should follow within a few segments
    const nm1_85 = segs.slice(hl1Idx).find((s) => s.startsWith('NM1*85*'));
    expect(nm1_85).toBeDefined();
    expect(nm1_85).toContain('1234567890'); // NPI
  });

  it('emits Tax ID via REF*EI', () => {
    expect(segs.find((s) => s === 'REF*EI*12-3456789')).toBeDefined();
  });

  it('emits HL*2 for subscriber with member ID under NM1*IL', () => {
    expect(segs.indexOf('HL*2*1*22*0')).toBeGreaterThan(-1);
    const nm1_il = segs.find((s) => s.startsWith('NM1*IL*'));
    expect(nm1_il).toContain('MEM001');
  });

  it('emits subscriber DMG with DOB in YYYYMMDD + gender', () => {
    expect(segs.find((s) => s === 'DMG*D8*19800101*M')).toBeDefined();
  });
});

describe('build837P — claim + diagnoses + service lines', () => {
  let segs;

  beforeAll(() => {
    segs = segments(build837P(FIXTURE));
  });

  it('emits CLM with claim id + total', () => {
    const clm = segs.find((s) => s.startsWith('CLM*'));
    expect(clm).toBeDefined();
    expect(clm).toContain('INV-2026-001');
    expect(clm).toContain('1500.00');
  });

  it('emits HI with principal diagnosis qualified ABK and secondary ABF', () => {
    const hi = segs.find((s) => s.startsWith('HI*'));
    expect(hi).toBeDefined();
    // Principal — ABK:J189 (period stripped)
    expect(hi).toContain('ABK:J189');
    // Secondary — ABF:R05
    expect(hi).toContain('ABF:R05');
  });

  it('strips periods from ICD-10 codes in HI', () => {
    const hi = segs.find((s) => s.startsWith('HI*'));
    // J18.9 → J189 (X12 ICD-10 codes have no decimal)
    expect(hi).not.toContain('J18.9');
  });

  it('emits one LX + SV1 + DTP per service line', () => {
    const lxs = segs.filter((s) => s.startsWith('LX*'));
    const sv1s = segs.filter((s) => s.startsWith('SV1*'));
    const dtps = segs.filter((s) => s.startsWith('DTP*472*D8*'));
    expect(lxs.length).toBe(2);
    expect(sv1s.length).toBe(2);
    expect(dtps.length).toBe(2);
  });

  it('emits CPT codes as HC:<code> in SV1', () => {
    const sv1s = segs.filter((s) => s.startsWith('SV1*'));
    expect(sv1s[0]).toContain('HC:99213');
    expect(sv1s[1]).toContain('HC:93000');
  });

  it('emits diagnosis pointers joined with sub-separator', () => {
    const sv1s = segs.filter((s) => s.startsWith('SV1*'));
    // Second service line points to dx 1 + 2 → "1:2"
    expect(sv1s[1]).toContain('1:2');
  });

  it('emits service date in YYYYMMDD format', () => {
    const dtps = segs.filter((s) => s.startsWith('DTP*472*D8*'));
    expect(dtps[0]).toBe('DTP*472*D8*20260414');
  });
});

describe('build837P — empty optional sections', () => {
  it('omits the HI segment entirely if no diagnoses provided', () => {
    const claim = { ...FIXTURE.claim, diagnoses: [] };
    const edi = build837P({ ...FIXTURE, claim });
    expect(edi).not.toContain('~HI*');
  });

  it('emits zero service-line segments if services is empty (CLM still present)', () => {
    const claim = { ...FIXTURE.claim, services: [] };
    const segs = segments(build837P({ ...FIXTURE, claim }));
    expect(segs.find((s) => s.startsWith('CLM*'))).toBeDefined();
    expect(segs.filter((s) => s.startsWith('LX*')).length).toBe(0);
  });
});
