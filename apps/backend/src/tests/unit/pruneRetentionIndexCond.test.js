// src/tests/unit/pruneRetentionIndexCond.test.js
//
// Migration 804 redefines public.prune_scheduled_job_run_evidence(), first
// defined in migration 668, changing exactly one token:
//   clock_timestamp()  ->  statement_timestamp()
//
// Nothing in CI validates a plpgsql body after the baseline, so a syntax slip
// in a redefinition reaches the database. The defence is that the new body is
// provably the old one with a single substitution — which is what this suite
// asserts, mechanically, rather than by review.
import { readFileSync } from 'node:fs';

const M668 = readFileSync(
  new URL('../../migrations/668_scheduler_truth_and_notification_tenant_integrity.sql', import.meta.url),
  'utf8',
);
const M804 = readFileSync(
  new URL('../../migrations/804_prune_scheduled_job_run_evidence_index_cond.sql', import.meta.url),
  'utf8',
);

const DEFINITION = /CREATE OR REPLACE FUNCTION public\.prune_scheduled_job_run_evidence\(\)[\s\S]*?\n\$function\$;\n/;

function definitionIn(source, label) {
  const match = DEFINITION.exec(source);
  if (!match) { throw new Error(`no prune definition found in ${label}`); }
  return match[0];
}

describe('migration 804 — retention prune cutoff', () => {
  const before = definitionIn(M668, '668');
  const after = definitionIn(M804, '804');

  it('finds a real function body in both migrations', () => {
    // Population guard: an empty or truncated match would make every
    // comparison below vacuously true.
    expect(before.length).toBeGreaterThan(400);
    expect(after.length).toBeGreaterThan(400);
    expect(before).toContain('LANGUAGE plpgsql');
    expect(after).toContain('LANGUAGE plpgsql');
  });

  it('changes the cutoff from a VOLATILE to a STABLE timestamp function', () => {
    // clock_timestamp() is VOLATILE, so Postgres cannot use it as an index
    // scan boundary and the retention index degrades to a per-row filter.
    expect(before.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(before).not.toContain('statement_timestamp()');

    expect(after.match(/statement_timestamp\(\)/g)).toHaveLength(1);
    expect(after).not.toContain('clock_timestamp()');
  });

  it('changes NOTHING else — the new body is the old one with one substitution', () => {
    expect(after.replace('statement_timestamp()', 'clock_timestamp()')).toBe(before);
  });

  it('keeps the retention window, the batch limit and the locking clause', () => {
    for (const fragment of [
      "INTERVAL '400 days'",
      'LIMIT 1000',
      'FOR UPDATE SKIP LOCKED',
      'RETURNS integer',
      'SECURITY DEFINER',
      'SET search_path = pg_catalog, public',
      'RETURN deleted_count;',
    ]) {
      expect(after).toContain(fragment);
    }
  });

  it('is the whole of migration 804 — no other statement rides along', () => {
    // Anchor on the full statement, not on 'CREATE OR REPLACE FUNCTION' alone:
    // that phrase also appears in the header comment, and slicing from there
    // would silently compare the wrong span.
    const START = 'CREATE OR REPLACE FUNCTION public.prune_scheduled_job_run_evidence()';
    const at = M804.indexOf(START);
    expect(at).toBeGreaterThan(-1);
    const body = M804.slice(at);
    expect(body.trim()).toBe(after.trim());

    // And nothing executable hides above it: every line before the definition
    // is a comment or blank.
    const header = M804.slice(0, at);
    const executable = header
      .split('\n')
      .filter(line => line.trim() !== '' && !line.trimStart().startsWith('--'));
    expect(executable).toEqual([]);
  });

  it('does not re-issue the grants that CREATE OR REPLACE preserves', () => {
    // 668 owns the REVOKE/GRANT posture. Repeating it here would be the easy
    // way to accidentally widen or narrow execute rights on a SECURITY DEFINER
    // function.
    expect(after).not.toMatch(/\bGRANT\b/);
    expect(after).not.toMatch(/\bREVOKE\b/);
  });
});

describe('migration 804 — registry', () => {
  const playbook = readFileSync(
    new URL('../../../../../docs/superpowers/NEXT_LEVEL_EXECUTION_PLAYBOOK.md', import.meta.url),
    'utf8',
  );

  it('is covered by a §5 registry row, and 804 is no longer advertised as free', () => {
    const section = playbook.slice(playbook.indexOf('## 5. Migration number registry'));
    expect(section.length).toBeGreaterThan(1000);
    expect(section).toMatch(/^\| 804 \|/m);
    expect(section).not.toContain('**804 is next-free**');
    expect(section).toContain('**805 is next-free**');
  });
});
