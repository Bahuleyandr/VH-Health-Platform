// WP1 — importer parsing for the WHO ICD-11 SimpleTabulation export and the
// WHOCC ATC index flat file. Fixtures are tiny SYNTHETIC files (fabricated
// codes/titles only — no licensed content lives in this repo). The pg client
// is a stub, so no DB is touched.

import { jest } from '@jest/globals';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectTabulationDelimiter,
  splitTabulationLine,
  normalizeTabulationHeaderCell,
  stripTabulationTitleDashes,
  icd11TabulationConceptFromRow,
  importIcd11Tabulation,
  atcLevelForCode,
  parseAtcIndexLine,
  importAtcIndex,
} from '../../../scripts/terminology-import.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => resolve(__dirname, '../fixtures/terminology', name);

const emptyStats = () => ({
  conceptsParsed: 0, conceptsWritten: 0, mapsParsed: 0, mapsWritten: 0,
  skipped: 0, failed: 0, retired: 0,
});

// Stub pg client: records every query, reports rowCount = batch row count so
// conceptsWritten mirrors what was flushed.
function stubClient() {
  const calls = [];
  return {
    calls,
    query: jest.fn(async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const values = /VALUES\s(.*)\n/.exec(String(sql));
      const rowCount = values ? String(sql).split('), (').length : 0;
      return { rowCount, rows: [] };
    }),
  };
}

// Extract flushed concept tuples (7 params per row) from the stub's calls.
function insertedConcepts(client) {
  const out = [];
  for (const call of client.calls) {
    if (!call.sql.includes('INSERT INTO terminology_concepts')) continue;
    for (let i = 0; i < call.params.length; i += 7) {
      out.push({
        system_key: call.params[i],
        code: call.params[i + 1],
        display: call.params[i + 2],
        category: call.params[i + 3],
        release: call.params[i + 5],
        batch_id: call.params[i + 6],
      });
    }
  }
  return out;
}

describe('ICD-11 SimpleTabulation pure parsers', () => {
  test('delimiter detection: tab beats semicolon beats comma', () => {
    expect(detectTabulationDelimiter('Code\tTitle;x')).toBe('\t');
    expect(detectTabulationDelimiter('Code;Title')).toBe(';');
    expect(detectTabulationDelimiter('Code,Title')).toBe(',');
  });

  test('header normalization collapses case and spaces', () => {
    expect(normalizeTabulationHeaderCell(' ClassKind ')).toBe('classkind');
    expect(normalizeTabulationHeaderCell('Linearization (release) URI')).toBe('linearization(release)uri');
    expect(normalizeTabulationHeaderCell('"Chapter No"')).toBe('chapterno');
  });

  test('title depth dashes are stripped, unicode dashes included', () => {
    expect(stripTabulationTitleDashes('- - Synthetic title')).toBe('Synthetic title');
    expect(stripTabulationTitleDashes('– Synthetic title')).toBe('Synthetic title');
    expect(stripTabulationTitleDashes('No dashes')).toBe('No dashes');
  });

  test('row mapping keeps only coded category rows', () => {
    expect(icd11TabulationConceptFromRow({
      code: 'XZ90', title: '- - Synthetic alpha', classkind: 'category', chapterno: '98',
    })).toEqual({ code: 'XZ90', display: 'Synthetic alpha', category: '98' });
    expect(icd11TabulationConceptFromRow({ code: '', title: 'Chapter', classkind: 'chapter', chapterno: '98' })).toBeNull();
    expect(icd11TabulationConceptFromRow({ code: '', title: '- Block', classkind: 'block', chapterno: '98' })).toBeNull();
    expect(icd11TabulationConceptFromRow({ code: '', title: '- - No code', classkind: 'category', chapterno: '98' })).toBeNull();
  });

  test('splitTabulationLine strips wrapping quotes for non-comma delimiters', () => {
    expect(splitTabulationLine('XZ91;"- - Quoted title";category', ';'))
      .toEqual(['XZ91', '- - Quoted title', 'category']);
  });
});

