import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');

const taskService = read('services/workflow/taskService.js');
const pharmacyCapService = read('services/pharmacy/pharmacyCapService.js');
const billingV2Service = read('services/billing/billingV2Service.js');

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

  // Patient-advance funding tasks are created ONLY by
  // substitutionFundingReauthorisationService, and only under the
  // `pharmacy_substitution_funding_task_v1` contract. Their authority is
  // therefore held at the substitution barrier that counter funding must pass
  // through before it resolves anything — not at the recovery hint below.
  it('holds patient-advance funding authority at the substitution barrier', () => {
    const resourceTypes = sliceBetween(
      pharmacyCapService,
      'const SUBSTITUTION_FUNDING_RESOURCE_TYPES = [',
      '];',
    );
    expect(resourceTypes).toContain("'pharmacy_tpa_line_decision'");
    expect(resourceTypes).toContain("'pharmacy_posted_payment'");
    expect(resourceTypes).toContain("'pharmacy_patient_advance'");

    const barrier = sliceBetween(
      pharmacyCapService,
      'export async function lockCounterFundingSubstitutionAuthorityTx',
      'function consumeCounterFundingSubstitutionAuthorityLease',
    );
    expect(barrier).toContain('SUBSTITUTION_FUNDING_RESOURCE_TYPES');
    expect(barrier).toContain('SUBSTITUTION_FUNDING_TASK_CONTRACT');
    expect(barrier).toContain("status IN ('open','in_progress','blocked','overdue')");
    expect(barrier).toContain('FOR UPDATE');
    // The barrier is fail-closed: any active substitution task, approval, or
    // command that is not the exact governed owner refuses the lease outright,
    // so a live patient-advance task can never be stepped over.
    expect(barrier).toContain('throw substitutionFundingConflict({');
  });

  // The counter-funding conflict's `funding_recovery` hint points the caller at
  // an already-open funding task. It is scoped to the OTHER contract,
  // `pharmacy_funding_task_v1`, so its resource-type list has to match exactly
  // what that contract can carry — see the pairing assertion below.
  it('offers counter-funding recovery only for a task its contract can own', () => {
    const recovery = sliceBetween(
      pharmacyCapService,
      'if (orderRows.length === 0)',
      'const activeFundingTargets',
    );

    expect(recovery).toContain("'pharmacy_funding_task_v1'");
    expect(recovery).toContain("task.metadata->>'contract'=$3");
    expect(recovery).toContain("task.metadata->>'pharmacy_order_id'=$2");
    expect(recovery).toContain("'pharmacy_tpa_line_decision'");
    expect(recovery).toContain("'pharmacy_posted_payment'");
    expect(recovery).toContain(
      "(task.related_resource_type='pharmacy_tpa_line_decision'\n"
      + "              AND task.metadata->>'task_type'='tpa_line_decision')",
    );
    expect(recovery).toContain(
      "(task.related_resource_type='pharmacy_posted_payment'\n"
      + "              AND task.metadata->>'task_type'='posted_payment')",
    );
    expect(recovery).toContain("task.status IN ('open','in_progress','blocked','overdue')");
    expect(recovery).toContain('posted-payment, patient-advance, or TPA authority');
    expect(recovery).toContain("next_action: recovery ? 'open_exact_pharmacy_funding_task'");
    // `pharmacy_patient_advance` is deliberately absent: no writer creates that
    // resource type under `pharmacy_funding_task_v1`, so listing it would be a
    // predicate that can never match. Should a patient-advance branch ever be
    // added to the writer pinned below, this assertion fails and forces the
    // recovery lookup to be widened with it.
    expect(recovery).not.toContain("'pharmacy_patient_advance'");
  });

  it('creates funding-contract tasks only as TPA-line-decision or posted-payment', () => {
    const writer = sliceBetween(
      billingV2Service,
      'async function upsertPharmacyFundingTaskTx',
      'const rows = await tx.$queryRawUnsafe',
    );

    expect(writer).toContain("contract: 'pharmacy_funding_task_v1'");
    expect(writer).toContain(
      "const resourceType = taskType === 'tpa_line_decision'\n"
      + "    ? 'pharmacy_tpa_line_decision'\n"
      + "    : 'pharmacy_posted_payment';",
    );
    expect(writer).not.toContain("'pharmacy_patient_advance'");
  });
});
