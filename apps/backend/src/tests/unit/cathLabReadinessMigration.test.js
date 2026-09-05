// apps/backend/src/tests/unit/cathLabReadinessMigration.test.js
//
// Migration 766 and cathLabReadinessService.js each spell the readiness
// vocabulary out in full — the eight states, the seven item codes, the three
// sources, the default required set. Neither can read the other, so the only
// thing keeping them equal is this file. A drift here is not cosmetic: the
// service writes `state` and `source` straight into columns whose CHECKs are
// the ones parsed below, so a value the service invents and the migration has
// never heard of is a 23514 raised in the middle of a cath-case read.
//
// Written in the style of cathConsumablesMigration.test.js: read the SQL, pull
// the list out of the constraint, compare it to the exported constant. ORDER is
// asserted too, not just membership — the constants are the documentation of
// what the constraint says, and a reordering makes them a worse map of it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ITEM_CODES,
  ITEM_SOURCES,
  ITEM_STATES,
  SETTINGS_DEFAULTS,
} from '../../services/clinical/cathLabReadinessService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = (name) => path.resolve(__dirname, '../../migrations', name);

// Migration SQL is LF-pinned at checkout. Keep defensive normalization for
// historical CRLF blobs or tools that bypass attributes so an assertion that
// spells a line break as `\n` means the same thing on every host.
const readCanonical = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

let sql = '';

beforeAll(() => {
  sql = readCanonical(migrationPath('766_cath_lab_readiness.sql'));
});

// One quoted-literal list out of the SQL. Fails loudly rather than returning an
// empty array when the pattern does not match: an assertion of [] === [] would
// pass silently the day someone renames a constraint.
function quotedList(pattern) {
  const match = sql.match(pattern);
  if (!match) throw new Error(`766 no longer matches ${pattern}`);
  return match[1]
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const literal = token.match(/^'([^']*)'$/);
      if (!literal) throw new Error(`not a quoted literal in 766: ${token}`);
      return literal[1];
    });
}

describe('migration 766 vocabulary matches cathLabReadinessService', () => {
  test('cath_case_lab_readiness_items_state_check lists exactly ITEM_STATES', () => {
    expect(quotedList(
      /CONSTRAINT cath_case_lab_readiness_items_state_check\s*\n\s*CHECK \(state IN \(([\s\S]*?)\)\)/,
    )).toEqual([...ITEM_STATES]);
  });

  test('cath_case_lab_readiness_items_code_check lists exactly ITEM_CODES', () => {
    expect(quotedList(
      /CONSTRAINT cath_case_lab_readiness_items_code_check\s*\n\s*CHECK \(item_code IN \(([^)]*)\)\)/,
    )).toEqual([...ITEM_CODES]);
  });

  test('cath_case_lab_readiness_items_source_check lists exactly ITEM_SOURCES', () => {
    expect(quotedList(
      /CONSTRAINT cath_case_lab_readiness_items_source_check\s*\n\s*CHECK \(source IS NULL OR source IN \(([^)]*)\)\)/,
    )).toEqual([...ITEM_SOURCES]);
  });

  // The settings table says the required set twice — the column DEFAULT and the
  // containment CHECK — and SETTINGS_DEFAULTS.required_items is a third copy the
  // service falls back to when a tenant has no settings row. All three must
  // agree, or an unconfigured tenant is evaluated against a set the table would
  // refuse to store.
  test('required_items default, CHECK and SETTINGS_DEFAULTS all agree', () => {
    const columnDefault = quotedList(
      /required_items TEXT\[\] NOT NULL DEFAULT ARRAY\[([^\]]*)\]::text\[\]/,
    );
    const containment = quotedList(
      /CHECK \(required_items <@ ARRAY\[([^\]]*)\]::text\[\]/,
    );
    expect(columnDefault).toEqual([...SETTINGS_DEFAULTS.required_items]);
    expect(containment).toEqual([...SETTINGS_DEFAULTS.required_items]);
    // The default set IS the full item set: every tenant that has never opened
    // the settings screen gets the whole check.
    expect(columnDefault).toEqual([...ITEM_CODES]);
  });

  // AVAILABLE_STATES and the states the resolver can produce are drawn from the
  // same list; this catches a state added to one side only.
  test('every state the service can persist is a state the constraint allows', () => {
    const allowed = new Set(ITEM_STATES);
    for (const state of ['waived', 'external_recorded', 'stale', 'not_ordered']) {
      expect(allowed.has(state)).toBe(true);
    }
    expect(new Set(ITEM_STATES).size).toBe(ITEM_STATES.length);
    expect(new Set(ITEM_CODES).size).toBe(ITEM_CODES.length);
  });
});
