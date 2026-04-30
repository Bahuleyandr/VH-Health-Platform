/**
 * Verifies migration 111 (clinical_protocols seed) is well-formed and stays
 * compatible with cdsEngine's evaluateProtocolTrigger /
 * evaluateUnmetRecommendations contracts. The migration itself runs against
 * a real DB in CI; this test catches regressions at the SQL-source level
 * (typos, drift in trigger keys, broken JSON, unknown priority values).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../migrations/111_clinical_protocols_seed.sql',
);

const KNOWN_TRIGGER_KEYS = new Set([
  'is_admitted',
  'admission_type',
  'department',
  'diagnosis_contains',
  'days_admitted_gte',
  'chief_complaint_contains',
  'code_status',
]);

const KNOWN_RECOMMENDATION_KEYS = new Set([
  'medications',
  'tests',
  'actions',
]);

const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);

const EXPECTED_PROTOCOLS = [
  'Sepsis 1-hour bundle',
  'VTE prophylaxis on admission',
  'Suspected DVT workup',
  'ARDS lung-protective ventilation',
  'ICU shift handover (SBAR)',
  'ED-to-ward handover (SHARED)',
];

function extractJsonbLiterals(sql) {
  const re = /'\s*({[\s\S]*?})\s*'::jsonb/g;
  return [...sql.matchAll(re)].map((m) => JSON.parse(m[1]));
}

function isRecommendationsBlob(blob) {
  return Object.keys(blob).some((key) => KNOWN_RECOMMENDATION_KEYS.has(key));
}

describe('migration 111 — clinical_protocols seed', () => {
  let sql;

  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  it('exists with non-trivial body', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('is wrapped in a transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it('declares idempotency via a unique index + ON CONFLICT', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_clinical_protocols_name/i);
    expect(sql).toMatch(/ON CONFLICT \(name\) DO NOTHING/i);
  });

  it('seeds the six canonical protocols by name', () => {
    for (const name of EXPECTED_PROTOCOLS) {
      expect(sql).toContain(`'${name}'`);
    }
  });

  it('uses only valid priority values', () => {
    // Pull every '<word>'  literal that immediately precedes a closing
    // ) of an INSERT row — last column is priority.
    const re = /,\s*'(high|medium|low|critical|urgent|none|info|warning)'\s*\)/gi;
    const matches = [...sql.matchAll(re)].map((m) => m[1].toLowerCase());
    expect(matches.length).toBe(EXPECTED_PROTOCOLS.length);
    for (const priority of matches) {
      expect(VALID_PRIORITIES.has(priority)).toBe(true);
    }
  });

  it('every jsonb literal parses as valid JSON', () => {
    const blobs = extractJsonbLiterals(sql);
    // 6 protocols × 2 jsonb columns = 12 blobs minimum.
    expect(blobs.length).toBeGreaterThanOrEqual(12);
    for (const blob of blobs) {
      expect(typeof blob).toBe('object');
    }
  });

  it('every trigger_conditions blob uses only cdsEngine-recognised keys', () => {
    const blobs = extractJsonbLiterals(sql);
    const triggers = blobs.filter((blob) => !isRecommendationsBlob(blob));
    expect(triggers.length).toBe(EXPECTED_PROTOCOLS.length);
    for (const trigger of triggers) {
      for (const key of Object.keys(trigger)) {
        expect(KNOWN_TRIGGER_KEYS.has(key)).toBe(true);
      }
    }
  });

  it('every recommendations blob carries at least one of medications / tests / actions', () => {
    const blobs = extractJsonbLiterals(sql);
    const recs = blobs.filter(isRecommendationsBlob);
    expect(recs.length).toBe(EXPECTED_PROTOCOLS.length);
    for (const rec of recs) {
      const hasAny =
        Array.isArray(rec.medications) ||
        Array.isArray(rec.tests) ||
        Array.isArray(rec.actions);
      expect(hasAny).toBe(true);
      for (const key of Object.keys(rec)) {
        expect(KNOWN_RECOMMENDATION_KEYS.has(key)).toBe(true);
      }
    }
  });

  it('sepsis protocol carries the SSC 1-hour bundle essentials', () => {
    const blobs = extractJsonbLiterals(sql);
    // Find the sepsis trigger by diagnosis_contains.
    const sepsisTrigger = blobs.find(
      (b) => Array.isArray(b.diagnosis_contains) && b.diagnosis_contains.some((d) => /sepsis/i.test(d)),
    );
    expect(sepsisTrigger).toBeDefined();
    // The recommendations block immediately after — find by lactate test.
    const sepsisRecs = blobs.find(
      (b) => Array.isArray(b.tests) && b.tests.some((t) => /lactate/i.test(t)),
    );
    expect(sepsisRecs).toBeDefined();
    expect(sepsisRecs.tests.some((t) => /blood culture/i.test(t))).toBe(true);
    expect(sepsisRecs.medications.some((m) => /antibiotic/i.test(m))).toBe(true);
  });

  it('ARDS protocol explicitly references ARDSNet tidal-volume and PEEP guidance', () => {
    const blobs = extractJsonbLiterals(sql);
    const ardsRecs = blobs.find(
      (b) => Array.isArray(b.actions) && b.actions.some((a) => /tidal volume/i.test(a) && /6 mL\/kg/i.test(a)),
    );
    expect(ardsRecs).toBeDefined();
    expect(ardsRecs.actions.some((a) => /PEEP/i.test(a))).toBe(true);
    expect(ardsRecs.actions.some((a) => /prone/i.test(a))).toBe(true);
  });

  it('every protocol has at least one trigger key (no all-empty triggers)', () => {
    const blobs = extractJsonbLiterals(sql);
    const triggers = blobs.filter((blob) => !isRecommendationsBlob(blob));
    for (const trigger of triggers) {
      expect(Object.keys(trigger).length).toBeGreaterThan(0);
    }
  });
});
