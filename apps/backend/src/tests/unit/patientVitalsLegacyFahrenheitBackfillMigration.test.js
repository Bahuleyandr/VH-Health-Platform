// Shape + arithmetic tests for migration 718 (legacy raw-°F patient_vitals
// temperature backfill). Same precedent as fileScanBacklogReleaseMigrations
// / vitalBoundsMigration: DB-backed verification is deferred to the deep
// suites; these pin the SQL text and the heuristic's numeric properties so
// the safety-critical claims cannot drift silently:
//
//   * the file is a single UPDATE on patient_vitals only, no DDL;
//   * the WHERE band is exactly the canonical 12-45 °C plausibility band
//     projected into °F (53.6-113), i.e. impossible-as-°C AND plausible-as-°F;
//   * the conversion is (v - 32) * 5 / 9 rounded to one decimal;
//   * the transformation is idempotent — every output lands in [12, 45] and
//     can never re-match the WHERE band, and no post-fix write (clamped to
//     <= 45 °C by assertVitalPlausibility) can match it either.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { VITAL_PLAUSIBILITY_BOUNDS } from '../../utils/clinical/vitalPlausibility.js';

const sql718 = readFileSync(
  fileURLToPath(
    new URL('../../migrations/718_patient_vitals_legacy_fahrenheit_backfill.sql', import.meta.url),
  ),
  'utf8',
);

function statements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^(BEGIN|COMMIT)$/i.test(s));
}

// JS mirror of the migration's transformation, used to verify the numeric
// claims the SQL header makes.
const LOWER_F = 53.6; // 12 °C in °F
const UPPER_F = 113; // 45 °C in °F
const matchesBand = (v) => v != null && v >= LOWER_F && v <= UPPER_F;
const convert = (v) => Math.round(((v - 32) * 5 / 9) * 10) / 10;

describe('migration 718 — legacy °F patient_vitals temperature backfill', () => {
  it('is a single UPDATE on patient_vitals with no DDL', () => {
    const stmts = statements(sql718);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/^UPDATE patient_vitals/);
    expect(sql718).not.toMatch(/ALTER TABLE|CREATE |DROP |TRUNCATE/);
    // Only the temperature column is touched.
    expect(stmts[0]).not.toMatch(/heart_rate|blood_pressure|blood_sugar|spo2|weight|mood/);
  });

  it('pins the exact WHERE band and conversion expression', () => {
    const stmt = statements(sql718)[0];
    expect(stmt).toContain('SET temperature = ROUND((temperature - 32) * 5.0 / 9.0, 1)');
    expect(stmt).toContain('temperature IS NOT NULL');
    expect(stmt).toContain('temperature >= 53.6');
    expect(stmt).toContain('temperature <= 113');
  });

  it('band bounds are exactly the canonical °C plausibility band projected to °F', () => {
    const { min, max } = VITAL_PLAUSIBILITY_BOUNDS.temperature;
    expect((min * 9) / 5 + 32).toBeCloseTo(LOWER_F, 10);
    expect((max * 9) / 5 + 32).toBeCloseTo(UPPER_F, 10);
    // The band only selects values impossible as °C: its floor sits above the
    // °C plausibility ceiling, so no genuine canonical row can match.
    expect(LOWER_F).toBeGreaterThan(max);
  });

  it('converts representative legacy °F values to the expected canonical °C', () => {
    expect(convert(98.6)).toBeCloseTo(37.0, 10);
    expect(convert(96.8)).toBeCloseTo(36.0, 10);
    expect(convert(104)).toBeCloseTo(40.0, 10);
    expect(convert(53.6)).toBeCloseTo(12.0, 10); // band floor → °C floor
    expect(convert(113)).toBeCloseTo(45.0, 10); // band ceiling → °C ceiling
  });

  it('leaves values outside both plausible ranges untouched', () => {
    // Plausible °C values (post-fix writes are clamped <= 45) never match.
    for (const c of [12, 36.6, 37, 40, 44.9, 45]) {
      expect(matchesBand(c)).toBe(false);
    }
    // Garbage in either unit — between the °C ceiling and the °F floor, or
    // above the °F ceiling — never matches.
    for (const garbage of [45.1, 50, 53.5, 113.1, 120, 500]) {
      expect(matchesBand(garbage)).toBe(false);
    }
    expect(matchesBand(null)).toBe(false);
  });

  it('is idempotent: every converted output falls below the band floor and can never re-match', () => {
    // Sweep the whole band at 0.1 °F resolution.
    for (let v = LOWER_F; v <= UPPER_F; v = Math.round((v + 0.1) * 10) / 10) {
      if (!matchesBand(v)) continue;
      const out = convert(v);
      expect(out).toBeGreaterThanOrEqual(12);
      expect(out).toBeLessThanOrEqual(45);
      expect(matchesBand(out)).toBe(false); // re-running converts nothing
    }
  });

  it('documents the no-double-convert argument in the header', () => {
    expect(sql718).toMatch(/CANNOT DOUBLE-CONVERT/i);
    expect(sql718).toMatch(/IDEMPOTENT/i);
  });
});
