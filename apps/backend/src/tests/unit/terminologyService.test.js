// Roadmap B8 — terminology service pure helpers.

import {
  normalizeSystemKey,
  scoreNameMatch,
  SYSTEM_KEYS,
  CATALOG_TARGETS,
} from '../../services/terminology/terminologyService.js';
import { parseCsvLine, splitFsn } from '../../../scripts/terminology-import.mjs';

describe('terminology normalizeSystemKey', () => {
  test('accepts canonical keys verbatim', () => {
    for (const key of Object.values(SYSTEM_KEYS)) {
      expect(normalizeSystemKey(key)).toBe(key);
    }
  });

  test('normalizes common aliases', () => {
    expect(normalizeSystemKey('icd-10')).toBe('ICD10');
    expect(normalizeSystemKey('ICD_10')).toBe('ICD10');
    expect(normalizeSystemKey('snomed')).toBe('SNOMED_CT');
    expect(normalizeSystemKey('SNOMED-CT')).toBe('SNOMED_CT');
    expect(normalizeSystemKey('sct')).toBe('SNOMED_CT');
    expect(normalizeSystemKey('loinc')).toBe('LOINC');
    expect(normalizeSystemKey('atc')).toBe('ATC');
    expect(normalizeSystemKey('icd-11')).toBe('ICD11');
  });

  test('normalizes FHIR canonical URIs', () => {
    expect(normalizeSystemKey('http://snomed.info/sct')).toBe('SNOMED_CT');
    expect(normalizeSystemKey('http://loinc.org')).toBe('LOINC');
    expect(normalizeSystemKey('http://hl7.org/fhir/sid/icd-10')).toBe('ICD10');
    expect(normalizeSystemKey('http://id.who.int/icd/release/11/mms')).toBe('ICD11');
  });

  test('rejects unknown systems', () => {
    expect(normalizeSystemKey('CPT4')).toBeNull();
    expect(normalizeSystemKey('')).toBeNull();
    expect(normalizeSystemKey(null)).toBeNull();
    expect(normalizeSystemKey(undefined)).toBeNull();
  });
});

describe('terminology scoreNameMatch', () => {
  test('exact case-insensitive match scores 1', () => {
    expect(scoreNameMatch('Serum Creatinine', 'serum creatinine')).toBe(1);
  });
  test('prefix relationship scores 0.8 either direction', () => {
    expect(scoreNameMatch('Glucose', 'Glucose [Mass/volume] in Blood')).toBe(0.8);
    expect(scoreNameMatch('Glucose fasting plasma', 'Glucose fasting')).toBe(0.8);
  });
  test('unrelated names score 0; empty inputs score 0', () => {
    expect(scoreNameMatch('Paracetamol', 'Creatinine')).toBe(0);
    expect(scoreNameMatch('', 'Creatinine')).toBe(0);
    expect(scoreNameMatch('Paracetamol', null)).toBe(0);
  });
});

describe('terminology catalog targets', () => {
  test('covers the three local catalogs with sane defaults', () => {
    expect(Object.keys(CATALOG_TARGETS).sort()).toEqual(['investigation_test', 'medication', 'pharmacy_item']);
    expect(CATALOG_TARGETS.investigation_test.defaultSystem).toBe('LOINC');
    expect(CATALOG_TARGETS.pharmacy_item.defaultSystem).toBe('ATC');
    expect(CATALOG_TARGETS.medication.defaultSystem).toBe('ATC');
  });
});

describe('terminology importer parsers', () => {
  test('parseCsvLine handles quoted fields with embedded commas and quotes', () => {
    expect(parseCsvLine('2160-0,"Creatinine [Mass/volume] in Serum, Plasma",CHEM'))
      .toEqual(['2160-0', 'Creatinine [Mass/volume] in Serum, Plasma', 'CHEM']);
    expect(parseCsvLine('"a ""quoted"" word",b')).toEqual(['a "quoted" word', 'b']);
    expect(parseCsvLine('plain,row,3')).toEqual(['plain', 'row', '3']);
  });

  test('splitFsn separates the SNOMED semantic tag', () => {
    expect(splitFsn('Myocardial infarction (disorder)'))
      .toEqual({ display: 'Myocardial infarction', tag: 'disorder' });
    expect(splitFsn('Plain term without tag'))
      .toEqual({ display: 'Plain term without tag', tag: null });
  });
});
