// WP4 — evaluateDrugKb deterministic-matching seam (migration 722).
// Prisma-mocked KB load + mocked drugKbLinkService. Pins:
//   * no tenantId and no resolvedKeys ⇒ the resolver is NEVER consulted and
//     matching is the existing substring path (byte-identical guard for every
//     pre-existing caller, including the fail-CLOSED CPOE prescription path);
//   * resolver-enabled keys let a med with a non-matching display name hit KB
//     interactions; unresolved meds fall back to substring;
//   * resolver disabled or throwing ⇒ identical findings to the substring
//     path (fail-open, never throws).
import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const resolveDrugKeysMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));
jest.unstable_mockModule('../../services/clinical/drugKbLinkService.js', () => ({
  resolveDrugKeys: resolveDrugKeysMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

const {
  evaluateDrugKb,
  __resetDrugKbCache,
} = await import('../../services/clinical/drugKnowledgeBaseService.js');
// The engine hands the resolver the db handle it is itself reading the KB
// through, so a strict-identity caller can resolve inside its own transaction.
// Bind the mocked client here to pin that the legacy (no-db) caller still gets
// the module-level client rather than some other handle.
const { default: mockedPrisma } = await import('../../lib/prisma.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

// Minimal active KB: two monographs + one contraindicated interaction.
function primeKb() {
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (/FROM drug_kb_monographs/.test(sql)) {
      return [
        {
          drug_key: 'nitroglycerin', display_name: 'Nitroglycerin', drug_class: 'nitrate', aliases: ['gtn'], source_key: 's', source_priority: 100, is_starter: true,
        },
        {
          drug_key: 'sildenafil', display_name: 'Sildenafil', drug_class: 'pde5', aliases: ['viagra'], source_key: 's', source_priority: 100, is_starter: true,
        },
      ];
    }
    if (/FROM drug_kb_interactions/.test(sql)) {
      return [{
        drug_a_key: 'nitroglycerin', drug_b_key: 'sildenafil', severity: 'contraindicated', mechanism: 'cGMP', effect: 'hypotension', management: 'avoid', source_key: 's', source_priority: 100, is_starter: true,
      }];
    }
    // groups / xreact / cautions / doses / iv pairs
    return [];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetDrugKbCache();
  primeKb();
});

// Display names deliberately do NOT substring-match any monograph key/alias.
const OPAQUE_MEDS = [
  { name: 'Cardiwell 2.6 SR', catalog_id: 11 },
  { name: 'Bluace 50', catalog_id: 12 },
];

// Names that DO substring-match (today's path).
const TEXT_MEDS = [
  { name: 'GTN 2.6mg SR' },
  { name: 'Viagra 50mg' },
];

test('no tenantId / no resolvedKeys → resolver never consulted, substring path only', async () => {
  const result = await evaluateDrugKb({ medications: OPAQUE_MEDS });
  expect(resolveDrugKeysMock).not.toHaveBeenCalled();
  expect(result.kbAvailable).toBe(true);
  expect(result.findings).toEqual([]);

  const textResult = await evaluateDrugKb({ medications: TEXT_MEDS });
  expect(resolveDrugKeysMock).not.toHaveBeenCalled();
  expect(textResult.findings).toHaveLength(1);
  expect(textResult.findings[0].check).toBe('interaction');
});

test('tenantId + enabled resolver → deterministic keys find the interaction', async () => {
  resolveDrugKeysMock.mockResolvedValue({
    enabled: true,
    resolutions: [
      { catalog_id: 11, drug_keys: ['nitroglycerin'], tier: 'explicit_link' },
      { catalog_id: 12, drug_keys: ['sildenafil'], tier: 'atc' },
    ],
  });
  const result = await evaluateDrugKb({ medications: OPAQUE_MEDS, tenantId: TENANT });
  // strict:false is the load-bearing half here — the gated/fail-open legacy
  // contract this suite exists to protect is exactly "not strict".
  expect(resolveDrugKeysMock).toHaveBeenCalledWith({
    tenantId: TENANT,
    medications: OPAQUE_MEDS,
    db: mockedPrisma,
    strict: false,
  });
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]).toMatchObject({
    check: 'interaction',
    severity: 'contraindicated',
    drug_keys: ['nitroglycerin', 'sildenafil'],
  });
});

test('per-med fallback: unresolved med still matches by substring', async () => {
  resolveDrugKeysMock.mockResolvedValue({
    enabled: true,
    resolutions: [
      { catalog_id: 11, drug_keys: ['nitroglycerin'], tier: 'composition' },
      null, // second med unresolved → substring
    ],
  });
  const meds = [OPAQUE_MEDS[0], { name: 'Viagra 50mg' }];
  const result = await evaluateDrugKb({ medications: meds, tenantId: TENANT });
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0].drug_keys).toEqual(['nitroglycerin', 'sildenafil']);
});

test('resolver disabled (gates off) → identical to substring path', async () => {
  resolveDrugKeysMock.mockResolvedValue({ enabled: false, resolutions: null });
  const withTenant = await evaluateDrugKb({ medications: TEXT_MEDS, tenantId: TENANT });
  __resetDrugKbCache();
  const withoutTenant = await evaluateDrugKb({ medications: TEXT_MEDS });
  expect(withTenant.findings).toEqual(withoutTenant.findings);

  const opaque = await evaluateDrugKb({ medications: OPAQUE_MEDS, tenantId: TENANT });
  expect(opaque.findings).toEqual([]);
});

test('resolver throwing → fail-open to substring, never throws', async () => {
  resolveDrugKeysMock.mockRejectedValue(new Error('resolver exploded'));
  const result = await evaluateDrugKb({ medications: TEXT_MEDS, tenantId: TENANT });
  expect(result.kbAvailable).toBe(true);
  expect(result.findings).toHaveLength(1);
});

test('caller-supplied resolvedKeys bypass the resolver entirely', async () => {
  const result = await evaluateDrugKb({
    medications: OPAQUE_MEDS,
    resolvedKeys: [['nitroglycerin'], ['sildenafil']],
  });
  expect(resolveDrugKeysMock).not.toHaveBeenCalled();
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0].severity).toBe('contraindicated');
});
