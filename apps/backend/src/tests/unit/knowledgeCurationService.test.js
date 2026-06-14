/**
 * WS5 B5.5 — knowledgeCurationService bridge tests.
 *
 * The bridge renders hospital-owned reference data (pharmacy_catalog /
 * antibiogram_90d / clinical_protocols) into the KB substrate as
 * curation-PENDING documents. These tests assert the pipeline-control logic
 * WITHOUT a live DB or Ollama embedder:
 *   - render-to-text correctness (stable ordering, suppression note)
 *   - idempotent dedup on file_hash (skip when a same-content doc exists)
 *   - imported docs are ingested with curation_status='pending'
 *   - per-source counts { processed, inserted, skipped, failed }
 *   - embed degradation does not fail the import (createInlineDocument still
 *     resolves; the doc lands pending with no chunks)
 *   - dry-run renders + dedups but never writes
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const getKnowledgeBaseMock = jest.fn();
const createInlineDocumentMock = jest.fn();
const findDocumentByHashMock = jest.fn();
const antibiogram90dMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  // Transparent pass-through so the importer body runs inline.
  runInTenantContext: (_tenantId, fn) => fn(),
  runWithSuperAdmin: (fn) => fn(),
  getCurrentTenantId: () => null,
}));

jest.unstable_mockModule('../../services/lab/microbiologyService.js', () => ({
  antibiogram90d: antibiogram90dMock,
}));

jest.unstable_mockModule('../../services/ai/knowledgeBaseService.js', () => ({
  getKnowledgeBase: getKnowledgeBaseMock,
}));

jest.unstable_mockModule('../../services/ai/knowledgeDocumentService.js', () => ({
  createInlineDocument: createInlineDocumentMock,
  findDocumentByHash: findDocumentByHashMock,
}));

const {
  importFormularyToKb,
  importAntibiogramToKb,
  importProtocolsToKb,
  importSource,
  renderFormularyRow,
  renderAntibiogramOrganism,
  renderProtocolRow,
  __testing__,
} = await import('../../services/ai/knowledgeCurationService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  getKnowledgeBaseMock.mockReset();
  createInlineDocumentMock.mockReset();
  findDocumentByHashMock.mockReset();
  antibiogram90dMock.mockReset();
  // KB exists + is the right type by default.
  getKnowledgeBaseMock.mockResolvedValue({ id: 1, kb_type: 'formulary', tenant_id: TENANT });
  // No pre-existing doc → not a dedup skip unless a test overrides it.
  findDocumentByHashMock.mockResolvedValue(null);
  // createInlineDocument succeeds by default (returns the persisted doc shape).
  createInlineDocumentMock.mockResolvedValue({ document: { id: 1 }, processed: true });
  // Import-batch open/close inserts/updates resolve to empty.
  queryUnsafeMock.mockResolvedValue([{ id: 99 }]);
});

// ---------------------------------------------------------------------------
// Render-to-text
// ---------------------------------------------------------------------------
describe('render-to-text', () => {
  it('renders a formulary row with stable line order and Rx flag', () => {
    const text = renderFormularyRow({
      id: 7, name: 'Crocin 500mg', generic_name: 'Paracetamol', category: 'analgesic',
      manufacturer: 'GSK', pack_size: '15 tablets', requires_prescription: false,
    });
    expect(text).toContain('Formulary entry: Crocin 500mg');
    expect(text).toContain('Generic: Paracetamol');
    expect(text).toContain('Category: analgesic');
    expect(text).toContain('Manufacturer: GSK');
    expect(text).toContain('Pack size: 15 tablets');
    expect(text).toContain('Prescription required: No (OTC)');
    // Stable order: generic before manufacturer before pack size.
    expect(text.indexOf('Generic')).toBeLessThan(text.indexOf('Manufacturer'));
    expect(text.indexOf('Manufacturer')).toBeLessThan(text.indexOf('Pack size'));
  });

  it('marks Rx-only when requires_prescription is true and fills n/a for blanks', () => {
    const text = renderFormularyRow({ id: 1, name: 'Amoxicillin', requires_prescription: true });
    expect(text).toContain('Prescription required: Yes (Rx-only)');
    expect(text).toContain('Generic: n/a');
  });

  it('renders a per-organism antibiogram sorted by descending susceptibility', () => {
    const text = renderAntibiogramOrganism('Escherichia coli', [
      { antibiotic_name: 'Ciprofloxacin', susceptible_pct: 48, susceptible_count: 20, total_tested: 42 },
      { antibiotic_name: 'Nitrofurantoin', susceptible_pct: 95, susceptible_count: 40, total_tested: 42 },
    ]);
    expect(text).toContain('Antibiogram (rolling 90-day susceptibility) — Escherichia coli');
    expect(text).toContain('Isolates tested (max across panel): 42');
    // Most-active agent leads.
    expect(text.indexOf('Nitrofurantoin')).toBeLessThan(text.indexOf('Ciprofloxacin'));
    expect(text).toContain('Nitrofurantoin: 95% susceptible (40/42)');
    // Carries the suppression / decision-support note.
    expect(text).toContain('small-sample organisms (<5 isolates) are suppressed');
  });

  it('flattens protocol JSONB trigger/recommendation fields deterministically', () => {
    const text = renderProtocolRow({
      id: 3, name: 'Sepsis 1-hour bundle', category: 'sepsis', priority: 'high',
      trigger_conditions: { lactate: '>2 mmol/L', sbp: '<90' },
      recommendations: ['Blood cultures before antibiotics', 'Broad-spectrum antibiotics within 1h'],
    });
    expect(text).toContain('Clinical protocol: Sepsis 1-hour bundle');
    expect(text).toContain('Priority: high');
    expect(text).toContain('lactate: >2 mmol/L');
    expect(text).toContain('- Blood cultures before antibiotics');
  });

  it('flattenJsonish accepts json-string input', () => {
    const out = __testing__.flattenJsonish('{"a":1,"b":["x","y"]}');
    expect(out).toContain('a: 1');
    expect(out).toContain('b: x, y');
  });
});

// ---------------------------------------------------------------------------
// Formulary import
// ---------------------------------------------------------------------------
describe('importFormularyToKb', () => {
  function mockFormularyPage(rows) {
    // openImportBatch INSERT … RETURNING id, then the page SELECT.
    queryUnsafeMock.mockResolvedValueOnce([{ id: 99 }]); // batch open
    queryUnsafeMock.mockResolvedValueOnce(rows);          // page 1
    queryUnsafeMock.mockResolvedValueOnce([]);            // batch close UPDATE
  }

  it('imports active rows as pending and returns counts', async () => {
    mockFormularyPage([
      { id: 1, name: 'Paracetamol', generic_name: 'Paracetamol', category: 'analgesic', requires_prescription: false },
      { id: 2, name: 'Amoxicillin', generic_name: 'Amoxicillin', category: 'antibiotic', requires_prescription: true },
    ]);

    const counts = await importFormularyToKb({ tenantId: TENANT, knowledgeBaseId: 1 });

    expect(counts).toEqual({ processed: 2, inserted: 2, skipped: 0, failed: 0 });
    expect(createInlineDocumentMock).toHaveBeenCalledTimes(2);
    // Imported docs MUST be curation_status='pending' + source_type='imported'.
    const firstCall = createInlineDocumentMock.mock.calls[0][0];
    expect(firstCall.curationStatus).toBe('pending');
    expect(firstCall.sourceType).toBe('imported');
    expect(firstCall.metadata.kind).toBe('formulary');
    expect(firstCall.metadata.source).toBe('pharmacy_catalog');
  });

  it('skips rows whose rendered content already exists (file_hash dedup)', async () => {
    mockFormularyPage([
      { id: 1, name: 'Paracetamol', requires_prescription: false },
    ]);
    findDocumentByHashMock.mockResolvedValueOnce({ id: 500 }); // already present

    const counts = await importFormularyToKb({ tenantId: TENANT, knowledgeBaseId: 1 });

    expect(counts).toEqual({ processed: 1, inserted: 0, skipped: 1, failed: 0 });
    expect(createInlineDocumentMock).not.toHaveBeenCalled();
  });

  it('counts a failed ingest without aborting the run', async () => {
    mockFormularyPage([
      { id: 1, name: 'A', requires_prescription: false },
      { id: 2, name: 'B', requires_prescription: false },
    ]);
    createInlineDocumentMock
      .mockRejectedValueOnce(new Error('insert blew up'))
      .mockResolvedValueOnce({ document: { id: 2 }, processed: true });

    const counts = await importFormularyToKb({ tenantId: TENANT, knowledgeBaseId: 1 });
    expect(counts).toEqual({ processed: 2, inserted: 1, skipped: 0, failed: 1 });
  });

  it('embed-unavailable does not fail the import (doc still ingested)', async () => {
    mockFormularyPage([{ id: 1, name: 'A', requires_prescription: false }]);
    // createInlineDocument resolves even when the embedder is down (degrades to
    // processing_status='failed' / reason='embed_unavailable' internally).
    createInlineDocumentMock.mockResolvedValueOnce({
      document: { id: 1, processing_status: 'failed' },
      processed: true,
      reason: 'embed_unavailable',
    });
    const counts = await importFormularyToKb({ tenantId: TENANT, knowledgeBaseId: 1 });
    expect(counts).toEqual({ processed: 1, inserted: 1, skipped: 0, failed: 0 });
  });

  it('dry-run renders + dedups but never writes a document', async () => {
    mockFormularyPage([
      { id: 1, name: 'A', requires_prescription: false },
      { id: 2, name: 'B', requires_prescription: false },
    ]);
    const counts = await importFormularyToKb({ tenantId: TENANT, knowledgeBaseId: 1, dryRun: true });
    expect(counts).toEqual({ processed: 2, inserted: 2, skipped: 0, failed: 0 });
    expect(createInlineDocumentMock).not.toHaveBeenCalled();
  });

  it('rejects a non-positive knowledgeBaseId', async () => {
    await expect(
      importFormularyToKb({ tenantId: TENANT, knowledgeBaseId: 0 }),
    ).rejects.toThrow(/knowledgeBaseId/);
  });
});

// ---------------------------------------------------------------------------
// Antibiogram import
// ---------------------------------------------------------------------------
describe('importAntibiogramToKb', () => {
  it('groups view rows per organism into one pending doc each', async () => {
    getKnowledgeBaseMock.mockResolvedValue({ id: 2, kb_type: 'antibiotic_policy', tenant_id: TENANT });
    queryUnsafeMock.mockResolvedValueOnce([{ id: 99 }]); // batch open
    antibiogram90dMock.mockResolvedValueOnce([
      { organism_name: 'E. coli', antibiotic_name: 'Nitrofurantoin', susceptible_pct: 95, susceptible_count: 40, total_tested: 42 },
      { organism_name: 'E. coli', antibiotic_name: 'Ciprofloxacin', susceptible_pct: 48, susceptible_count: 20, total_tested: 42 },
      { organism_name: 'Klebsiella pneumoniae', antibiotic_name: 'Meropenem', susceptible_pct: 88, susceptible_count: 22, total_tested: 25 },
    ]);
    queryUnsafeMock.mockResolvedValueOnce([]); // batch close

    const counts = await importAntibiogramToKb({ tenantId: TENANT, knowledgeBaseId: 2 });

    // 2 organisms → 2 documents.
    expect(counts).toEqual({ processed: 2, inserted: 2, skipped: 0, failed: 0 });
    expect(createInlineDocumentMock).toHaveBeenCalledTimes(2);
    expect(createInlineDocumentMock.mock.calls[0][0].curationStatus).toBe('pending');
    expect(createInlineDocumentMock.mock.calls[0][0].metadata.kind).toBe('antibiogram');
    expect(antibiogram90dMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
  });

  it('processes nothing when the view is empty (small-sample suppressed)', async () => {
    getKnowledgeBaseMock.mockResolvedValue({ id: 2, kb_type: 'antibiotic_policy', tenant_id: TENANT });
    queryUnsafeMock.mockResolvedValueOnce([{ id: 99 }]); // batch open
    antibiogram90dMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([]); // batch close

    const counts = await importAntibiogramToKb({ tenantId: TENANT, knowledgeBaseId: 2 });
    expect(counts).toEqual({ processed: 0, inserted: 0, skipped: 0, failed: 0 });
    expect(createInlineDocumentMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Protocols import + dispatcher
// ---------------------------------------------------------------------------
describe('importProtocolsToKb', () => {
  it('imports active protocols as pending clinical-guideline docs', async () => {
    getKnowledgeBaseMock.mockResolvedValue({ id: 3, kb_type: 'clinical_guideline', tenant_id: TENANT });
    queryUnsafeMock.mockResolvedValueOnce([{ id: 99 }]); // batch open
    queryUnsafeMock.mockResolvedValueOnce([
      { id: 1, name: 'Sepsis bundle', category: 'sepsis', priority: 'high', trigger_conditions: {}, recommendations: ['x'] },
    ]); // SELECT protocols
    queryUnsafeMock.mockResolvedValueOnce([]); // batch close

    const counts = await importProtocolsToKb({ tenantId: TENANT, knowledgeBaseId: 3 });
    expect(counts).toEqual({ processed: 1, inserted: 1, skipped: 0, failed: 0 });
    expect(createInlineDocumentMock.mock.calls[0][0].metadata.kind).toBe('protocol');
  });
});

describe('importSource dispatcher', () => {
  it('rejects an unknown source', async () => {
    await expect(importSource({ tenantId: TENANT, source: 'nope', kbIds: {} }))
      .rejects.toThrow(/source must be one of/);
  });

  it('requires a kbId per requested source', async () => {
    await expect(importSource({ tenantId: TENANT, source: 'formulary', kbIds: {} }))
      .rejects.toThrow(/knowledgeBaseId for source 'formulary'/);
  });
});
