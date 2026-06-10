// Roadmap B2 — drug KB pure helpers.

import {
  canonicalPair,
  frequencyPerDay,
  parseFlatDoseMg,
  matchMonographKeys,
} from '../../services/clinical/drugKnowledgeBaseService.js';

describe('drug KB canonicalPair', () => {
  test('orders lexicographically and normalizes case/whitespace', () => {
    expect(canonicalPair('Sildenafil', 'nitroglycerin')).toEqual(['nitroglycerin', 'sildenafil']);
    expect(canonicalPair('  warfarin ', 'Aspirin')).toEqual(['aspirin', 'warfarin']);
  });
});

describe('drug KB frequencyPerDay', () => {
  test('standard Indian/Latin tokens', () => {
    expect(frequencyPerDay('OD')).toBe(1);
    expect(frequencyPerDay('bd')).toBe(2);
    expect(frequencyPerDay('TDS')).toBe(3);
    expect(frequencyPerDay('QID')).toBe(4);
    expect(frequencyPerDay('qds')).toBe(4); // must not substring-match 'qd'
    expect(frequencyPerDay('q8h')).toBe(3);
    expect(frequencyPerDay('every 6 h')).toBe(4);
    expect(frequencyPerDay('HS')).toBe(1);
  });

  test('1-0-1 style notation sums doses', () => {
    expect(frequencyPerDay('1-0-1')).toBe(2);
    expect(frequencyPerDay('1-1-1')).toBe(3);
    expect(frequencyPerDay('1 - 0 - 0')).toBe(1);
  });

  test('PRN/SOS and garbage return null (no daily bound guessed)', () => {
    expect(frequencyPerDay('SOS')).toBeNull();
    expect(frequencyPerDay('PRN pain')).toBeNull();
    expect(frequencyPerDay('with meals?')).toBeNull();
    expect(frequencyPerDay('')).toBeNull();
    expect(frequencyPerDay(null)).toBeNull();
  });
});

describe('drug KB parseFlatDoseMg', () => {
  test('parses mg/g/mcg', () => {
    expect(parseFlatDoseMg('500 mg')).toBe(500);
    expect(parseFlatDoseMg('1g')).toBe(1000);
    expect(parseFlatDoseMg('250mcg')).toBe(0.25);
  });
  test('refuses mg/kg and syrup-strength text (owned by paediatric check)', () => {
    expect(parseFlatDoseMg('15 mg/kg')).toBeNull();
    expect(parseFlatDoseMg('125mg/5ml syrup 10 ml')).toBeNull();
  });
  test('refuses doseless text', () => {
    expect(parseFlatDoseMg('two tablets')).toBeNull();
    expect(parseFlatDoseMg('')).toBeNull();
  });
});

describe('drug KB matchMonographKeys', () => {
  const monographs = [
    { drug_key: 'ibuprofen', aliases: ['brufen', 'combiflam'] },
    { drug_key: 'paracetamol', aliases: ['crocin', 'dolo', 'acetaminophen'] },
    { drug_key: 'ringer lactate', aliases: ['hartmann'] },
  ];

  test('matches by key, by Indian brand alias, and multi-word keys', () => {
    expect(matchMonographKeys(monographs, 'tab ibuprofen 400mg')).toEqual(['ibuprofen']);
    expect(matchMonographKeys(monographs, 'Tab Brufen 400'.toLowerCase())).toEqual(['ibuprofen']);
    expect(matchMonographKeys(monographs, 'dolo 650 tablet')).toEqual(['paracetamol']);
    expect(matchMonographKeys(monographs, 'iv ringer lactate 500ml')).toEqual(['ringer lactate']);
  });

  test('returns empty for unknown drugs and empty input', () => {
    expect(matchMonographKeys(monographs, 'tab amlodipine 5mg')).toEqual([]);
    expect(matchMonographKeys(monographs, '')).toEqual([]);
  });
});
