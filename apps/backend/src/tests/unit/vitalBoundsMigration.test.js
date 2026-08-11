import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ICU_FLOWSHEET_BOUNDS,
  ICU_FLOWSHEET_VITAL_FIELDS,
} from '../../utils/clinical/icuPlausibility.js';

const migrationPath = fileURLToPath(
  new URL('../../migrations/654_relax_icu_flowsheet_peri_arrest_bounds.sql', import.meta.url),
);
const migrationSql = readFileSync(migrationPath, 'utf8');

function compact(value) {
  return value.toLowerCase().replace(/[()\s]/g, '');
}

function expectedBetweenContract() {
  return ICU_FLOWSHEET_VITAL_FIELDS
    .map((field) => {
      const { min, max } = ICU_FLOWSHEET_BOUNDS[field];
      return `${field}isnullor${field}between${min}and${max}`;
    })
    .join('and');
}

describe('migration 654 ICU peri-arrest bounds', () => {
  it('uses the deploy-safe runner directives and an atomic constraint replacement', () => {
    expect(migrationSql).toContain('-- @no-transaction');
    expect(migrationSql).toContain('-- @statement_timeout: 0');
    expect(migrationSql).toMatch(
      /ALTER TABLE icu_flowsheet_entries\s+DROP CONSTRAINT[\s\S]+ADD CONSTRAINT chk_icu_flowsheet_vitals_plausible/,
    );
    expect(migrationSql).toContain(') NOT VALID;');
  });

  it('derives every migrated floor and ceiling from the server contract', () => {
    const checkBody = migrationSql.match(
      /ADD CONSTRAINT chk_icu_flowsheet_vitals_plausible CHECK\s*\(([\s\S]+)\)\s*NOT VALID;/,
    )?.[1];
    expect(checkBody).toBeDefined();
    expect(compact(checkBody)).toBe(expectedBetweenContract());
  });
});
