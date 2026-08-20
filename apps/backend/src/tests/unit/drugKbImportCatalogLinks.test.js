// WP4 — drug-kb-import.mjs catalog-links extensions: CLI arg parsing for the
// new subcommands (--dataset catalog-links / --activate-source /
// --deactivate-source / --report / license metadata) and the pure
// catalog-links row normalizer. No DB — the script only connects when invoked
// directly.
import {
  parseArgs,
  normalizeCatalogLinkRow,
} from '../../../scripts/drug-kb-import.mjs';

const TENANT = '00000000-0000-4000-8000-000000000001';

function argv(...rest) {
  return ['node', 'drug-kb-import.mjs', ...rest];
}

describe('parseArgs — new WP4 flags', () => {
  test('catalog-links dataset with tenant + link-source + license metadata', () => {
    const args = parseArgs(argv(
      '--source', 'cims_2026q2',
      '--dataset', 'catalog-links',
      '--csv', 'links.csv',
      '--tenant', TENANT,
      '--link-source', 'manual',
      '--license-holder', 'VH Hospital Pvt Ltd',
      '--license-expires', '2027-03-31',
      '--vendor-edition', '2026 Q2',
    ));
    expect(args.dataset).toBe('catalog-links');
    expect(args.tenant).toBe(TENANT);
    expect(args.linkSource).toBe('manual');
    expect(args.licenseHolder).toBe('VH Hospital Pvt Ltd');
    expect(args.licenseExpires).toBe('2027-03-31');
    expect(args.vendorEdition).toBe('2026 Q2');
  });

  test('defaults: vendor_import link source, no subcommands, dark posture', () => {
    const args = parseArgs(argv('--source', 's1', '--dataset', 'monographs', '--csv', 'm.csv'));
    expect(args.linkSource).toBe('vendor_import');
    expect(args.tenant).toBeNull();
    expect(args.activateSource).toBeNull();
    expect(args.deactivateSource).toBeNull();
    expect(args.report).toBe(false);
    expect(args.licenseHolder).toBeNull();
  });

  test('source lifecycle + report subcommands parse standalone', () => {
    expect(parseArgs(argv('--activate-source', 'cims_2026q2')).activateSource).toBe('cims_2026q2');
    expect(parseArgs(argv('--deactivate-source', 'vh_starter_set')).deactivateSource).toBe('vh_starter_set');
    const report = parseArgs(argv('--report', '--tenant', TENANT));
    expect(report.report).toBe(true);
    expect(report.tenant).toBe(TENANT);
  });
});

describe('normalizeCatalogLinkRow', () => {
  test('numeric catalog_id row', () => {
    expect(normalizeCatalogLinkRow({ catalog_id: '42', drug_key: 'Warfarin' }))
      .toEqual({
        catalogId: 42, nameQuery: null, drugKey: 'warfarin', confidence: null, linkSource: 'vendor_import',
      });
  });

  test('name-resolved row with confidence and per-row link_source', () => {
    expect(normalizeCatalogLinkRow(
      { catalog_code_or_name: 'Ecosprin 75', drug_key: 'ASPIRIN', confidence: '0.95', link_source: 'manual' },
      { defaultLinkSource: 'vendor_import' },
    )).toEqual({
      catalogId: null, nameQuery: 'Ecosprin 75', drugKey: 'aspirin', confidence: 0.95, linkSource: 'manual',
    });
  });

  test('catalog_name is accepted as an alias column', () => {
    const row = normalizeCatalogLinkRow({ catalog_name: 'Dolo 650', drug_key: 'paracetamol' });
    expect(row.nameQuery).toBe('Dolo 650');
  });

  test('catalog_id takes precedence over the name column', () => {
    const row = normalizeCatalogLinkRow({
      catalog_id: '7', catalog_code_or_name: 'ignored', drug_key: 'x',
    });
    expect(row.catalogId).toBe(7);
    expect(row.nameQuery).toBeNull();
  });

  test('rejects: missing drug_key, missing identifier, bad id, bad confidence, bad link_source', () => {
    expect(() => normalizeCatalogLinkRow({ catalog_id: '1' })).toThrow(/drug_key/);
    expect(() => normalizeCatalogLinkRow({ drug_key: 'x' })).toThrow(/catalog_id or catalog_code_or_name/);
    expect(() => normalizeCatalogLinkRow({ catalog_id: '-3', drug_key: 'x' })).toThrow(/invalid catalog_id/);
    expect(() => normalizeCatalogLinkRow({ catalog_id: 'abc', drug_key: 'x' })).toThrow(/invalid catalog_id/);
    expect(() => normalizeCatalogLinkRow({ catalog_id: '1', drug_key: 'x', confidence: '1.5' })).toThrow(/confidence/);
    expect(() => normalizeCatalogLinkRow({ catalog_id: '1', drug_key: 'x', link_source: 'guess' })).toThrow(/link_source/);
  });

  test('atc / composition are valid per-row link sources (derived-link backfills)', () => {
    expect(normalizeCatalogLinkRow({ catalog_id: '1', drug_key: 'x', link_source: 'atc' }).linkSource).toBe('atc');
    expect(normalizeCatalogLinkRow({ catalog_id: '1', drug_key: 'x', link_source: 'composition' }).linkSource).toBe('composition');
  });
});
