// Guard pin for the `care_pathway_stage` identifier (SLA-halves audit,
// docs/CANONICAL_CLINICAL_TIMELINE.md "Workflow SLA" note).
//
// `care_pathway_stage` is NOT a workflow SLA rule. It exists only as the
// COALESCE fallback obligation-label inside the care-pathway DB
// routing/ownership functions (migrations 585/586:
// `COALESCE(NULLIF(BTRIM(sla.rule_code), ''), 'care_pathway_stage')`) and the
// matching readiness-audit script. It has deliberately never been seeded into
// `workflow_sla_rules`, and no service passes it to `startWorkflowSla` — the
// workflow definition compiler requires an explicit `sla_rule_code` for any
// stage semantics that arm a clock, so no fallback path can reach
// `startWorkflowSla` with this label.
//
// If product ever wants a default per-stage clock, that is a deliberate
// wire-up (rule seed migration + compiler default), not an accident. This
// test makes an accidental half-wire fail loudly in either direction:
//  * seeding the label as a rule without touching the compiler, or
//  * a service starting/completing clocks under the label without a seed.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LABEL = 'care_pathway_stage';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('care_pathway_stage is a routing fallback label, not an SLA rule', () => {
  test('no migration seeds care_pathway_stage into workflow_sla_rules', () => {
    const migrationsDir = path.join(SRC_ROOT, 'migrations');
    const offenders = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .filter((name) => {
        const sql = readFileSync(path.join(migrationsDir, name), 'utf8');
        return sql.includes(LABEL) && sql.includes('workflow_sla_rules');
      });
    expect(offenders).toEqual([]);
  });

  test('no service or util references the label (only the DB routing functions may)', () => {
    const offenders = [];
    for (const dir of ['services', 'controllers', 'utils', 'config']) {
      const root = path.join(SRC_ROOT, dir);
      for (const file of walk(root)) {
        if (!file.endsWith('.js')) continue;
        if (readFileSync(file, 'utf8').includes(LABEL)) {
          offenders.push(path.relative(SRC_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the fallback label itself still exists in the routing functions (guard must not rot)', () => {
    // The COALESCE fallback appears both inline and split across lines —
    // match the shape, not one formatting.
    const fallbackShape = new RegExp(
      String.raw`COALESCE\(\s*NULLIF\(BTRIM\([\w.]*rule_code\),\s*''\),\s*'${LABEL}'\s*\)`,
    );
    for (const migration of [
      '585_care_pathway_exclusive_owner_integrity.sql',
      '586_care_pathway_owner_acceptance.sql',
    ]) {
      const sql = readFileSync(path.join(SRC_ROOT, 'migrations', migration), 'utf8');
      expect(sql).toMatch(fallbackShape);
    }
  });
});