describe('importIcd11Tabulation (synthetic TSV fixture)', () => {
  test('imports category rows only, strips dashes, stamps release + batch', async () => {
    const client = stubClient();
    const stats = emptyStats();
    await importIcd11Tabulation(client, fixture('icd11-simple-tabulation-synthetic.tsv'), stats, false, {
      releaseLabel: '2026-01-synthetic',
      batchId: 42,
    });

    const rows = insertedConcepts(client);
    expect(rows.map((r) => r.code)).toEqual(['XZ90', 'XZ90.0', 'XZ90.1', 'XZ91', 'XZ92']);
    expect(rows.every((r) => r.system_key === 'ICD11')).toBe(true);
    expect(rows.every((r) => r.release === '2026-01-synthetic')).toBe(true);
    expect(rows.every((r) => r.batch_id === 42)).toBe(true);
    expect(rows[0].display).toBe('Synthetic fabricated disorder alpha');
    expect(rows[0].category).toBe('98');
    // quoted title round-trips without wrapping quotes
    expect(rows.find((r) => r.code === 'XZ91').display).toBe('Synthetic fabricated disorder beta');
    // chapter + block + code-less category rows skipped
    expect(stats.skipped).toBe(3);
    expect(stats.conceptsParsed).toBe(5);
  });

  test('semicolon-delimited export parses too (titles may contain commas)', async () => {
    const client = stubClient();
    const stats = emptyStats();
    await importIcd11Tabulation(client, fixture('icd11-simple-tabulation-synthetic-semicolon.csv'), stats, false, {
      releaseLabel: null,
      batchId: 7,
    });

    const rows = insertedConcepts(client);
    expect(rows.map((r) => r.code)).toEqual(['XZ95', 'XZ95.0']);
    expect(rows[1].display).toBe('Synthetic fabricated disorder delta, variant one');
    expect(stats.skipped).toBe(2);
  });

  test('dry-run parses but writes nothing', async () => {
    const client = stubClient();
    const stats = emptyStats();
    await importIcd11Tabulation(client, fixture('icd11-simple-tabulation-synthetic.tsv'), stats, true, {
      releaseLabel: null,
      batchId: 1,
    });

    expect(stats.conceptsParsed).toBe(5);
    expect(stats.conceptsWritten).toBe(0);
    expect(client.calls.filter((c) => c.sql.includes('INSERT INTO terminology_concepts'))).toEqual([]);
  });

  test('a file without the tabulation columns is rejected by name', async () => {
    const client = stubClient();
    await expect(
      importIcd11Tabulation(client, fixture('atc-index-synthetic.csv'), emptyStats(), true, { releaseLabel: null, batchId: 1 }),
    ).rejects.toThrow(/Not a WHO ICD-11 SimpleTabulation export/);
  });
});

describe('ATC index parsing', () => {
  test('atcLevelForCode derives the level from code shape', () => {
    expect(atcLevelForCode('Z')).toBe(1);
    expect(atcLevelForCode('Z99')).toBe(2);
    expect(atcLevelForCode('Z99Z')).toBe(3);
    expect(atcLevelForCode('Z99ZA')).toBe(4);
    expect(atcLevelForCode('Z99ZA01')).toBe(5);
    expect(atcLevelForCode('NOTACODE')).toBeNull();
    expect(atcLevelForCode('Z9')).toBeNull();
  });

  test('parseAtcIndexLine handles CSV, quoted names, and rejects headers', () => {
    expect(parseAtcIndexLine('Z99ZA01,syntheticdrugine'))
      .toEqual({ code: 'Z99ZA01', display: 'syntheticdrugine', category: 'atc_level_5' });
    expect(parseAtcIndexLine('Z99ZA02,"fabricol, combinations"'))
      .toEqual({ code: 'Z99ZA02', display: 'fabricol, combinations', category: 'atc_level_5' });
    expect(parseAtcIndexLine('Z99ZA01 syntheticdrugine'))
      .toEqual({ code: 'Z99ZA01', display: 'syntheticdrugine', category: 'atc_level_5' });
    expect(parseAtcIndexLine('ATC code,ATC level name')).toBeNull();
    expect(parseAtcIndexLine('')).toBeNull();
  });

  test('importAtcIndex imports all levels from the synthetic fixture', async () => {
    const client = stubClient();
    const stats = emptyStats();
    await importAtcIndex(client, fixture('atc-index-synthetic.csv'), stats, false, {
      releaseLabel: 'atc-2026-synthetic',
      batchId: 9,
    });

    const rows = insertedConcepts(client);
    expect(rows.map((r) => r.code)).toEqual(['Z', 'Z99', 'Z99Z', 'Z99ZA', 'Z99ZA01', 'Z99ZA02']);
    expect(rows.map((r) => r.category)).toEqual(
      ['atc_level_1', 'atc_level_2', 'atc_level_3', 'atc_level_4', 'atc_level_5', 'atc_level_5'],
    );
    expect(rows.every((r) => r.system_key === 'ATC')).toBe(true);
    // header + malformed row skipped
    expect(stats.skipped).toBe(2);
    expect(stats.conceptsParsed).toBe(6);
  });
});
