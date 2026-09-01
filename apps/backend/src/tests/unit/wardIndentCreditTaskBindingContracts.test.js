import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function source(relativePath) {
  return fs.readFileSync(path.resolve(here, '../../', relativePath), 'utf8');
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe('ward-indent credit-note task binding contracts', () => {
  test('materialization locks the note and CAS-binds exactly one canonical task', () => {
    const obligation = source('services/ipd/wardIndentObligationService.js');
    const materialization = between(
      obligation,
      'async function lockCreditNoteTaskBinding',
      'export async function completeBillingCreditNoteObligationTx',
    );
    expect(materialization).toContain('FROM billing_credit_notes');
    expect(materialization).toContain('FOR UPDATE');
    expect(materialization).toContain('related_resource_type = \'billing_credit_notes\'');
    expect(materialization).toContain('UPDATE billing_credit_notes');
    expect(materialization).toContain('SET task_id = $3::int');
    expect(materialization).toContain('(task_id IS NULL OR task_id = $3::int)');
    expect(materialization.indexOf('lockCreditNoteTaskBinding(')).toBeLessThan(
      materialization.indexOf('createWardMedicationObligationTaskTx({'),
    );
    expect(materialization.indexOf('createWardMedicationObligationTaskTx({')).toBeLessThan(
      materialization.indexOf('await bindCreditNoteTask(tx'),
    );
  });

  test('every credit lifecycle stage resolves the persisted task identity', () => {
    const obligation = source('services/ipd/wardIndentObligationService.js');
    for (const functionName of [
      'completeBillingCreditNoteObligationTx',
      'advanceBillingCreditNoteObligationTx',
      'advanceBillingCreditNoteRefundObligationTx',
      'advanceBillingCreditNoteRefundPayoutObligationTx',
      'completeBillingCreditNoteRefundObligationTx',
    ]) {
      const start = obligation.indexOf(`export async function ${functionName}`);
      const next = obligation.indexOf('\nexport async function ', start + 1);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = obligation.slice(start, next < 0 ? obligation.length : next);
      expect(body).toContain('loadOpenCreditNoteTask(');
      expect(body).toContain('creditNote.task_id');
    }
  });

  test('draft-invoice auto-application binds and evidence-completes the same obligation', () => {
    const billing = source('services/billing/billingCreditNoteService.js');
    const projection = between(
      billing,
      'export async function createBillingCreditNoteFromFinancialEventTx',
      'export async function listBillingCreditNotes',
    );
    expect(projection).toContain("eventType: 'raised'");
    expect(projection).toContain('auto_applied_draft: draft');
    expect(projection).toContain("authority: 'draft_invoice_projection'");
    expect(projection).toContain("eventType: 'applied'");
    expect(projection).toContain('completeBillingCreditNoteObligationTx(tx, {');
    expect(projection).toContain("evidenceKind: 'billing_credit_note_application'");
    expect(projection.indexOf("eventType: 'applied'")).toBeLessThan(
      projection.indexOf('completeBillingCreditNoteObligationTx(tx, {'),
    );
    expect(projection).toContain('return loadCreditNoteTx(tx, tid, note.id)');
    expect(projection.indexOf('materializeBillingCreditNoteObligationTx(tx, {')).toBeLessThan(
      projection.lastIndexOf('return loadCreditNoteTx(tx, tid, note.id)'),
    );
  });

  test('ward closure rejects any unbound or nonterminal finance obligation with exact 409 code', () => {
    const workflow = source('services/ipd/wardIndentWorkflowService.js');
    const reconciliation = between(
      workflow,
      'async function assertWardIndentFinancialReconciliationCompleteTx',
      'export async function closeWardIndent',
    );
    const close = between(
      workflow,
      'export async function closeWardIndent',
      'export async function listWardIndents',
    );
    expect(reconciliation).toContain('WARD_INDENT_FINANCIAL_RECONCILIATION_REQUIRED');
    expect(reconciliation).toContain('credit_note_task_missing');
    expect(reconciliation).toContain('credit_note_task_nonterminal');
    expect(reconciliation).toContain('credit_note_sla_nonterminal');
    expect(close).toContain('assertWardIndentFinancialReconciliationCompleteTx(tx, current)');
  });
});
