import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../../migrations/741_ward_indent_authoritative_state_machine.sql', import.meta.url),
  'utf8',
);
const supportService = readFileSync(
  new URL('../../services/ipd/ipdSupportService.js', import.meta.url),
  'utf8',
);
const workflowService = readFileSync(
  new URL('../../services/ipd/wardIndentWorkflowService.js', import.meta.url),
  'utf8',
);

const STATUSES = [
  'requested',
  'reserved',
  'short_supply',
  'substitution_pending',
  'controlled_handoff_required',
  'approved',
  'issued',
  'partially_received',
  'received',
  'return_pending',
  'reconciliation_required',
  'reconciled',
  'rejected',
  'cancelled',
  'closed',
];

describe('migration 741 ward-indent authoritative state-machine contract', () => {
  test('pins the complete lifecycle and an SLA identity for every nonterminal row', () => {
    const statusConstraint = migration.match(
      /ADD CONSTRAINT ward_indents_status_v2_check[\s\S]*?CHECK \(status IN \(([\s\S]*?)\)\)\s*,/i,
    );
    expect(statusConstraint).not.toBeNull();
    for (const status of STATUSES) expect(statusConstraint[1]).toContain(`'${status}'`);
    expect(migration).toContain('ADD CONSTRAINT ward_indents_active_sla_state_check');
    expect(migration).toContain("status IN ('rejected', 'cancelled', 'closed') AND active_sla_source_id IS NULL");
    expect(migration).toContain("status NOT IN ('rejected', 'cancelled', 'closed') AND active_sla_source_id IS NOT NULL");
  });

  test('projects safe defaults while requiring versioned evidence for every durable state', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION ward_indent_project_state_defaults()');
    expect(migration).toContain("ARRAY['PHARMACY_STAFF', 'PHARMACY_INCHARGE', 'PHARMACIST']::TEXT[]");
    expect(migration).toContain("CONCAT('ward-indent:', NEW.id, ':v', NEW.state_version)");
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF status, state_version, active_sla_source_id');
    expect(migration).toContain('CREATE TRIGGER ward_indent_next_state_version');
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER ward_indent_transition_evidence');
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain('has no matching transition evidence');
  });

  test('makes transition evidence tenant-bound, versioned, idempotent, RLS-enforced, and append-only', () => {
    expect(migration).toContain('CREATE TABLE ward_indent_events');
    expect(migration).toContain('UNIQUE (tenant_id, ward_indent_id, state_version)');
    expect(migration).toContain('CREATE UNIQUE INDEX ux_ward_indent_events_command_key');
    expect(migration).toContain('ALTER TABLE ward_indent_events ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE ward_indent_events FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY tenant_isolation ON ward_indent_events');
    expect(migration).toContain('CREATE POLICY ward_indents_explicit_tenant_context');
    expect(migration).toContain('CREATE POLICY ward_indent_items_explicit_tenant_context');
    expect(migration).toContain('CREATE POLICY ward_indent_events_explicit_tenant_context');
    expect(migration.match(/AS RESTRICTIVE/g)).toHaveLength(3);
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON ward_indent_events');
    expect(migration).toContain('EXECUTE FUNCTION audit_append_only_guard()');
  });

  test('binds every item and clinical or controlled evidence reference to the same tenant', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_invoice_items_ward_indent');
    expect(migration).toContain("WHERE source_ref_type = 'ward_indent'");
    expect(migration).toContain('ADD CONSTRAINT fk_ward_indent_items_indent_tenant');
    expect(migration).toContain('FOREIGN KEY (tenant_id, ward_indent_id)');
    expect(migration).toContain('ADD CONSTRAINT fk_ward_indent_items_clinical_order_tenant');
    expect(migration).toContain('ADD CONSTRAINT fk_ward_indent_items_controlled_return_movement_tenant');
    expect(migration).toContain('ADD CONSTRAINT fk_ward_indent_items_controlled_return_register_tenant');
    expect(migration).toContain('ADD CONSTRAINT ward_indent_items_controlled_return_evidence_check');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS ux_ward_indent_items_clinical_order');
  });

  test('makes an admission authoritative for the indent patient and encounter context', () => {
    expect(migration).toContain('UPDATE ward_indents indent');
    expect(migration).toContain('patient_uid = admission.patient_uid');
    expect(migration).toContain('ward indent admission patient or encounter context is inconsistent');
    expect(migration).toContain('CREATE TRIGGER ward_indent_admission_context');
    expect(migration).toContain('ward indent patient must match the linked admission patient');
    expect(migration).toContain('ward indent encounter must match the linked admission encounter');
  });

  test('promotes only same-patient clinical-order notes and rejects mismatched typed links', () => {
    expect(migration).toContain('clinical_order.patient_uid = indent.patient_uid');
    expect(migration).toContain('CREATE TRIGGER ward_indent_item_clinical_order_context');
    expect(migration).toContain('ward indent clinical order must match the indent patient');
    expect(migration).toContain('ward indent clinical order must match the indent encounter');
    expect(workflowService).not.toContain('matchAll(/clinical_order_id:');
  });

  test('seeds all six fail-closed ownership clocks', () => {
    const ruleCodes = [...migration.matchAll(/\(NULL, '(ward_indent_[a-z_]+)'/g)]
      .map((match) => match[1]);
    expect(ruleCodes).toEqual([
      'ward_indent_pharmacy_response',
      'ward_indent_substitution_authorization',
      'ward_indent_controlled_handoff',
      'ward_indent_pharmacy_issue',
      'ward_indent_ward_receipt',
      'ward_indent_reconciliation',
    ]);
    expect(migration).toContain("ARRAY['DOCTOR', 'DUTY_DOCTOR', 'CONSULTANT', 'JUNIOR_DOCTOR', 'RESIDENT']::TEXT[]");
    expect(migration).toContain("ARRAY['PHARMACY_INCHARGE', 'NURSING_INCHARGE', 'IP_INCHARGE', 'ICU_INCHARGE']::TEXT[]");
  });

  test('routes both production creation paths through transactional initialization', () => {
    expect(supportService.match(/ward_indents\.create\(/g)).toHaveLength(2);
    expect(supportService.match(/initializeWardIndentWorkflowTx\(tx,/g)).toHaveLength(2);
    expect(workflowService).toContain('await appendTransitionEvidence(tx');
    expect(workflowService).toContain('await rotateSla(tx, current, updated, action)');
    expect(workflowService).toContain('recordCanonicalClinicalEvent');
  });
});
