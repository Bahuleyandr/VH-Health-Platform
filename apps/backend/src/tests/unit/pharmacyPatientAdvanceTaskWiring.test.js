import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');

const taskService = read('services/workflow/taskService.js');
const pharmacyCapService = read('services/pharmacy/pharmacyCapService.js');

function sliceBetween(source, start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe('pharmacy patient-advance task wiring', () => {
  it('keeps every substitution funding task behind the domain workflow', () => {
    const guard = sliceBetween(
      taskService,
      'function isSubstitutionFundingApprovalTask',
      'function assertGenericTaskMutationAllowed',
    );

    expect(guard).toContain("'pharmacy_tpa_line_decision'");
    expect(guard).toContain("'pharmacy_posted_payment'");
    expect(guard).toContain("'pharmacy_patient_advance'");
  });

  it('recognizes an active patient-advance task as counter-funding recovery', () => {
    const recovery = sliceBetween(
      pharmacyCapService,
      'if (orderRows.length === 0)',
      'const activeFundingTargets',
    );

    expect(recovery).toContain("'pharmacy_tpa_line_decision'");
    expect(recovery).toContain("'pharmacy_posted_payment'");
    expect(recovery).toContain("'pharmacy_patient_advance'");
    expect(recovery).toContain("task.status IN ('open','in_progress','blocked','overdue')");
    expect(recovery).toContain('posted-payment, patient-advance, or TPA authority');
    expect(recovery).toContain("next_action: recovery ? 'open_exact_pharmacy_funding_task'");
  });
});
