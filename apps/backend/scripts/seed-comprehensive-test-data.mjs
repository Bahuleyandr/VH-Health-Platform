import bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { seedCurrentBedStructure } from './seed-current-bed-structure.mjs';
import { compileWorkflowDefinition } from '../src/services/workflow/workflowDefinitionCompiler.js';
import {
  INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION,
  compileInpatientAdmissionToRecoveryDefinition
} from '../src/services/pathways/inpatientPathwayDefinition.js';
import { CLINICAL_CONTINUITY_SEED_FIXTURE } from './lib/clinicalContinuitySeedFixture.mjs';
import { INTENTIONALLY_EMPTY_SEED_TABLES } from '../src/db/seedCoveragePolicy.js';
import { assertSyntheticSeedTarget } from './lib/testDataSeedGuard.mjs';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const STAFF_PASSWORD = process.env.VH_TEST_STAFF_PASSWORD || ['test', '1234'].join('');
const ADMIN_PASSWORD = process.env.VH_TEST_ADMIN_PASSWORD || STAFF_PASSWORD;
const SEED_TAG = 'vh_seed';
const I05_SEED_PAYLOAD = 'MSH|^~\\&|VH|SEED|BACKEND|SEED|20260802000000||ADT^A01|VH-SEED-I05|P|2.5';
const I05_SEED_PAYLOAD_HASH = createHash('sha256').update(I05_SEED_PAYLOAD, 'utf8').digest('hex');
const FHIR_VITAL_SEED_OBSERVED_AT = new Date('2026-05-04T09:00:00.000Z');
const FHIR_VITAL_SEED_RESOURCE_ID = 'vh-seed-heart-rate';
const FHIR_VITAL_SEED_RESOURCE_FINGERPRINT = `fhir:${createHash('sha256')
  .update('vhhealth:seed:fhir-vital:heart-rate', 'utf8')
  .digest('hex')}`;
const FHIR_VITAL_SEED_SET_FINGERPRINT = `fhir-set:${createHash('sha256')
  .update(FHIR_VITAL_SEED_RESOURCE_FINGERPRINT, 'utf8')
  .digest('hex')}`;
// Continuity authorization and replay remain inert until their approval gates
// are satisfied. Synthetic credentials or immutable receipts would violate
// those activation boundaries.
const INTENTIONALLY_EMPTY_TABLES = new Set(INTENTIONALLY_EMPTY_SEED_TABLES);
const MANUAL_SEED_TABLES = new Set([
  // Care-pathway and lab-ingest coverage must be coherent evidence graphs.
  // The generic walker cannot satisfy their tenant-composite links, immutable
  // canonical receipts, definition pins, or exact task/SLA lifecycle checks.
  'workflow_definitions',
  'workflow_runs',
  'workflow_steps',
  'tasks',
  'task_comments',
  'approvals',
  'workflow_sla_instances',
  'care_pathway_definition_governance',
  'care_pathway_instances',
  'care_pathway_transition_events',
  'care_handoff_instances',
  'care_pathway_reconciliation_checks',
  // Scheduled notifications are tenant-owned user obligations. Seed one
  // explicit composite-tenant fixture instead of asking the generic walker to
  // guess a user/tenant pair.
  'scheduled_notifications',
  // C3.1 continuity governance must not be synthesized by the generic FK
  // walker. Seed one cryptographically valid draft under a suspended,
  // non-default test tenant and one legacy snapshot; never create an active
  // policy or a clinical_continuity_pack publication.
  'clinical_continuity_policy_versions',
  'downtime_snapshots',
  // S5 ED closure/recovery rows require the exact visit/patient/encounter/
  // clinician graph plus canonical timeline and audit receipts.
  'ed_closure_evidence',
  'ed_recovery_contact_events',
  // S4 OP/inpatient evidence tables require one coherent pathway, admission,
  // named-owner, task, generation, outbox, timeline, and audit graph.
  'care_pathway_resource_references',
  'op_visit_closure_evidence',
  'inpatient_primary_physician_assignments',
  'discharge_pending_result_handoffs',
  'discharge_pending_result_owner_actions',
  'post_discharge_contact_events',
  'diagnostic_result_generations',
  'diagnostic_result_generation_items',
  'diagnostic_result_actions',
  'diagnostic_result_release_states',
  'diagnostic_result_patient_notifications',
  // C6.1-D provider evidence is append-only and claim-fenced. Seed one
  // coherent accepted attempt instead of synthesizing disconnected rows.
  'notification_delivery_attempts',
  'notification_provider_receipts',
  'notification_delivery_cursors',
  // I05 dependency graph. These rows must share one tenant/channel/version;
  // the generic walker cannot safely infer that composite ownership.
  'interop_systems',
  'interop_channels',
  'interop_channel_versions',
  'interop_messages',
  // C6.1-E I04 outbound HL7 evidence is append-only and claim-fenced. Seed
  // one correlated MSA|AA graph without performing provider egress.
  'hl7_outbound_transport_attempts',
  'hl7_outbound_transport_results',
  'hl7_outbound_acknowledgements',
  'hl7_outbound_delivery_cursors',
  // C6.1-E I05 adapter receipts are append-only and must match the message's
  // tenant, channel, version, protocol, direction, hash, and byte count.
  'interop_backend_delivery_receipts',
  'referrals',
  'referral_transition_events',
  'referral_responses',
  'referral_patient_notifications',
  'clinical_timeline_events',
  'clinical_audit_events',
  'lab_analyzers',
  'lab_pathologist_signoffs',
  'lab_results',
  'lab_critical_alerts',
  'lab_critical_alert_acknowledgement_receipts',
  'lab_critical_alert_reconciliation_receipts',
  'lab_oru_ingest_messages',
  'lab_result_ingest_commands',
  // FHIR vital receipts are immutable, mutually linked provenance. The generic
  // walker cannot create a valid array payload, fingerprint, or same-scope
  // receipt -> set -> vitals graph, so seed one coherent completed import below.
  'fhir_vital_observation_receipts',
  'fhir_vital_observation_sets',
  'fhir_vital_observation_set_resources',
  'insurance_claim_caps',
  // Migration 669 makes the current payroll attempt a required, deferrable
  // back-reference from payroll_runs. Seed the circular run/attempt graph and
  // its first payslip/document/result coherently below.
  'payroll_runs',
  'payroll_run_attempts',
  'payroll_run_staff_results',
  'payslips',
  'payslip_documents',
  // Pillar-D workflow tables — domain CHECKs the auto-seeder can't
  // satisfy (ordered time windows, slot holds, XOR dosing, FDI tooth
  // codes, plan-anchored cycles). Seeded by seedPillarDWorkflowTables below.
  'provider_availability_templates',
  'appointment_slot_holds',
  'resource_bookings',
  // NL13-P1f: the link row must reference the REAL seeded booking/room/case —
  // resource_bookings itself is manually seeded AFTER the generic walk, so the
  // generic pass would have no parent to point at. Seeded alongside it in
  // seedPillarDWorkflowTables below.
  'cath_case_schedule_links',
  'chemo_protocol_drugs',
  'chemo_cycles',
  'dental_tooth_findings',
  // Double-entry ledger transactional tables — migration 344 added a
  // constraint trigger (ledger_assert_entry_balanced, DEFERRABLE INITIALLY
  // DEFERRED) requiring each entry's postings to sum to 0 at COMMIT. The
  // naive auto-seeder inserts a single unbalanced posting, which aborts the
  // whole seed transaction. They still need a row for the seeded-coverage
  // contract, so seedLedgerEntries below inserts one balanced journal entry
  // (two postings netting to zero) instead.
  'ledger_entries',
  'ledger_postings',
  // NL-1 identity SSO tables have realm/protocol/role CHECK constraints
  // that the generic relaxed seeder cannot infer safely.
  'tenant_identity_providers',
  'tenant_idp_role_mappings',
  // N6-1 radiology peer review rows must carry distinct reviewer/author
  // humans. The generic auto-seeder assigns one semantic UUID to both.
  'radiology_peer_reviews',
  // N6-2 donor intake: volume_ml BETWEEN 100 AND 650 and sha256_hash
  // ~ '^[0-9a-f]{64}$' CHECKs reject the generic seeder's values.
  'donation_events',
  'donor_consents',
  // NL-7 P3 biomedical CMMS rows need a valid device -> schedule -> work-order
  // chain plus timestamp/check-constrained certificate data.
  'clinical_ai_biomed_devices',
  'biomed_maintenance_schedules',
  'biomed_work_orders',
  'biomed_work_order_updates',
  'biomed_work_order_recipients',
  'biomed_calibration_certificates',
  // NL-7 P2 cold-chain units need a fridge-sensor device and an ordered
  // min/max temperature range before child readings/excursions can seed.
  'cold_chain_units',
  // MED-03 medication closure is a single causal evidence graph. The generic
  // FK walker cannot preserve exact order, batch, custody, MAR, invoice, and
  // credit-note lineage across its append-only projections, so seed the
  // complete synthetic lifecycle together below.
  'ward_indent_inventory_allocations',
  'ward_indent_inventory_movement_links',
  'mar_administration_command_receipts',
  'mar_transition_command_receipts',
  'mar_supply_consumptions',
  'mar_supply_reconciliation_links',
  'ward_indent_financial_events',
  'billing_credit_notes',
  'billing_credit_note_events',
  // N6-12 mortuary slots enforce occupancy consistency: an available
  // slot cannot carry a current body reference.
  'mortuary_slots',
  // N6-10 infusion chair coverage needs an active chair plus an ordered,
  // cycle-date-aligned booking window.
  'infusion_chairs',
  'chair_bookings',
  // NL11-S1 migration toolkit: source_row_number is a plain INTEGER the
  // generic seeder fills with semantic strings, and content_sha256/row_hash
  // carry 64-lowercase-hex CHECKs. NL11-S9 adds HL7 ADT hash + enum checks
  // that also need constraint-aware values.
  'migration_source_files',
  'migration_import_records',
  'migration_hl7_adt_batches',
  'migration_hl7_adt_messages',
  // NL12-S2 SIEM: transport/severity/source enums + CHAR(64) hex hashes +
  // a redaction CHECK that forbids raw_payload_exported=true.
  'siem_export_targets',
  'siem_export_cursors',
  'siem_export_events',
  'siem_export_delivery_attempts',
  // NL-14 ICU chart depth rows have clinical review/provenance gates and
  // exact-one-source links that the generic foreign-key seeder cannot infer.
  'icu_device_observation_links',
  'icu_scoring_outputs',
  'icu_weaning_trials',
  // NL-13 P5 perfusion sign-offs require reviewer/timestamp pairs; a minimal
  // draft row must be linked to the generated perfusion record explicitly.
  'perfusion_signoffs',
  // NL-13 P6 transplant suite: organ enums, non-empty organ arrays, and
  // clinical chain FKs need a coherent program -> candidate -> review seed.
  'transplant_program_settings',
  'transplant_programs',
  'transplant_candidates',
  'transplant_waitlist_status_history',
  'transplant_donor_referrals',
  'transplant_match_reviews',
  'transplant_committee_reviews',
  'transplant_immunosuppression_plans',
  'transplant_notto_exports',
  // NL-14 ED evidence requires exactly one source pointer; seed below.
  'ed_encounter_evidence',
  // NL-14 P2 resuscitation rows carry status/finalize/content CHECK gates,
  // an append-only trigger, and MAR/device link invariants the generic
  // seeder cannot satisfy.
  'resuscitation_settings',
  'resuscitation_events',
  'resuscitation_event_timeline',
  'resuscitation_team_roles',
  'resuscitation_medication_links',
  'resuscitation_device_links',
  'resuscitation_qa_reviews',
  // NL-14 P3 NICU/PICU rows carry per-kind payload CHECKs (typed feed/
  // fluid/jaundice events) and an owner-approval reference gate on score
  // outputs that the generic seeder cannot satisfy.
  'nicu_feed_fluid_entries',
  'nicu_jaundice_phototherapy_events',
  'nicu_picu_scoring_outputs',
  // Sign-off 2026-07-13: migration 573 seeds stemi_pathway_settings for every
  // tenant (incl. the default tenant), so the generic walker's default-tenant
  // insert would collide on the tenant_id PK. The migration owns this row.
  'stemi_pathway_settings',
]);

const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL or TEST_DATABASE_URL is required.');
}

assertSyntheticSeedTarget({
  connectionString,
  scriptName: 'seed-comprehensive-test-data.mjs',
});

const client = new pg.Client({ connectionString });
await client.connect();

const quote = (ident) => `"${String(ident).replaceAll('"', '""')}"`;
const clip = (value, max) => {
  const text = String(value);
  return max && text.length > max ? text.slice(0, max) : text;
};

async function tableCount(table) {
  const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${quote(table)}`);
  return result.rows[0].count;
}

async function columnExists(table, column) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return result.rowCount > 0;
}

async function tableExists(table) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
      LIMIT 1`,
    [table]
  );
  return result.rowCount > 0;
}

async function insert(table, row) {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    await client.query(`INSERT INTO ${quote(table)} DEFAULT VALUES`);
    return;
  }

  const columns = entries.map(([key]) => quote(key)).join(', ');
  const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
  const values = entries.map(([, value]) => value);
  await client.query(`INSERT INTO ${quote(table)} (${columns}) VALUES (${placeholders})`, values);
}

async function insertIfEmpty(table, rows) {
  if (await tableCount(table)) return 0;
  let inserted = 0;
  for (const row of rows) {
    await insert(table, row);
    inserted += 1;
  }
  return inserted;
}

async function insertIfTenantEmpty(table, rows, tenantId = DEFAULT_TENANT_ID) {
  const existing = await client.query(
    `SELECT 1 FROM ${quote(table)} WHERE tenant_id = $1::uuid LIMIT 1`,
    [tenantId],
  );
  if (existing.rowCount) return 0;
  let inserted = 0;
  for (const row of rows) {
    await insert(table, row);
    inserted += 1;
  }
  return inserted;
}

async function first(table, select = '*', where = 'TRUE', params = []) {
  const result = await client.query(
    `SELECT ${select} FROM ${quote(table)} WHERE ${where} LIMIT 1`,
    params
  );
  return result.rows[0] || null;
}

async function firstValue(table, column) {
  const row = await first(table, quote(column));
  return row?.[column] ?? null;
}

async function firstTenantValue(table, column) {
  const row = await first(
    table,
    quote(column),
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );
  return row?.[column] ?? null;
}

async function getMetadata() {
  const columns = await client.query(`
    SELECT c.table_name,
           c.column_name,
           c.udt_name,
           c.data_type,
           c.is_nullable,
           c.column_default,
           c.is_identity,
           c.is_generated,
           c.character_maximum_length,
           c.ordinal_position
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position
  `);

  const fks = await client.query(`
    SELECT child_table.relname AS table_name,
           child_column.attname AS column_name,
           parent_table.relname AS foreign_table_name,
           parent_column.attname AS foreign_column_name
      FROM pg_constraint fk
      JOIN pg_class child_table
        ON child_table.oid = fk.conrelid
      JOIN pg_namespace child_namespace
        ON child_namespace.oid = child_table.relnamespace
      JOIN pg_class parent_table
        ON parent_table.oid = fk.confrelid
      JOIN pg_namespace parent_namespace
        ON parent_namespace.oid = parent_table.relnamespace
      JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY AS child_key(attnum, position)
        ON TRUE
      JOIN LATERAL unnest(fk.confkey) WITH ORDINALITY AS parent_key(attnum, position)
        ON parent_key.position = child_key.position
      JOIN pg_attribute child_column
        ON child_column.attrelid = child_table.oid
       AND child_column.attnum = child_key.attnum
      JOIN pg_attribute parent_column
        ON parent_column.attrelid = parent_table.oid
       AND parent_column.attnum = parent_key.attnum
     WHERE fk.contype = 'f'
       AND child_namespace.nspname = 'public'
       AND parent_namespace.nspname = 'public'
     ORDER BY child_table.relname, fk.conname, child_key.position
  `);

  const checks = await client.query(`
    SELECT conrelid::regclass::text AS table_name,
           pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE contype = 'c'
       AND connamespace = 'public'::regnamespace
  `);

  const columnsByTable = new Map();
  for (const row of columns.rows) {
    if (!columnsByTable.has(row.table_name)) columnsByTable.set(row.table_name, []);
    columnsByTable.get(row.table_name).push(row);
  }

  const fkByTableColumn = new Map();
  for (const row of fks.rows) {
    fkByTableColumn.set(`${row.table_name}.${row.column_name}`, row);
  }

  const checksByTable = new Map();
  const xorPairsByTable = new Map();
  for (const row of checks.rows) {
    if (!checksByTable.has(row.table_name)) checksByTable.set(row.table_name, []);
    checksByTable.get(row.table_name).push(row.definition);
    const xor = detectXorPair(row.definition);
    if (xor && !xorPairsByTable.has(row.table_name)) {
      xorPairsByTable.set(row.table_name, xor);
    }
  }

  return { columnsByTable, fkByTableColumn, checksByTable, xorPairsByTable };
}

function detectXorPair(definition) {
  // Mutually-exclusive pair: exactly one of (A, B) must be NOT NULL.
  // Matches `(A IS NOT NULL AND B IS NULL) OR (A IS NULL AND B IS NOT NULL)`
  // regardless of how many parens pg_get_constraintdef wraps each clause in.
  const stripped = definition.replace(/[()]/g, ' ').replace(/\s+/g, ' ');
  const re = /([a-z_][a-z0-9_]*)\s+IS\s+NOT\s+NULL\s+AND\s+([a-z_][a-z0-9_]*)\s+IS\s+NULL\s+OR\s+\1\s+IS\s+NULL\s+AND\s+\2\s+IS\s+NOT\s+NULL/i;
  const match = stripped.match(re);
  return match ? [match[1], match[2]] : null;
}

function checkedValue(checksByTable, table, column) {
  const textTypes = new Set(['bpchar', 'char', 'name', 'text', 'varchar']);
  if (!textTypes.has(column.udt_name)) return null;

  const definitions = checksByTable.get(table) || [];
  const lowerColumn = column.column_name.toLowerCase();
  for (const definition of definitions) {
    if (!definition.toLowerCase().includes(lowerColumn)) continue;
    const values = [...definition.matchAll(/'([^']+)'(?:::|,|\)|\])/g)].map((match) => match[1]);
    const cleaned = values.filter((value) => (
      !value.includes('::')
      && value.length <= 80
      && !/[\\^$[\]{}+*?]/.test(value)
    ));
    if (cleaned.length) return cleaned[0];
  }
  return null;
}

function semanticValue(column, table, index, ctx, maxLength) {
  const name = column.column_name.toLowerCase();
  const tablePrefix = table.replace(/[^a-z0-9]+/gi, '_').slice(0, 28);
  const text = (value) => clip(value, maxLength);

  if (column.data_type === 'ARRAY' || column.udt_name.startsWith('_')) return [];
  if (name === 'tenant_id') return ctx.tenantId;
  if (name === 'patient_uid') return ctx.patient.uid;
  if (name === 'doctor_uid' || name === 'surgeon' || name === 'anesthetist') return ctx.doctor.uid;
  if (name.includes('staff_uid') || name === 'sender_uid' || name === 'recipient_uid') return ctx.staff.uid;
  if (name.endsWith('_uid') || name === 'uid') return ctx.generatedUuid;

  if (name === 'patient_id') return column.udt_name === 'uuid' ? ctx.patient.uid : ctx.patient.id;
  if (name === 'doctor_id') return column.udt_name === 'uuid' ? ctx.doctor.uid : ctx.doctor.id;
  if (name === 'staff_id') return column.udt_name === 'uuid' ? ctx.staff.uid : ctx.staff.userId;
  if (name === 'user_id') return column.udt_name === 'uuid' ? ctx.staff.uid : ctx.staff.userId;
  if (name === 'created_by' || name === 'updated_by' || name === 'changed_by') {
    return column.udt_name === 'uuid' ? ctx.staff.uid : ctx.staff.userId;
  }
  if (name.includes('appointment_id')) return ctx.appointmentId;
  if (name.includes('admission_id')) return ctx.admissionId;
  if (name.includes('department_id')) return ctx.departmentId;
  if (name.includes('ward_id')) return ctx.wardId;
  if (name.includes('bed_id')) return ctx.bedId;
  if (name.includes('pharmacy_order_id')) return ctx.pharmacyOrderId;
  if (name.includes('investigation_id')) return ctx.investigationId;
  if (name.includes('claim_id')) {
    return column.udt_name === 'uuid' ? ctx.generatedUuid : ctx.invoiceId;
  }
  if (name.includes('ot_schedule_id')) return ctx.otScheduleId;
  if (name.includes('care_plan_id')) return ctx.carePlanId;
  if (name.includes('chat_session_id')) return ctx.chatSessionId;
  if (name.includes('task_id')) return ctx.taskId;
  if (name.includes('api_client_id')) return ctx.apiClientId;
  if (name.includes('from_node_id') || name.includes('to_node_id')) return ctx.kgNodeId;

  if (table === 'ophthalmic_biometry' && name === 'axial_length_mm') return 23.5;

  if (name.includes('phone')) return text(`+919777${String(index).padStart(5, '0')}`);
  if (name.includes('email')) return text(`${tablePrefix}.${name}@example.test`);
  if (name === 'blood_group') return text('O+');
  if (name === 'component') return text('PRBC');
  if (name === 'gender') return text('Female');
  if (name.includes('priority')) return text('routine');
  if (name.includes('severity')) return text('low');
  if (name.includes('status')) return text('active');
  if (name.includes('role')) return text('staff');
  if (name.includes('type') || name.includes('kind') || name.includes('category')) return text('general');
  if (name.includes('code')) return text(`CODE-${index}`);
  if (name.includes('number') && ['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money'].includes(column.udt_name)) return 1;
  if (name.includes('number')) return text(`VH-${String(index).padStart(5, '0')}`);
  if (name.includes('key')) return text(`${SEED_TAG}_${tablePrefix}_${index}`);
  if (name.includes('sha256')) return text('0'.repeat(64));
  if (name.includes('hash')) return text(`hash_${tablePrefix}_${index}`);
  if (name.includes('url')) return text(`https://example.test/${tablePrefix}/${index}`);
  if (name.includes('name') || name.includes('title') || name.includes('label')) return text(`Seed ${tablePrefix}`);
  if (name.includes('description') || name.includes('reason') || name.includes('notes') || name.includes('body')) {
    return text(`Synthetic local test data for ${table}.${column.column_name}`);
  }
  if (name.includes('date')) {
    if (column.udt_name === 'date' || column.udt_name === 'timestamp' || column.udt_name === 'timestamptz') {
      return new Date('2026-05-04T00:00:00.000Z');
    }
  }
  if (name.includes('time')) {
    if (column.udt_name === 'time' || column.udt_name === 'timetz') return '09:00:00';
    if (column.udt_name === 'timestamp' || column.udt_name === 'timestamptz') {
      return new Date('2026-05-04T09:00:00.000Z');
    }
  }
  if (/(^|_)(lat|latitude)($|_)/.test(name)) return 13.02936;
  if (/(^|_)(lng|lon|longitude)($|_)/.test(name)) return 80.24409;
  if (name === 'volume_ml') return 450;
  if (name.includes('amount') || name.includes('cost') || name.includes('rate') || name.includes('score')) return 1;
  if (name.includes('count') || name.includes('total') || name.includes('units') || name.includes('minutes')) return 1;

  return undefined;
}

// Constraint-aware per-table overrides for columns the generic heuristics
// cannot satisfy: conditional CHECKs that tie one column's validity to
// another column's value. rowForTable also consults this map so a NULLABLE
// override column is still filled (the generic walk skips nullable non-FK
// columns). Keep entries minimal and tied to the migration that needs them.
const TABLE_COLUMN_SEED_OVERRIDES = {
  // mig 591: structured Radiology/AP sign-off and addendum evidence is
  // all-or-nothing. Seed complete, internally consistent normal-result
  // snapshots instead of letting the generic FK walker populate only the
  // signer columns and violate the coupled CHECK constraints.
  radiology_orders: {
    status: 'signed_off',
    ordered_by: (ctx) => ctx.doctor.uid,
    radiologist: (ctx) => ctx.doctor.uid,
    report: 'Seed radiology report with no diagnostic abnormality.',
    structured_report: JSON.stringify({
      sections: { impression: 'No diagnostic abnormality.' },
      seed: true,
    }),
    report_completed_at: () => new Date('2026-05-04T09:00:00.000Z'),
    report_signed_off_at: () => new Date('2026-05-04T09:00:00.000Z'),
    report_signed_off_by: (ctx) => ctx.doctor.uid,
    result_classification: 'normal',
    classification_basis: JSON.stringify({ explicit_normal_flag: true, seed: true }),
    report_generation_version: 1,
    classification_signed_by: (ctx) => ctx.doctor.uid,
    classification_signed_at: () => new Date('2026-05-04T09:00:00.000Z'),
    signoff_idempotency_key: 'seed-radiology-signoff-v1',
    signoff_request_sha256: '0'.repeat(64),
  },
  radiology_report_addenda: {
    generation_version: 2,
    previous_classification: 'normal',
    result_classification: 'normal',
    classification_basis: JSON.stringify({ explicit_normal_flag: true, seed: true }),
    clinical_significance: 'unchanged',
    signed_by: (ctx) => ctx.doctor.uid,
    idempotency_key: 'seed-radiology-addendum-v2',
    request_sha256: '1'.repeat(64),
  },
  ap_reports: {
    report_status: 'final',
    diagnosis_text: 'Seed anatomic pathology report with no diagnostic abnormality.',
    report_author_uid: (ctx) => ctx.doctor.uid,
    signed_at: () => new Date('2026-05-04T09:00:00.000Z'),
    signed_by: (ctx) => ctx.doctor.uid,
    result_classification: 'normal',
    classification_basis: JSON.stringify({ explicit_normal_flag: true, seed: true }),
    report_generation_version: 1,
    classification_signed_by: (ctx) => ctx.doctor.uid,
    signoff_idempotency_key: 'seed-ap-signoff-v1',
    signoff_request_sha256: '2'.repeat(64),
  },
  ap_report_addenda: {
    generation_version: 2,
    previous_classification: 'normal',
    result_classification: 'normal',
    classification_basis: JSON.stringify({ explicit_normal_flag: true, seed: true }),
    clinical_significance: 'unchanged',
    addendum_by: (ctx) => ctx.doctor.uid,
    idempotency_key: 'seed-ap-addendum-v2',
    request_sha256: '3'.repeat(64),
  },
  // mig 562: started_at/due_at became nullable, but NULL is legal only for
  // stemi-sourced rows carrying explicit *_pending metadata — the generic
  // row must supply both clocks or every SLA-linked dependent cascades.
  workflow_sla_instances: {
    started_at: () => new Date('2026-05-04T09:00:00.000Z'),
    due_at: () => new Date('2026-05-04T10:00:00.000Z'),
  },
  // mig 558: stemi_activations_door_clock requires door_time_at unless the
  // activation is a prehospital handover; pick the source whose branch the
  // generic row satisfies without coordinating three clock columns.
  stemi_activations: {
    activation_source: 'prehospital_handover',
  },
  // mig 414: body_custody_release_has_method requires release_method whenever
  // event_type = 'release'. checkedValue() scans the table's CHECK definitions
  // in pg_constraint order — which is UNORDERED — and event_type appears in
  // two of them: the IN-list (first literal 'receive', row passes) and the
  // conditional CHECK (first literal 'release', row fails because the nullable
  // release_method is never filled). Whichever definition the catalog returns
  // first decided pass vs fail — the intermittent 801/802 seeded-coverage
  // failure. Pin the safe branch deterministically.
  body_custody_events: {
    event_type: 'receive',
  },
  // mig 704 has the same catalog-order ambiguity: event_type appears in both
  // its allowed-values CHECK and a conditional transition-evidence CHECK. If
  // the latter is visited first, checkedValue() chooses status_changed while
  // nullable to_status remains unset. Pin a non-transition event so the seed
  // is deterministic on fresh PostgreSQL catalogs.
  facility_asset_events: {
    event_type: 'created',
  },
  // migs 563-565: keep the generic cath usage row on the non-batch,
  // non-implant branch while satisfying its tenant-composite references.
  cath_consumable_catalog: {
    tenant_id: (ctx) => ctx.tenantId,
    inventory_item_id: async () => firstValue('pharmacy_inventory_items', 'id'),
  },
  cath_case_consumable_usage: {
    tenant_id: (ctx) => ctx.tenantId,
    case_id: async () => firstValue('cath_lab_cases', 'id'),
    procedure_log_id: null,
    catalog_item_id: async () => firstValue('cath_consumable_catalog', 'id'),
    patient_uid: async () => firstValue('cath_lab_cases', 'patient_uid'),
    inventory_batch_id: null,
    batch_tracked: false,
    is_implant: false,
    inventory_movement_id: null,
    timeline_event_id: null,
    audit_event_id: null,
  },
  surgical_implants: {
    tenant_id: (ctx) => ctx.tenantId,
    cath_case_id: null,
    cath_usage_id: null,
  },
  // mig 603: seed the preserved pathway-registry row shape. External recovery
  // rows require operator-owned policy, retention, and cursor evidence and
  // must never be synthesized by the generic coverage walker.
  event_consumer_offsets: {
    scope_kind: 'pathway_registry',
    tenant_id: null,
    facility_scope: null,
    facility_id: null,
    historical_cutoff_event_id: 0,
    backfill_cursor_event_id: 0,
    registration_operability_action_id: null,
    resume_operability_action_id: null,
  },
  pathway_projector_inbox: {
    scope_kind: 'pathway_registry',
    event_id: 0,
    offset_id: null,
    facility_id: null,
    pending_task_id: null,
  },
  // mig 620: generic coverage represents ordinary live webhook configuration
  // and an ad-hoc occurrence. Recovery provenance and owner classifications
  // are never invented by the comprehensive seed mirror.
  webhook_subscriptions: {
    downstream_effect_classification: 'unclassified',
    acknowledgement_contract: 'unclassified',
    acknowledgement_config: {},
    recovery_contract_owner_uid: null,
    recovery_contract_owner_reason: null,
    recovery_contract_classified_at: null,
  },
  webhook_deliveries: {
    event_outbox_id: null,
    payload: {},
    source_kind: 'adhoc',
    source_identity: 'seed-webhook-delivery',
    source_position: null,
    payload_sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    downstream_effect_classification: 'unclassified',
    acknowledgement_contract: 'unclassified',
    acknowledgement_config: {},
    acknowledgement_state: 'unclassified',
    acknowledgement_evidence: null,
    acknowledged_at: null,
    send_authority: 'live_authorized',
    recovery_inbox_id: null,
    recovery_interface_family: null,
    recovery_owner_uid: null,
    recovery_owner_reason: null,
    recovery_evidence: null,
    effect_disposition: 'live',
  },
  // mig 621: generic coverage represents an ordinary in-progress provider
  // page. A seed row never invents provider completeness, revision evidence,
  // opaque continuation, or canonical recovery ownership.
  clinical_ai_trial_sync_runs: {
    status: 'running',
    finished_at: null,
    error_message: null,
    source_partition: `clinicaltrials_gov_v2:${'a'.repeat(64)}`,
    provider_page_number: 1,
    provider_page_token: 'origin',
    provider_page_token_sha256: createHash('sha256').update('origin', 'utf8').digest('hex'),
    provider_next_page_token: null,
    provider_next_page_token_sha256: null,
    provider_revision: null,
    provider_page_sha256: null,
    provider_page_complete: false,
    recovery_inbox_id: null,
    recovery_interface_family: null,
    recovery_owner_uid: null,
    recovery_owner_reason: null,
    recovery_evidence: null,
    effect_disposition: 'live',
  },
  clinical_trials_catalog: {
    provider_revision: null,
    source_payload_sha256: null,
    source_sync_run_id: null,
  },
  // migs 607/608: recovery links and pending evidence are backed by exact
  // canonical-inbox rows. Generic coverage data has no such occurrence.
  lab_interface_messages: {
    protocol: 'hl7v2',
    recovery_inbox_id: null,
    recovery_interface_family: null,
    recovery_critical_result_ids: [],
    recovery_pending_task_id: null,
  },
  // mig 624: release receipt links are command evidence. Generic coverage
  // rows must remain ordinary live/held messages and never synthesize release.
  hl7_outbound_messages: {
    tenant_id: (ctx) => ctx.tenantId,
    owner_release_client_event_id: null,
  },
  vitals_chart: {
    recovery_inbox_id: null,
    recovery_interface_family: null,
  },
  // mig 611: generic coverage represents an ordinary live HL7v2 message and
  // its protocol-adapter receipt. Recovery provenance is owner-supplied only.
  interop_messages: {
    tenant_id: (ctx) => ctx.tenantId,
    protocol: 'hl7v2',
    direction: 'inbound',
    message_type: 'ADT^A01',
    external_control_id: 'VH-SEED-I05',
    payload_hash: I05_SEED_PAYLOAD_HASH,
    raw_payload_ciphertext: null,
    raw_payload_retained: false,
    parsed_summary: JSON.stringify({
      seed: true,
      message_type: 'ADT^A01',
      control_id: 'VH-SEED-I05',
    }),
    status: 'received',
    recovery_ledger_version: 0,
    source_position: null,
    source_token: null,
    predecessor_token: null,
    recovery_inbox_id: null,
    recovery_interface_family: null,
    arrival_class: 'live',
    effect_disposition: 'live',
    send_authority: 'live_authorized',
    owner_reconciliation_required: false,
    delivery_claim_token: null,
    delivery_claimed_at: null,
    delivery_lease_expires_at: null,
    owner_release_client_event_id: null,
  },
  // mig 618: generic coverage represents legacy/live ABDM rows. Recovery
  // ownership and canonical-inbox provenance are owner-supplied only.
  abdm_data_requests: {
    recovery_inbox_id: null,
    recovery_interface_family: null,
    recovery_owner_uid: null,
    recovery_owner_reason: null,
    recovery_disposition: null,
    recovery_claimed_at: null,
  },
  abdm_webhook_events: {
    receipt_source: null,
    recovery_inbox_id: null,
    recovery_interface_family: null,
    recovery_owner_uid: null,
    recovery_owner_reason: null,
    recovery_disposition: null,
    source_partition: null,
    source_position: null,
    source_token: null,
    predecessor_token: null,
    duplicate_key: null,
  },
  // mig 619: generic coverage represents an ordinary live NHCX envelope.
  // Recovery provenance and stranded-processing ownership are owner-supplied.
  nhcx_messages: {
    tenant_id: (ctx) => ctx.tenantId,
    environment: 'sandbox',
    cycle: 'eligibility',
    recovery_inbox_id: null,
    recovery_interface_family: null,
    recovery_owner_uid: null,
    recovery_owner_reason: null,
    recovery_disposition: null,
    recovery_claimed_at: null,
    recovery_prior_status: null,
    recovery_evidence: null,
    source_partition: null,
    source_position: null,
    source_token: null,
    predecessor_token: null,
    duplicate_key: null,
    inbound_claim_token: null,
    inbound_claimed_at: null,
    inbound_completed_at: null,
    inbound_owner_uid: null,
    inbound_owner_reason: null,
    inbound_owner_disposition: null,
    inbound_owner_claimed_at: null,
    owner_release_client_event_id: null,
  },
  // mig 604: legacy staff-device rows remain valid only when both identity
  // pointers are absent, while user_devices must not infer continuity or
  // facility authority for an ordinary pre-enrollment device.
  staff_devices: {
    staff_id: null,
    user_uid: null,
  },
  user_devices: {
    facility_id: null,
    continuity_grant_id: null,
    continuity_grant_purpose: null,
    continuity_capture_revision: null,
    continuity_context_id: null,
    continuity_context_revision: null,
    continuity_session_jti_sha256: null,
    continuity_issued_at: null,
    continuity_expires_at: null,
    continuity_validated_at: null,
    continuity_validation_state: null,
  },
  cold_chain_readings: {
    tenant_id: (ctx) => ctx.tenantId,
    unit_id: async () => firstValue('cold_chain_units', 'id'),
    device_registry_id: async () => firstValue('device_registry', 'id'),
    facility_id: null,
    recovery_inbox_id: null,
  },
  // The FHIR AllergyIntolerance reader is deliberately fail-closed: a
  // tenant-wide read refuses outright if ANY active row cannot be attributed to
  // a patient, so an unattributable allergy is never silently dropped from a
  // clinical allergy feed. patient_allergies.patient_id and .patient_uid are
  // both NULLABLE and carry no FK, so the generic walk skipped both (it only
  // fills NOT NULL columns, FK columns, and overrides) and left a patientless
  // seed row that poisoned every tenant-wide read. Seed a real patient on both
  // columns and keep them consistent — the reader rejects a uid/id pair that
  // disagrees just as hard as it rejects a missing one.
  patient_allergies: {
    patient_id: (ctx) => ctx.patient.id,
    patient_uid: (ctx) => ctx.patient.uid,
  },
  // Same reader, second source, same reason: an active allergy whose substance
  // is unknown is unusable clinically, so the reader refuses rather than serve
  // a nameless entry. `allergen` and its legacy alias `name` are both NULLABLE,
  // so the generic walk left the seed row with no substance at all. patient_uid
  // is NOT NULL here and is already filled by the generic walk.
  allergies: {
    allergen: 'Seed allergen (synthetic)',
  },
  // The birth-notification schema currently declares VARCHAR(12) while its
  // legacy default "indeterminate" is 13 characters. Use an explicitly valid
  // value so fresh-DB coverage does not depend on that incompatible default.
  birth_notifications: {
    sex: 'female',
    mother_patient_uid: (ctx) => ctx.patient.uid,
  },
  // Optional dependent linkage is real consent evidence, not synthetic seed
  // material. A plain family contact remains a valid coverage row.
  family_members: {
    linked_dependent_uid: null,
    linked_at: null,
    link_consent_method: null,
    link_consent_ref: null,
  },
  fhir_allergy_intolerance_receipts: {
    resource_fingerprint: '4'.repeat(64),
    payload_sha256: '5'.repeat(64),
  },
  hl7_inbound_clinical_receipts: {
    sender_identity: 'VH-SEED-SENDER',
    message_control_id: 'VH-SEED-INBOUND-CLINICAL',
    message_type: 'ADT^A01',
    payload_sha256: '6'.repeat(64),
    detail_table: 'admissions',
    detail_id: async () => firstTenantValue('admissions', 'id'),
  },
  mis_report_schedules: {
    report_keys: ['daily-ops'],
    cadence: 'daily',
    recipients: ['seed-mis@example.test'],
    send_weekday: null,
    send_day_of_month: null,
  },
  mis_report_deliveries: {
    report_keys: ['daily-ops'],
    outcome: 'uncertain',
    provider_message_id: null,
  },
  payment_gateway_orders: {
    provider: 'dry_run',
    environment: 'sandbox',
    status: 'created',
    reconciled_at: null,
    reconciliation_note: null,
    reconciled_by: null,
  },
  payment_gateway_refunds: {
    provider: 'dry_run',
    environment: 'sandbox',
    status: 'initiated',
    reconciled_at: null,
    reconciliation_note: null,
    reconciled_by: null,
  },
  payment_gateway_webhook_events: {
    provider: 'dry_run',
    environment: 'sandbox',
    status: 'pending',
  },
  pharmacy_counter_sales: {
    status: 'IN_PROGRESS',
    void_refund_id: null,
    voided_at: null,
    voided_by: null,
    void_reason: null,
  },
  staff_on_call_assignments: {
    staff_id: (ctx) => ctx.staff.staffId,
    staff_uid: (ctx) => ctx.staff.uid,
    start_at: () => new Date('2026-05-04T09:00:00.000Z'),
    end_at: () => new Date('2026-05-04T17:00:00.000Z'),
    is_active: true,
    ended_at: null,
  },
  staff_shift_swap_requests: {
    requester_id: (ctx) => ctx.staff.staffId,
    requester_uid: (ctx) => ctx.staff.uid,
    requester_assignment_id: null,
    counterparty_id: (ctx) => ctx.secondStaff.staffId,
    counterparty_uid: (ctx) => ctx.secondStaff.uid,
    counterparty_assignment_id: null,
    status: 'cancelled',
    counterparty_responded_at: null,
    decided_by: null,
    decided_by_uid: null,
    decided_at: null,
    expires_at: () => new Date('2026-05-05T09:00:00.000Z'),
  },
  // Addenda are legal only after the parent procedure report is signed.
  cath_procedure_reports: {
    status: 'signed',
    preliminary_by: (ctx) => ctx.doctor.uid,
    preliminary_at: () => new Date('2026-05-04T09:00:00.000Z'),
    signed_by: (ctx) => ctx.doctor.uid,
    signed_at: () => new Date('2026-05-04T09:00:00.000Z'),
  },
  // mig 744: MED-03 requires one coherent medication order to anchor the
  // synthetic order -> ward-indent -> MAR -> inventory -> billing lineage.
  // The generic CHECK literal picker can otherwise select a non-medication
  // order and the database correctly rejects the MAR relationship.
  clinical_orders: {
    order_type: 'medication',
    patient_uid: (ctx) => ctx.admissionPatientUid,
    encounter_id: (ctx) => ctx.admissionEncounterId,
    ordered_by: (ctx) => ctx.doctor.uid,
  },
  medication_administrations: {
    tenant_id: (ctx) => ctx.tenantId,
    patient_uid: (ctx) => ctx.admissionPatientUid,
    clinical_order_id: async () => {
      const row = await first(
        'clinical_orders',
        'id',
        "tenant_id = $1::uuid AND order_type = 'medication'",
        [DEFAULT_TENANT_ID],
      );
      return row?.id ?? null;
    },
    medication_name: 'Paracetamol 500 mg',
    dosage: '500 mg',
    route: 'oral',
    scheduled_time: () => new Date('2026-05-04T09:00:00.000Z'),
    administered_at: () => new Date('2026-05-04T09:01:00.000Z'),
    administered_by: (ctx) => ctx.staff.uid,
    status: 'administered',
    notes: 'Synthetic MED-03 exact-batch matched administration.',
    scanned_patient_uid: (ctx) => ctx.admissionPatientUid,
    scanned_barcode: 'VH-SEED-MED03-PARA500',
    rights_passed: JSON.stringify({ patient: true, medication: true, dose: true, route: true, time: true }),
    all_rights_passed: true,
    patient_scanned_at: () => new Date('2026-05-04T09:00:30.000Z'),
    medication_scanned_at: () => new Date('2026-05-04T09:00:45.000Z'),
    witness_uid: null,
    hold_reason: null,
    refusal_reason: null,
    override_reason: null,
    supply_quantity_per_dose: 1,
  },
  ward_indents: {
    admission_id: (ctx) => ctx.admissionId,
    patient_uid: (ctx) => ctx.admissionPatientUid,
    encounter_id: (ctx) => ctx.admissionEncounterId,
    ward_id: (ctx) => ctx.wardId,
    requested_by: (ctx) => ctx.staff.uid,
    status: 'reconciled',
    state_version: 1,
    approved_by: (ctx) => ctx.staff.uid,
    approved_at: () => new Date('2026-05-04T08:30:00.000Z'),
    issued_by: (ctx) => ctx.staff.uid,
    issued_at: () => new Date('2026-05-04T08:40:00.000Z'),
    received_by: (ctx) => ctx.staff.uid,
    received_at: () => new Date('2026-05-04T08:50:00.000Z'),
    return_requested_by: (ctx) => ctx.staff.uid,
    return_requested_at: () => new Date('2026-05-04T11:00:00.000Z'),
    reconciliation_reason: 'Two doses administered and one unused unit returned.',
    reconciled_by: (ctx) => ctx.staff.uid,
    reconciled_at: () => new Date('2026-05-04T11:15:00.000Z'),
    rejection_reason: null,
    short_supply_reason: null,
    cancelled_by: null,
    cancelled_at: null,
    cancellation_reason: null,
    closed_by: null,
    closed_at: null,
    closure_outcome: null,
    closure_reason: null,
  },
  ward_indent_items: {
    clinical_order_id: async () => {
      const row = await first(
        'clinical_orders',
        'id',
        "tenant_id = $1::uuid AND order_type = 'medication'",
        [DEFAULT_TENANT_ID],
      );
      return row?.id ?? null;
    },
    quantity_requested: 3,
    quantity_reserved: 3,
    quantity_approved: 3,
    quantity_issued: 3,
    quantity_received: 3,
    quantity_variance_resolved: 0,
    quantity_return_requested: 1,
    quantity_returned: 1,
    fulfilment_status: 'reconciled',
    unit_price: 1,
    proposed_pharmacy_catalog_id: null,
    proposed_item_name: null,
    proposed_quantity: null,
    substitution_status: null,
    substitution_reason: null,
    substitution_proposed_by: null,
    substitution_proposed_at: null,
    substitution_decided_by: null,
    substitution_decided_at: null,
    substitution_acknowledged_by: null,
    substitution_acknowledged_at: null,
    substitution_acknowledged_event_version: null,
    controlled_reference_id: null,
    controlled_movement_id: null,
    controlled_register_id: null,
    controlled_return_movement_id: null,
    controlled_return_register_id: null,
  },
  ward_indent_events: {
    ward_indent_id: async () => firstTenantValue('ward_indents', 'id'),
    state_version: async () => firstTenantValue('ward_indents', 'state_version'),
    action: 'synthetic_reconciled_snapshot',
    to_status: async () => firstTenantValue('ward_indents', 'status'),
    actor_uid: (ctx) => ctx.staff.uid,
    owner_role_codes: async () => firstTenantValue('ward_indents', 'owner_role_codes'),
    from_status: null,
    command_key: null,
  },
};

function seedOverrideFor(table, columnName) {
  return TABLE_COLUMN_SEED_OVERRIDES[table]?.[columnName];
}

function primitiveValue(column, table, index, ctx, checksByTable) {
  const override = seedOverrideFor(table, column.column_name);
  if (override !== undefined) {
    const value = typeof override === 'function' ? override() : override;
    return typeof value === 'string' ? clip(value, column.character_maximum_length) : value;
  }

  const checked = checkedValue(checksByTable, table, column);
  if (checked) return clip(checked, column.character_maximum_length);

  const semantic = semanticValue(column, table, index, ctx, column.character_maximum_length);
  if (semantic !== undefined) return semantic;

  const type = column.udt_name;
  if (type === 'uuid') return ctx.generatedUuid;
  if (['int2', 'int4', 'int8'].includes(type)) return 1;
  if (['float4', 'float8', 'numeric', 'money'].includes(type)) return 1;
  if (type === 'bool') return true;
  if (type === 'date') return new Date('2026-05-04T00:00:00.000Z');
  if (type === 'time') return '09:00:00';
  if (['timestamp', 'timestamptz'].includes(type)) return new Date('2026-05-04T09:00:00.000Z');
  if (type === 'json' || type === 'jsonb') return JSON.stringify({ seed: true });
  if (type.startsWith('_')) return [];
  if (type === 'bytea') return Buffer.from('seed');
  if (column.data_type === 'ARRAY') return [];
  return clip(`${SEED_TAG}_${table}_${column.column_name}_${index}`, column.character_maximum_length);
}

async function fkValue(fk) {
  const preferred = await firstValue(fk.foreign_table_name, fk.foreign_column_name);
  if (preferred !== null && preferred !== undefined) return preferred;
  return undefined;
}

async function rowForTable(table, columns, metadata, ctx, index, relaxed = false) {
  const row = {};
  // For XOR check constraints (e.g. billing_refunds.chk_refund_target requires
  // exactly one of invoice_id/advance_id to be NOT NULL), drop the second
  // column so the kept column carries the value.
  const xorSkip = metadata.xorPairsByTable?.get(table)?.[1] ?? null;
  for (const column of columns) {
    if (column.column_name === xorSkip) continue;
    const hasDefault = column.column_default !== null;
    const isGenerated = column.is_identity === 'YES' || column.is_generated !== 'NEVER';
    if (isGenerated) continue;

    const tableOverrides = TABLE_COLUMN_SEED_OVERRIDES[table];
    if (tableOverrides && Object.hasOwn(tableOverrides, column.column_name)) {
      const override = tableOverrides[column.column_name];
      row[column.column_name] = typeof override === 'function'
        ? await override(ctx)
        : override;
      continue;
    }

    const required = column.is_nullable === 'NO' && !hasDefault;
    const fk = metadata.fkByTableColumn.get(`${table}.${column.column_name}`);
    const hasOverride = seedOverrideFor(table, column.column_name) !== undefined;
    if (!required && !fk && !hasOverride) continue;

    if (fk) {
      const value = await fkValue(fk);
      if (value === undefined) {
        if (required) {
          throw new Error(
            `Seed dependency ${fk.foreign_table_name}.${fk.foreign_column_name} is empty`,
          );
        }
        continue;
      }
      row[column.column_name] = value;
      continue;
    }

    if (required || relaxed || hasOverride) {
      row[column.column_name] = primitiveValue(column, table, index, ctx, metadata.checksByTable);
    }
  }
  return row;
}

async function tryInsertSeedRow(table, row, savepointSuffix) {
  const savepoint = `seed_${String(savepointSuffix).replace(/[^a-z0-9_]/gi, '_')}`;
  await client.query(`SAVEPOINT ${quote(savepoint)}`);
  try {
    await insert(table, row);
    await client.query(`RELEASE SAVEPOINT ${quote(savepoint)}`);
    return null;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${quote(savepoint)}`);
    await client.query(`RELEASE SAVEPOINT ${quote(savepoint)}`);
    return error;
  }
}

async function seedCoreData() {
  const staffHash = await bcrypt.hash(STAFF_PASSWORD, 10);
  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);

  await insertIfEmpty('admins', [{
    username: 'admin',
    password_hash: adminHash,
    email: 'admin@example.test',
    name: 'Seed Admin',
    role: 'SUPER_ADMIN',
    status: 'active',
    permissions: ['*'],
    updated_at: new Date(),
  }]);

  const staffAccounts = [
    ['EMP-1001', 'e2e_test Nurse Arya', 'NURSING_STAFF', '+919999990001', 'General Medicine', 'Staff Nurse'],
    ['EMP-1002', 'e2e_test Pharmacist Bala', 'PHARMACY_STAFF', '+919999990002', 'Pharmacy', 'Pharmacist'],
    ['EMP-1003', 'e2e_test LabTech Chitra', 'LAB_STAFF', '+919999990003', 'Laboratory', 'Lab Technician'],
    ['EMP-1004', 'Test Doctor', 'DOCTOR', '+919999990004', 'General Medicine', 'Consultant'],
    ['EMP-1005', 'Test HR', 'HR_STAFF', '+919999990005', 'HR', 'HR Officer'],
    ['EMP-1006', 'Test Admin', 'ADMIN', '+919999990006', 'Administration', 'Administrator'],
    ['EMP-1007', 'Test Super Admin', 'SUPER_ADMIN', '+919999990007', 'Administration', 'Super Admin'],
    ['EMP-1008', 'Test General Staff', 'GENERAL_STAFF', '+919999990008', 'Operations', 'Staff'],
  ];

  for (const [employeeId, name, role, phone, department, position] of staffAccounts) {
    const user = await client.query(
      `INSERT INTO users (phone, name, role, encrypted_password, is_active, status, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, 'active', NOW())
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET name = EXCLUDED.name,
             role = EXCLUDED.role,
             encrypted_password = EXCLUDED.encrypted_password,
             is_active = TRUE,
             status = 'active',
             updated_at = NOW()
       RETURNING id, uid`,
      [phone, name, role, staffHash]
    );

    const existingStaff = await client.query(
      `SELECT id FROM staff WHERE employee_id = $1 OR user_id = $2::uuid LIMIT 1`,
      [employeeId, user.rows[0].uid]
    );
    if (existingStaff.rowCount) {
      await client.query(
        `UPDATE staff
            SET user_id = $1::uuid,
                employee_id = $2,
                name = $3,
                designation = $4,
                position = $4,
                department = $5,
                shift = 'DAY',
                salary = 75000,
                is_active = TRUE,
                updated_at = NOW()
          WHERE id = $6`,
        [user.rows[0].uid, employeeId, name, position, department, existingStaff.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO staff
           (user_id, employee_id, name, designation, position, department, shift, salary, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, $4, $4, $5, 'DAY', 75000, TRUE, NOW())`,
        [user.rows[0].uid, employeeId, name, position, department]
      );
    }

    if (role === 'DOCTOR') {
      const existingDoctor = await client.query(
        `SELECT id
           FROM doctors
          WHERE tenant_id = $1::uuid
            AND user_id = $2::integer
          ORDER BY id
          LIMIT 1`,
        [DEFAULT_TENANT_ID, user.rows[0].id],
      );
      if (existingDoctor.rowCount) {
        await client.query(
          `UPDATE doctors
              SET name = $1,
                  department = $2,
                  specialty = $3,
                  is_available = TRUE,
                  is_active = TRUE,
                  updated_at = NOW()
            WHERE id = $4
              AND tenant_id = $5::uuid`,
          [name, department, position, existingDoctor.rows[0].id, DEFAULT_TENANT_ID],
        );
      } else {
        await client.query(
          `INSERT INTO doctors
             (user_id, name, department, specialty, is_available, is_active,
              updated_at, tenant_id)
           VALUES ($1::integer, $2, $3, $4, TRUE, TRUE, NOW(), $5::uuid)`,
          [user.rows[0].id, name, department, position, DEFAULT_TENANT_ID],
        );
      }
    }
  }

  const patients = [
    ['+918888880001', 'Seed Patient Asha Rao', 'Female', 'O+'],
    ['+918888880002', 'Seed Patient Bala Menon', 'Male', 'A+'],
    ['+918888880003', 'Seed Patient Chitra Devi', 'Female', 'B+'],
    ['+918888880004', 'Seed Patient Dev Kumar', 'Male', 'AB+'],
    ['+918888880005', 'Seed Patient Esha Nair', 'Female', 'O-'],
  ];

  for (const [phone, name, gender, bloodGroup] of patients) {
    await client.query(
      `INSERT INTO users
         (phone, name, gender, email, role, is_active, status, blood_group, allergies, medical_history,
          profile_completed_at, updated_at)
       VALUES ($1, $2, $3, $4, 'PATIENT', TRUE, 'active', $5, 'Penicillin', 'Hypertension',
               NOW(), NOW())
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET name = EXCLUDED.name,
             role = 'PATIENT',
             is_active = TRUE,
             status = 'active',
             blood_group = EXCLUDED.blood_group,
             profile_completed_at = NOW(),
             updated_at = NOW()`,
      [phone, name, gender, `${phone.slice(-4)}@patient.example.test`, bloodGroup]
    );
  }

  const refs = await getCoreRefs();

  await seedCurrentBedStructure(client);

  const firstWard = await first('wards', 'id, name, floor', 'LOWER(name) = LOWER($1)', ['A Block - Floor III']);
  const firstBed = await first('beds', 'id', 'LOWER(bed_number) = LOWER($1)', ['A-303']);
  if (firstWard && firstBed) {
    await client.query(
      `UPDATE beds
          SET status = 'occupied',
              patient_id = $1,
              patient_uid = $2::uuid,
              patient_name = $3,
              admitted_at = COALESCE(admitted_at, NOW()),
              assigned_at = COALESCE(assigned_at, NOW()),
              ward_id = $4,
              ward_name = $5,
              floor = $6,
              notes = COALESCE(notes, 'Seed occupied bed'),
              updated_at = NOW()
        WHERE id = $7
          AND (patient_uid IS NULL OR patient_uid = $2::uuid)`,
      [refs.patient.id, refs.patient.uid, refs.patient.name, firstWard.id, firstWard.name, firstWard.floor, firstBed.id]
    );
  }

  const refreshed = await getCoreRefs();
  await insertIfTenantEmpty('appointments', [
    {
      phone: refreshed.patient.phone,
      patient_id: refreshed.patient.id,
      doctor_id: refreshed.doctor.userId,
      doctor_name: refreshed.doctor.name,
      patient_name: refreshed.patient.name,
      appointment_date: new Date(),
      appointment_time: '10:00',
      status: 'SCHEDULED',
      reason: 'Seed general medicine review',
      token_number: 'A001',
      department: 'General Medicine',
      updated_at: new Date(),
    },
    {
      phone: '+918888880002',
      patient_id: refreshed.secondPatient.id,
      doctor_id: refreshed.doctor.userId,
      doctor_name: refreshed.doctor.name,
      patient_name: refreshed.secondPatient.name,
      appointment_date: new Date(),
      appointment_time: '10:30',
      status: 'CONFIRMED',
      reason: 'Seed follow-up',
      token_number: 'A002',
      department: 'Cardiology',
      updated_at: new Date(),
    },
  ]);

  const afterAppointment = await getCoreRefs();
  await insertIfTenantEmpty('appointment_status_history', [{
    appointment_id: afterAppointment.appointmentId,
    from_status: 'REQUESTED',
    to_status: 'SCHEDULED',
    changed_by: afterAppointment.staff.userId,
    changed_by_role: 'SUPER_ADMIN',
    reason: 'Seed status transition',
  }]);

  await insertIfEmpty('medications', [
    {
      name: 'Paracetamol',
      generic_name: 'Paracetamol',
      brand: 'SeedMed',
      category: 'Analgesic',
      dosage: '500mg',
      form: 'tablet',
      price: 12,
      stock_quantity: 500,
      expiry_date: new Date('2027-05-04T00:00:00.000Z'),
      manufacturer: 'Seed Pharma',
      prescription_required: false,
      description: 'Seed medication',
      updated_at: new Date(),
    },
  ]);

  await insertIfTenantEmpty('pharmacy_orders', [{
    phone: afterAppointment.patient.phone,
    patient_id: afterAppointment.patient.id,
    patient_name: afterAppointment.patient.name,
    patient_phone: afterAppointment.patient.phone,
    order_note: 'Seed medication order',
    medication: 'Paracetamol 500mg',
    status: 'PENDING',
    priority: 'NORMAL',
    total_amount: 120,
    items_list: JSON.stringify([{ name: 'Paracetamol', quantity: 10 }]),
    updated_at: new Date(),
  }]);

  await insertIfTenantEmpty('investigations', [{
    phone: afterAppointment.patient.phone,
    patient_id: afterAppointment.patient.id,
    patient_uid: afterAppointment.patient.uid,
    test_name: 'Complete Blood Count',
    test_type: 'Pathology',
    investigation_type: 'LAB',
    status: 'REQUESTED',
    priority: 'NORMAL',
    requested_by: afterAppointment.doctor.uid,
    doctor_id: afterAppointment.doctor.userId,
    test_code: 'CBC',
    type: 'LAB',
    normal_range: 'Standard',
    unit: 'cells/uL',
    cost: 450,
    updated_at: new Date(),
  }]);

  const afterInvestigation = await getCoreRefs();
  await insertIfTenantEmpty('investigation_bookings', [{
    patient_id: afterInvestigation.patient.id,
    patient_name: afterInvestigation.patient.name,
    patient_phone: afterInvestigation.patient.phone,
    investigation_id: afterInvestigation.investigationId,
    test_name: 'Complete Blood Count',
    preferred_date: new Date(),
    preferred_time_slot: '09:00-10:00',
    estimated_cost: 450,
    final_cost: 450,
    status: 'BOOKED',
    updated_at: new Date(),
  }]);

  await insertIfTenantEmpty('medical_records', [{
    patient_id: afterInvestigation.patient.uid,
    doctor_id: afterInvestigation.doctor.userId,
    record_type: 'consultation',
    title: 'Seed consultation note',
    description: 'Stable vitals. Continue current medication.',
    diagnosis: 'Hypertension',
    treatment: 'Lifestyle advice and medication review',
    medications: JSON.stringify([{ name: 'Amlodipine', dose: '5mg' }]),
    lab_results: JSON.stringify([{ test: 'CBC', status: 'pending' }]),
    updated_at: new Date(),
  }]);

  await insertIfTenantEmpty('patient_records', [{
    patient_id: afterInvestigation.patient.id,
    document_type: 'lab_report',
    title: 'Seed CBC report',
    file_key: 'seed/patient-records/cbc.pdf',
    file_name: 'cbc.pdf',
    file_size: 1024,
    file_mime: 'application/pdf',
    source_hospital: 'Venkataeswara Hospitals',
    record_date: new Date(),
    notes: 'Seed patient record',
  }]);

  await insertIfTenantEmpty('health_records', [{
    phone: afterInvestigation.patient.phone,
    record_type: 'GENERAL',
    file_name: 'seed-health-record.pdf',
    file_type: 'application/pdf',
    file_key: 'seed/health-records/general.pdf',
    file_size: 1024,
    privacy_level: 'RESTRICTED',
    created_by: afterInvestigation.patient.uid,
    updated_at: new Date(),
  }]);

  await insertIfTenantEmpty('admissions', [{
    patient_uid: afterInvestigation.patient.uid,
    status: 'admitted',
    allergies: ['Penicillin'],
    admitting_doctor: afterInvestigation.doctor.uid,
    attending_doctor: afterInvestigation.doctor.uid,
    department: 'General Medicine',
    ward: 'General Ward',
    bed_id: afterInvestigation.bedId,
    bed_number: 'GW-201',
    chief_complaint: 'Seed admission',
    admitting_diagnosis: 'Observation',
    admission_type: 'planned',
    priority: 'routine',
    admitted_at: new Date(),
    updated_at: new Date(),
  }]);

  const afterAdmission = await getCoreRefs();
  await insertIfTenantEmpty('prescriptions', [{
    patient_uid: afterAdmission.patient.uid,
    medication_name: 'Paracetamol',
    dosage: '500mg',
    frequency: 'BD',
    status: 'active',
    duration_days: 3,
  }]);

  await insertIfTenantEmpty('e_prescriptions', [{
    appointment_id: afterAdmission.appointmentId,
    patient_id: afterAdmission.patient.id,
    doctor_id: afterAdmission.doctor.userId,
    patient_uid: afterAdmission.patient.uid,
    doctor_uid: afterAdmission.doctor.uid,
    medication_name: 'Paracetamol',
    diagnosis: 'Fever',
    clinical_notes: 'Seed e-prescription',
    medications: JSON.stringify([{ route: 'oral', dose: '500mg', frequency: 'BD' }]),
    created_by: afterAdmission.doctor.userId,
    updated_at: new Date(),
  }]);

  await insertIfTenantEmpty('staff_attendance', [{
    staff_id: afterAdmission.staff.userId,
    staff_uid: afterAdmission.staff.uid,
    type: 'check_in',
    attendance_type: 'regular',
    attendance_status: 'present',
    check_in_time: new Date(),
    location: 'Main Campus',
    updated_at: new Date(),
  }]);

  await insertIfTenantEmpty('leave_applications', [{
    staff_id: afterAdmission.staff.userId,
    leave_type: 'sick',
    start_date: new Date('2026-05-10T00:00:00.000Z'),
    end_date: new Date('2026-05-11T00:00:00.000Z'),
    days_taken: 2,
    reason: 'Seed leave request',
    status: 'pending',
    applied_by: afterAdmission.staff.uid,
  }]);

  await insertIfTenantEmpty('replacement_requests', [{
    leave_request_id: await firstTenantValue('leave_applications', 'id'),
    requester_id: afterAdmission.staff.userId,
    replacement_staff_id: afterAdmission.secondStaff.userId,
    dates: JSON.stringify(['2026-05-10', '2026-05-11']),
    status: 'pending',
    requester_message: 'Seed replacement request',
  }]);

  await insertIfTenantEmpty('staff_messages', [{
    sender_uid: afterAdmission.staff.uid,
    recipient_uid: afterAdmission.secondStaff.uid,
    patient_uid: afterAdmission.patient.uid,
    subject: 'Seed handover',
    body: 'Seed staff message for desktop smoke testing.',
    priority: 'normal',
  }]);

  await seedCareTeam(afterAdmission);

  await insertIfTenantEmpty('notifications', [{
    uid: afterAdmission.patient.uid,
    phone: afterAdmission.patient.phone,
    title: 'Seed notification',
    body: 'Your appointment is scheduled.',
    type: 'APPOINTMENT',
    priority: 'NORMAL',
    user_id: afterAdmission.patient.id,
    updated_at: new Date(),
  }]);
}

async function seedCareTeam(refs) {
  if (!refs.patient || !refs.staff) return;

  if ((await tableCount('care_teams')) === 0) {
    await insert('care_teams', {
      tenant_id: refs.tenantId,
      patient_uid: refs.patient.uid,
      admission_id: refs.admissionId,
      team_kind: 'ip',
      display_name: 'Seed IP care team',
      primary_department: 'General Medicine',
      status: 'active',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
      updated_by: refs.staff.uid,
      updated_at: new Date(),
    });
  }

  if ((await tableCount('care_team_members')) > 0) return;

  const team = await first('care_teams', 'id, patient_uid', 'TRUE', []);
  if (!team) return;

  await insert('care_team_members', {
    tenant_id: refs.tenantId,
    care_team_id: team.id,
    patient_uid: team.patient_uid,
    staff_uid: refs.staff.uid,
    staff_id: refs.staff.staffId,
    staff_role: 'NURSING_STAFF',
    member_name: refs.staff.employeeId || 'Seed staff',
    relationship_kind: 'nurse',
    access_scope: JSON.stringify({ ip: true, vitals: true, notes: true }),
    break_glass_allowed: false,
    status: 'active',
    notes: 'Seed care-team member for patient-access coverage',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    created_by: refs.staff.uid,
    updated_by: refs.staff.uid,
    updated_at: new Date(),
  });
}

async function seedScheduledNotificationFixture() {
  const ctx = await getCoreRefs();
  if (!ctx.patient?.id) {
    throw new Error('Scheduled notification seed requires a patient fixture');
  }
  await client.query(
    `INSERT INTO scheduled_notifications
       (tenant_id, user_id, type, data, send_at, status)
     SELECT $1::uuid, $2::integer, 'feedback_request',
            '{"appointment_id":"seed","survey":"nps","seed":true}'::jsonb,
            '2099-01-01T00:00:00Z'::timestamptz, 'pending'
      WHERE NOT EXISTS (
        SELECT 1
          FROM scheduled_notifications
         WHERE tenant_id = $1::uuid
           AND user_id = $2::integer
           AND type = 'feedback_request'
           AND data->>'appointment_id' = 'seed'
      )`,
    [ctx.patient.tenant_id, ctx.patient.id],
  );
}

async function getCoreRefs() {
  const patient = await first(
    'users',
    'id, uid, phone, name, tenant_id',
    "tenant_id = $1::uuid AND role = 'PATIENT'",
    [DEFAULT_TENANT_ID],
  );
  const secondPatient = await first(
    'users',
    'id, uid, phone, name, tenant_id',
    "tenant_id = $1::uuid AND role = 'PATIENT' AND phone <> $2",
    [DEFAULT_TENANT_ID, patient?.phone || ''],
  );
  const doctor = await client.query(`
    SELECT d.id, d.user_id, d.name, u.uid
      FROM doctors d
      JOIN users u
        ON u.tenant_id = d.tenant_id
       AND u.id = d.user_id
     WHERE d.tenant_id = $1::uuid
     ORDER BY d.id
     LIMIT 1
  `, [DEFAULT_TENANT_ID]);
  const staff = await client.query(`
    SELECT s.id AS staff_id, u.id AS user_id, u.uid, s.employee_id
      FROM staff s
      JOIN users u
        ON u.tenant_id = s.tenant_id
       AND u.uid = s.user_id
     WHERE s.tenant_id = $1::uuid
     ORDER BY s.id
     LIMIT 1
  `, [DEFAULT_TENANT_ID]);
  const secondStaff = await client.query(`
    SELECT s.id AS staff_id, u.id AS user_id, u.uid, s.employee_id
      FROM staff s
      JOIN users u
        ON u.tenant_id = s.tenant_id
       AND u.uid = s.user_id
     WHERE s.tenant_id = $1::uuid
     ORDER BY s.id
     OFFSET 1
     LIMIT 1
  `, [DEFAULT_TENANT_ID]);
  const doctorRow = doctor.rows[0];
  const staffRow = staff.rows[0];
  const secondStaffRow = secondStaff.rows[0] || staffRow;

  return {
    tenantId: DEFAULT_TENANT_ID,
    generatedUuid: '11111111-1111-4111-8111-111111111111',
    patient,
    secondPatient: secondPatient || patient,
    doctor: doctorRow ? {
      id: doctorRow.id,
      userId: doctorRow.user_id,
      uid: doctorRow.uid,
      name: doctorRow.name,
    } : null,
    staff: staffRow ? {
      staffId: staffRow.staff_id,
      userId: staffRow.user_id,
      uid: staffRow.uid,
      employeeId: staffRow.employee_id,
    } : null,
    secondStaff: secondStaffRow ? {
      staffId: secondStaffRow.staff_id,
      userId: secondStaffRow.user_id,
      uid: secondStaffRow.uid,
      employeeId: secondStaffRow.employee_id,
    } : null,
    departmentId: await firstTenantValue('departments', 'id'),
    wardId: await firstTenantValue('wards', 'id'),
    bedId: await firstTenantValue('beds', 'id'),
    appointmentId: await firstTenantValue('appointments', 'id'),
    admissionId: await firstTenantValue('admissions', 'id'),
    admissionPatientUid: await firstTenantValue('admissions', 'patient_uid'),
    admissionEncounterId: await firstTenantValue('admissions', 'encounter_id'),
    pharmacyOrderId: await firstTenantValue('pharmacy_orders', 'id'),
    investigationId: await firstTenantValue('investigations', 'id'),
    invoiceId: await firstTenantValue('invoices', 'id'),
    otScheduleId: await firstTenantValue('ot_schedules', 'id'),
    carePlanId: await firstTenantValue('care_plans', 'id'),
    chatSessionId: await firstTenantValue('chat_sessions', 'id'),
    taskId: await firstTenantValue('tasks', 'id'),
    apiClientId: await firstTenantValue('api_clients', 'id'),
    kgNodeId: await firstTenantValue('clinical_ai_kg_nodes', 'id'),
  };
}

async function seedRemainingTables() {
  const metadata = await getMetadata();
  const tables = [...metadata.columnsByTable.keys()]
    .filter((table) => (
      !table.startsWith('_')
      && !MANUAL_SEED_TABLES.has(table)
      && !INTENTIONALLY_EMPTY_TABLES.has(table)
    ))
    .sort();
  const seeded = [];
  const failed = new Map();

  for (let pass = 0; pass < 6; pass += 1) {
    let progress = 0;
    const ctx = await getCoreRefs();
    for (const table of tables) {
      if (await tableCount(table)) continue;
      try {
        const row = await rowForTable(table, metadata.columnsByTable.get(table), metadata, ctx, seeded.length + 1);
        const error = await tryInsertSeedRow(table, row, `${pass}_${table}`);
        if (error) throw error;
        seeded.push(table);
        failed.delete(table);
        progress += 1;
      } catch (error) {
        failed.set(table, error.message);
      }
    }
    if (progress === 0) break;
  }

  return { seeded, failed };
}

async function summarize(failed) {
  const counts = await client.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `);

  let nonEmpty = 0;
  const empty = [];
  const intentionallyEmpty = [];
  for (const { table_name: table } of counts.rows) {
    if (table.startsWith('_')) continue;
    if (await tableCount(table)) nonEmpty += 1;
    else if (INTENTIONALLY_EMPTY_TABLES.has(table)) intentionallyEmpty.push(table);
    else empty.push(table);
  }

  const domainCounts = {};
  for (const table of [
    'users',
    'staff',
    'admins',
    'appointments',
    'admissions',
    'beds',
    'investigations',
    'investigation_bookings',
    'pharmacy_orders',
    'medical_records',
    'patient_records',
    'notifications',
  ]) {
    if (await columnExists(table, 'id')) domainCounts[table] = await tableCount(table);
  }

  return {
    totalAppTables: counts.rows.filter((row) => !row.table_name.startsWith('_')).length,
    nonEmptyAppTables: nonEmpty,
    emptyAppTables: empty,
    intentionallyEmptyAppTables: intentionallyEmpty,
    failed: [...failed.entries()].map(([table, error]) => ({ table, error })),
    domainCounts,
    credentials: {
      staff: 'EMP-1001..EMP-1008 / test1234',
      admin: `admin / ${ADMIN_PASSWORD === STAFF_PASSWORD ? 'test1234' : '<VH_TEST_ADMIN_PASSWORD>'}`,
    },
  };
}

function assertComprehensiveSeedComplete(summary) {
  const failures = summary.failed.map(({ table, error }) => `${table}: ${error}`);
  if (summary.emptyAppTables.length > 0) {
    failures.push(`unexpectedly empty tables: ${summary.emptyAppTables.join(', ')}`);
  }
  if (failures.length > 0) {
    throw new Error(`Comprehensive seed incomplete: ${failures.join('; ')}`);
  }
}

async function seedPayrollAttemptGraph() {
  const ctx = await getCoreRefs();
  if (!ctx.staff?.uid) throw new Error('Payroll seed graph requires an active staff user.');

  let run = await first(
    'payroll_runs',
    'id, attempt_token',
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );
  if (!run) {
    const attemptToken = randomUUID();
    const inserted = await client.query(
      `INSERT INTO payroll_runs
         (tenant_id, month, year, status, total_staff, total_gross,
          total_net, total_deductions, failed_staff_count, attempt_token,
          result_manifest_hash, document_manifest_hash, notes)
       VALUES
         ($1::uuid, 5, 2026, 'draft', 0, 0, 0, 0, 0, $2::uuid,
          NULL, NULL, 'Synthetic local payroll attempt coverage')
       RETURNING id, attempt_token`,
      [DEFAULT_TENANT_ID, attemptToken],
    );
    run = inserted.rows[0];
  }

  await client.query(
    `INSERT INTO payroll_run_attempts
       (tenant_id, payroll_run_id, attempt_token, started_at, status,
        expected_staff_count, succeeded_staff_count, failed_staff_count)
     VALUES ($1::uuid, $2::integer, $3::uuid, $4::timestamptz,
             'processing', 0, 0, 0)
     ON CONFLICT DO NOTHING`,
    [
      DEFAULT_TENANT_ID,
      run.id,
      run.attempt_token,
      new Date('2026-05-04T09:00:00.000Z'),
    ],
  );

  let payslip = await first(
    'payslips',
    'id, payroll_run_id, generation_attempt_token, staff_uid, document_revision',
    'tenant_id = $1::uuid AND payroll_run_id = $2::integer AND staff_uid = $3::uuid',
    [DEFAULT_TENANT_ID, run.id, ctx.staff.uid],
  );
  if (!payslip) {
    const inserted = await client.query(
      `INSERT INTO payslips
         (tenant_id, payroll_run_id, generation_attempt_token, staff_uid,
          month, year, status, document_revision)
       VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid,
               5, 2026, 'draft', 1)
       RETURNING id, payroll_run_id, generation_attempt_token, staff_uid,
                 document_revision`,
      [DEFAULT_TENANT_ID, run.id, run.attempt_token, ctx.staff.uid],
    );
    payslip = inserted.rows[0];
  }

  await client.query(
    `INSERT INTO payroll_run_staff_results
       (tenant_id, payroll_run_id, attempt_token, staff_uid, outcome)
     VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid, 'pending')
     ON CONFLICT DO NOTHING`,
    [DEFAULT_TENANT_ID, run.id, run.attempt_token, ctx.staff.uid],
  );

  if (!(await tableCount('payslip_documents'))) {
    await client.query(
      `INSERT INTO payslip_documents
         (tenant_id, payslip_id, payroll_run_id, attempt_token, staff_uid,
          payslip_revision, version, object_key, credential_ciphertext,
          content_sha256, status)
       VALUES
         ($1::uuid, $2::integer, $3::integer, $4::uuid, $5::uuid,
          $6::integer, 1, $7, $8, $9, 'prepared')`,
      [
        DEFAULT_TENANT_ID,
        payslip.id,
        run.id,
        run.attempt_token,
        ctx.staff.uid,
        payslip.document_revision,
        'seed/payroll/payslip-2026-05.pdf',
        'synthetic-test-credential-ciphertext',
        '7'.repeat(64),
      ],
    );
  }
}

async function seedCarePathwayWorkflowGraph() {
  const graphTables = [
    'workflow_definitions',
    'workflow_runs',
    'workflow_steps',
    'tasks',
    'approvals',
    'care_pathway_definition_governance',
    'care_pathway_instances',
    'care_pathway_transition_events',
    'care_handoff_instances',
  ];
  const existingCounts = [];
  for (const table of graphTables) existingCounts.push(await tableCount(table));
  if (existingCounts.every(Boolean)) return;

  const patient = await first(
    'users',
    'uid, name',
    "tenant_id = $1::uuid AND role = 'PATIENT' AND is_active = TRUE",
    [DEFAULT_TENANT_ID],
  );
  const clinicalActor = await first(
    'users',
    'uid, role',
    "tenant_id = $1::uuid AND role = 'DOCTOR' AND is_active = TRUE AND status = 'active'",
    [DEFAULT_TENANT_ID],
  );
  const operationalActor = await first(
    'users',
    'uid, role',
    `tenant_id = $1::uuid
     AND role IN ('NURSING_STAFF', 'CARE_COORDINATOR', 'DOCTOR')
     AND is_active = TRUE AND status = 'active'`,
    [DEFAULT_TENANT_ID],
  );
  const clinicalOwner = clinicalActor?.uid;
  const operationalOwner = operationalActor?.uid;
  const approver = await first(
    'users',
    'uid, role',
    `tenant_id = $1::uuid
     AND role IN ('ADMIN', 'SUPER_ADMIN') AND is_active = TRUE AND status = 'active'`,
    [DEFAULT_TENANT_ID],
  );
  if (!patient?.uid || !clinicalOwner || !operationalOwner || !approver?.uid) {
    throw new Error('Care-pathway seed graph requires a patient, two staff owners, and an admin approver.');
  }

  const workflowKey = 'seed_test_care_pathway';
  const stepKey = 'handoff_request';
  const rawDefinition = {
    workflow_key: workflowKey,
    version: 1,
    steps: [{
      step_key: stepKey,
      step_kind: 'task',
      display_name: 'Seed neutral handoff request',
      assigned_role: 'DOCTOR',
      metadata: { seed: true, source: 'seed-comprehensive-test-data' },
      work_semantics: {
        task_kind: 'general',
        priority: 'normal',
        title: 'Seed neutral handoff request',
        description: 'Synthetic local test workflow coverage.',
        sla_completion_semantics: 'none',
      },
    }],
    triggers: [],
    defaults: {},
  };
  const compiledDefinition = compileWorkflowDefinition(rawDefinition);
  const evidenceAt = new Date();

  const definition = await client.query(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, display_name, description, category,
        steps, triggers, defaults, is_active, created_by)
     VALUES
       ($1::uuid, $2::text, 1, 'Seed care pathway coverage',
        'Synthetic local test-only execution-spine coverage.', 'test_fixture',
        $3::jsonb, $4::jsonb, $5::jsonb, FALSE, $6::uuid)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      workflowKey,
      JSON.stringify(compiledDefinition.steps),
      JSON.stringify(compiledDefinition.triggers),
      JSON.stringify(compiledDefinition.defaults),
      operationalOwner,
    ],
  );
  const definitionId = definition.rows[0].id;

  const approval = await client.query(
    `INSERT INTO approvals
       (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
        required_approvers, required_role, status, approved_by, created_by,
        decided_by, decided_at, metadata)
     VALUES
       ($1::uuid, 'care_pathway_definition_governance',
        'care_pathway_definition', $2::text, 1, 'ADMIN', 'approved',
        $3::jsonb, $4::uuid, $4::uuid, $5::timestamptz,
        jsonb_build_object(
          'care_pathway_definition_governance',
          jsonb_build_object('definition_checksum', $6::text),
          'seed', TRUE
        ))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      String(definitionId),
      JSON.stringify([{ uid: approver.uid, at: evidenceAt.toISOString() }]),
      approver.uid,
      evidenceAt,
      compiledDefinition.checksum,
    ],
  );
  const approvalId = approval.rows[0].id;

  const governance = await client.query(
    `INSERT INTO care_pathway_definition_governance
       (tenant_id, workflow_definition_id, clinical_owner_uid,
        operational_owner_uid, governance_status, approval_id, approved_by,
        approved_at, patient_visibility_policy_ref, definition_checksum,
        platform_gates, metadata)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, $4::uuid, 'approved', $5::integer,
        $6::uuid, $7::timestamptz, 'staff_after_signoff', $8::char(64),
        '[]'::jsonb,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      definitionId,
      clinicalOwner,
      operationalOwner,
      approvalId,
      approver.uid,
      evidenceAt,
      compiledDefinition.checksum,
    ],
  );
  const governanceId = governance.rows[0].id;

  await client.query(
    `UPDATE workflow_definitions
        SET is_active = TRUE, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [DEFAULT_TENANT_ID, definitionId],
  );

  const run = await client.query(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
        trigger_kind, trigger_payload, status, context, initiated_by, metadata,
        pathway_governance_id, pathway_definition_checksum)
     VALUES
       ($1::uuid, $2::integer, $3::text, 1, 'manual',
        '{"seed":true}'::jsonb, 'started',
        '{"seed":true,"pathway_mode":"test_only_off"}'::jsonb, $4::uuid,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        $5::uuid, $6::char(64))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      definitionId,
      workflowKey,
      operationalOwner,
      governanceId,
      compiledDefinition.checksum,
    ],
  );
  const runId = run.rows[0].id;

  const step = await client.query(
    `INSERT INTO workflow_steps
       (tenant_id, workflow_run_id, step_key, display_name, step_kind,
        status, ordering, assigned_to, assigned_role, metadata)
     VALUES
       ($1::uuid, $2::integer, $3::text, 'Seed neutral handoff request',
        'task', 'pending', 0, $4::uuid, 'DOCTOR',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
     RETURNING id`,
    [DEFAULT_TENANT_ID, runId, stepKey, clinicalOwner],
  );
  const stepId = step.rows[0].id;

  const task = await client.query(
    `INSERT INTO tasks
       (tenant_id, workflow_run_id, workflow_step_id, task_kind, title,
        description, patient_uid, priority, status, assigned_to_uid,
        assigned_to_role, created_by, sla_completion_semantics, metadata)
     VALUES
       ($1::uuid, $2::integer, $3::integer, 'general',
        'Seed neutral handoff request',
        'Synthetic local test-only pathway task.', $4::uuid, 'normal', 'open',
        $5::uuid, NULL, $6::uuid, 'none',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
     RETURNING id`,
    [DEFAULT_TENANT_ID, runId, stepId, patient.uid, clinicalOwner, operationalOwner],
  );
  const taskId = task.rows[0].id;

  const idempotencyKey = 'seed-care-pathway-instance-v1';
  const sourceEpisodeId = 'seed-care-episode-v1';
  const pathway = await client.query(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, pathway_key, pathway_version,
        source_episode_type, source_episode_id, owning_clinician_uid,
        accountable_role, clinical_status, patient_visibility_status,
        idempotency_key, created_by, updated_by, metadata,
        workflow_definition_id, definition_governance_id, definition_checksum)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, $4::text, 1,
        'test_fixture', $5::text, $6::uuid, 'DOCTOR', 'planned', 'hidden',
        $7::text, $8::uuid, $8::uuid,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        $9::integer, $10::uuid, $11::char(64))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      runId,
      patient.uid,
      workflowKey,
      sourceEpisodeId,
      clinicalOwner,
      idempotencyKey,
      operationalOwner,
      definitionId,
      governanceId,
      compiledDefinition.checksum,
    ],
  );
  const pathwayId = pathway.rows[0].id;
  const eventId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
  const fingerprint = compiledDefinition.checksum;
  const previousState = {};
  const newState = { clinical_status: 'planned', run_status: 'started' };
  const eventPayload = {
    event_id: eventId,
    tenant_id: DEFAULT_TENANT_ID,
    pathway_instance_id: pathwayId,
    patient_uid: patient.uid,
    encounter_id: null,
    workflow_run_id: runId,
    workflow_step_id: null,
    sequence_number: 1,
    transition_scope: 'pathway',
    transition_key: 'pathway_instance_created',
    stage_key: null,
    source_resource_type: 'test_fixture',
    source_resource_id: sourceEpisodeId,
    workflow_sla_instance_id: null,
    actor_uid: null,
    system_actor_key: 'seed-comprehensive-test-data.v1',
    actor_role: null,
    occurred_at: evidenceAt.toISOString(),
    idempotency_key: idempotencyKey,
    command_fingerprint: fingerprint,
    effect_ordinal: 0,
    workflow_definition_id: definitionId,
    governance_id: governanceId,
    definition_checksum: compiledDefinition.checksum,
  };
  const eventMetadata = {
    seed: true,
    pathway_runtime: { definition_checksum: compiledDefinition.checksum },
    command_fingerprint: fingerprint,
    effect_ordinal: 0,
    provenance: { kind: 'system', system_key: 'seed-comprehensive-test-data.v1' },
  };

  const timeline = await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, event_status, source_table,
        source_id, source_uid, resource_type, resource_id, occurred_at,
        visible_to_patient, clinical_summary, payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'care_pathway.transition', 'pathway',
        'care_pathway_transition_events', $3::text, $3::uuid,
        'care_pathway_transition_event', $3::text, $4::timestamptz, FALSE,
        'Synthetic care-pathway transition for local test coverage.', $5::jsonb,
        ARRAY['care_pathway', $6::text, 'pathway', 'seed']::text[],
        'care_pathway_transition_events:' || $3::text || ':timeline')
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      eventId,
      evidenceAt,
      JSON.stringify(eventPayload),
      workflowKey,
    ],
  );
  const audit = await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, action_status, resource_type,
        resource_table, resource_id, before_state, after_state, metadata,
        idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, 'care_pathway.transition', 'success',
        'care_pathway_transition_event', 'care_pathway_transition_events',
        $3::text, $4::jsonb, $5::jsonb, $6::jsonb,
        'care_pathway_transition_events:' || $3::text || ':audit',
        $7::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      eventId,
      JSON.stringify(previousState),
      JSON.stringify(newState),
      JSON.stringify(eventMetadata),
      evidenceAt,
    ],
  );

  await client.query(
    `INSERT INTO care_pathway_transition_events
       (id, tenant_id, pathway_instance_id, patient_uid, workflow_run_id,
        sequence_number, transition_scope, transition_key, previous_state,
        new_state, source_resource_type, source_resource_id, system_actor_key,
        occurred_at, idempotency_key, command_fingerprint, effect_ordinal,
        canonical_timeline_event_id, canonical_audit_event_id, event_payload,
        metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 1, 'pathway',
        'pathway_instance_created', $6::jsonb, $7::jsonb, 'test_fixture',
        $8::text, 'seed-comprehensive-test-data.v1', $9::timestamptz,
        $10::text, $11::char(64), 0, $12::uuid, $13::uuid, $14::jsonb,
        $15::jsonb)`,
    [
      eventId,
      DEFAULT_TENANT_ID,
      pathwayId,
      patient.uid,
      runId,
      JSON.stringify(previousState),
      JSON.stringify(newState),
      sourceEpisodeId,
      evidenceAt,
      idempotencyKey,
      fingerprint,
      timeline.rows[0].id,
      audit.rows[0].id,
      JSON.stringify(eventPayload),
      JSON.stringify(eventMetadata),
    ],
  );

  await client.query(
    `INSERT INTO care_handoff_instances
       (tenant_id, patient_uid, sending_pathway_instance_id,
        sending_workflow_run_id, sending_step_key, handoff_type,
        source_resource_type, source_resource_id, urgency_code, sender_uid,
        recipient_kind, intended_recipient_uid, status, requested_at,
        task_id, idempotency_key, metadata)
     VALUES
        ($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text,
        'test_only_neutral', 'care_pathway_instance', $3::text, 'routine',
        $6::uuid, 'user', $7::uuid, 'requested', $8::timestamptz,
        $9::integer, 'seed-care-handoff-v1',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      pathwayId,
      runId,
      stepKey,
      clinicalOwner,
      operationalOwner,
      evidenceAt,
      taskId,
    ],
  );

  await client.query(
    `UPDATE workflow_definitions
        SET is_active = FALSE, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [DEFAULT_TENANT_ID, definitionId],
  );
  await client.query(
    `UPDATE care_pathway_definition_governance
        SET governance_status = 'retired',
            retired_by = $1::uuid,
            retired_at = $2::timestamptz,
            retirement_reason = 'Synthetic test-only pathway remains disabled.',
            effective_until = $2::timestamptz,
            updated_at = NOW()
      WHERE tenant_id = $3::uuid AND id = $4::uuid`,
    [approver.uid, evidenceAt, DEFAULT_TENANT_ID, governanceId],
  );
}

async function seedOpInpatientEvidenceGraph() {
  const evidenceTables = [
    'care_pathway_resource_references',
    'op_visit_closure_evidence',
    'inpatient_primary_physician_assignments',
    'discharge_pending_result_handoffs',
    'discharge_pending_result_owner_actions',
    'post_discharge_contact_events'
  ];
  const existingCounts = [];
  for (const table of evidenceTables) existingCounts.push(await tableCount(table));
  if (existingCounts.every(Boolean)) return;

  const contextResult = await client.query(
    `SELECT admission.id AS admission_id,
            admission.patient_uid,
            COALESCE(
              admission.attending_doctor,
              admission.admitting_doctor
            ) AS physician_uid,
            patient.id AS patient_id,
            patient.phone
       FROM admissions AS admission
       JOIN users AS patient
         ON patient.tenant_id = admission.tenant_id
        AND patient.uid = admission.patient_uid
      WHERE admission.tenant_id = $1::uuid
        AND COALESCE(
              admission.attending_doctor,
              admission.admitting_doctor
            ) IS NOT NULL
      ORDER BY admission.id
      LIMIT 1`,
    [DEFAULT_TENANT_ID]
  );
  const context = contextResult.rows[0];
  const approver = await first(
    'users',
    'uid',
    `tenant_id = $1::uuid
     AND role IN ('ADMIN', 'SUPER_ADMIN')
     AND is_active = TRUE
     AND status = 'active'`,
    [DEFAULT_TENANT_ID]
  );
  if (!context?.admission_id || !context.patient_uid || !context.physician_uid || !approver?.uid) {
    throw new Error(
      'S4 OP/inpatient evidence seed requires an admission, its named physician, patient, and admin approver.'
    );
  }

  const appointmentResult = await client.query(
    `SELECT appointment.id,
            history.id AS status_history_id
       FROM appointments AS appointment
       JOIN users AS patient
         ON patient.tenant_id = appointment.tenant_id
        AND patient.id = appointment.patient_id
       LEFT JOIN LATERAL (
         SELECT status_history.id
           FROM appointment_status_history AS status_history
          WHERE status_history.tenant_id = appointment.tenant_id
            AND status_history.appointment_id = appointment.id
          ORDER BY status_history.id
          LIMIT 1
       ) AS history ON TRUE
      WHERE appointment.tenant_id = $1::uuid
        AND patient.uid = $2::uuid
      ORDER BY appointment.id
      LIMIT 1`,
    [DEFAULT_TENANT_ID, context.patient_uid]
  );
  const appointment = appointmentResult.rows[0];
  if (!appointment?.id || !appointment.status_history_id) {
    throw new Error(
      'S4 OP closure evidence seed requires an appointment with status history for the admitted patient.'
    );
  }

  const workflowKey = 'inpatient_admission_to_recovery';
  const stepKey = 'await_discharge_evidence';
  const rawDefinition = INPATIENT_ADMISSION_TO_RECOVERY_DEFINITION;
  const compiledDefinition = compileInpatientAdmissionToRecoveryDefinition();
  const evidenceAt = new Date('2026-05-04T09:00:00.000Z');
  const definition = await client.query(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, display_name, description, category,
        steps, triggers, defaults, is_active, created_by)
      VALUES
        ($1::uuid, $2::text, 1, 'Seed inpatient pathway coverage',
         'Synthetic local test-only S4 evidence coverage.', NULL,
         $3::jsonb, $4::jsonb, $5::jsonb, FALSE, $6::uuid)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      workflowKey,
      JSON.stringify(rawDefinition.steps),
      JSON.stringify(rawDefinition.triggers),
      JSON.stringify(rawDefinition.defaults),
      context.physician_uid
    ]
  );
  const definitionId = Number(definition.rows[0].id);
  const approval = await client.query(
    `INSERT INTO approvals
       (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
        required_approvers, required_role, status, approved_by, created_by,
        decided_by, decided_at, metadata)
     VALUES
       ($1::uuid, 'care_pathway_definition_governance',
        'care_pathway_definition', $2::text, 1, 'ADMIN', 'approved',
        $3::jsonb, $4::uuid, $4::uuid, $5::timestamptz,
        jsonb_build_object(
          'care_pathway_definition_governance',
          jsonb_build_object('definition_checksum', $6::text),
          'seed', TRUE
        ))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      String(definitionId),
      JSON.stringify([{ uid: approver.uid, at: evidenceAt.toISOString() }]),
      approver.uid,
      evidenceAt,
      compiledDefinition.checksum
    ]
  );
  const governance = await client.query(
    `INSERT INTO care_pathway_definition_governance
       (tenant_id, workflow_definition_id, clinical_owner_uid,
        operational_owner_uid, governance_status, approval_id, approved_by,
        approved_at, patient_visibility_policy_ref, definition_checksum,
        platform_gates, metadata)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, $3::uuid, 'approved', $4::integer,
        $5::uuid, $6::timestamptz, 'staff_after_signoff', $7::char(64),
        '[]'::jsonb,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      definitionId,
      context.physician_uid,
      Number(approval.rows[0].id),
      approver.uid,
      evidenceAt,
      compiledDefinition.checksum
    ]
  );
  const governanceId = governance.rows[0].id;
  await client.query(
    `UPDATE workflow_definitions
        SET is_active = TRUE, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [DEFAULT_TENANT_ID, definitionId]
  );
  const run = await client.query(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
        trigger_kind, trigger_payload, status, context, initiated_by, metadata,
        pathway_governance_id, pathway_definition_checksum)
     VALUES
       ($1::uuid, $2::integer, $3::text, 1, 'manual',
        '{"seed":true}'::jsonb, 'started',
        '{"seed":true,"pathway_mode":"test_only_off"}'::jsonb, $4::uuid,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        $5::uuid, $6::char(64))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      definitionId,
      workflowKey,
      context.physician_uid,
      governanceId,
      compiledDefinition.checksum
    ]
  );
  const runId = Number(run.rows[0].id);
  const step = await client.query(
      `INSERT INTO workflow_steps
         (tenant_id, workflow_run_id, step_key, display_name, step_kind,
          status, ordering, assigned_to, assigned_role, metadata)
      VALUES
        ($1::uuid, $2::integer, $3::text, 'Await discharge safety evidence',
         'wait', 'in_progress', 3, $4::uuid, 'DOCTOR',
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
      RETURNING id`,
    [DEFAULT_TENANT_ID, runId, stepKey, context.physician_uid]
  );
  const stepId = Number(step.rows[0].id);
  const pathway = await client.query(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, pathway_key, pathway_version,
        source_episode_type, source_episode_id, owning_clinician_uid,
        accountable_role, clinical_status, patient_visibility_status,
        idempotency_key, created_by, updated_by, metadata,
        workflow_definition_id, definition_governance_id, definition_checksum)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, $4::text, 1,
        'admission', $5::text, $6::uuid, 'DOCTOR', 'active', 'hidden',
        $7::text, $6::uuid, $6::uuid,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        $8::integer, $9::uuid, $10::char(64))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      runId,
      context.patient_uid,
      workflowKey,
      String(context.admission_id),
      context.physician_uid,
      'seed-s4-inpatient-pathway-v1',
      definitionId,
      governanceId,
      compiledDefinition.checksum
    ]
  );
  const pathwayId = pathway.rows[0].id;
  const creationEventId = randomUUID();
  const creationFingerprint = compiledDefinition.checksum;
  const creationPreviousState = {};
  const creationNewState = { clinical_status: 'active', run_status: 'started' };
  const creationPayload = {
    event_id: creationEventId,
    tenant_id: DEFAULT_TENANT_ID,
    pathway_instance_id: pathwayId,
    patient_uid: context.patient_uid,
    encounter_id: null,
    workflow_run_id: runId,
    workflow_step_id: null,
    sequence_number: 1,
    transition_scope: 'pathway',
    transition_key: 'pathway_instance_created',
    stage_key: null,
    source_resource_type: 'admission',
    source_resource_id: String(context.admission_id),
    workflow_sla_instance_id: null,
    actor_uid: null,
    system_actor_key: 'seed-comprehensive-test-data.s4',
    actor_role: null,
    occurred_at: evidenceAt.toISOString(),
    idempotency_key: 'seed-s4-inpatient-pathway-v1',
    command_fingerprint: creationFingerprint,
    effect_ordinal: 0,
    workflow_definition_id: definitionId,
    governance_id: governanceId,
    definition_checksum: compiledDefinition.checksum
  };
  const creationMetadata = {
    seed: true,
    pathway_runtime: { definition_checksum: compiledDefinition.checksum },
    command_fingerprint: creationFingerprint,
    effect_ordinal: 0,
    provenance: { kind: 'system', system_key: 'seed-comprehensive-test-data.s4' }
  };
  const creationTimeline = await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, event_status, source_table,
        source_id, source_uid, resource_type, resource_id, occurred_at,
        visible_to_patient, clinical_summary, payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'care_pathway.transition', 'pathway',
        'care_pathway_transition_events', $3::text, $3::uuid,
        'care_pathway_transition_event', $3::text, $4::timestamptz, FALSE,
        'Synthetic S4 care-pathway transition for local test coverage.', $5::jsonb,
        ARRAY['care_pathway', $6::text, 'pathway', 'seed']::text[],
        'care_pathway_transition_events:' || $3::text || ':timeline')
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      context.patient_uid,
      creationEventId,
      evidenceAt,
      JSON.stringify(creationPayload),
      workflowKey
    ]
  );
  const creationAudit = await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, action_status, resource_type,
        resource_table, resource_id, before_state, after_state, metadata,
        idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, 'care_pathway.transition', 'success',
        'care_pathway_transition_event', 'care_pathway_transition_events',
        $3::text, $4::jsonb, $5::jsonb, $6::jsonb,
        'care_pathway_transition_events:' || $3::text || ':audit',
        $7::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      context.patient_uid,
      creationEventId,
      JSON.stringify(creationPreviousState),
      JSON.stringify(creationNewState),
      JSON.stringify(creationMetadata),
      evidenceAt
    ]
  );
  await client.query(
    `INSERT INTO care_pathway_transition_events
       (id, tenant_id, pathway_instance_id, patient_uid, workflow_run_id,
        sequence_number, transition_scope, transition_key, previous_state,
        new_state, source_resource_type, source_resource_id, system_actor_key,
        occurred_at, idempotency_key, command_fingerprint, effect_ordinal,
        canonical_timeline_event_id, canonical_audit_event_id, event_payload,
        metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, 1, 'pathway',
        'pathway_instance_created', $6::jsonb, $7::jsonb, 'admission',
        $8::text, 'seed-comprehensive-test-data.s4', $9::timestamptz,
        $10::text, $11::char(64), 0, $12::uuid, $13::uuid, $14::jsonb,
        $15::jsonb)`,
    [
      creationEventId,
      DEFAULT_TENANT_ID,
      pathwayId,
      context.patient_uid,
      runId,
      JSON.stringify(creationPreviousState),
      JSON.stringify(creationNewState),
      String(context.admission_id),
      evidenceAt,
      'seed-s4-inpatient-pathway-v1',
      creationFingerprint,
      creationTimeline.rows[0].id,
      creationAudit.rows[0].id,
      JSON.stringify(creationPayload),
      JSON.stringify(creationMetadata)
    ]
  );

  const investigation = await client.query(
    `INSERT INTO investigations
       (tenant_id, phone, patient_id, patient_uid, test_name, status, priority,
        requested_by, admission_id, result_version, requested_at, updated_at)
     VALUES
       ($1::uuid, $2::text, $3::integer, $4::uuid,
        'Seed S4 pending discharge result', 'COMPLETED', 'NORMAL',
        $5::uuid, $6::integer, 1, $7::timestamptz, $7::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      context.phone,
      context.patient_id,
      context.patient_uid,
      context.physician_uid,
      context.admission_id,
      evidenceAt
    ]
  );
  const investigationId = Number(investigation.rows[0].id);
  const resourceReference = await client.query(
    `INSERT INTO care_pathway_resource_references
       (tenant_id, pathway_instance_id, patient_uid, resource_type,
        relationship_kind, evidence_state, resource_id, actor_system_key,
        occurred_at, idempotency_key, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'investigation',
        'child_action', 'open', $4::text,
        'seed-comprehensive-test-data.s4', $5::timestamptz,
        'seed-s4-pending-resource-v1',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
     RETURNING id`,
    [DEFAULT_TENANT_ID, pathwayId, context.patient_uid, String(investigationId), evidenceAt]
  );

  const assignmentId = randomUUID();
  const assignmentTimelineId = randomUUID();
  const assignmentAuditId = randomUUID();
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, resource_type, resource_id,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'admission.primary_physician.assigned', 'assigned',
        'inpatient_primary_physician_assignments', $4::text,
        'inpatient_primary_physician_assignments', $4::text,
        $5::timestamptz, FALSE, 'Seed primary physician assignment',
        '{}'::jsonb, ARRAY['inpatient', 'primary_physician', 'seed']::text[],
        'seed-s4-primary-assignment-timeline-v1')`,
    [assignmentTimelineId, DEFAULT_TENANT_ID, context.patient_uid, assignmentId, evidenceAt]
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'admission.primary_physician.assigned', 'success',
        'inpatient_primary_physician_assignments',
        'inpatient_primary_physician_assignments', $4::text,
        '{}'::jsonb, '{}'::jsonb,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        'seed-s4-primary-assignment-audit-v1', $5::timestamptz)`,
    [assignmentAuditId, DEFAULT_TENANT_ID, context.patient_uid, assignmentId, evidenceAt]
  );
  await client.query(
    `INSERT INTO inpatient_primary_physician_assignments
       (id, tenant_id, admission_id, patient_uid, assignment_version,
        physician_uid, assignment_source, assigned_by_uid, assigned_at,
        canonical_timeline_event_id, canonical_audit_event_id, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, 1,
        $5::uuid, 'attending_physician', $5::uuid, $6::timestamptz,
        $7::uuid, $8::uuid, 'seed-s4-primary-assignment-v1')`,
    [
      assignmentId,
      DEFAULT_TENANT_ID,
      context.admission_id,
      context.patient_uid,
      context.physician_uid,
      evidenceAt,
      assignmentTimelineId,
      assignmentAuditId
    ]
  );

  const generationId = randomUUID();
  const generationTimelineId = randomUUID();
  const generationAuditId = randomUUID();
  const itemHash = createHash('sha256')
    .update(`seed-s4-pending-item:${generationId}`, 'utf8')
    .digest('hex');
  const aggregateHash = createHash('sha256').update(itemHash, 'utf8').digest('hex');
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, occurred_at, visible_to_patient,
        clinical_summary, payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'diagnostic_result.generation_signed', 'signed',
        'diagnostic_result_generations', $4::text,
        $5::timestamptz, FALSE, 'Seed diagnostic result generation signed',
        '{}'::jsonb, ARRAY['diagnostic_result', 'seed']::text[],
        'seed-s4-generation-timeline-v1')`,
    [generationTimelineId, DEFAULT_TENANT_ID, context.patient_uid, generationId, evidenceAt]
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'diagnostic_result.generation_signed', 'success',
        'diagnostic_result_generation', 'diagnostic_result_generations',
        $4::text, '{}'::jsonb, '{}'::jsonb,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        'seed-s4-generation-audit-v1', $5::timestamptz)`,
    [generationAuditId, DEFAULT_TENANT_ID, context.patient_uid, generationId, evidenceAt]
  );
  await client.query(
    `INSERT INTO diagnostic_result_generations
       (id, tenant_id, patient_uid, admission_id,
        source_kind, source_table, source_episode_type, source_episode_key,
        source_version, investigation_id, ordering_owner_uid, owner_source,
        signer_uid, signer_role, signed_at, classification,
        classification_basis, snapshot_sha256, item_count,
        canonical_timeline_event_id, canonical_audit_event_id)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::integer,
        'shared_investigation', 'investigations', 's4_seed_pending_result',
        $5::text, 1, $6::integer, $7::uuid, 'named_orderer',
        $7::uuid, 'DOCTOR', $8::timestamptz, 'normal',
        '{"seed":true}'::jsonb, $9::char(64), 1, $10::uuid, $11::uuid)`,
    [
      generationId,
      DEFAULT_TENANT_ID,
      context.patient_uid,
      context.admission_id,
      `seed-s4-pending-generation:${context.admission_id}:${investigationId}`,
      investigationId,
      context.physician_uid,
      evidenceAt,
      aggregateHash,
      generationTimelineId,
      generationAuditId
    ]
  );
  await client.query(
    `INSERT INTO diagnostic_result_generation_items
       (tenant_id, patient_uid, generation_id, source_table,
        source_row_id, source_version, source_ordinal, item_code,
        item_name, value_snapshot, normalized_flag, source_critical,
        classification, item_snapshot_sha256)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'investigations',
        $4::text, '1', 1, 'S4-SEED-PENDING',
        'Seed pending-result probe', '{"value":"available"}'::jsonb,
        'normal', FALSE, 'normal', $5::char(64))`,
    [DEFAULT_TENANT_ID, context.patient_uid, generationId, String(investigationId), itemHash]
  );
  const diagnosticConstraints = [
    'fk_diagnostic_generation_investigation',
    'fk_diagnostic_generation_timeline',
    'fk_diagnostic_generation_audit',
    'fk_diagnostic_generation_item_generation',
    'trg_validate_diagnostic_generation_predecessor',
    'trg_validate_diagnostic_generation_complete',
    'trg_validate_diagnostic_generation_items_complete'
  ].join(', ');
  await client.query(`SET CONSTRAINTS ${diagnosticConstraints} IMMEDIATE`);
  await client.query(`SET CONSTRAINTS ${diagnosticConstraints} DEFERRED`);

  const pendingHandoffId = randomUUID();
  const trackingTask = await client.query(
    `INSERT INTO tasks
       (tenant_id, workflow_run_id, workflow_step_id, task_kind, title,
        description, patient_uid, related_resource_type, related_resource_id,
        priority, status, assigned_to_uid, assigned_to_role, created_by,
        sla_completion_semantics, metadata)
     VALUES
       ($1::uuid, $2::integer, $3::integer, 'follow_up',
        'Review seed pending discharge result',
        'Synthetic local test-only S4 tracking task.', $4::uuid,
        'discharge_pending_result_handoff', $5::text, 'normal', 'open',
        $6::uuid, NULL, $6::uuid, 'none',
        jsonb_build_object(
          'admission_id', $7::integer,
          'source_type', 'investigation',
          'source_id', $8::text,
          'task_contract', 'discharge_pending_result_tracking_v1',
          'correlation_contract', 'pending_result_tracking_v1',
          'predecessor_tracking_task_id', NULL,
          'rearm_reason', NULL,
          'seed', TRUE
        ))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      runId,
      stepId,
      context.patient_uid,
      pendingHandoffId,
      context.physician_uid,
      context.admission_id,
      String(investigationId)
    ]
  );
  const trackingTaskId = Number(trackingTask.rows[0].id);
  await client.query(
    `INSERT INTO discharge_pending_result_handoffs
       (id, tenant_id, admission_id, patient_uid, resource_reference_id,
        source_type, source_id, patient_safe_label, result_status,
        primary_physician_assignment_id, named_physician_uid, task_id,
        resolution_generation_id, handoff_state, created_by_uid,
        idempotency_key, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
        'investigation', $6::text, 'Pending diagnostic result',
        'available', $7::uuid, $8::uuid, $9::integer,
        $10::uuid, 'result_available', $8::uuid,
        'seed-s4-pending-handoff-v1',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)`,
    [
      pendingHandoffId,
      DEFAULT_TENANT_ID,
      context.admission_id,
      context.patient_uid,
      resourceReference.rows[0].id,
      String(investigationId),
      assignmentId,
      context.physician_uid,
      trackingTaskId,
      generationId
    ]
  );

  const actionTask = await client.query(
    `INSERT INTO tasks
       (tenant_id, workflow_run_id, parent_task_id, task_kind, title,
        description, patient_uid, related_resource_type, related_resource_id,
        priority, status, assigned_to_uid, assigned_to_role, created_by,
        sla_completion_semantics, metadata)
     VALUES
       ($1::uuid, $2::integer, $3::integer, 'review',
        'Review seed available discharge result',
        'Synthetic local test-only S4 owner action.', $4::uuid,
        'discharge_pending_result_action', $5::text, 'normal', 'open',
        $6::uuid, NULL, $6::uuid, 'none',
        jsonb_build_object(
          'task_contract', 'discharge_pending_result_action_v1',
          'handoff_id', $7::text,
          'generation_id', $8::text,
          'predecessor_generation_id', NULL,
          'predecessor_owner_action_id', NULL,
          'predecessor_resolution_action_id', NULL,
          'rearm_source_action_id', NULL,
          'seed', TRUE
        ))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      runId,
      trackingTaskId,
      context.patient_uid,
      `${pendingHandoffId}:${generationId}`,
      context.physician_uid,
      pendingHandoffId,
      generationId
    ]
  );
  const actionTaskId = Number(actionTask.rows[0].id);
  const ownerActionId = randomUUID();
  const ownerTimelineId = randomUUID();
  const ownerAuditId = randomUUID();
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, resource_type, resource_id,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'discharge.pending_result_available', 'result_available',
        'discharge_pending_result_handoffs', $4::text,
        'diagnostic_result_generation', $5::text,
        $6::timestamptz, FALSE, 'Seed pending result available',
        jsonb_build_object(
          'admission_id', $7::integer,
          'handoff_id', $4::text,
          'generation_id', $5::text,
          'predecessor_generation_id', NULL,
          'predecessor_owner_action_id', NULL,
          'predecessor_resolution_action_id', NULL,
          'rearm_source_action_id', NULL,
          'action_task_id', $8::integer,
          'tracking_task_id', $9::integer
        ),
        ARRAY['pending_result', 'seed']::text[],
        'seed-s4-owner-action-timeline-v1')`,
    [
      ownerTimelineId,
      DEFAULT_TENANT_ID,
      context.patient_uid,
      pendingHandoffId,
      generationId,
      evidenceAt,
      context.admission_id,
      actionTaskId,
      trackingTaskId
    ]
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'discharge.pending_result_available', 'success',
        'diagnostic_result_generation', 'discharge_pending_result_handoffs',
        $4::text, '{}'::jsonb, '{}'::jsonb,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        'seed-s4-owner-action-audit-v1', $5::timestamptz)`,
    [ownerAuditId, DEFAULT_TENANT_ID, context.patient_uid, generationId, evidenceAt]
  );
  const outbox = await client.query(
    `INSERT INTO event_outbox
       (tenant_id, event_type, aggregate_type, aggregate_id,
        patient_uid, payload)
     VALUES
       ($1::uuid, 'discharge.pending_result_available',
        'discharge_pending_result_handoff', $2::text, $3::uuid,
        jsonb_build_object(
          'admission_id', $4::integer,
          'handoff_id', $2::text,
          'generation_id', $5::text,
          'predecessor_generation_id', NULL,
          'predecessor_owner_action_id', NULL,
          'predecessor_resolution_action_id', NULL,
          'rearm_source_action_id', NULL,
          'action_task_id', $6::integer,
          'tracking_task_id', $7::integer,
          'canonical_timeline_event_id', $8::text,
          'canonical_audit_event_id', $9::text
        ))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      pendingHandoffId,
      context.patient_uid,
      context.admission_id,
      generationId,
      actionTaskId,
      trackingTaskId,
      ownerTimelineId,
      ownerAuditId
    ]
  );
  await client.query(
    `INSERT INTO discharge_pending_result_owner_actions
       (id, tenant_id, handoff_id, admission_id, patient_uid, generation_id,
        task_id, owner_uid, source_outbox_event_id,
        canonical_timeline_event_id, canonical_audit_event_id,
        idempotency_key, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::uuid,
        $7::integer, $8::uuid, $9::bigint, $10::uuid, $11::uuid,
        'seed-s4-pending-owner-action-v1',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)`,
    [
      ownerActionId,
      DEFAULT_TENANT_ID,
      pendingHandoffId,
      context.admission_id,
      context.patient_uid,
      generationId,
      actionTaskId,
      context.physician_uid,
      outbox.rows[0].id,
      ownerTimelineId,
      ownerAuditId
    ]
  );
  await client.query(
    `SET CONSTRAINTS
       trg_discharge_pending_result_owner_actions_validate,
       trg_discharge_pending_result_handoffs_validate
     IMMEDIATE`
  );
  await client.query(
    `SET CONSTRAINTS
       trg_discharge_pending_result_owner_actions_validate,
       trg_discharge_pending_result_handoffs_validate
     DEFERRED`
  );

  const closureId = randomUUID();
  const closureTimelineId = randomUUID();
  const closureAuditId = randomUUID();
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, occurred_at, visible_to_patient,
        clinical_summary, payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'appointment.closure_evidence_recorded', 'completed',
        'op_visit_closure_evidence', $4::text,
        $5::timestamptz, FALSE, 'Seed OP closure evidence recorded',
        '{}'::jsonb, ARRAY['op_closure', 'seed']::text[],
        'seed-s4-op-closure-timeline-v1')`,
    [closureTimelineId, DEFAULT_TENANT_ID, context.patient_uid, closureId, evidenceAt]
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'appointment.closure_evidence_recorded', 'success',
        'op_visit_closure_evidence', 'op_visit_closure_evidence', $4::text,
        '{}'::jsonb, '{}'::jsonb,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        'seed-s4-op-closure-audit-v1', $5::timestamptz)`,
    [closureAuditId, DEFAULT_TENANT_ID, context.patient_uid, closureId, evidenceAt]
  );
  await client.query(
    `INSERT INTO op_visit_closure_evidence
       (id, tenant_id, appointment_id, patient_uid, evidence_revision,
        clinician_uid, follow_up_required, patient_safe_next_steps,
        closure_basis, source_status_history_id,
        canonical_timeline_event_id, canonical_audit_event_id,
        occurred_at, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, 1,
        $5::uuid, FALSE,
        '[{"kind":"self_care","label":"Continue the care plan"}]'::jsonb,
        'all_required_work_completed', $6::bigint,
        $7::uuid, $8::uuid, $9::timestamptz,
        'seed-s4-op-closure-v1')`,
    [
      closureId,
      DEFAULT_TENANT_ID,
      appointment.id,
      context.patient_uid,
      context.physician_uid,
      appointment.status_history_id,
      closureTimelineId,
      closureAuditId,
      evidenceAt
    ]
  );

  const contactId = randomUUID();
  const contactTimelineId = randomUUID();
  const contactAuditId = randomUUID();
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, occurred_at, visible_to_patient,
        clinical_summary, payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'post_discharge.contact_recorded', 'attempt',
        'post_discharge_contact_events', $4::text,
        $5::timestamptz, FALSE, 'Seed post-discharge contact attempt',
        '{}'::jsonb, ARRAY['post_discharge', 'seed']::text[],
        'seed-s4-post-discharge-contact-timeline-v1')`,
    [contactTimelineId, DEFAULT_TENANT_ID, context.patient_uid, contactId, evidenceAt]
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'post_discharge.contact_recorded', 'success',
        'post_discharge_contact_event', 'post_discharge_contact_events',
        $4::text, '{}'::jsonb, '{}'::jsonb,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        'seed-s4-post-discharge-contact-audit-v1', $5::timestamptz)`,
    [contactAuditId, DEFAULT_TENANT_ID, context.patient_uid, contactId, evidenceAt]
  );
  await client.query(
    `INSERT INTO post_discharge_contact_events
       (id, tenant_id, admission_id, patient_uid, event_kind,
        contact_source, contact_channel, recorded_by_uid,
        canonical_timeline_event_id, canonical_audit_event_id,
        occurred_at, idempotency_key, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, 'attempt',
        'manual', 'phone', $5::uuid, $6::uuid, $7::uuid,
        $8::timestamptz, 'seed-s4-post-discharge-contact-v1',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)`,
    [
      contactId,
      DEFAULT_TENANT_ID,
      context.admission_id,
      context.patient_uid,
      context.physician_uid,
      contactTimelineId,
      contactAuditId,
      evidenceAt
    ]
  );
}

async function seedCarePathwayReconciliationEvidence() {
  if (!(await tableExists('care_pathway_reconciliation_checks'))
      || await tableCount('care_pathway_reconciliation_checks')) return;

  const now = new Date('2026-05-04T12:00:00.000Z');
  await insert('care_pathway_reconciliation_checks', {
    sweep_id: '11111111-2222-4333-8444-555555555555',
    tenant_id: DEFAULT_TENANT_ID,
    pathway_key: 'diagnostics_order_to_action',
    pathway_mode: 'off',
    registry_version: 1,
    registry_checksum: 'a'.repeat(64),
    governance_checksum: 'b'.repeat(64),
    governance_count: 1,
    covered_governance_count: 1,
    expected_check_count: 1,
    executed_check_count: 1,
    finding_count: 0,
    repair_count: 0,
    error_count: 0,
    registry_complete: true,
    passed: false,
    check_results: JSON.stringify([{
      check_key: 'seed_fixture',
      status: 'passed',
      source: 'seed-comprehensive-test-data',
    }]),
    started_at: now,
    completed_at: now,
  });
}

async function seedDiagnosticResultEvidence() {
  const targetTables = [
    'diagnostic_result_generations',
    'diagnostic_result_generation_items',
    'diagnostic_result_actions',
    'diagnostic_result_release_states',
  ];
  const existingCounts = [];
  for (const table of targetTables) existingCounts.push(await tableCount(table));
  if (existingCounts.every(Boolean)) return;

  const investigation = await first(
    'investigations',
    'id, patient_uid, requested_by, test_name, result_version',
    'tenant_id = $1::uuid AND patient_uid IS NOT NULL',
    [DEFAULT_TENANT_ID],
  );
  const doctor = await first(
    'users',
    'uid, role',
    `tenant_id = $1::uuid
     AND role = 'DOCTOR' AND is_active = TRUE AND status = 'active'`,
    [DEFAULT_TENANT_ID],
  );
  let radiology = await first(
    'radiology_orders',
    'id, patient_uid, modality, body_part, report_generation_version',
    'tenant_id = $1::uuid AND patient_uid = $2::uuid AND report_signed_off_at IS NOT NULL',
    [DEFAULT_TENANT_ID, investigation?.patient_uid],
  );
  if (!investigation?.id || !investigation.patient_uid || !doctor?.uid) {
    throw new Error('Diagnostic-result seed evidence requires a patient-linked investigation and doctor.');
  }
  if (!radiology?.id) {
    const seededRadiology = await client.query(
      `INSERT INTO radiology_orders
         (tenant_id, patient_uid, modality, body_part, clinical_indication,
          priority, status, ordered_by, radiologist, report,
          report_completed_at, report_signed_off_at, report_signed_off_by,
          result_classification, classification_basis, report_generation_version,
          classification_signed_by, classification_signed_at,
          signoff_idempotency_key, signoff_request_sha256,
          created_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'ct', 'chest', 'Synthetic seed evidence',
          'routine', 'signed_off', $3::uuid, $3::uuid,
          'Seed radiology report with no diagnostic abnormality.',
          $4::timestamptz, $4::timestamptz, $3::uuid,
          'normal', $5::jsonb, 1, $3::uuid, $4::timestamptz,
          'seed-radiology-generation-signoff-v1', $6::char(64),
          $4::timestamptz, $4::timestamptz)
       RETURNING id, patient_uid, modality, body_part, report_generation_version`,
      [
        DEFAULT_TENANT_ID,
        investigation.patient_uid,
        doctor.uid,
        new Date('2026-05-04T11:00:00.000Z'),
        JSON.stringify({ explicit_normal_flag: true, seed: true }),
        '4'.repeat(64),
      ],
    );
    radiology = seededRadiology.rows[0];
  }

  const itemHash = createHash('sha256')
    .update('seed-diagnostic-result-item-v1')
    .digest('hex');
  const generationHash = createHash('sha256').update(itemHash).digest('hex');
  const requestHash = createHash('sha256')
    .update('seed-diagnostic-normal-auto-close-v1')
    .digest('hex');
  const generationId = '22222222-3333-4444-8555-666666666666';
  const actionId = '33333333-4444-4555-8666-777777777777';
  const signedAt = new Date('2026-05-04T11:00:00.000Z');

  const generationTimeline = await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, event_status, source_table,
        source_id, source_uid, resource_type, resource_id, occurred_at,
        visible_to_patient, clinical_summary, payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'diagnostic_result.generation_created', 'normal',
        'diagnostic_result_generations', $3::text, $3::uuid,
        'diagnostic_result_generation', $3::text, $4::timestamptz, FALSE,
        'Synthetic normal diagnostic generation for local test coverage.',
        $5::jsonb, ARRAY['diagnostics', 'seed']::text[], $6::text)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      investigation.patient_uid,
      generationId,
      signedAt,
      JSON.stringify({ seed: true, classification: 'normal' }),
      `diagnostic-result-generation:${generationId}:timeline`,
    ],
  );
  const generationAudit = await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, action_status, resource_type,
        resource_table, resource_id, after_state, metadata, idempotency_key,
        occurred_at)
     VALUES
       ($1::uuid, $2::uuid, 'diagnostic_result.generation_created', 'success',
        'diagnostic_result_generation', 'diagnostic_result_generations',
        $3::text, $4::jsonb, $5::jsonb, $6::text, $7::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      investigation.patient_uid,
      generationId,
      JSON.stringify({ classification: 'normal', snapshot_sha256: generationHash }),
      JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      `diagnostic-result-generation:${generationId}:audit`,
      signedAt,
    ],
  );

  await client.query(
    `INSERT INTO diagnostic_result_generations
       (id, tenant_id, patient_uid, source_kind, source_table,
        source_episode_type, source_episode_key, source_version,
        radiology_order_id, ordering_owner_uid, owner_source, signer_uid,
        signer_role, signed_at, classification, classification_basis,
        snapshot_sha256, item_count, canonical_timeline_event_id,
        canonical_audit_event_id)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'radiology_report', 'radiology_orders',
        'radiology_order', $4::text, $5::bigint, $6::integer, $7::uuid,
        'named_orderer', $7::uuid, $8::text, $9::timestamptz, 'normal',
        $10::jsonb, $11::char(64), 1, $12::uuid, $13::uuid)`,
    [
      generationId,
      DEFAULT_TENANT_ID,
      investigation.patient_uid,
      `radiology_order:${radiology.id}`,
      Number(radiology.report_generation_version || 1),
      radiology.id,
      doctor.uid,
      doctor.role,
      signedAt,
      JSON.stringify({ explicit_normal_flag: true, seed: true }),
      generationHash,
      generationTimeline.rows[0].id,
      generationAudit.rows[0].id,
    ],
  );
  await client.query(
    `INSERT INTO diagnostic_result_generation_items
       (tenant_id, patient_uid, generation_id, source_table, source_row_id,
        source_version, source_ordinal, item_name, value_snapshot,
        normalized_flag, source_critical, classification, item_snapshot_sha256)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'radiology_orders', $4::text, $5::text,
        1, $6::text, $7::jsonb, 'N', FALSE, 'normal', $8::char(64))`,
    [
      DEFAULT_TENANT_ID,
      investigation.patient_uid,
      generationId,
      String(radiology.id),
      String(radiology.report_generation_version || 1),
      [radiology.modality, radiology.body_part].filter(Boolean).join(' ') || 'Seed radiology report',
      JSON.stringify({ report: 'No diagnostic abnormality.', seed: true }),
      itemHash,
    ],
  );
  await client.query(
    `INSERT INTO diagnostic_result_release_states
       (generation_id, tenant_id, patient_uid)
     VALUES ($1::uuid, $2::uuid, $3::uuid)`,
    [generationId, DEFAULT_TENANT_ID, investigation.patient_uid],
  );

  const actionTimeline = await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, event_status, source_table,
        source_id, source_uid, resource_type, resource_id, occurred_at,
        visible_to_patient, clinical_summary, payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'diagnostic_result.normal_auto_closed', 'completed',
        'diagnostic_result_actions', $3::text, $3::uuid,
        'diagnostic_result_action', $3::text, $4::timestamptz, FALSE,
        'Synthetic normal-result auto-closure for local test coverage.',
        $5::jsonb, ARRAY['diagnostics', 'seed']::text[], $6::text)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      investigation.patient_uid,
      actionId,
      signedAt,
      JSON.stringify({ seed: true, generation_id: generationId }),
      `diagnostic-result-action:${actionId}:timeline`,
    ],
  );
  const actionAudit = await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, action_status, resource_type,
        resource_table, resource_id, after_state, metadata, idempotency_key,
        occurred_at)
     VALUES
       ($1::uuid, $2::uuid, 'diagnostic_result.normal_auto_closed', 'success',
        'diagnostic_result_action', 'diagnostic_result_actions', $3::text,
        $4::jsonb, $5::jsonb, $6::text, $7::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      investigation.patient_uid,
      actionId,
      JSON.stringify({ action_kind: 'normal_auto_closed', generation_id: generationId }),
      JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      `diagnostic-result-action:${actionId}:audit`,
      signedAt,
    ],
  );
  await client.query(
    `INSERT INTO diagnostic_result_actions
       (id, tenant_id, patient_uid, generation_id, action_kind,
        generation_snapshot_sha256, idempotency_key, request_sha256,
        release_decision, canonical_timeline_event_id,
        canonical_audit_event_id, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'normal_auto_closed',
        $5::char(64), $6::text, $7::char(64), $8::jsonb, $9::uuid,
        $10::uuid, $11::timestamptz)`,
    [
      actionId,
      DEFAULT_TENANT_ID,
      investigation.patient_uid,
      generationId,
      generationHash,
      'seed-diagnostic-normal-auto-close-v1',
      requestHash,
      JSON.stringify({ decision: 'release_allowed', seed: true }),
      actionTimeline.rows[0].id,
      actionAudit.rows[0].id,
      signedAt,
    ],
  );
}

async function seedDiagnosticResultPatientNotificationEvidence() {
  if (await tableCount('diagnostic_result_patient_notifications')) return;
  await client.query(
    "SELECT set_config('app.current_tenant_id', $1::text, true)",
    [DEFAULT_TENANT_ID],
  );
  const generation = await first(
    'diagnostic_result_generations',
    'id, patient_uid',
    `tenant_id = $1::uuid
     AND source_kind IN ('radiology_report', 'anatomical_pathology_report')`,
    [DEFAULT_TENANT_ID],
  );
  if (!generation?.id || !generation.patient_uid) {
    throw new Error('Diagnostic notification seed evidence requires a structured generation.');
  }
  const outbox = await client.query(
    `INSERT INTO notification_outbox
       (tenant_id, type, recipient_id, title, body, payload, status, sent_at, created_at)
     VALUES
       ($1::uuid, 'diagnostic_result_ready', $2::text,
        'New report available',
        'Open VH Health to securely view your latest report.',
        $3::jsonb, 'SENT', NOW(), NOW())
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      String(generation.patient_uid),
      JSON.stringify({
        tenant_id: DEFAULT_TENANT_ID,
        type: 'diagnostic_result_ready',
        route: '/portal/diagnostic-results',
        seed: true,
      }),
    ],
  );
  await client.query(
    `INSERT INTO diagnostic_result_patient_notifications
       (tenant_id, generation_id, patient_uid, notification_kind,
        policy_version, notification_outbox_id)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'result_ready',
        'structured_diagnostic_result_ready.v1', $4::integer)`,
    [DEFAULT_TENANT_ID, generation.id, generation.patient_uid, Number(outbox.rows[0].id)],
  );
}

async function seedNotificationDeliveryEvidence() {
  if (!await tableExists('notification_delivery_attempts')) return;
  if (await tableCount('notification_delivery_attempts')) return;
  await client.query(
    "SELECT set_config('app.current_tenant_id', $1::text, true)",
    [DEFAULT_TENANT_ID],
  );
  const claimToken = randomUUID();
  const outbox = await client.query(
    `INSERT INTO notification_outbox
       (tenant_id, type, recipient_id, title, body, payload, status,
        channel, source_event_key, recipient_key, template_version,
        rendered_intent_hash, ledger_version)
     VALUES
       ($1::uuid, 'push', 'seed-notification-operator',
        'Seed provider acceptance',
        'Synthetic delivery evidence for schema coverage only.',
        '{"seed":true,"provider_egress":false}'::jsonb, 'PENDING',
        'push', 'seed:notification-delivery-accepted',
        'id:seed-notification-operator', 'seed.notification-delivery.v1',
        repeat('e', 64), 1)
     ON CONFLICT ON CONSTRAINT ux_notification_outbox_delivery_intent
     DO NOTHING
     RETURNING id`,
    [DEFAULT_TENANT_ID],
  );
  const outboxId = outbox.rows[0]?.id || (await client.query(
    `SELECT id FROM notification_outbox
      WHERE tenant_id = $1::uuid
        AND source_event_key = 'seed:notification-delivery-accepted'
      LIMIT 1`,
    [DEFAULT_TENANT_ID],
  )).rows[0].id;
  await client.query(
    `UPDATE notification_outbox
        SET status = 'CLAIMED', claim_token = $3::uuid,
            claim_generation = claim_generation + 1,
            claimed_at = NOW(), lease_expires_at = NOW() + INTERVAL '2 minutes'
      WHERE tenant_id = $1::uuid AND id = $2::integer
        AND status = 'PENDING'`,
    [DEFAULT_TENANT_ID, outboxId, claimToken],
  );
  const attempt = await client.query(
    `INSERT INTO notification_delivery_attempts
       (tenant_id, notification_outbox_id, channel, claim_token,
        claim_generation, attempt_number, provider, rendered_intent_hash)
     SELECT tenant_id, id, channel, claim_token, claim_generation, 1,
            'seed_no_egress', rendered_intent_hash
       FROM notification_outbox
      WHERE tenant_id = $1::uuid AND id = $2::integer
     RETURNING attempt_id`,
    [DEFAULT_TENANT_ID, outboxId],
  );
  await client.query(
    `INSERT INTO notification_provider_receipts
       (tenant_id, attempt_id, notification_outbox_id, channel, outcome,
        receipt_source, provider_reference, provider_code, evidence)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, 'push', 'acknowledged',
        'provider_response', 'seed:no-egress:accepted', 'seed_acceptance',
        '{"seed":true,"provider_egress":false}'::jsonb)`,
    [DEFAULT_TENANT_ID, attempt.rows[0].attempt_id, outboxId],
  );
  await client.query(
    `INSERT INTO notification_delivery_cursors (tenant_id, channel)
     VALUES ($1::uuid, 'push')
     ON CONFLICT (tenant_id, channel) DO NOTHING`,
    [DEFAULT_TENANT_ID],
  );
  await client.query(
    `UPDATE notification_delivery_cursors
        SET last_contiguous_outbox_id = $2::integer, state = 'ready',
            blocked_outbox_id = NULL, inflight_outbox_id = NULL, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND channel = 'push'`,
    [DEFAULT_TENANT_ID, outboxId],
  );
  await client.query(
    `UPDATE notification_outbox
        SET status = 'SENT', claim_token = NULL, claimed_at = NULL,
            lease_expires_at = NULL, sent_at = NOW(), last_attempt_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [DEFAULT_TENANT_ID, outboxId],
  );
}

async function seedHl7OutboundDeliveryEvidence() {
  if (!await tableExists('hl7_outbound_transport_attempts')) return;
  if (await tableCount('hl7_outbound_transport_attempts')) return;
  await client.query(
    "SELECT set_config('app.current_tenant_id', $1::text, true)",
    [DEFAULT_TENANT_ID],
  );

  const claimToken = randomUUID();
  const controlId = 'VH-SEED-I04-AA';
  const payload = [
    `MSH|^~\\&|VH|VH|SEED|SEED|20260802000000||ADT^A01|${controlId}|P|2.5`,
    'PID|1||SEED-I04^^^VH^MR||Recovery^Evidence',
  ].join('\r');
  const payloadHash = createHash('sha256').update(payload, 'utf8').digest('hex');
  const acknowledgement = [
    `MSH|^~\\&|SEED|SEED|VH|VH|20260802000001||ACK^A01|SEED-ACK-I04|P|2.5`,
    `MSA|AA|${controlId}|Seed acceptance without provider egress`,
  ].join('\r');
  const acknowledgementHash = createHash('sha256')
    .update(acknowledgement, 'utf8')
    .digest('hex');

  const subscription = await client.query(
    `INSERT INTO hl7_feed_subscriptions
       (tenant_id, name, endpoint_url, message_types, is_active, metadata)
     VALUES
       ($1::uuid, 'VH seed I04 delivery', 'https://example.invalid/no-egress',
        ARRAY['ADT^A01']::text[], FALSE,
        '{"seed":true,"provider_egress":false}'::jsonb)
     ON CONFLICT (tenant_id, name) DO UPDATE
       SET is_active = FALSE, metadata = EXCLUDED.metadata
     RETURNING id`,
    [DEFAULT_TENANT_ID],
  );
  const message = await client.query(
    `INSERT INTO hl7_outbound_messages
       (tenant_id, subscription_id, message_type, message_control_id,
        hl7_payload, source_table, source_id, status, source_event_key,
        payload_sha256, ledger_version, transport_state,
        acknowledgement_state, send_authority)
     VALUES
       ($1::uuid, $2::integer, 'ADT^A01', $3::text, $4::text,
        'seed-comprehensive-test-data', 'VH-SEED-I04', 'queued',
        'seed:hl7-outbound-delivery-aa', $5::char(64), 1,
        'not_attempted', 'pending', 'authorized')
     ON CONFLICT ON CONSTRAINT ux_hl7_outbound_message_source
     DO NOTHING
     RETURNING id`,
    [DEFAULT_TENANT_ID, subscription.rows[0].id, controlId, payload, payloadHash],
  );
  const messageId = message.rows[0]?.id || (await client.query(
    `SELECT id
       FROM hl7_outbound_messages
      WHERE tenant_id = $1::uuid
        AND subscription_id = $2::integer
        AND source_event_key = 'seed:hl7-outbound-delivery-aa'
        AND message_type = 'ADT^A01'`,
    [DEFAULT_TENANT_ID, subscription.rows[0].id],
  )).rows[0].id;

  await client.query(
    `UPDATE hl7_outbound_messages
        SET status = 'claimed', claim_token = $3::uuid,
            claim_generation = claim_generation + 1,
            claimed_at = NOW(), lease_expires_at = NOW() + INTERVAL '2 minutes'
      WHERE tenant_id = $1::uuid AND id = $2::integer
        AND status = 'queued' AND send_authority = 'authorized'`,
    [DEFAULT_TENANT_ID, messageId, claimToken],
  );
  const attempt = await client.query(
    `INSERT INTO hl7_outbound_transport_attempts
       (tenant_id, message_id, subscription_id, claim_token,
        claim_generation, attempt_number, payload_sha256)
     SELECT tenant_id, id, subscription_id, claim_token,
            claim_generation, 1, payload_sha256
       FROM hl7_outbound_messages
      WHERE tenant_id = $1::uuid AND id = $2::integer
     RETURNING attempt_id`,
    [DEFAULT_TENANT_ID, messageId],
  );
  const transport = await client.query(
    `INSERT INTO hl7_outbound_transport_results
       (tenant_id, attempt_id, message_id, subscription_id, outcome,
        http_status, response_body_sha256, evidence)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::integer, 'http_response',
        200, $5::char(64), '{"seed":true,"provider_egress":false}'::jsonb)
     RETURNING transport_result_id`,
    [
      DEFAULT_TENANT_ID,
      attempt.rows[0].attempt_id,
      messageId,
      subscription.rows[0].id,
      acknowledgementHash,
    ],
  );
  await client.query(
    `INSERT INTO hl7_outbound_acknowledgements
       (tenant_id, attempt_id, transport_result_id, message_id,
        subscription_id, msa_code, acknowledged_control_id,
        correlation_matches, acknowledgement_payload_sha256,
        receipt_source, evidence)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::integer,
        'AA', $6::text, TRUE, $7::char(64), 'provider_response',
        '{"seed":true,"provider_egress":false,"parsed_msa":true}'::jsonb)`,
    [
      DEFAULT_TENANT_ID,
      attempt.rows[0].attempt_id,
      transport.rows[0].transport_result_id,
      messageId,
      subscription.rows[0].id,
      controlId,
      acknowledgementHash,
    ],
  );
  await client.query(
    `INSERT INTO hl7_outbound_delivery_cursors (tenant_id, subscription_id)
     VALUES ($1::uuid, $2::integer)
     ON CONFLICT (tenant_id, subscription_id) DO NOTHING`,
    [DEFAULT_TENANT_ID, subscription.rows[0].id],
  );
  await client.query(
    `UPDATE hl7_outbound_delivery_cursors
        SET last_contiguous_message_id = $3::integer, state = 'ready',
            blocked_message_id = NULL, inflight_message_id = NULL,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND subscription_id = $2::integer`,
    [DEFAULT_TENANT_ID, subscription.rows[0].id, messageId],
  );
  await client.query(
    `UPDATE hl7_outbound_messages
        SET status = 'sent', attempts = attempts + 1,
            transport_state = 'http_response', acknowledgement_state = 'aa',
            claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL,
            sent_at = NOW(), last_error = NULL
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [DEFAULT_TENANT_ID, messageId],
  );
}

async function seedInteropHl7v2DeliveryReceipt() {
  if (!await tableExists('interop_backend_delivery_receipts')) return;
  if (await tableCount('interop_backend_delivery_receipts')) return;
  await client.query(
    "SELECT set_config('app.current_tenant_id', $1::text, true)",
    [DEFAULT_TENANT_ID],
  );
  const message = await first(
    'interop_messages',
    'id, tenant_id, channel_id, channel_version_id, protocol, direction, payload_hash',
    "tenant_id = $1::uuid AND protocol = 'hl7v2' AND direction = 'inbound'",
    [DEFAULT_TENANT_ID],
  );
  if (!message) {
    throw new Error('I05 seed receipt requires the generic live HL7v2 message');
  }
  if (message.payload_hash !== I05_SEED_PAYLOAD_HASH) {
    throw new Error('I05 seed message payload hash drifted from its frozen bytes');
  }
  await client.query(
    `INSERT INTO interop_backend_delivery_receipts
       (tenant_id, message_id, channel_id, channel_version_id, protocol,
        direction, adapter_key, adapter_version, payload_sha256, payload_bytes,
        transformed_payload, receipt_status, evidence)
     VALUES ($1::uuid, $2::integer, $3::integer, $4::integer, $5::text,
             $6::text, 'backend.interop.preview', 'vhhealth.i05.hl7v2/v1',
             $7::char(64), $8::integer, '{"seed":true}'::jsonb, 'accepted',
             '{"seed":true,"byte_parity_verified":true,"raw_payload_retained":false}'::jsonb)`,
    [
      message.tenant_id,
      message.id,
      message.channel_id,
      message.channel_version_id,
      message.protocol,
      message.direction,
      I05_SEED_PAYLOAD_HASH,
      Buffer.byteLength(I05_SEED_PAYLOAD, 'utf8'),
    ],
  );
}

async function seedInteropHl7v2MessageGraph() {
  if (!await tableExists('interop_messages')) return;
  await client.query(
    "SELECT set_config('app.current_tenant_id', $1::text, true)",
    [DEFAULT_TENANT_ID],
  );
  const source = await client.query(
    `INSERT INTO interop_systems
       (tenant_id, system_key, display_name, kind, direction, status, metadata)
     VALUES
       ($1::uuid, 'vh-seed-i05-source', 'VH seed I05 source', 'his',
        'inbound', 'paused', '{"seed":true,"provider_egress":false}'::jsonb)
     ON CONFLICT (tenant_id, system_key) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           status = 'paused',
           metadata = EXCLUDED.metadata
     RETURNING id`,
    [DEFAULT_TENANT_ID],
  );
  const target = await client.query(
    `INSERT INTO interop_systems
       (tenant_id, system_key, display_name, kind, direction, status, metadata)
     VALUES
       ($1::uuid, 'vh-seed-i05-backend', 'VH seed I05 backend', 'vh_backend',
        'inbound', 'paused', '{"seed":true,"provider_egress":false}'::jsonb)
     ON CONFLICT (tenant_id, system_key) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           status = 'paused',
           metadata = EXCLUDED.metadata
     RETURNING id`,
    [DEFAULT_TENANT_ID],
  );
  const channel = await client.query(
    `INSERT INTO interop_channels
       (tenant_id, channel_key, display_name, source_system_id, target_system_id,
        direction, connector_kind, protocol, message_types, status, auth_kind,
        metadata)
     VALUES
       ($1::uuid, 'vh-seed-i05-inbound', 'VH seed I05 inbound', $2::integer,
        $3::integer, 'inbound', 'http_inbound', 'hl7v2', ARRAY['ADT^A01']::text[],
        'paused', 'internal', '{"seed":true,"provider_egress":false}'::jsonb)
     ON CONFLICT (tenant_id, channel_key) DO UPDATE
       SET source_system_id = EXCLUDED.source_system_id,
           target_system_id = EXCLUDED.target_system_id,
           status = 'paused',
           metadata = EXCLUDED.metadata
     RETURNING id`,
    [DEFAULT_TENANT_ID, source.rows[0].id, target.rows[0].id],
  );
  const version = await client.query(
    `INSERT INTO interop_channel_versions
       (tenant_id, channel_id, version_number, status, connector_config,
        validation_profile, transform_dsl, routing_policy, redaction_profile)
     VALUES
       ($1::uuid, $2::integer, 1, 'candidate',
        '{"seed":true,"listener_enabled":false}'::jsonb,
        '{"message_types":["ADT^A01"]}'::jsonb,
        '{"kind":"identity"}'::jsonb,
        '{"backend_preview_only":true}'::jsonb,
        '{"retain_raw":false}'::jsonb)
     ON CONFLICT (tenant_id, channel_id, version_number) DO UPDATE
       SET status = 'candidate',
           connector_config = EXCLUDED.connector_config,
           validation_profile = EXCLUDED.validation_profile,
           transform_dsl = EXCLUDED.transform_dsl,
           routing_policy = EXCLUDED.routing_policy,
           redaction_profile = EXCLUDED.redaction_profile
     RETURNING id`,
    [DEFAULT_TENANT_ID, channel.rows[0].id],
  );
  await client.query(
    `INSERT INTO interop_messages
       (tenant_id, channel_id, channel_version_id, direction, protocol,
        message_type, external_control_id, dedupe_key, payload_hash,
        raw_payload_ciphertext, raw_payload_retained, redacted_preview,
        parsed_summary, status, recovery_ledger_version, arrival_class,
        effect_disposition, send_authority, owner_reconciliation_required)
     VALUES
       ($1::uuid, $2::integer, $3::integer, 'inbound', 'hl7v2', 'ADT^A01',
        'VH-SEED-I05', 'seed:i05:vh-seed-i05', $4::varchar(64), NULL, FALSE,
        'Synthetic ADT A01 seed payload',
        '{"seed":true,"message_type":"ADT^A01","control_id":"VH-SEED-I05"}'::jsonb,
         'received', 0, 'legacy_unverified', 'held', 'held', TRUE)
      ON CONFLICT (tenant_id, channel_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL
      DO UPDATE
        SET channel_version_id = EXCLUDED.channel_version_id,
            status = 'received',
            recovery_ledger_version = 0,
            source_position = NULL,
            source_token = NULL,
            predecessor_token = NULL,
            recovery_inbox_id = NULL,
            recovery_interface_family = NULL,
            arrival_class = 'legacy_unverified',
            effect_disposition = 'held',
            send_authority = 'held',
            owner_reconciliation_required = TRUE`,
    [DEFAULT_TENANT_ID, channel.rows[0].id, version.rows[0].id, I05_SEED_PAYLOAD_HASH],
  );
}

function stableSeedStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSeedStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSeedStringify(value[key])}`).join(',')}}`;
}

async function seedReferralClosedLoopGraph() {
  const targetTables = [
    'referrals',
    'referral_transition_events',
    'referral_responses',
    'referral_patient_notifications',
  ];
  const existingCounts = [];
  for (const table of targetTables) existingCounts.push(await tableCount(table));
  if (existingCounts.every(Boolean)) return;

  const patient = await first(
    'users',
    'uid, name',
    "tenant_id = $1::uuid AND role = 'PATIENT' AND is_active = TRUE",
    [DEFAULT_TENANT_ID],
  );
  const clinicians = await client.query(
    `SELECT user_record.uid, user_record.name, user_record.role,
            doctor.department, doctor.specialty
       FROM users AS user_record
       JOIN doctors AS doctor ON doctor.user_id = user_record.id
      WHERE user_record.tenant_id = $1::uuid
        AND user_record.role = 'DOCTOR'
        AND user_record.is_active = TRUE
        AND user_record.status = 'active'
        AND doctor.is_active = TRUE
      ORDER BY doctor.id
      LIMIT 2`,
    [DEFAULT_TENANT_ID],
  );
  const originator = clinicians.rows[0];
  const receiver = clinicians.rows[1] || clinicians.rows[0];
  if (!patient?.uid || !originator?.uid || !receiver?.uid) {
    throw new Error('Referral seed graph requires a patient and active doctor actors.');
  }

  const requestFingerprint = createHash('sha256')
    .update('seed-referral-request-to-closure-v1')
    .digest('hex');
  const responseFingerprint = createHash('sha256')
    .update('seed-referral-response-v1')
    .digest('hex');
  const referral = (await client.query(
    `INSERT INTO referrals
       (referral_number, tenant_id, patient_uid, referring_doctor,
        referred_to_doctor, referred_to_department, referral_type, reason,
        urgency, priority, requester_id, performer_id, source, status,
        first_seen_at, first_seen_by, accepted_at, accepted_by, completed_at,
        current_owner_uid, closure_status, request_fingerprint,
        ownership_accepted_at, request_context)
     VALUES
       ('REF-SEED-0001', $1::uuid, $2::uuid, $3::uuid,
        $4::uuid, $5::text, 'internal', 'Seed specialist review',
        'routine', 'NORMAL', $3::uuid, $4::uuid, 'seed', 'completed',
        NOW(), $4::uuid, NOW(), $4::uuid, NOW(),
        $3::uuid, 'open', $6::char(64), NOW(),
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
     RETURNING id, referral_number, patient_uid`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      originator.uid,
      receiver.uid,
      receiver.department || receiver.specialty || 'General Medicine',
      requestFingerprint,
    ],
  )).rows[0];

  const transitionId = '33333333-4444-4555-8666-777777777777';
  const timeline = await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, event_status, source_table,
        source_id, source_uid, resource_type, resource_id, occurred_at,
        visible_to_patient, clinical_summary, payload, tags, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'referral.response_signed', 'completed',
        'referral_transition_events', $3::text, $3::uuid, 'referral',
        $4::text, NOW(), FALSE, 'Seed signed referral response.',
        $5::jsonb, ARRAY['referral','seed']::text[], $6::text)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      transitionId,
      String(referral.id),
      JSON.stringify({ referral_id: referral.id, seed: true }),
      `seed-referral-transition:${transitionId}:timeline`,
    ],
  );
  const audit = await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
        resource_type, resource_table, resource_id, before_state, after_state,
        metadata, idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, 'referral.response_signed', 'success',
        $3::uuid, $4::text, 'referral', 'referral_transition_events',
        $5::text, '{}'::jsonb, $6::jsonb,
        '{"seed":true}'::jsonb, $7::text, NOW())
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      receiver.uid,
      receiver.role,
      transitionId,
      JSON.stringify({ status: 'completed', current_owner_uid: originator.uid }),
      `seed-referral-transition:${transitionId}:audit`,
    ],
  );
  await client.query(
    `INSERT INTO referral_transition_events
       (id, tenant_id, referral_id, patient_uid, sequence_number, event_type,
        from_status, to_status, from_owner_uid, to_owner_uid, actor_uid,
        actor_role, event_payload, canonical_timeline_event_id,
        canonical_audit_event_id)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, 1,
        'referral.response_signed', 'accepted', 'completed', $5::uuid,
        $6::uuid, $5::uuid, $7::text,
        '{"seed":true,"response_version":1}'::jsonb, $8::uuid, $9::uuid)`,
    [
      transitionId,
      DEFAULT_TENANT_ID,
      referral.id,
      patient.uid,
      receiver.uid,
      originator.uid,
      receiver.role,
      timeline.rows[0].id,
      audit.rows[0].id,
    ],
  );

  const responseId = '44444444-5555-4666-8777-888888888888';
  const responseResult = await client.query(
    `INSERT INTO referral_responses
       (id, tenant_id, referral_id, patient_uid, version, assessment,
        recommendations, follow_up_plan, patient_summary, patient_instructions,
        request_fingerprint, release_to_patient, continuing_ownership,
        signed_by, signer_role)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, 1,
        'Seed specialist assessment.', 'Continue the documented care plan.',
        'Originating doctor to review at follow-up.',
        'Your specialist has reviewed this referral.',
        'Follow the plan discussed with your care team.',
        $5::char(64), TRUE, FALSE, $6::uuid, $7::text)
     RETURNING to_jsonb(referral_responses) AS document`,
    [
      responseId,
      DEFAULT_TENANT_ID,
      referral.id,
      patient.uid,
      responseFingerprint,
      receiver.uid,
      receiver.role,
    ],
  );
  const contentHash = createHash('sha256')
    .update(stableSeedStringify(responseResult.rows[0].document), 'utf8')
    .digest('hex');
  await client.query(
    `INSERT INTO clinical_document_signatures
       (tenant_id, patient_uid, document_type, document_table, document_id,
        content_hash, signer_uid, signer_role, signer_name,
        signature_method, signature_statement, metadata)
     VALUES
       ($1::uuid, $2::uuid, 'referral_response', 'referral_responses',
        $3::text, $4::char(64), $5::uuid, $6::text, $7::text,
        'electronic_attestation',
        'Seed attestation for closed-loop referral coverage.',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      responseId,
      contentHash,
      receiver.uid,
      receiver.role,
      receiver.name,
    ],
  );
  const outbox = await client.query(
    `INSERT INTO notification_outbox
       (tenant_id, type, recipient_id, title, body, payload, status, sent_at, created_at)
     VALUES
       ($1::uuid, 'referral_response_ready', $2::text,
        'Referral update available',
        'Open VH Health to securely view your referral update.',
        $3::jsonb, 'SENT', NOW(), NOW())
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      String(patient.uid),
      JSON.stringify({
        tenant_id: DEFAULT_TENANT_ID,
        type: 'referral_response_ready',
        route: '/portal/referrals',
        seed: true,
      }),
    ],
  );
  await client.query(
    `INSERT INTO referral_patient_notifications
       (tenant_id, response_id, patient_uid, notification_kind,
        notification_outbox_id)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'referral_response_ready', $4::integer)`,
    [DEFAULT_TENANT_ID, responseId, patient.uid, Number(outbox.rows[0].id)],
  );
}

async function seedLabIngestCriticalAlertGraph() {
  const targetTables = [
    'lab_results',
    'lab_critical_alerts',
    'lab_critical_alert_acknowledgement_receipts',
    'lab_critical_alert_reconciliation_receipts',
    'lab_oru_ingest_messages',
    'lab_result_ingest_commands',
  ];
  const existingCounts = [];
  for (const table of targetTables) existingCounts.push(await tableCount(table));
  if (existingCounts.every(Boolean)) return;

  const patient = await first(
    'users',
    'uid, name',
    "tenant_id = $1::uuid AND role = 'PATIENT' AND is_active = TRUE",
    [DEFAULT_TENANT_ID],
  );
  const labActor = await first(
    'users',
    'uid, name, role',
    `tenant_id = $1::uuid
     AND role = 'LAB_STAFF' AND is_active = TRUE AND status = 'active'`,
    [DEFAULT_TENANT_ID],
  );
  const doctorActor = await first(
    'users',
    'uid, name, role',
    `tenant_id = $1::uuid
     AND role = 'DOCTOR' AND is_active = TRUE AND status = 'active'`,
    [DEFAULT_TENANT_ID],
  );
  const investigation = await first(
    'investigations',
    'id, patient_uid, test_code, test_name',
    'tenant_id = $1::uuid AND patient_uid = $2::uuid',
    [DEFAULT_TENANT_ID, patient?.uid],
  );
  if (
    !labActor?.uid
    || !doctorActor?.uid
    || !patient?.uid
    || !investigation?.id
    || !investigation.test_code
  ) {
    throw new Error(
      'Lab seed graph requires active lab and doctor actors and a patient-linked investigation.',
    );
  }

  let analyzer = await first(
    'lab_analyzers',
    'id, analyzer_code',
    "tenant_id = $1::uuid AND status = 'active'",
    [DEFAULT_TENANT_ID],
  );
  if (!analyzer) {
    analyzer = (await client.query(
      `INSERT INTO lab_analyzers
         (tenant_id, analyzer_code, display_name, manufacturer, model,
          serial_number, interface_kind, status, metadata, created_by, updated_by)
       VALUES
         ($1::uuid, 'SEED-ORU-ANALYZER', 'Seed ORU analyzer',
          'Seed manufacturer', 'Seed model', 'SEED-ORU-001', 'hl7', 'active',
          '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
          $2::uuid, $2::uuid)
       RETURNING id, analyzer_code`,
      [DEFAULT_TENANT_ID, labActor.uid],
    )).rows[0];
  }
  if (!analyzer?.id || !analyzer.analyzer_code) {
    throw new Error(
      'Lab seed graph could not resolve its active analyzer.',
    );
  }

  const analyzerCode = analyzer.analyzer_code;
  const messageControlId = 'SEED-ORU-CRITICAL-1';
  const rawMessage = [
    `MSH|^~\\&|${analyzerCode}|VH|VH|VH|20260504100000||ORU^R01|${messageControlId}|P|2.5`,
    `PID|1||${patient.uid}||Seed^Patient`,
    `ORC|RE|VHINV-${investigation.id}`,
    `OBR|1|VHINV-${investigation.id}||${investigation.test_code}^${investigation.test_name || 'Seed test'}`,
    `OBX|1|NM|${investigation.test_code}^${investigation.test_name || 'Seed test'}||7.1|seed-unit|0.0-5.0|HH|||F`,
  ].join('\r');
  const oruClaim = await client.query(
    `INSERT INTO lab_oru_ingest_messages
       (tenant_id, trusted_sender_identity, message_control_id, raw_message,
        obx_count, status, authenticated_actor_uid, authenticated_actor_roles,
        sender_binding_mode, sender_binding_identity)
     VALUES
       ($1::uuid, $2::text, $3::text, $4::text, 1, 'processing', $5::uuid,
        ARRAY[$6::text]::text[], 'actor_uid', $5::text)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      analyzerCode,
      messageControlId,
      rawMessage,
      labActor.uid,
      labActor.role,
    ],
  );

  const criticalResult = await client.query(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, patient_name, investigation_id, analyzer_id,
        performed_by_lab, hl7_message_id, hl7_segment_index,
        oru_ingest_message_id, test_code, test_name, value_text, value_numeric,
        unit, reference_range, abnormal_flag, status, is_critical, raw_obx,
        received_at, updated_at)
     VALUES
       ($1::uuid, $2::uuid, $3::text, $4::integer, $5::integer, $6::text,
        $7::text, 1, $8::bigint, $9::text, $10::text, '7.1', 7.1,
        'seed-unit', '0.0-5.0', 'HH', 'final', TRUE, $11::text,
        $12::timestamptz, $12::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      patient.name,
      investigation.id,
      analyzer.id,
      analyzerCode,
      messageControlId,
      oruClaim.rows[0].id,
      investigation.test_code,
      investigation.test_name || 'Seed test',
      `OBX|1|NM|${investigation.test_code}||7.1|seed-unit|0.0-5.0|HH|||F`,
      new Date(),
    ],
  );
  const resultId = criticalResult.rows[0].id;
  const reservedIds = (await client.query(
    `SELECT
       nextval(pg_get_serial_sequence('tasks', 'id'))::integer AS task_id,
       nextval(pg_get_serial_sequence('lab_critical_alerts', 'id'))::integer AS alert_id`,
  )).rows[0];
  const taskId = reservedIds.task_id;
  const alertId = reservedIds.alert_id;
  const acknowledgedAt = new Date();
  const firedAt = new Date(acknowledgedAt.getTime() - 60_000);
  const dueAt = new Date(firedAt.getTime() + 5 * 60_000);

  const sla = await client.query(
    `INSERT INTO workflow_sla_instances
       (tenant_id, rule_code, patient_uid, source_table, source_id, status,
        priority, started_at, due_at, completed_at, assigned_user_uid, metadata)
     VALUES
       ($1::uuid, 'critical_result_ack', $2::uuid, 'lab_result', $3::text,
        'completed', 'critical', $4::timestamptz, $5::timestamptz,
        $6::timestamptz, $7::uuid,
        jsonb_build_object(
          'completed_via', 'task_ack',
          'completed_by_task', $8::text,
          'completed_by', $7::text,
          'ack_contract_version', 2,
          'seed', TRUE
        ))
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      String(resultId),
      firedAt,
      dueAt,
      acknowledgedAt,
      doctorActor.uid,
      String(taskId),
    ],
  );
  const slaId = sla.rows[0].id;
  const task = await client.query(
    `INSERT INTO tasks
       (id, tenant_id, task_kind, title, description, patient_uid,
        related_resource_type, related_resource_id, priority, status,
        assigned_to_uid, assigned_to_role, created_by, due_at,
        workflow_sla_instance_id, sla_completion_semantics, metadata)
     VALUES
       ($1::integer, $2::uuid, 'review', 'Acknowledge seed critical result',
        'Synthetic terminal critical-result evidence for local tests.',
        $3::uuid, 'lab_result', $4::text, 'critical', 'in_progress',
        $5::uuid, NULL, $5::uuid, $6::timestamptz, $7::uuid,
        'acknowledgement',
        jsonb_build_object(
          'sla_instance_id', $7::text,
          'sla_key', 'critical_result_ack',
          'lab_critical_alert_id', $8::text,
          'lab_alert_generation_state', 'critical',
          'acknowledged_at', $9::text,
          'acknowledged_by', $5::text,
          'acknowledged_via', 'assignee',
          'ack_contract_version', 2,
          'seed', TRUE
        ))
     RETURNING id`,
    [
      taskId,
      DEFAULT_TENANT_ID,
      patient.uid,
      String(resultId),
      doctorActor.uid,
      dueAt,
      slaId,
      String(alertId),
      acknowledgedAt.toISOString(),
    ],
  );
  if (task.rows[0].id !== taskId) throw new Error('Lab seed task reservation was not preserved.');

  await client.query(
    `INSERT INTO lab_critical_alerts
       (id, tenant_id, result_id, patient_uid, test_name, value_text,
        value_numeric, unit, threshold_breached, threshold_value, fired_at,
        acknowledged_at, acknowledged_by, acknowledged_by_name,
        read_back_method, notes, acknowledgement_task_id, generation_metadata)
     VALUES
       ($1::integer, $2::uuid, $3::integer, $4::uuid, $5::text, '7.1',
        7.1, 'seed-unit', 'high', 5.0, $6::timestamptz, $7::timestamptz,
        $8::uuid, $9::text, 'verbal_readback',
        'Synthetic local test-only acknowledgement evidence.', $10::integer,
        jsonb_build_object(
          'kind', 'initial_result_generation',
          'acknowledgement_task_id', $10::text,
          'corrected_state', 'critical',
          'seed', TRUE
        ))`,
    [
      alertId,
      DEFAULT_TENANT_ID,
      resultId,
      patient.uid,
      investigation.test_name || 'Seed test',
      firedAt,
      acknowledgedAt,
      doctorActor.uid,
      doctorActor.name || 'Seed doctor',
      taskId,
    ],
  );

  await client.query(
    `INSERT INTO task_comments
       (tenant_id, task_id, author_uid, body, body_kind, metadata, created_at)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, 'Seed critical result acknowledged',
        'state_change',
        jsonb_build_object(
          'from', 'open',
          'to', 'in_progress',
          'acknowledged_at', $4::text,
          'via', 'assignee',
          'ack_contract_version', 2,
          'seed', TRUE
        ),
        $5::timestamptz)`,
    [DEFAULT_TENANT_ID, taskId, doctorActor.uid, acknowledgedAt.toISOString(), acknowledgedAt],
  );
  const acknowledgementPayload = {
    alert_id: alertId,
    result_id: resultId,
    acknowledgement_authorization: 'assignee',
    read_back_method: 'verbal_readback',
    ack_contract_version: 2,
  };
  await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, event_status, source_table,
        source_id, resource_type, resource_id, actor_uid, actor_role,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result.acknowledged', 'acknowledged',
        'lab_critical_alerts', $3::text, 'critical_lab_alert', $3::text,
        $4::uuid, $5::text, $6::timestamptz, FALSE,
        'Synthetic critical result acknowledgement for local tests.', $7::jsonb,
        ARRAY['lab', 'critical', 'seed']::text[],
        'lab_critical_alerts:' || $3::text || ':acknowledged')`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      String(alertId),
      doctorActor.uid,
      doctorActor.role,
      acknowledgedAt,
      JSON.stringify(acknowledgementPayload),
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, action_status, actor_uid, actor_role,
        resource_type, resource_table, resource_id, after_state, metadata,
        idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, 'critical_result.acknowledged', 'success',
        $3::uuid, $4::text, 'critical_lab_alert', 'lab_critical_alerts',
        $5::text, $6::jsonb, '{"ack_contract_version":2,"seed":true}'::jsonb,
        'lab_critical_alerts:' || $5::text || ':audit:acknowledged',
        $7::timestamptz)`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      doctorActor.uid,
      doctorActor.role,
      String(alertId),
      JSON.stringify({
        acknowledged_at: acknowledgedAt.toISOString(),
        acknowledged_by: doctorActor.uid,
        read_back_method: 'verbal_readback',
        ack_contract_version: 2,
      }),
      acknowledgedAt,
    ],
  );
  await client.query(
    `SELECT record_lab_critical_alert_acknowledgement_receipt(
       $1::uuid, $2::integer, $3::integer
     )`,
    [DEFAULT_TENANT_ID, alertId, taskId],
  );

  await client.query(
    `UPDATE lab_oru_ingest_messages
        SET status = 'completed',
            result_ids = ARRAY[$1::integer],
            critical_result_ids = ARRAY[$1::integer],
            active_critical_result_ids = '{}'::integer[],
            closed_critical_result_ids = ARRAY[$1::integer],
            alert_ids = '{}'::integer[],
            task_ids = '{}'::integer[],
            sla_instance_ids = '{}'::uuid[],
            closed_alert_ids = ARRAY[$2::integer],
            closed_task_ids = ARRAY[$3::integer],
            closed_sla_instance_ids = ARRAY[$4::uuid],
            legacy_adoption = TRUE,
            completed_at = $5::timestamptz,
            updated_at = NOW()
      WHERE tenant_id = $6::uuid AND id = $7::bigint`,
    [resultId, alertId, taskId, slaId, acknowledgedAt, DEFAULT_TENANT_ID, oruClaim.rows[0].id],
  );

  const ingestCommand = await client.query(
    `INSERT INTO lab_result_ingest_commands
       (tenant_id, actor_uid, command_scope, command_key,
        request_body_sha256, status)
     VALUES
       ($1::uuid, $2::uuid, 'manual_result', 'seed-manual-result-v1',
        $3::char(64), 'processing')
     RETURNING id`,
    [DEFAULT_TENANT_ID, labActor.uid, 'd'.repeat(64)],
  );
  const correctedAt = new Date();
  const correctedResult = await client.query(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, patient_name, investigation_id,
        ingest_command_id, test_code, test_name, value_text, value_numeric,
        unit, reference_range, abnormal_flag, status, is_critical,
        performed_by_lab, performed_at, received_at, signed_off_at,
        signed_off_by, comments, updated_at)
     VALUES
       ($1::uuid, $2::uuid, $3::text, $4::integer, $5::bigint, $6::text,
        $7::text, '4.1', 4.1, 'seed-unit', '0.0-5.0', 'N', 'corrected', FALSE,
        'Manual seed entry', $8::timestamptz, $8::timestamptz,
        $8::timestamptz, $9::uuid,
        'Synthetic corrected result with no active critical threshold.',
        $8::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      patient.name,
      investigation.id,
      ingestCommand.rows[0].id,
      investigation.test_code,
      investigation.test_name || 'Seed test',
      correctedAt,
      doctorActor.uid,
    ],
  );
  const correctedResultId = correctedResult.rows[0].id;
  await client.query(
    `UPDATE lab_result_ingest_commands
        SET status = 'completed',
            result_ids = ARRAY[$1::integer],
            response_data = jsonb_build_object(
              'result_ids', ARRAY[$1::integer],
              'seed', TRUE
            ),
            completed_at = $2::timestamptz,
            updated_at = NOW()
      WHERE tenant_id = $3::uuid AND id = $4::bigint`,
    [correctedResultId, correctedAt, DEFAULT_TENANT_ID, ingestCommand.rows[0].id],
  );
  const signoff = await client.query(
    `INSERT INTO lab_pathologist_signoffs
       (tenant_id, patient_uid, result_ids, signed_off_by,
        signed_off_by_name, signed_off_by_reg, decision, comments, signed_at)
     VALUES
       ($1::uuid, $2::uuid, ARRAY[$3::integer], $4::uuid, $5::text,
        'SEED-REG-001', 'corrected',
        'Synthetic corrected sign-off for reconciliation coverage.',
        $6::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      patient.uid,
      correctedResultId,
      doctorActor.uid,
      doctorActor.name || 'Seed doctor',
      correctedAt,
    ],
  );
  await client.query(
    `INSERT INTO lab_critical_alert_reconciliation_receipts
       (tenant_id, result_id, patient_uid, signoff_id, signoff_decision,
        signoff_signed_at, outcome, source, result_value_text,
        result_value_numeric, result_unit, evidence)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, $4::integer, 'corrected',
        $5::timestamptz, 'no_active_critical_threshold',
        'seed-comprehensive-test-data', '4.1', 4.1, 'seed-unit',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)`,
    [
      DEFAULT_TENANT_ID,
      correctedResultId,
      patient.uid,
      signoff.rows[0].id,
      correctedAt,
    ],
  );
}

async function assertNoActiveSyntheticWorkflowDefinitions() {
  const activeSyntheticDefinitions = await client.query(
    `SELECT id, workflow_key, version
       FROM workflow_definitions
      WHERE is_active = TRUE
        AND (
          workflow_key = 'seed_test_care_pathway'
          OR LEFT(workflow_key, 5) = 'seed_'
          OR category = 'test_fixture'
        )
      ORDER BY id`,
  );
  if (activeSyntheticDefinitions.rowCount > 0) {
    throw new Error(
      `Refusing to commit active synthetic workflow definitions: ${JSON.stringify(activeSyntheticDefinitions.rows)}`,
    );
  }
}

// Explicit seed for insurance_claim_caps. The auto-seeder in
// seedRemainingTables can't navigate the CHECK constraint added by
// migration 197 — the constraint requires exactly one of claim_id /
// tpa_claim_id to be set, but rowForTable either sets both (violating
// the XOR check) or neither (violating the "at least one" half). Pick
// any existing insurance_claims.id from the auto-seeded rows and bind
// a single cap row to it so the seeded.table.coverage contract passes.
async function seedInsuranceClaimCaps() {
  if (await tableCount('insurance_claim_caps')) return;

  // Prefer linking to a legacy insurance_claims row; fall back to
  // tpa_claims if the legacy side is somehow empty. Both should be
  // auto-seeded by this point.
  const legacyClaim = await first('insurance_claims', 'id', 'TRUE', []);
  const tpaClaim = legacyClaim ? null : await first('tpa_claims', 'id', 'TRUE', []);
  if (!legacyClaim && !tpaClaim) return; // can't seed without a parent

  const staffUid = await firstValue('users', 'uid') || DEFAULT_TENANT_ID;
  // insurance_claim_caps has no tenant_id column — its tenant scope is
  // inherited through the parent claim row (insurance_claims has no
  // tenant_id either, tpa_claims has tenant_id). Columns: claim_id /
  // tpa_claim_id (XOR), category, max_amount, currency, source, notes,
  // created_by (uuid required), created_at, updated_at.
  const baseRow = {
    category: 'room_rent',
    max_amount: 3500,
    currency: 'INR',
    source: 'tpa_preauth',
    notes: 'Seed cap for QA coverage',
    created_by: staffUid,
  };

  await insertIfEmpty('insurance_claim_caps', [
    legacyClaim
      ? { ...baseRow, claim_id: legacyClaim.id }
      : { ...baseRow, tpa_claim_id: tpaClaim.id },
  ]);
}

async function seedMedicationClosureEvidence() {
  const evidenceTables = [
    'ward_indent_inventory_allocations',
    'ward_indent_inventory_movement_links',
    'mar_administration_command_receipts',
    'mar_transition_command_receipts',
    'mar_supply_consumptions',
    'mar_supply_reconciliation_links',
    'ward_indent_financial_events',
    'billing_credit_notes',
    'billing_credit_note_events',
  ];
  const counts = [];
  for (const table of evidenceTables) {
    counts.push(await tableCount(table));
  }
  const marker = await first(
    'ward_indent_financial_events',
    'id',
    'tenant_id = $1::uuid AND event_key = $2',
    [DEFAULT_TENANT_ID, 'seed-med03-charge-v1'],
  );
  if (marker && counts.every((count) => count > 0)) return;
  if (counts.some((count) => count > 0)) {
    throw new Error(
      'MED-03 synthetic evidence is partially populated; reset the synthetic database before reseeding',
    );
  }

  const ctx = await getCoreRefs();
  if (!ctx.staff?.uid) {
    throw new Error('MED-03 synthetic evidence requires a staff actor');
  }
  const actorUid = ctx.staff.uid;
  const lineageResult = await client.query(
    `SELECT indent.id AS ward_indent_id,
            indent.patient_uid,
            indent.encounter_id,
            indent.admission_id,
            indent.state_version,
            item.id AS ward_indent_item_id,
            item.clinical_order_id,
            item.pharmacy_catalog_id,
            event.id AS ward_indent_event_id
       FROM ward_indents indent
       JOIN ward_indent_items item
         ON item.tenant_id = indent.tenant_id
        AND item.ward_indent_id = indent.id
       JOIN ward_indent_events event
         ON event.tenant_id = indent.tenant_id
        AND event.ward_indent_id = indent.id
        AND event.state_version = indent.state_version
        AND event.to_status = indent.status
      WHERE indent.tenant_id = $1::uuid
        AND item.clinical_order_id IS NOT NULL
      ORDER BY indent.id, item.id, event.id
      LIMIT 1`,
    [DEFAULT_TENANT_ID],
  );
  const lineage = lineageResult.rows[0];
  if (!lineage) {
    throw new Error('MED-03 synthetic evidence requires an exact ward-indent medication order');
  }

  const patient = await first(
    'users',
    'uid, phone, name',
    'tenant_id = $1::uuid AND uid = $2::uuid',
    [DEFAULT_TENANT_ID, lineage.patient_uid],
  );
  let matchedAdministration = await first(
    'medication_administrations',
    'id',
    `tenant_id = $1::uuid
      AND patient_uid = $2::uuid
      AND clinical_order_id = $3::int`,
    [DEFAULT_TENANT_ID, lineage.patient_uid, lineage.clinical_order_id],
  );
  if (!patient) {
    throw new Error('MED-03 synthetic evidence requires a matching patient fixture');
  }
  if (!matchedAdministration) {
    const inserted = await client.query(
      `INSERT INTO medication_administrations
         (tenant_id, patient_uid, medication_name, dosage, route,
          scheduled_time, administered_at, administered_by, status,
          clinical_order_id, supply_quantity_per_dose, scanned_patient_uid,
          scanned_barcode, patient_scanned_at, medication_scanned_at,
          rights_passed, all_rights_passed, notes)
       VALUES ($1::uuid, $2::uuid, 'Paracetamol 500 mg', '500 mg', 'oral',
               '2026-05-04T09:00:00.000Z'::timestamptz,
               '2026-05-04T09:01:00.000Z'::timestamptz,
               $3::uuid, 'administered', $4::int, 1, $2::uuid,
               'VH-SEED-MED03-PARA500',
               '2026-05-04T09:00:30.000Z'::timestamptz,
               '2026-05-04T09:00:45.000Z'::timestamptz,
               '{"patient":true,"drug":true,"dose":true,"route":true,"time":true}'::jsonb,
               TRUE, 'Synthetic MED-03 exact-custody administration.')
       RETURNING id`,
      [DEFAULT_TENANT_ID, lineage.patient_uid, actorUid, lineage.clinical_order_id],
    );
    matchedAdministration = inserted.rows[0];
  }

  let inventoryItem = await first(
    'pharmacy_inventory_items',
    'id',
    'tenant_id = $1::uuid AND sku_code = $2',
    [DEFAULT_TENANT_ID, 'VH-SEED-MED03-PARA500'],
  );
  if (!inventoryItem) {
    const inserted = await client.query(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, generic_name, form, strength,
          unit_label, status, catalog_id, metadata)
       VALUES ($1::uuid, $2, 'Paracetamol 500 mg tablet', 'Paracetamol',
               'tablet', '500 mg', 'tablet', 'active', $3::int,
               '{"seed":true,"med_03":true}'::jsonb)
       RETURNING id`,
      [DEFAULT_TENANT_ID, 'VH-SEED-MED03-PARA500', lineage.pharmacy_catalog_id],
    );
    inventoryItem = inserted.rows[0];
  }

  let inventoryBatch = await first(
    'pharmacy_inventory_batches',
    'id',
    'tenant_id = $1::uuid AND inventory_item_id = $2::int AND batch_number = $3',
    [DEFAULT_TENANT_ID, inventoryItem.id, 'VH-SEED-MED03-BATCH-001'],
  );
  if (!inventoryBatch) {
    const inserted = await client.query(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, lot_number, manufacture_date,
          expiry_date, received_quantity, remaining_quantity, unit_cost_minor,
          mrp_minor, status, metadata)
       VALUES ($1::uuid, $2::int, $3, 'VH-SEED-MED03-LOT-001',
               '2026-01-01'::date, '2027-12-31'::date, 10, 8, 100, 100,
               'in_stock', '{"seed":true,"med_03":true}'::jsonb)
       RETURNING id`,
      [DEFAULT_TENANT_ID, inventoryItem.id, 'VH-SEED-MED03-BATCH-001'],
    );
    inventoryBatch = inserted.rows[0];
  }

  await client.query(
    `INSERT INTO pharmacy_stock_movements
       (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
        quantity_delta, reference_type, reference_id, performed_by, notes,
        metadata, created_at)
     VALUES ($1::uuid, $2::int, $3::int, 'receive', 10,
             'synthetic_opening_receipt', 'seed-med03-opening', $4::uuid,
             'Synthetic MED-03 opening stock receipt.',
             '{"seed":true,"med_03":true}'::jsonb,
             '2026-05-04T08:00:00.000Z'::timestamptz)`,
    [DEFAULT_TENANT_ID, inventoryItem.id, inventoryBatch.id, actorUid],
  );

  const allocationResult = await client.query(
    `INSERT INTO ward_indent_inventory_allocations
       (tenant_id, ward_indent_id, ward_indent_item_id, inventory_item_id,
        inventory_batch_id, status, reserved_quantity, issued_quantity,
        received_quantity, consumed_quantity, returned_quantity,
        reservation_key, reserved_by, reserved_at)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::int, 'reserved',
             3, 0, 0, 0, 0, 'seed-med03-reservation-v1', $6::uuid,
             '2026-05-04T08:20:00.000Z'::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      lineage.ward_indent_id,
      lineage.ward_indent_item_id,
      inventoryItem.id,
      inventoryBatch.id,
      actorUid,
    ],
  );
  const allocationId = allocationResult.rows[0].id;

  const issueMovement = await client.query(
    `INSERT INTO pharmacy_stock_movements
       (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
        quantity_delta, reference_type, reference_id, performed_by, notes,
        metadata, created_at)
     VALUES ($1::uuid, $2::int, $3::int, 'issue', -3,
             'ward_indent_item', $4::text, $5::uuid,
             'Synthetic MED-03 exact-batch ward issue.',
             '{"seed":true,"med_03":true}'::jsonb,
             '2026-05-04T08:40:00.000Z'::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      inventoryItem.id,
      inventoryBatch.id,
      String(lineage.ward_indent_item_id),
      actorUid,
    ],
  );
  await client.query(
    `INSERT INTO ward_indent_inventory_movement_links
       (tenant_id, allocation_id, stock_movement_id, movement_purpose,
        quantity, ward_indent_state_version, command_key, linked_by, created_at)
     VALUES ($1::uuid, $2::bigint, $3::int, 'issue', 3, $4::int,
             'seed-med03-issue-link-v1', $5::uuid,
             '2026-05-04T08:40:00.000Z'::timestamptz)`,
    [DEFAULT_TENANT_ID, allocationId, issueMovement.rows[0].id, lineage.state_version, actorUid],
  );
  await client.query(
    `UPDATE ward_indent_inventory_allocations
        SET received_quantity = 3,
            updated_at = '2026-05-04T08:50:00.000Z'::timestamptz
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint`,
    [DEFAULT_TENANT_ID, allocationId],
  );

  await client.query(
    `INSERT INTO mar_supply_consumptions
       (tenant_id, medication_administration_id, clinical_order_id,
        ward_indent_item_id, inventory_allocation_id, inventory_batch_id,
        quantity, evidence_status, administration_mode, command_key,
        recorded_by, created_at)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::bigint, $6::int,
             1, 'matched', 'online_scan', 'seed-med03-mar-matched-v1',
             $7::uuid, '2026-05-04T09:01:00.000Z'::timestamptz)`,
    [
      DEFAULT_TENANT_ID,
      matchedAdministration.id,
      lineage.clinical_order_id,
      lineage.ward_indent_item_id,
      allocationId,
      inventoryBatch.id,
      actorUid,
    ],
  );

  await client.query(
    `INSERT INTO mar_administration_command_receipts
       (tenant_id, medication_administration_id, actor_uid, command_scope,
        command_key, request_body_sha256, administration_mode,
        response_data, completed_at)
     VALUES ($1::uuid, $2::int, $3::uuid, 'mar_administer_scan',
             'seed-med03-mar-administer-scan-v1',
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
             'online_barcode_scan',
             jsonb_build_object(
               'id', $2::int,
               'tenant_id', $1::text,
               'status', 'administered',
               'administered_by', $3::text,
               'scanned_patient_uid', $4::text,
               'scanned_barcode', 'VH-SEED-MED03-PARA500',
               'supply_state', jsonb_build_object('status', 'matched', 'quantity', 1)
             ),
             '2026-05-04T09:01:00.000Z'::timestamptz)`,
    [DEFAULT_TENANT_ID, matchedAdministration.id, actorUid, lineage.patient_uid],
  );

  const transitionAdministrations = await client.query(
    `INSERT INTO medication_administrations
       (tenant_id, patient_uid, medication_name, dosage, route, scheduled_time,
        status, notes, hold_reason, held_by, held_at, missed_by, missed_at,
        clinical_order_id, supply_quantity_per_dose)
     VALUES
       ($1::uuid, $2::uuid, 'Paracetamol 500 mg', '500 mg', 'oral',
        '2026-05-04T11:00:00.000Z'::timestamptz, 'held',
        'Synthetic MED-03 hold receipt.', 'Awaiting prescriber review.',
        $3::uuid, '2026-05-04T10:55:00.000Z'::timestamptz,
        NULL, NULL, $4::int, 1),
       ($1::uuid, $2::uuid, 'Paracetamol 500 mg', '500 mg', 'oral',
        '2026-05-04T12:00:00.000Z'::timestamptz, 'missed',
        'Patient declined the synthetic dose.', NULL, NULL, NULL,
        $3::uuid, '2026-05-04T12:30:00.000Z'::timestamptz,
        $4::int, 1)
     RETURNING id, status`,
    [DEFAULT_TENANT_ID, lineage.patient_uid, actorUid, lineage.clinical_order_id],
  );
  const heldAdministration = transitionAdministrations.rows.find((row) => row.status === 'held');
  const missedAdministration = transitionAdministrations.rows.find((row) => row.status === 'missed');
  await client.query(
    `INSERT INTO mar_transition_command_receipts
       (tenant_id, medication_administration_id, actor_uid, command_scope,
        transition_action, command_key, request_body_sha256, response_data,
        completed_at)
     VALUES
       ($1::uuid, $2::int, $4::uuid, 'mar_hold', 'held',
        'seed-med03-mar-hold-v1',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        jsonb_build_object(
          'id', $2::int, 'tenant_id', $1::text, 'status', 'held',
          'held_by', $4::text, 'hold_reason', 'Awaiting prescriber review.'
        ),
        '2026-05-04T10:55:00.000Z'::timestamptz),
       ($1::uuid, $3::int, $4::uuid, 'mar_miss', 'missed',
        'seed-med03-mar-miss-v1',
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        jsonb_build_object(
          'id', $3::int, 'tenant_id', $1::text, 'status', 'missed',
          'missed_by', $4::text, 'notes', 'Patient declined the synthetic dose.'
        ),
        '2026-05-04T12:30:00.000Z'::timestamptz)`,
    [
      DEFAULT_TENANT_ID,
      heldAdministration.id,
      missedAdministration.id,
      actorUid,
    ],
  );

  const overrideAdministration = await client.query(
    `INSERT INTO medication_administrations
       (tenant_id, patient_uid, medication_name, dosage, route, scheduled_time,
        administered_at, administered_by, status, notes, clinical_order_id,
        supply_quantity_per_dose, rights_passed, all_rights_passed)
     VALUES ($1::uuid, $2::uuid, 'Paracetamol 500 mg', '500 mg', 'oral',
             '2026-05-04T10:00:00.000Z'::timestamptz,
             '2026-05-04T10:05:00.000Z'::timestamptz, $3::uuid,
             'administered',
             'Synthetic downtime administration awaiting exact-batch reconciliation.',
             $4::int, 1,
             '{"patient":true,"medication":true,"dose":true,"route":true,"time":true}'::jsonb,
             TRUE)
     RETURNING id`,
    [DEFAULT_TENANT_ID, lineage.patient_uid, actorUid, lineage.clinical_order_id],
  );
  const overrideAdministrationId = overrideAdministration.rows[0].id;

  const marSlaId = randomUUID();
  const marRule = await first(
    'workflow_sla_rules',
    'id',
    `rule_code = 'ward_indent_mar_supply_reconciliation'
      AND enabled = TRUE
      AND (tenant_id IS NULL OR tenant_id = $1::uuid)
      ORDER BY tenant_id NULLS LAST`,
    [DEFAULT_TENANT_ID],
  );
  if (!marRule) {
    throw new Error('MED-03 MAR reconciliation SLA rule is missing');
  }
  await client.query(
    `INSERT INTO workflow_sla_instances
       (id, tenant_id, rule_id, rule_code, patient_uid, encounter_id,
        source_table, source_id, status, priority, started_at, due_at,
        assigned_role_codes, metadata)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'ward_indent_mar_supply_reconciliation', $4::uuid, $5::uuid,
             'medication_administrations', $6::text, 'active', 'critical',
             '2026-05-04T10:05:00.000Z'::timestamptz,
             '2026-05-04T10:35:00.000Z'::timestamptz,
             ARRAY['PHARMACY_INCHARGE','NURSING_INCHARGE','IP_INCHARGE']::text[],
             $7::jsonb)`,
    [
      marSlaId,
      DEFAULT_TENANT_ID,
      marRule.id,
      lineage.patient_uid,
      lineage.encounter_id,
      String(overrideAdministrationId),
      JSON.stringify({
        med_03: true,
        medication_administration_id: Number(overrideAdministrationId),
        clinical_order_id: Number(lineage.clinical_order_id),
        ward_indent_id: Number(lineage.ward_indent_id),
        ward_indent_item_id: Number(lineage.ward_indent_item_id),
      }),
    ],
  );
  const marTask = await client.query(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, description, patient_uid, encounter_id,
        related_resource_type, related_resource_id, priority, status,
        assigned_to_role, created_by, due_at, workflow_sla_instance_id,
        sla_completion_semantics, stage_occurrence_key, metadata)
     VALUES ($1::uuid, 'review', 'Reconcile MAR administration with ward custody',
             'Match the synthetic downtime administration to exact received ward stock.',
             $2::uuid, NULL, 'medication_administrations', $3::text,
             'critical', 'open', 'PHARMACY_INCHARGE', $4::uuid,
             '2026-05-04T10:35:00.000Z'::timestamptz, $5::uuid,
             'domain_evidence', 'seed-med03-mar-supply-reconciliation-v1',
             $6::jsonb)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      lineage.patient_uid,
      String(overrideAdministrationId),
      actorUid,
      marSlaId,
      JSON.stringify({
        task_contract: 'ward_medication_obligation_v1',
        med_03: true,
        sla_key: 'ward_indent_mar_supply_reconciliation',
        sla_instance_id: marSlaId,
        canonical_encounter_id: lineage.encounter_id,
        obligation_kind: 'mar_supply_reconciliation',
        evidence_kind: 'mar_supply_reconciled',
        medication_administration_id: Number(overrideAdministrationId),
        clinical_order_id: Number(lineage.clinical_order_id),
        ward_indent_id: Number(lineage.ward_indent_id),
        ward_indent_item_id: Number(lineage.ward_indent_item_id),
        override_reason: 'Synthetic downtime administration.',
      }),
    ],
  );
  const marTaskId = marTask.rows[0].id;
  const unmatchedConsumption = await client.query(
    `INSERT INTO mar_supply_consumptions
       (tenant_id, medication_administration_id, clinical_order_id,
        ward_indent_item_id, quantity, evidence_status, administration_mode,
        command_key, recorded_by, override_reason, override_recorded_at,
        reconciliation_task_id, created_at)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, 1,
             'unmatched_override', 'downtime_reconciliation',
             'seed-med03-mar-unmatched-v1', $5::uuid,
             'Synthetic downtime administration required before batch evidence was available.',
             '2026-05-04T10:05:00.000Z'::timestamptz, $6::int,
             '2026-05-04T10:05:00.000Z'::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      overrideAdministrationId,
      lineage.clinical_order_id,
      lineage.ward_indent_item_id,
      actorUid,
      marTaskId,
    ],
  );

  const reconciliationAt = new Date('2026-05-04T10:06:00.000Z');
  const reconciliation = await client.query(
    `INSERT INTO mar_supply_reconciliation_links
       (tenant_id, unmatched_consumption_id, clinical_order_id,
        ward_indent_item_id, inventory_allocation_id, inventory_batch_id,
        quantity, command_key, reconciled_by, created_at)
     VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::bigint, $6::int,
             1, 'seed-med03-mar-reconciliation-v1', $7::uuid, $8::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      unmatchedConsumption.rows[0].id,
      lineage.clinical_order_id,
      lineage.ward_indent_item_id,
      allocationId,
      inventoryBatch.id,
      actorUid,
      reconciliationAt,
    ],
  );
  const reconciliationEvidence = {
    kind: 'mar_supply_reconciled',
    resource_type: 'mar_supply_reconciliation_link',
    resource_id: String(reconciliation.rows[0].id),
    occurred_at: reconciliationAt.toISOString(),
    recorded_at: reconciliationAt.toISOString(),
  };
  await client.query(
    `UPDATE workflow_sla_instances
        SET status = 'completed',
            completed_at = $3::timestamptz,
            metadata = metadata || $4::jsonb,
            updated_at = $3::timestamptz
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid`,
    [
      DEFAULT_TENANT_ID,
      marSlaId,
      reconciliationAt,
      JSON.stringify({
        completed_via: 'domain_evidence',
        completed_by_task: String(marTaskId),
        completed_by: actorUid,
        completion_evidence: reconciliationEvidence,
      }),
    ],
  );
  await client.query(
    `UPDATE tasks
        SET status = 'completed',
            assigned_to_uid = $3::uuid,
            completed_at = $4::timestamptz,
            updated_at = $4::timestamptz
      WHERE tenant_id = $1::uuid
        AND id = $2::int`,
    [DEFAULT_TENANT_ID, marTaskId, actorUid, reconciliationAt],
  );

  const returnMovement = await client.query(
    `INSERT INTO pharmacy_stock_movements
       (tenant_id, inventory_item_id, inventory_batch_id, movement_kind,
        quantity_delta, reference_type, reference_id, performed_by, notes,
        metadata, created_at)
     VALUES ($1::uuid, $2::int, $3::int, 'return', 1,
             'ward_indent_item', $4::text, $5::uuid,
             'Synthetic MED-03 unused ward unit return.',
             '{"seed":true,"med_03":true}'::jsonb,
             '2026-05-04T11:00:00.000Z'::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      inventoryItem.id,
      inventoryBatch.id,
      String(lineage.ward_indent_item_id),
      actorUid,
    ],
  );
  await client.query(
    `INSERT INTO ward_indent_inventory_movement_links
       (tenant_id, allocation_id, stock_movement_id, movement_purpose,
        quantity, ward_indent_state_version, command_key, linked_by, created_at)
     VALUES ($1::uuid, $2::bigint, $3::int, 'return', 1, $4::int,
             'seed-med03-return-link-v1', $5::uuid,
             '2026-05-04T11:00:00.000Z'::timestamptz)`,
    [DEFAULT_TENANT_ID, allocationId, returnMovement.rows[0].id, lineage.state_version, actorUid],
  );

  const invoice = await client.query(
    `INSERT INTO billing_invoices
       (tenant_id, invoice_number, patient_uid, patient_phone, patient_name,
        admission_id, invoice_type, subtotal, cgst_amount, sgst_amount,
        igst_amount, discount_amount, total_amount, amount_paid, amount_due,
        status, created_by, notes)
     VALUES ($1::uuid, 'VH-SEED-MED03-INV-0001', $2::uuid, $3, $4,
             $5::int, 'IP', 3, 0, 0, 0, 0, 3, 0, 3, 'DRAFT', $6::uuid,
             'Synthetic MED-03 ward medication invoice.')
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      lineage.patient_uid,
      patient.phone,
      patient.name,
      lineage.admission_id,
      actorUid,
    ],
  );
  const invoiceItem = await client.query(
    `INSERT INTO billing_invoice_items
       (tenant_id, invoice_id, service_code, description, category, quantity,
        unit_price, gst_rate, line_subtotal, cgst_amount, sgst_amount,
        igst_amount, line_total, source_ref_type, source_ref_id,
        source_ref_active)
     VALUES ($1::uuid, $2::int, 'MED03-PARA500',
             'Paracetamol 500 mg ward supply', 'PHARMACY', 3, 1, 0, 3,
             0, 0, 0, 3, 'ward_indent_item', $3::bigint, TRUE)
     RETURNING id`,
    [DEFAULT_TENANT_ID, invoice.rows[0].id, lineage.ward_indent_item_id],
  );
  const charge = await client.query(
    `INSERT INTO ward_indent_financial_events
       (tenant_id, ward_indent_id, ward_indent_item_id, clinical_order_id,
        ward_indent_event_id, ward_indent_state_version, event_kind,
        quantity, unit_price_minor, amount_minor, currency, pricing_snapshot,
        original_event_id, invoice_id, invoice_item_id, event_key, actor_uid,
        occurred_at)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::bigint, $6::int,
             'charge', 3, 100, 300, 'INR', $7::jsonb, NULL, $8::int,
             $9::int, 'seed-med03-charge-v1', $10::uuid,
             '2026-05-04T08:40:00.000Z'::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      lineage.ward_indent_id,
      lineage.ward_indent_item_id,
      lineage.clinical_order_id,
      lineage.ward_indent_event_id,
      lineage.state_version,
      JSON.stringify({ unit_price_minor: 100, currency: 'INR', seed: true, med_03: true }),
      invoice.rows[0].id,
      invoiceItem.rows[0].id,
      actorUid,
    ],
  );
  const credit = await client.query(
    `INSERT INTO ward_indent_financial_events
       (tenant_id, ward_indent_id, ward_indent_item_id, clinical_order_id,
        ward_indent_event_id, ward_indent_state_version, event_kind,
        quantity, unit_price_minor, amount_minor, currency, pricing_snapshot,
        original_event_id, invoice_id, invoice_item_id, event_key, actor_uid,
        occurred_at)
     VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::bigint, $6::int,
             'credit', 1, 100, -100, 'INR', $7::jsonb, $8::bigint,
             $9::int, $10::int, 'seed-med03-credit-v1', $11::uuid,
             '2026-05-04T11:15:00.000Z'::timestamptz)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      lineage.ward_indent_id,
      lineage.ward_indent_item_id,
      lineage.clinical_order_id,
      lineage.ward_indent_event_id,
      lineage.state_version,
      JSON.stringify({ unit_price_minor: 100, currency: 'INR', seed: true, med_03: true }),
      charge.rows[0].id,
      invoice.rows[0].id,
      invoiceItem.rows[0].id,
      actorUid,
    ],
  );
  const creditNote = await client.query(
    `INSERT INTO billing_credit_notes
       (tenant_id, credit_note_number, invoice_id, patient_uid,
        source_financial_event_id, amount_minor, currency, reason, status,
        raised_by, raised_at)
     VALUES ($1::uuid, 'VH-SEED-MED03-CN-0001', $2::int, $3::uuid,
             $4::bigint, 100, 'INR', 'Unused exact-batch ward unit returned.',
             'pending', $5::uuid, '2026-05-04T11:20:00.000Z'::timestamptz)
     RETURNING id`,
    [DEFAULT_TENANT_ID, invoice.rows[0].id, lineage.patient_uid, credit.rows[0].id, actorUid],
  );
  await client.query(
    `INSERT INTO billing_credit_note_events
       (tenant_id, credit_note_id, event_type, actor_uid, command_key,
        details, occurred_at)
     VALUES ($1::uuid, $2::bigint, 'raised', $3::uuid,
             'seed-med03-credit-note-raised-v1',
             '{"seed":true,"med_03":true}'::jsonb,
             '2026-05-04T11:20:00.000Z'::timestamptz)`,
    [DEFAULT_TENANT_ID, creditNote.rows[0].id, actorUid],
  );

  const creditSlaId = randomUUID();
  const creditRule = await first(
    'workflow_sla_rules',
    'id',
    `rule_code = 'ward_indent_credit_note_review'
      AND enabled = TRUE
      AND (tenant_id IS NULL OR tenant_id = $1::uuid)
      ORDER BY tenant_id NULLS LAST`,
    [DEFAULT_TENANT_ID],
  );
  if (!creditRule) {
    throw new Error('MED-03 credit-note review SLA rule is missing');
  }
  await client.query(
    `INSERT INTO workflow_sla_instances
       (id, tenant_id, rule_id, rule_code, patient_uid, encounter_id,
        source_table, source_id, status, priority, started_at, due_at,
        assigned_role_codes, metadata)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'ward_indent_credit_note_review',
             $4::uuid, $5::uuid, 'billing_credit_notes', $6::text,
             'active', 'high', '2026-05-04T11:20:00.000Z'::timestamptz,
             '2026-05-05T11:20:00.000Z'::timestamptz,
             ARRAY['BILLING_INCHARGE','FINANCE_INCHARGE']::text[], $7::jsonb)`,
    [
      creditSlaId,
      DEFAULT_TENANT_ID,
      creditRule.id,
      lineage.patient_uid,
      lineage.encounter_id,
      String(creditNote.rows[0].id),
      JSON.stringify({
        med_03: true,
        credit_note_id: String(creditNote.rows[0].id),
        ward_indent_id: Number(lineage.ward_indent_id),
        invoice_id: Number(invoice.rows[0].id),
      }),
    ],
  );
  const creditTask = await client.query(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, description, patient_uid, encounter_id,
        related_resource_type, related_resource_id, priority, status,
        assigned_to_role, created_by, due_at, workflow_sla_instance_id,
        sla_completion_semantics, stage_occurrence_key, metadata)
     VALUES ($1::uuid, 'review', 'Review ward medication credit note',
             'Approve or reject the synthetic append-only original-price credit.',
             $2::uuid, NULL, 'billing_credit_notes', $3::text,
             'high', 'open', 'BILLING_INCHARGE', $4::uuid,
             '2026-05-05T11:20:00.000Z'::timestamptz, $5::uuid,
             'domain_evidence', 'seed-med03-credit-note-review-v1', $6::jsonb)
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      lineage.patient_uid,
      String(creditNote.rows[0].id),
      actorUid,
      creditSlaId,
      JSON.stringify({
        task_contract: 'ward_medication_obligation_v1',
        med_03: true,
        sla_key: 'ward_indent_credit_note_review',
        sla_instance_id: creditSlaId,
        canonical_encounter_id: lineage.encounter_id,
        obligation_kind: 'credit_note_review',
        evidence_kind: 'billing_credit_note_decision',
        credit_note_id: String(creditNote.rows[0].id),
        ward_indent_id: Number(lineage.ward_indent_id),
        ward_indent_item_id: Number(lineage.ward_indent_item_id),
        invoice_id: Number(invoice.rows[0].id),
        source_financial_event_id: String(credit.rows[0].id),
      }),
    ],
  );
  await client.query(
    `UPDATE billing_credit_notes
        SET task_id = $3::int,
            updated_at = '2026-05-04T11:20:00.000Z'::timestamptz
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint`,
    [DEFAULT_TENANT_ID, creditNote.rows[0].id, creditTask.rows[0].id],
  );
}

// Explicit seed for the double-entry ledger (migrations 343/344). The
// auto-seeder is excluded from ledger_entries/ledger_postings (see
// MANUAL_SEED_TABLES) because it would insert a single unbalanced posting,
// and ledger_postings_balanced (DEFERRABLE INITIALLY DEFERRED) rejects any
// entry whose postings don't sum to 0 at COMMIT. Insert one balanced journal
// entry — two equal-and-opposite postings — so the seeded.table.coverage
// contract sees a row in both tables. tenant_id defaults to the literal
// default tenant on every ledger row (GUC unset during seeding).
async function seedLedgerEntries() {
  if (await tableCount('ledger_entries')) return;

  // Any ledger account works — the balance invariant is about the entry's
  // posting sum, not which accounts are touched. Reuse an auto-seeded
  // ledger_accounts row, or create a minimal one if none exists yet.
  let account = await first('ledger_accounts', 'id');
  if (!account) {
    const created = await client.query(
      `INSERT INTO ledger_accounts (code, type, description)
       VALUES ('SEED-COVERAGE', 'ASSET', 'Seed account for QA coverage')
       RETURNING id`,
    );
    account = created.rows[0];
  }

  const entry = await client.query(
    `INSERT INTO ledger_entries (entry_type, idempotency_key, metadata)
     VALUES ('SEED_COVERAGE', 'seed-coverage-balanced-1', '{}'::jsonb)
     RETURNING id`,
  );
  const entryId = entry.rows[0].id;

  // Two postings netting to zero — satisfies ledger_assert_entry_balanced
  // at COMMIT. Inserted in one statement; the deferred trigger checks the
  // entry total once the transaction commits.
  await client.query(
    `INSERT INTO ledger_postings (entry_id, account_id, amount_paise)
     VALUES ($1, $2, $3), ($1, $2, $4)`,
    [entryId, account.id, 100000, -100000],
  );
}

async function seedIdentityProviderTables() {
  let provider = await first(
    'tenant_identity_providers',
    'id',
    "tenant_id = $1::uuid AND realm = 'admin' AND protocol = 'oidc'",
    [DEFAULT_TENANT_ID],
  );

  if (!provider) {
    const created = await client.query(
      `INSERT INTO tenant_identity_providers (
         tenant_id, realm, protocol, provider_key, display_name, status
       )
       VALUES ($1::uuid, 'admin', 'oidc', 'seed-oidc', 'Seed admin OIDC', 'draft')
       RETURNING id`,
      [DEFAULT_TENANT_ID],
    );
    provider = created.rows[0];
  }

  await insertIfEmpty('tenant_idp_role_mappings', [{
    tenant_id: DEFAULT_TENANT_ID,
    provider_id: provider.id,
    realm: 'admin',
    idp_group: 'seed-admins',
    vh_role: 'ADMIN',
    status: 'active',
    priority: 100,
  }]);
}

// Explicit seeds for the Pillar-D workflow tables (migrations 285/290/292).
// The auto-seeder can't navigate their domain CHECK constraints — provider
// availability and resource bookings require ordered time windows
// (end > start), chemo_protocol_drugs requires the mg/m²-XOR-fixed dosing
// shape, chemo_cycles hangs off a treatment plan with real weight/BSA
// numbers, and dental findings must carry a valid FDI tooth code. These
// CHECKs failing the generic engine is the constraints working as designed;
// constraint-aware rows here keep the seeded.table.coverage contract
// meaningful instead of weakening it. (This was the Forgejo `backend` stage
// failure from the pillar-C/D merges onward — the guardrail flow is the
// only place the comprehensive seeder runs.)
async function seedPillarDWorkflowTables() {
  const doctor = await first('doctors', 'id');
  if (doctor) {
    await insertIfEmpty('provider_availability_templates', [{
      doctor_id: doctor.id,
      weekday: 1,
      start_time: '09:00:00',
      end_time: '13:00:00',
      slot_minutes: 15,
      location: 'OPD-1 (seed)',
    }]);
  }

  const refs = await getCoreRefs();
  if (doctor && refs.patient?.uid) {
    await insertIfEmpty('appointment_slot_holds', [{
      tenant_id: DEFAULT_TENANT_ID,
      doctor_id: doctor.id,
      appointment_date: new Date().toISOString().slice(0, 10),
      slot_start: '09:00:00',
      slot_end: '09:15:00',
      source_channel: 'staff',
      idempotency_key: 'seed-slot-hold-0001',
      held_by_uid: refs.staff?.uid,
      held_by_role: 'RECEPTIONIST',
      patient_uid: refs.patient.uid,
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  const resource = await first('bookable_resources', 'id');
  if (resource) {
    await insertIfEmpty('resource_bookings', [{
      resource_id: resource.id,
      starts_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ends_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      booked_for_type: 'other',
      status: 'booked',
      notes: 'Seed booking for QA coverage',
    }]);
  }

  // NL13-P1f: cath case ↔ booking link needs the real seeded parents (the
  // partial unique indexes allow exactly one active link per case/booking).
  const cathCase = await first('cath_lab_cases', 'id');
  const booking = await first('resource_bookings', 'id, resource_id');
  if (cathCase && booking?.resource_id) {
    await insertIfEmpty('cath_case_schedule_links', [{
      tenant_id: DEFAULT_TENANT_ID,
      case_id: cathCase.id,
      resource_booking_id: booking.id,
      resource_id: booking.resource_id,
      status: 'active',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  const protocol = await first('chemo_protocols', 'id');
  if (protocol) {
    await insertIfEmpty('chemo_protocol_drugs', [{
      protocol_id: protocol.id,
      drug_name: 'Doxorubicin (seed)',
      dose_per_m2: 60, // XOR dosing: fixed_dose deliberately NULL
      dose_unit: 'mg',
      route: 'IV',
      infusion_duration_min: 30,
      is_vesicant: true,
      max_lifetime_dose_per_m2: 450,
      sequence: 1,
      notes: 'Seed protocol drug for QA coverage',
    }]);
  }

  const plan = await first('chemo_treatment_plans', 'id');
  if (plan) {
    await insertIfEmpty('chemo_cycles', [{
      plan_id: plan.id,
      cycle_number: 1,
      scheduled_date: new Date().toISOString().slice(0, 10),
      status: 'scheduled',
      weight_kg: 70.0,
      bsa_m2: 1.84,
      notes: 'Seed cycle for QA coverage',
    }]);
  }

  const patientUid = await firstValue('users', 'uid');
  if (patientUid) {
    await insertIfEmpty('dental_tooth_findings', [{
      patient_uid: patientUid,
      tooth_fdi: '16',
      surface: 'occlusal',
      finding: 'caries',
      status: 'active',
      notes: 'Seed finding for QA coverage',
    }]);
  }
}

async function seedRadiologyPeerReviews() {
  if (await tableCount('radiology_peer_reviews')) return;

  const refs = await getCoreRefs();
  const fallbackAuthorUid = refs.doctor?.uid || refs.staff?.uid;
  if (!refs.patient?.uid || !fallbackAuthorUid) return;

  let order = await first(
    'radiology_orders',
    'id, tenant_id, ordered_by, radiologist, report_signed_off_by',
    'TRUE',
    [],
  );

  if (!order) {
    const created = await client.query(
      `INSERT INTO radiology_orders (
         tenant_id, patient_uid, modality, body_part, clinical_indication,
         priority, status, ordered_by, radiologist, report, report_completed_at,
         report_signed_off_at, report_signed_off_by, structured_report
       )
       VALUES (
         $1::uuid, $2::uuid, 'xray', 'chest', 'Seed chest radiograph review',
         'routine', 'signed_off', $3::uuid, $4::uuid,
         'Findings: No acute cardiopulmonary abnormality.\n\nImpression: No acute abnormality.',
         NOW() - INTERVAL '20 minutes', NOW(), $4::uuid,
         '{"sections":{"findings":"No acute cardiopulmonary abnormality.","impression":"No acute abnormality."}}'::jsonb
       )
       RETURNING id, tenant_id, ordered_by, radiologist, report_signed_off_by`,
      [DEFAULT_TENANT_ID, refs.patient.uid, refs.staff?.uid || fallbackAuthorUid, fallbackAuthorUid],
    );
    order = created.rows[0];
  }

  const reportAuthorUid = order.report_signed_off_by || order.radiologist || fallbackAuthorUid;
  const reviewerUid = [
    refs.secondStaff?.uid,
    refs.staff?.uid,
    refs.doctor?.uid,
    refs.generatedUuid,
  ].find((uid) => uid && uid !== reportAuthorUid);

  if (!reviewerUid) return;

  await insertIfEmpty('radiology_peer_reviews', [{
    tenant_id: order.tenant_id || DEFAULT_TENANT_ID,
    radiology_order_id: order.id,
    reviewer_uid: reviewerUid,
    report_author_uid: reportAuthorUid,
    discrepancy_score: 1,
    outcome: 'no_change',
    comments: 'Seed peer review for QA coverage',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedDonorIntakeTables() {
  // N6-2: constraint-aware seeds — the generic seeder cannot satisfy
  // chk_donation_events_volume (100..650) or chk_donor_consents_hash
  // (64 lowercase hex). Mirrors the radiology_peer_reviews precedent.
  const donor = await first('donors', 'id, tenant_id', 'TRUE', []);
  if (!donor) return;

  if (!(await tableCount('donation_events'))) {
    await insertIfEmpty('donation_events', [{
      tenant_id: donor.tenant_id || DEFAULT_TENANT_ID,
      donor_id: donor.id,
      donation_code: 'DON-SEED-0001',
      donation_barcode: 'DONBAR-SEED-0001',
      collection_kind: 'in_house',
      volume_ml: 450,
      status: 'collected',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (!(await tableCount('donor_consents'))) {
    await insertIfEmpty('donor_consents', [{
      tenant_id: donor.tenant_id || DEFAULT_TENANT_ID,
      donor_id: donor.id,
      consent_type: 'blood_donation',
      consent_version: 1,
      consent_statement: 'Seed donor consent for QA coverage.',
      consent_payload: JSON.stringify({ seed: true }),
      sha256_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }
}

async function seedBiomedCmmsTables() {
  let device = await first('clinical_ai_biomed_devices', 'id, tenant_id', 'TRUE', []);
  if (!device) {
    const created = await client.query(
      `INSERT INTO clinical_ai_biomed_devices (
         tenant_id, device_code, device_type, manufacturer, model, serial_number,
         location, installed_at, usage_hours, fault_events_last_90d, status, metadata
       )
       VALUES (
         $1::uuid, 'BIO-SEED-0001', 'ventilator', 'Seed Biomedical', 'Ventilator QA',
         'BIO-SEED-SN-0001', 'ICU seed bay', CURRENT_DATE - INTERVAL '180 days',
         1200, 0, 'in_service', '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, tenant_id`,
      [DEFAULT_TENANT_ID],
    );
    device = created.rows[0];
  }

  const staffUser = await first('users', 'id, uid', 'role <> $1', ['PATIENT']);
  if (!staffUser) return;

  let schedule = await first('biomed_maintenance_schedules', 'id, tenant_id', 'TRUE', []);
  if (!schedule) {
    const created = await client.query(
      `INSERT INTO biomed_maintenance_schedules (
         tenant_id, biomed_device_id, kind, interval_days, next_due_at,
         assigned_role, assigned_to_id, assigned_to_uid, created_by, metadata
       )
       VALUES (
         $1::uuid, $2, 'preventive', 90, NOW() + INTERVAL '30 days',
         'BIOMEDICAL_STAFF', $3, $4::uuid, $4::uuid,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, tenant_id`,
      [device.tenant_id || DEFAULT_TENANT_ID, device.id, staffUser.id, staffUser.uid],
    );
    schedule = created.rows[0];
  }

  let workOrder = await first('biomed_work_orders', 'id, tenant_id', 'TRUE', []);
  if (!workOrder) {
    const created = await client.query(
      `INSERT INTO biomed_work_orders (
         tenant_id, biomed_device_id, schedule_id, kind, priority, status,
         description, assigned_to_id, assigned_to_uid, assigned_to_role,
         assigned_by, assigned_at, sla_due_at, source, due_window_start,
         due_window_end, created_by, metadata
       )
       VALUES (
         $1::uuid, $2, $3, 'preventive', 'normal', 'assigned',
         'Seed preventive maintenance work order for QA coverage.',
         $4, $5::uuid, 'BIOMEDICAL_STAFF', $5::uuid, NOW(),
         NOW() + INTERVAL '72 hours', 'schedule', NOW() + INTERVAL '30 days',
         NOW() + INTERVAL '31 days', $5::uuid,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, tenant_id`,
      [schedule.tenant_id || device.tenant_id || DEFAULT_TENANT_ID, device.id, schedule.id, staffUser.id, staffUser.uid],
    );
    workOrder = created.rows[0];
  }

  await client.query(
    `UPDATE biomed_maintenance_schedules
        SET last_work_order_id = $1,
            updated_at = NOW()
      WHERE id = $2
        AND last_work_order_id IS NULL`,
    [workOrder.id, schedule.id],
  );

  await insertIfEmpty('biomed_work_order_recipients', [{
    tenant_id: workOrder.tenant_id || DEFAULT_TENANT_ID,
    work_order_id: workOrder.id,
    staff_id: staffUser.id,
    staff_uid: staffUser.uid,
    recipient_kind: 'assignee',
    source: 'seed',
  }]);

  await insertIfEmpty('biomed_work_order_updates', [{
    tenant_id: workOrder.tenant_id || DEFAULT_TENANT_ID,
    work_order_id: workOrder.id,
    previous_status: 'open',
    status: 'assigned',
    message: 'Seed work-order update for QA coverage.',
    author_id: staffUser.id,
    author_uid: staffUser.uid,
    author_role: 'BIOMEDICAL_STAFF',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);

  await insertIfEmpty('biomed_calibration_certificates', [{
    tenant_id: workOrder.tenant_id || DEFAULT_TENANT_ID,
    biomed_device_id: device.id,
    work_order_id: workOrder.id,
    certificate_number: 'BIO-CERT-SEED-0001',
    calibrated_at: new Date('2026-05-04T09:00:00.000Z'),
    due_at: new Date('2027-05-04T09:00:00.000Z'),
    performed_by: 'Seed Biomedical Engineer',
    performed_by_uid: staffUser.uid,
    document_id: 'seed-biomed-calibration-document',
    document_storage_key: 'seed/biomed/calibration/BIO-CERT-SEED-0001.pdf',
    document_mime_type: 'application/pdf',
    result: 'pass',
    notes: 'Seed calibration certificate for QA coverage.',
    created_by: staffUser.uid,
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedColdChainTables() {
  let device = await first(
    'device_registry',
    'id',
    'tenant_id = $1 AND kind = $2',
    [DEFAULT_TENANT_ID, 'fridge_sensor']
  );

  if (!device) {
    await insert('device_registry', {
      tenant_id: DEFAULT_TENANT_ID,
      device_code: 'SEED-COLD-FRIDGE-01',
      display_name: 'Seed cold-chain fridge sensor',
      kind: 'fridge_sensor',
      protocol: 'http-json',
      vendor: 'Seed',
      model: 'ColdChain',
      serial_number: 'SEED-COLD-FRIDGE-01',
      status: 'active',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    });
    device = await first(
      'device_registry',
      'id',
      'tenant_id = $1 AND kind = $2',
      [DEFAULT_TENANT_ID, 'fridge_sensor']
    );
  }

  if (!device) return;

  await insertIfEmpty('cold_chain_units', [{
    tenant_id: DEFAULT_TENANT_ID,
    unit_code: 'SEED-COLD-FRIDGE-01',
    display_name: 'Seed cold-chain refrigerator',
    kind: 'fridge',
    department: 'pharmacy',
    device_registry_id: device.id,
    min_temp_c: 2,
    max_temp_c: 8,
    excursion_grace_minutes: 15,
    status: 'active',
    retention_days: 730,
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedMortuarySlots() {
  await insertIfEmpty('mortuary_slots', [{
    tenant_id: DEFAULT_TENANT_ID,
    slot_code: 'MORT-SEED-0001',
    display_name: 'Seed mortuary slot',
    status: 'available',
    notes: 'Seed slot for QA coverage',
  }]);
}

async function seedInfusionChairTables() {
  let chair = await first(
    'infusion_chairs',
    'id, tenant_id',
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );

  if (!chair) {
    const created = await client.query(
      `INSERT INTO infusion_chairs (
         tenant_id, unit_name, chair_code, display_name, status, location_note
       )
       VALUES (
         $1::uuid, 'Day Care', 'SEED-CHAIR-1', 'Seed Chair 1',
         'active', 'Seed chair for QA coverage'
       )
       ON CONFLICT (tenant_id, unit_name, chair_code)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         status = 'active',
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, tenant_id`,
      [DEFAULT_TENANT_ID],
    );
    chair = created.rows[0];
  }

  if (await tableCount('chair_bookings')) return;

  const cycleResult = await client.query(
    `SELECT c.id, c.tenant_id, c.scheduled_date, p.patient_uid
       FROM chemo_cycles c
       JOIN chemo_treatment_plans p ON p.id = c.plan_id
      ORDER BY c.id
      LIMIT 1`,
  );
  const cycle = cycleResult.rows[0];
  if (!chair || !cycle?.patient_uid) return;

  const scheduledDate =
    cycle.scheduled_date instanceof Date
      ? cycle.scheduled_date.toISOString().slice(0, 10)
      : String(cycle.scheduled_date).slice(0, 10);

  await insertIfEmpty('chair_bookings', [{
    tenant_id: cycle.tenant_id || chair.tenant_id || DEFAULT_TENANT_ID,
    chair_id: chair.id,
    cycle_id: cycle.id,
    patient_uid: cycle.patient_uid,
    start_at: `${scheduledDate}T09:00:00.000Z`,
    end_at: `${scheduledDate}T10:00:00.000Z`,
    status: 'booked',
    warning_codes: [],
    notes: 'Seed booking for QA coverage',
  }]);
}

async function seedMergedMainCoverageTables() {
  const hasBiomedCalibration = await tableExists('biomed_calibration_certificates');
  const hasBiomedMaintenance = await tableExists('biomed_maintenance_schedules');

  if ((hasBiomedCalibration || hasBiomedMaintenance) && await tableExists('clinical_ai_biomed_devices')) {
    const biomedDevice = await first(
      'clinical_ai_biomed_devices',
      'id, tenant_id',
      'tenant_id = $1::uuid',
      [DEFAULT_TENANT_ID],
    );

    if (biomedDevice && hasBiomedCalibration) {
      await insertIfEmpty('biomed_calibration_certificates', [{
        tenant_id: biomedDevice.tenant_id || DEFAULT_TENANT_ID,
        biomed_device_id: biomedDevice.id,
        certificate_number: 'CAL-SEED-0001',
        calibrated_at: new Date('2026-05-04T09:00:00.000Z'),
        due_at: new Date('2027-05-04T09:00:00.000Z'),
        performed_by: 'Seed biomedical engineer',
        document_id: 'DOC-SEED-CAL-0001',
        document_storage_key: 'seed/biomed/calibration/DOC-SEED-CAL-0001.pdf',
        document_mime_type: 'application/pdf',
        result: 'pass',
        notes: 'Seed calibration certificate for QA coverage',
        metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      }]);
    }

    if (biomedDevice && hasBiomedMaintenance) {
      await insertIfEmpty('biomed_maintenance_schedules', [{
        tenant_id: biomedDevice.tenant_id || DEFAULT_TENANT_ID,
        biomed_device_id: biomedDevice.id,
        kind: 'preventive',
        interval_days: 90,
        next_due_at: new Date('2026-08-04T09:00:00.000Z'),
        assigned_role: 'BIOMEDICAL_STAFF',
        active: true,
        metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      }]);
    }
  }

  if (await tableExists('cold_chain_units') && await tableExists('device_registry')) {
    const registeredDevice = await first(
      'device_registry',
      'id, tenant_id',
      'tenant_id = $1::uuid',
      [DEFAULT_TENANT_ID],
    );

    if (registeredDevice) {
      await insertIfEmpty('cold_chain_units', [{
        tenant_id: registeredDevice.tenant_id || DEFAULT_TENANT_ID,
        unit_code: 'CC-SEED-0001',
        display_name: 'Seed vaccine fridge',
        kind: 'fridge',
        department: 'pharmacy',
        device_registry_id: registeredDevice.id,
        min_temp_c: 2,
        max_temp_c: 8,
        excursion_grace_minutes: 15,
        alert_roles: ['PHARMACY_INCHARGE'],
        status: 'active',
        retention_days: 730,
        metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      }]);
    }
  }

  const hasMigrationSourceFiles = await tableExists('migration_source_files');
  const hasMigrationImportRecords = await tableExists('migration_import_records');

  if (!hasMigrationSourceFiles || !(await tableExists('migration_import_jobs'))) return;

  const importJob = await first(
    'migration_import_jobs',
    'id, tenant_id',
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );

  if (!importJob) return;

  if (hasMigrationSourceFiles) {
    await insertIfEmpty('migration_source_files', [{
      tenant_id: importJob.tenant_id || DEFAULT_TENANT_ID,
      job_id: importJob.id,
      file_kind: 'patient',
      source_filename: 'seed-patients.csv',
      content_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mime_type: 'text/csv',
      byte_size: 128,
      row_count: 1,
      header_row: JSON.stringify(['external_id', 'full_name']),
      column_profile: JSON.stringify({ external_id: 'text', full_name: 'text' }),
      sample_rows_redacted: JSON.stringify([{ external_id: 'SEED-1', full_name: 'Seed Patient' }]),
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (!hasMigrationImportRecords || !hasMigrationSourceFiles) return;

  const sourceFile = await first(
    'migration_source_files',
    'id, tenant_id, job_id',
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );

  if (!sourceFile) return;

  await insertIfEmpty('migration_import_records', [{
    tenant_id: sourceFile.tenant_id || DEFAULT_TENANT_ID,
    job_id: sourceFile.job_id || importJob.id,
    source_file_id: sourceFile.id,
    target_kind: 'patient',
    source_row_number: 1,
    source_key: 'SEED-1',
    row_hash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    normalized_preview_redacted: JSON.stringify({ external_id: 'SEED-1' }),
    validation_state: 'valid',
    duplicate_candidate: false,
    duplicate_summary: JSON.stringify({}),
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedMigrationToolkitTables() {
  // NL11-S1/S9: constraint-aware seeds — generic values violate the 64-hex
  // sha256 CHECKs, ADT enum checks, and the INTEGER source_row_number column.
  const job = await first('migration_import_jobs', 'id, tenant_id', 'TRUE', []);
  if (!job) return;
  const hex64 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  const altHex64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  if (!(await tableCount('migration_source_files'))) {
    await insertIfEmpty('migration_source_files', [{
      tenant_id: job.tenant_id || DEFAULT_TENANT_ID,
      job_id: job.id,
      file_kind: 'patient',
      source_filename: 'seed-patients.csv',
      content_sha256: hex64,
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (!(await tableCount('migration_import_records'))) {
    const file = await first('migration_source_files', 'id, tenant_id, job_id', 'TRUE', []);
    if (!file) return;
    await insertIfEmpty('migration_import_records', [{
      tenant_id: file.tenant_id || DEFAULT_TENANT_ID,
      job_id: file.job_id,
      source_file_id: file.id,
      target_kind: 'patient',
      source_row_number: 1,
      row_hash: hex64,
    }]);
  }

  if ((await tableExists('migration_hl7_adt_batches')) && !(await tableCount('migration_hl7_adt_batches'))) {
    await insertIfEmpty('migration_hl7_adt_batches', [{
      tenant_id: job.tenant_id || DEFAULT_TENANT_ID,
      job_id: job.id,
      status: 'committed',
      source_filename: 'seed-adt-a01.hl7',
      content_sha256: altHex64,
      message_count: 1,
      accepted_count: 1,
      rejected_count: 0,
      idempotency_key: 'seed-hl7-adt-batch-1',
      summary: JSON.stringify({ seed: true, accepted: 1 }),
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if ((await tableExists('migration_hl7_adt_messages')) && !(await tableCount('migration_hl7_adt_messages'))) {
    const batch = await first('migration_hl7_adt_batches', 'id, tenant_id', 'TRUE', []);
    if (!batch) return;
    const commitBatch = await first('migration_commit_batches', 'id', 'TRUE', []);
    await insertIfEmpty('migration_hl7_adt_messages', [{
      tenant_id: batch.tenant_id || DEFAULT_TENANT_ID,
      hl7_batch_id: batch.id,
      commit_batch_id: commitBatch?.id,
      message_control_id: 'SEED-ADT-A01-1',
      message_type: 'ADT^A01',
      source_patient_key: 'SEED-1',
      raw_message_hash: hex64,
      parsed_summary_redacted: JSON.stringify({ messageType: 'ADT^A01', patientKey: 'SEED-1' }),
      validation_findings: JSON.stringify([]),
      status: 'committed',
    }]);
  }
}

async function seedSiemExportTables() {
  // NL12-S2: constraint-aware seeds (transport/severity/source enums,
  // CHAR(64) hex hashes, minimized_payload redaction invariant).
  const hex64 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  if (!(await tableCount('siem_export_targets'))) {
    await insertIfEmpty('siem_export_targets', [{
      tenant_id: DEFAULT_TENANT_ID,
      target_key: 'seed-siem-webhook',
      display_name: 'Seed SIEM webhook target',
      transport: 'webhook',
      status: 'draft',
      min_severity: 'high',
      acknowledgement_contract: 'unclassified',
      acknowledgement_config: JSON.stringify({}),
      acknowledgement_classified_by: null,
      acknowledgement_owner_reason: null,
      acknowledgement_owner_evidence: null,
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }
  if (!(await tableCount('siem_export_cursors'))) {
    await insertIfEmpty('siem_export_cursors', [{
      tenant_id: DEFAULT_TENANT_ID,
      source_name: 'audit_log',
      cursor_key: 'security',
      cursor_semantics: 'capture_into_event_ledger',
      writer_state: 'legacy_capture',
      capture_schedule_decision: 'owner_activation_required',
      metadata: JSON.stringify({
        seed: true,
        cursor_truth: 'capture_into_event_ledger_not_delivery',
        automatic_scheduler_activated: false,
      }),
    }]);
  }
  const target = await first('siem_export_targets', 'id, tenant_id', 'TRUE', []);
  if (!target) return;
  if (!(await tableCount('siem_export_events'))) {
    await insertIfEmpty('siem_export_events', [{
      tenant_id: target.tenant_id || DEFAULT_TENANT_ID,
      source_name: 'synthetic',
      source_id: 'seed-event-1',
      event_type: 'seed.security.event',
      severity: 'high',
      payload_sha256: hex64,
      minimized_payload: JSON.stringify({ redaction: { raw_payload_exported: false }, seed: true }),
      synthetic: true,
    }]);
  }
  const event = await first('siem_export_events', 'id, tenant_id', 'TRUE', []);
  if (!event) return;
  if (!(await tableCount('siem_export_delivery_attempts'))) {
    await insertIfEmpty('siem_export_delivery_attempts', [{
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      event_id: event.id,
      target_id: target.id,
      transport: 'webhook',
      status: 'pending',
      payload_sha256: hex64,
      lease_generation: 0,
      acknowledgement_state: 'not_evaluated',
      send_authority: 'normal',
      effect_disposition: 'live',
      metadata: JSON.stringify({ seed: true }),
    }]);
  }
}

async function seedNicuPicuChartTables() {
  const hasFeedFluid = await tableExists('nicu_feed_fluid_entries');
  const hasJaundice = await tableExists('nicu_jaundice_phototherapy_events');
  const hasScoring = await tableExists('nicu_picu_scoring_outputs');
  if (!hasFeedFluid && !hasJaundice && !hasScoring) return;

  const refs = await getCoreRefs();
  const icuAdmission = await first(
    'icu_admissions',
    'id, tenant_id, admission_id, patient_uid',
    'TRUE',
    [],
  );
  const reviewerUid = refs.staff?.uid || refs.doctor?.uid;
  if (!icuAdmission?.id || !icuAdmission.patient_uid || !reviewerUid) return;
  const tenantId = icuAdmission.tenant_id || DEFAULT_TENANT_ID;
  const seedMeta = JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' });

  if (hasFeedFluid) {
    await insertIfEmpty('nicu_feed_fluid_entries', [
      {
        tenant_id: tenantId,
        icu_admission_id: icuAdmission.id,
        admission_id: icuAdmission.admission_id,
        patient_uid: icuAdmission.patient_uid,
        entry_kind: 'weight',
        recorded_at: new Date('2026-05-04T06:00:00.000Z'),
        weight_grams: 1500,
        recorded_by: reviewerUid,
        notes: 'Seed NICU weight-of-day anchor for QA coverage.',
        metadata: seedMeta,
      },
      {
        tenant_id: tenantId,
        icu_admission_id: icuAdmission.id,
        admission_id: icuAdmission.admission_id,
        patient_uid: icuAdmission.patient_uid,
        entry_kind: 'feed',
        recorded_at: new Date('2026-05-04T08:00:00.000Z'),
        feed_type: 'expressed_breast_milk',
        feed_route: 'og_tube',
        volume_ml: 30,
        duration_minutes: 20,
        recorded_by: reviewerUid,
        metadata: seedMeta,
      },
      {
        tenant_id: tenantId,
        icu_admission_id: icuAdmission.id,
        admission_id: icuAdmission.admission_id,
        patient_uid: icuAdmission.patient_uid,
        entry_kind: 'fluid_output',
        recorded_at: new Date('2026-05-04T09:00:00.000Z'),
        output_kind: 'urine',
        output_volume_ml: 12,
        diaper_weight_based: true,
        recorded_by: reviewerUid,
        metadata: seedMeta,
      },
    ]);
  }

  if (hasJaundice) {
    await insertIfEmpty('nicu_jaundice_phototherapy_events', [{
      tenant_id: tenantId,
      icu_admission_id: icuAdmission.id,
      patient_uid: icuAdmission.patient_uid,
      event_kind: 'bilirubin_measurement',
      occurred_at: new Date('2026-05-04T10:00:00.000Z'),
      bilirubin_total_mgdl: 11.4,
      bilirubin_direct_mgdl: 0.6,
      measurement_method: 'serum',
      threshold_reference_source: 'nl5_content_studio',
      threshold_reference_version: 'seed-tsb-v1',
      recorded_by: reviewerUid,
      notes: 'Seed bilirubin measurement for QA coverage.',
      metadata: seedMeta,
    }]);
  }

  if (!hasScoring) return;

  // Score outputs fail closed without an owner-approved definition row, so
  // the seed provides its own reference-complete (inactive) definition and
  // stamps the output from it — mirroring the service's provenance rule.
  let definition = await first(
    'nicu_picu_score_definitions',
    'id, reference_source, reference_version',
    'reference_source IS NOT NULL AND reference_version IS NOT NULL',
    [],
  );
  if (!definition && await tableExists('nicu_picu_score_definitions')) {
    const created = await client.query(
      `INSERT INTO nicu_picu_score_definitions (
         tenant_id, score_kind, display_name, description, age_scope, source,
         reference_source, reference_version, approved_by, approved_at,
         active, metadata
       )
       VALUES (
         $1::uuid, 'crib_ii', 'CRIB-II (seed)',
         'Seed owner-approval evidence row for QA coverage.', 'neonatal',
         'operator_supplied', 'Seed owner-approved CRIB-II reference',
         'seed-crib2-v1', $2::uuid, NOW(), FALSE,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, reference_source, reference_version`,
      [tenantId, reviewerUid],
    );
    definition = created.rows[0];
  }
  if (!definition?.id) return;

  await insertIfEmpty('nicu_picu_scoring_outputs', [{
    tenant_id: tenantId,
    icu_admission_id: icuAdmission.id,
    patient_uid: icuAdmission.patient_uid,
    score_definition_id: definition.id,
    score_kind: 'crib_ii',
    recorded_at: new Date('2026-05-04T11:00:00.000Z'),
    input_facts: JSON.stringify({ gestational_age_weeks: 31.5, birth_weight_g: 1500 }),
    score_value: 7,
    score_label: 'CRIB-II 7',
    output_payload: JSON.stringify({ score: 7, scale: 'CRIB-II' }),
    reference_source: definition.reference_source,
    reference_version: definition.reference_version,
    reviewer_uid: reviewerUid,
    reviewer_role: 'NURSING_STAFF',
    reviewed_at: new Date('2026-05-04T11:05:00.000Z'),
    review_status: 'reviewed',
    score_available: true,
    order_mutation_performed: false,
    recorded_by: reviewerUid,
    metadata: seedMeta,
  }]);
}

async function seedResuscitationTables() {
  if (!(await tableExists('resuscitation_events'))) return;

  const refs = await getCoreRefs();
  const patientUid = refs.patient?.uid;
  const leaderUid = refs.staff?.uid || refs.doctor?.uid;
  const recorderUid = refs.secondStaff?.uid || leaderUid;
  if (!patientUid || !leaderUid) return;

  await insertIfEmpty('resuscitation_settings', [{
    tenant_id: DEFAULT_TENANT_ID,
    enabled: true,
    charting_policy: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    trigger_policy: JSON.stringify({ seed: true }),
    policy_source: 'operator_supplied',
    enabled_at: new Date('2026-05-04T08:00:00.000Z'),
    enabled_by: leaderUid,
    acceptance_snapshot: JSON.stringify({ seed: true, accepted_by: 'seed-comprehensive-test-data' }),
  }]);

  let event = await first('resuscitation_events', 'id, tenant_id, patient_uid', 'TRUE', []);
  if (!event) {
    const created = await client.query(
      `INSERT INTO resuscitation_events (
         tenant_id, patient_uid, event_kind, trigger_source, triggered_by,
         ward_snapshot, bed_snapshot, reason, started_at, ended_at, outcome,
         status, team_leader_uid, team_leader_name, recorder_uid, recorder_name,
         post_event_note_status, created_by, metadata
       )
       VALUES (
         $1::uuid, $2::uuid, 'code_blue', 'explicit_staff', $3::uuid,
         'ICU-A', 'B1', 'Seed code blue for QA coverage.',
         '2026-05-04T11:00:00.000Z'::timestamptz,
         '2026-05-04T11:25:00.000Z'::timestamptz, 'rosc',
         'ended', $3::uuid, 'Seed team leader', $4::uuid, 'Seed recorder',
         'draft', $3::uuid,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id, tenant_id, patient_uid`,
      [DEFAULT_TENANT_ID, patientUid, leaderUid, recorderUid],
    );
    event = created.rows[0];
  }

  await insertIfEmpty('resuscitation_event_timeline', [
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      seq: 1,
      entry_type: 'compressions_started',
      occurred_at: new Date('2026-05-04T11:00:30.000Z'),
      details: JSON.stringify({ seed: true }),
      recorded_by: recorderUid,
    },
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      seq: 2,
      entry_type: 'shock',
      occurred_at: new Date('2026-05-04T11:02:00.000Z'),
      rhythm: 'vf',
      energy_joules: 200,
      details: JSON.stringify({ seed: true, waveform: 'biphasic' }),
      recorded_by: recorderUid,
    },
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      seq: 3,
      entry_type: 'medication',
      occurred_at: new Date('2026-05-04T11:03:00.000Z'),
      medication_name: 'Adrenaline (epinephrine)',
      dose: '1 mg',
      route: 'IV',
      details: JSON.stringify({ seed: true }),
      recorded_by: recorderUid,
    },
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      seq: 4,
      entry_type: 'rosc',
      occurred_at: new Date('2026-05-04T11:24:00.000Z'),
      details: JSON.stringify({ seed: true }),
      recorded_by: recorderUid,
    },
  ]);

  const medEntry = await first(
    'resuscitation_event_timeline',
    'id',
    "resuscitation_event_id = $1 AND entry_type = 'medication'",
    [event.id],
  );
  await insertIfEmpty('resuscitation_medication_links', [{
    tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
    resuscitation_event_id: event.id,
    timeline_entry_id: medEntry?.id,
    patient_uid: event.patient_uid,
    link_kind: 'unlinked_emergency',
    medication_kind: 'medication',
    medication_name: 'Adrenaline (epinephrine)',
    dose: '1 mg',
    route: 'IV',
    reconciliation_status: 'pending_mar_reconciliation',
    recorded_by: recorderUid,
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);

  await insertIfEmpty('resuscitation_team_roles', [
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      staff_uid: leaderUid,
      staff_name: 'Seed team leader',
      role: 'team_leader',
      joined_at: new Date('2026-05-04T11:00:00.000Z'),
      signed_at: new Date('2026-05-04T11:30:00.000Z'),
      signature_method: 'app_confirmation',
      signature_evidence: JSON.stringify({ seed: true }),
      assigned_by: leaderUid,
      metadata: JSON.stringify({ seed: true }),
    },
    {
      tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
      resuscitation_event_id: event.id,
      patient_uid: event.patient_uid,
      staff_uid: recorderUid,
      staff_name: 'Seed recorder',
      role: 'recorder',
      joined_at: new Date('2026-05-04T11:00:00.000Z'),
      signed_at: new Date('2026-05-04T11:30:00.000Z'),
      signature_method: 'app_confirmation',
      signature_evidence: JSON.stringify({ seed: true }),
      assigned_by: leaderUid,
      metadata: JSON.stringify({ seed: true }),
    },
  ]);

  const alertRow = await first('clinical_alerts', 'id', 'TRUE', []);
  await insertIfEmpty('resuscitation_device_links', [{
    tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
    resuscitation_event_id: event.id,
    patient_uid: event.patient_uid,
    link_kind: alertRow ? 'clinical_alert' : 'defibrillator',
    clinical_alert_id: alertRow?.id,
    evidence: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    linked_by: recorderUid,
    linked_at: new Date('2026-05-04T11:02:30.000Z'),
  }]);

  await insertIfEmpty('resuscitation_qa_reviews', [{
    tenant_id: event.tenant_id || DEFAULT_TENANT_ID,
    resuscitation_event_id: event.id,
    patient_uid: event.patient_uid,
    review_status: 'draft',
    template_source: 'operator_supplied',
    template_version: 'seed-qa-v1',
    template_snapshot: JSON.stringify({ seed: true, questions: ['timeliness', 'documentation'] }),
    evidence_owner_uid: leaderUid,
    responses: JSON.stringify({ timeliness: 'seed answer' }),
    findings: 'Seed QA review for coverage.',
    action_items: JSON.stringify([]),
    debrief_held_at: new Date('2026-05-04T12:00:00.000Z'),
    debrief_lead_uid: leaderUid,
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedEdEncounterEvidence() {
  if (!(await tableExists('ed_encounter_evidence')) || await tableCount('ed_encounter_evidence')) return;

  const visit = await first('emergency_visits', 'id, tenant_id, patient_uid', 'TRUE', []);
  const vital = await first(
    'vitals_chart',
    'id, tenant_id, patient_uid, recorded_at, device_verified, recorded_by',
    'TRUE',
    [],
  );
  if (!visit || !vital) return;

  await insertIfEmpty('ed_encounter_evidence', [{
    tenant_id: visit.tenant_id || vital.tenant_id || DEFAULT_TENANT_ID,
    emergency_visit_id: visit.id,
    patient_uid: visit.patient_uid || vital.patient_uid,
    evidence_kind: 'vital_snapshot',
    vitals_chart_id: vital.id,
    observed_at: vital.recorded_at || new Date(),
    verified: vital.device_verified ?? false,
    linked_by_uid: vital.recorded_by,
    notes: 'Seed ED vital snapshot evidence for QA coverage',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedEdClosureRecoveryEvidence() {
  if (
    (await tableCount('ed_closure_evidence')) > 0
    && (await tableCount('ed_recovery_contact_events')) > 0
  ) {
    return;
  }

  const refs = await getCoreRefs();
  const encounterId = '59700000-0000-4000-8000-000000000001';
  const closureId = '59700000-0000-4000-8000-000000000002';
  const recoveryId = '59700000-0000-4000-8000-000000000003';
  const occurredAt = new Date('2026-05-04T11:00:00.000Z');

  await client.query(
    `INSERT INTO patient_encounters
       (id, tenant_id, patient_uid, encounter_type, status,
        primary_doctor_uid, care_team_uids, opened_at, activated_at,
        created_by, updated_by, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, 'er', 'active',
        $4::uuid, ARRAY[$4::uuid], $5::timestamptz, $5::timestamptz,
        $4::uuid, $4::uuid,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET patient_uid = EXCLUDED.patient_uid,
           primary_doctor_uid = EXCLUDED.primary_doctor_uid,
           care_team_uids = EXCLUDED.care_team_uids,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [
      encounterId,
      DEFAULT_TENANT_ID,
      refs.patient.uid,
      refs.doctor.uid,
      occurredAt,
    ],
  );

  const visit = await client.query(
    `INSERT INTO emergency_visits
       (tenant_id, visit_number, patient_uid, encounter_id, arrival_at,
        arrival_mode, chief_complaint, attending_doctor_uid, status,
        disposition, disposition_at, departure_at, is_mlc, metadata,
        created_by)
     VALUES
       ($1::uuid, 'SEED-ED-CLOSURE-597', $2::uuid, $3::uuid,
        $4::timestamptz, 'walk_in', 'Seed LAMA continuity coverage',
        $5::uuid, 'left_against_advice',
        'left_against_medical_advice', $4::timestamptz, $4::timestamptz,
        FALSE,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        $5::uuid)
     ON CONFLICT (tenant_id, visit_number) DO UPDATE
       SET patient_uid = EXCLUDED.patient_uid,
           encounter_id = EXCLUDED.encounter_id,
           attending_doctor_uid = EXCLUDED.attending_doctor_uid,
           status = EXCLUDED.status,
           disposition = EXCLUDED.disposition,
           disposition_at = EXCLUDED.disposition_at,
           departure_at = EXCLUDED.departure_at,
           updated_at = NOW()
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      refs.patient.uid,
      encounterId,
      occurredAt,
      refs.doctor.uid,
    ],
  );
  const visitId = Number(visit.rows[0].id);

  const closureTimeline = await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, encounter_id, event_type, event_status,
        source_table, source_id, resource_type, resource_id, actor_uid,
        actor_role, occurred_at, visible_to_patient, clinical_summary,
        payload, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'emergency.closure_evidence_recorded', 'recorded',
        'ed_closure_evidence', $4::uuid::text,
        'ed_closure_evidence', $4::uuid::text, $5::uuid, 'DOCTOR',
        $6::timestamptz, FALSE, 'Seed ED LAMA closure evidence',
        jsonb_build_object(
          'emergency_visit_id', $7::integer,
          'closure_kind', 'left_against_medical_advice',
          'seed', TRUE
        ),
        'seed-ed-closure-597-timeline')
     ON CONFLICT (idempotency_key) DO UPDATE
       SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      refs.patient.uid,
      encounterId,
      closureId,
      refs.doctor.uid,
      occurredAt,
      visitId,
    ],
  );
  const closureAudit = await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, encounter_id, action, action_status,
        actor_uid, actor_role, resource_type, resource_table, resource_id,
        after_state, metadata, idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'emergency.closure_evidence_recorded', 'success',
        $4::uuid, 'DOCTOR', 'ed_closure_evidence',
        'ed_closure_evidence', $5::uuid::text,
        '{"closure_kind":"left_against_medical_advice"}'::jsonb,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        'seed-ed-closure-597-audit', $6::timestamptz)
     ON CONFLICT (idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      refs.patient.uid,
      encounterId,
      refs.doctor.uid,
      closureId,
      occurredAt,
    ],
  );

  await client.query(
    `INSERT INTO ed_closure_evidence
       (id, tenant_id, emergency_visit_id, patient_uid, encounter_id,
        evidence_revision, closure_kind, clinician_uid,
        follow_up_required, no_follow_up_reason, patient_safe_next_steps,
        medication_not_applicable_reason, risk_classification_code,
        risk_summary, identity_resolution_status, patient_visibility_status,
        canonical_timeline_event_id, canonical_audit_event_id, occurred_at,
        idempotency_key, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
        1, 'left_against_medical_advice', $6::uuid,
        FALSE, 'No scheduled follow-up is required for seed coverage.',
        '[{"label":"Follow the documented ED safety-net advice","status":"planned","patient_action":"Seek urgent care if symptoms worsen","route_token":"health"}]'::jsonb,
        'No medication reconciliation is required for seed coverage.',
        'seed_risk_reviewed',
        'Seed-only risk review completed without a clinical policy value.',
        'verified', 'released', $7::uuid, $8::uuid, $9::timestamptz,
        'seed-ed-closure-597',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      closureId,
      DEFAULT_TENANT_ID,
      visitId,
      refs.patient.uid,
      encounterId,
      refs.doctor.uid,
      closureTimeline.rows[0].id,
      closureAudit.rows[0].id,
      occurredAt,
    ],
  );

  const recoveryTimeline = await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, encounter_id, event_type, event_status,
        source_table, source_id, resource_type, resource_id, actor_uid,
        actor_role, occurred_at, visible_to_patient, clinical_summary,
        payload, idempotency_key)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'emergency.recovery_contact_recorded', 'attempt',
        'ed_recovery_contact_events', $4::uuid::text,
        'ed_recovery_contact_event', $4::uuid::text, $5::uuid, 'DOCTOR',
        $6::timestamptz, FALSE, 'Seed ED recovery contact attempt',
        jsonb_build_object(
          'emergency_visit_id', $7::integer,
          'closure_evidence_id', $8::uuid,
          'event_kind', 'attempt',
          'seed', TRUE
        ),
        'seed-ed-recovery-597-timeline')
     ON CONFLICT (idempotency_key) DO UPDATE
       SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      refs.patient.uid,
      encounterId,
      recoveryId,
      refs.doctor.uid,
      new Date('2026-05-04T11:05:00.000Z'),
      visitId,
      closureId,
    ],
  );
  const recoveryAudit = await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, encounter_id, action, action_status,
        actor_uid, actor_role, resource_type, resource_table, resource_id,
        after_state, metadata, idempotency_key, occurred_at)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid,
        'emergency.recovery_contact_recorded', 'success',
        $4::uuid, 'DOCTOR', 'ed_recovery_contact_event',
        'ed_recovery_contact_events', $5::uuid::text,
        '{"event_kind":"attempt"}'::jsonb,
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb,
        'seed-ed-recovery-597-audit', $6::timestamptz)
     ON CONFLICT (idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id`,
    [
      DEFAULT_TENANT_ID,
      refs.patient.uid,
      encounterId,
      refs.doctor.uid,
      recoveryId,
      new Date('2026-05-04T11:05:00.000Z'),
    ],
  );

  await client.query(
    `INSERT INTO ed_recovery_contact_events
       (id, tenant_id, emergency_visit_id, closure_evidence_id,
        patient_uid, encounter_id, event_kind, contact_channel,
        patient_safe_summary, staff_notes, recorded_by_uid,
        canonical_timeline_event_id, canonical_audit_event_id, occurred_at,
        idempotency_key, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3::integer, $4::uuid,
        $5::uuid, $6::uuid, 'attempt', 'phone',
        'The ED team attempted a follow-up contact.',
        'Seed-only recovery contact coverage.', $7::uuid,
        $8::uuid, $9::uuid, $10::timestamptz,
        'seed-ed-recovery-597',
        '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      recoveryId,
      DEFAULT_TENANT_ID,
      visitId,
      closureId,
      refs.patient.uid,
      encounterId,
      refs.doctor.uid,
      recoveryTimeline.rows[0].id,
      recoveryAudit.rows[0].id,
      new Date('2026-05-04T11:05:00.000Z'),
    ],
  );
}

async function seedTransplantProgramTables() {
  if (!(await tableExists('transplant_programs'))) return;

  const refs = await getCoreRefs();
  if (!refs.patient || !refs.staff) return;
  const ownerUid = refs.doctor?.uid || refs.staff.uid;

  if (await tableExists('transplant_program_settings')) {
    await insertIfEmpty('transplant_program_settings', [{
      tenant_id: DEFAULT_TENANT_ID,
      enabled: false,
      acceptance_snapshot: JSON.stringify({ seed: true, suite: 'nl13-p6-transplant' }),
      owner_evidence_reference: 'seed-transplant-owner-evidence',
    }]);
  }

  let program = await first(
    'transplant_programs',
    'id, tenant_id',
    'tenant_id = $1::uuid',
    [DEFAULT_TENANT_ID],
  );
  if (!program) {
    const created = await client.query(
      `INSERT INTO transplant_programs (
         tenant_id, organ, service_line, site, program_owner_uid, program_owner_role,
         status, notto_evidence_owner_uid, notto_evidence_owner_role,
         notto_evidence_reference, metadata, created_by
       )
       VALUES (
         $1::uuid, 'kidney'::transplant_organ_type, 'Seed transplant service',
         'Seed transplant site', $2::uuid, 'DOCTOR', 'active', $3::uuid,
         'TRANSPLANT_COORDINATOR', 'seed-transplant-owner-evidence',
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb, $3::uuid
       )
       RETURNING id, tenant_id`,
      [DEFAULT_TENANT_ID, ownerUid, refs.staff.uid],
    );
    program = created.rows[0];
  }

  let candidate = await first(
    'transplant_candidates',
    'id, tenant_id, patient_uid',
    'tenant_id = $1::uuid',
    [program.tenant_id || DEFAULT_TENANT_ID],
  );
  if (!candidate && await tableExists('transplant_candidates')) {
    const created = await client.query(
      `INSERT INTO transplant_candidates (
         tenant_id, program_id, patient_uid, diagnosis, required_organs,
         listing_evaluation_status, committee_status, contraindications_summary,
         metadata, created_by
       )
       VALUES (
         $1::uuid, $2, $3::uuid, 'Seed transplant candidate evaluation',
         ARRAY['kidney']::transplant_organ_type[], 'committee_review', 'approved',
         'No seed contraindications recorded',
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb, $4::uuid
       )
       RETURNING id, tenant_id, patient_uid`,
      [program.tenant_id || DEFAULT_TENANT_ID, program.id, refs.patient.uid, refs.staff.uid],
    );
    candidate = created.rows[0];
  }

  if (!candidate) return;

  if (await tableExists('transplant_committee_reviews')) {
    await insertIfEmpty('transplant_committee_reviews', [{
      tenant_id: candidate.tenant_id || DEFAULT_TENANT_ID,
      program_id: program.id,
      candidate_id: candidate.id,
      attendees: JSON.stringify([{ staff_uid: refs.staff.uid, role: 'TRANSPLANT_COORDINATOR' }]),
      quorum_policy_reference: 'seed-transplant-quorum-policy',
      decision: 'approved',
      recommendations: 'Seed committee approval for QA coverage.',
      affects_candidate: true,
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
    }]);
  }

  if (await tableExists('transplant_waitlist_status_history')) {
    await insertIfEmpty('transplant_waitlist_status_history', [{
      tenant_id: candidate.tenant_id || DEFAULT_TENANT_ID,
      candidate_id: candidate.id,
      status: 'listed',
      reason: 'Seed waitlist status for QA coverage.',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
    }]);
  }

  let donorReferral = await first(
    'transplant_donor_referrals',
    'id, tenant_id',
    'tenant_id = $1::uuid',
    [program.tenant_id || DEFAULT_TENANT_ID],
  );
  if (!donorReferral && await tableExists('transplant_donor_referrals')) {
    const created = await client.query(
      `INSERT INTO transplant_donor_referrals (
         tenant_id, program_id, donor_type, source, relation_category,
         screening_summary, documents, status, audit_register, created_by
       )
       VALUES (
         $1::uuid, $2, 'living', 'Seed donor referral', 'related',
         'Seed transplant donor referral for QA coverage.',
         '[]'::jsonb, 'screening',
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb, $3::uuid
       )
       RETURNING id, tenant_id`,
      [program.tenant_id || DEFAULT_TENANT_ID, program.id, refs.staff.uid],
    );
    donorReferral = created.rows[0];
  }

  if (donorReferral && await tableExists('transplant_match_reviews')) {
    await insertIfEmpty('transplant_match_reviews', [{
      tenant_id: candidate.tenant_id || DEFAULT_TENANT_ID,
      candidate_id: candidate.id,
      donor_referral_id: donorReferral.id,
      compatibility_summary: 'Seed compatibility review for QA coverage.',
      crossmatch_documents: JSON.stringify([]),
      chain_of_custody: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      risk_flags: [],
      decision: 'pending',
      created_by: refs.staff.uid,
    }]);
  }

  if (await tableExists('transplant_immunosuppression_plans')) {
    await insertIfEmpty('transplant_immunosuppression_plans', [{
      tenant_id: candidate.tenant_id || DEFAULT_TENANT_ID,
      candidate_id: candidate.id,
      patient_uid: candidate.patient_uid || refs.patient.uid,
      regimen_summary: 'Seed immunosuppression regimen for QA coverage.',
      monitoring_plan: 'Seed monitoring plan for QA coverage.',
      prescribing_owner_uid: ownerUid,
      downstream_medication_links: JSON.stringify([]),
      status: 'draft',
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
    }]);
  }

  if (await tableExists('transplant_notto_exports')) {
    await insertIfEmpty('transplant_notto_exports', [{
      tenant_id: program.tenant_id || DEFAULT_TENANT_ID,
      program_id: program.id,
      candidate_id: candidate.id,
      package_metadata: JSON.stringify({ seed: true, export_kind: 'candidate_snapshot' }),
      owner_reviewed_status: 'pending_owner_review',
      audit_evidence: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
      created_by: refs.staff.uid,
    }]);
  }
}

async function seedPerfusionSignoffs() {
  if (!(await tableExists('perfusion_signoffs')) || await tableCount('perfusion_signoffs')) return;
  const record = await first('perfusion_records', 'id, tenant_id, ot_schedule_id, patient_uid', 'TRUE', []);
  if (!record) return;

  await insertIfEmpty('perfusion_signoffs', [{
    tenant_id: record.tenant_id || DEFAULT_TENANT_ID,
    perfusion_record_id: record.id,
    ot_schedule_id: record.ot_schedule_id,
    patient_uid: record.patient_uid,
    status: 'draft',
    signoff_policy_source_label: 'owner-pending-perfusion-signoff-policy',
    signoff_policy_source_version: 'pending',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedIcuChartDepthTables() {
  const hasWeaning = await tableExists('icu_weaning_trials');
  const hasScoring = await tableExists('icu_scoring_outputs');
  const hasDeviceLinks = await tableExists('icu_device_observation_links');
  if (!hasWeaning && !hasScoring && !hasDeviceLinks) return;

  const refs = await getCoreRefs();
  const icuAdmission = await first(
    'icu_admissions',
    'id, tenant_id, admission_id, patient_uid',
    'TRUE',
    [],
  );
  const reviewerUid = refs.staff?.uid || refs.doctor?.uid;
  if (!icuAdmission?.id || !icuAdmission.patient_uid || !reviewerUid) return;

  let ventilationEpisode = await first(
    'icu_ventilation_episodes',
    'id',
    'icu_admission_id = $1',
    [icuAdmission.id],
  );
  if (hasWeaning && !ventilationEpisode && await tableExists('icu_ventilation_episodes')) {
    const created = await client.query(
      `INSERT INTO icu_ventilation_episodes (
         tenant_id, icu_admission_id, admission_id, patient_uid, mode, oxygen_device,
         airway_type, started_at, settings, responsible_clinician_uid,
         responsible_clinician_name, started_by, metadata
       )
       VALUES (
         $1::uuid, $2, $3, $4::uuid, 'pressure_support', 'ventilator',
         'ett', '2026-05-04T08:00:00.000Z'::timestamptz,
         '{"fio2":0.35,"peepCmH2o":5}'::jsonb, $5::uuid,
         'Seed ICU clinician', $5::uuid,
         '{"seed":true,"source":"seed-comprehensive-test-data"}'::jsonb
       )
       RETURNING id`,
      [
        icuAdmission.tenant_id || DEFAULT_TENANT_ID,
        icuAdmission.id,
        icuAdmission.admission_id,
        icuAdmission.patient_uid,
        reviewerUid,
      ],
    );
    ventilationEpisode = created.rows[0];
  }

  if (hasWeaning) {
    await insertIfEmpty('icu_weaning_trials', [{
      tenant_id: icuAdmission.tenant_id || DEFAULT_TENANT_ID,
      icu_admission_id: icuAdmission.id,
      ventilation_episode_id: ventilationEpisode?.id,
      patient_uid: icuAdmission.patient_uid,
      trial_kind: 'sbt',
      readiness_status: 'ready',
      started_at: new Date('2026-05-04T09:00:00.000Z'),
      ended_at: new Date('2026-05-04T09:30:00.000Z'),
      outcome: 'passed',
      reason: 'Seed spontaneous breathing trial for QA coverage.',
      criteria_snapshot: JSON.stringify({ fio2: 0.35, peepCmH2o: 5, hemodynamics: 'stable' }),
      protocol_reference: JSON.stringify({ source: 'nl5_content_studio', version: 'seed-sbt-v1' }),
      reviewer_uid: reviewerUid,
      reviewed_at: new Date('2026-05-04T09:35:00.000Z'),
      recorded_by: reviewerUid,
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (hasScoring) {
    await insertIfEmpty('icu_scoring_outputs', [{
      tenant_id: icuAdmission.tenant_id || DEFAULT_TENANT_ID,
      icu_admission_id: icuAdmission.id,
      patient_uid: icuAdmission.patient_uid,
      scoring_kind: 'rass',
      recorded_at: new Date('2026-05-04T10:00:00.000Z'),
      input_facts: JSON.stringify({ agitation: 'calm', arousal: 'alert' }),
      score_value: 0,
      score_label: 'Alert and calm',
      output_payload: JSON.stringify({ score: 0, scale: 'RASS' }),
      reference_source: 'nl5_content_studio',
      reference_version: 'seed-rass-v1',
      reviewer_uid: reviewerUid,
      reviewer_role: 'NURSING_STAFF',
      reviewed_at: new Date('2026-05-04T10:05:00.000Z'),
      review_status: 'reviewed',
      protocol_available: true,
      order_mutation_performed: false,
      recorded_by: reviewerUid,
      metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
    }]);
  }

  if (!hasDeviceLinks) return;

  let vitalsRow = await first(
    'vitals_chart',
    'id, tenant_id, patient_uid',
    'patient_uid = $1::uuid',
    [icuAdmission.patient_uid],
  );
  if (!vitalsRow) {
    const created = await client.query(
      `INSERT INTO vitals_chart (
         tenant_id, patient_uid, heart_rate, systolic_bp, diastolic_bp,
         spo2, respiratory_rate, source, device_verified, verified_by,
         verified_at, recorded_by, recorded_at, notes
       )
       VALUES (
         $1::uuid, $2::uuid, 82, 118, 72, 98, 16, 'device',
         TRUE, $3::uuid, '2026-05-04T10:10:00.000Z'::timestamptz,
         $3::uuid, '2026-05-04T10:10:00.000Z'::timestamptz,
         'Seed ICU device vital for QA coverage.'
       )
       RETURNING id, tenant_id, patient_uid`,
      [icuAdmission.tenant_id || DEFAULT_TENANT_ID, icuAdmission.patient_uid, reviewerUid],
    );
    vitalsRow = created.rows[0];
  }

  await insertIfEmpty('icu_device_observation_links', [{
    tenant_id: icuAdmission.tenant_id || vitalsRow.tenant_id || DEFAULT_TENANT_ID,
    icu_admission_id: icuAdmission.id,
    patient_uid: icuAdmission.patient_uid,
    link_kind: 'vitals_chart',
    vitals_chart_id: vitalsRow.id,
    linked_at: new Date('2026-05-04T10:15:00.000Z'),
    linked_by: reviewerUid,
    context: 'seed_coverage',
    metadata: JSON.stringify({ seed: true, source: 'seed-comprehensive-test-data' }),
  }]);
}

async function seedClinicalContinuityTables() {
  const hasPolicies = await tableExists('clinical_continuity_policy_versions');
  const hasSnapshots = await tableExists('downtime_snapshots');
  if (!hasPolicies && !hasSnapshots) return;

  if (hasPolicies) {
    const fixture = CLINICAL_CONTINUITY_SEED_FIXTURE;
    await client.query(
      `INSERT INTO tenants (id, slug, name, status, settings)
       VALUES ($1::uuid, $2::text, 'Continuity seed tenant (inert)', 'suspended',
               '{"seed":true,"activation":"disabled"}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [fixture.tenantId, fixture.tenantSlug],
    );
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1::text, true)",
      [fixture.tenantId],
    );
    await client.query(
      `INSERT INTO facilities
         (id, tenant_id, facility_code, display_name, timezone, status, is_default, metadata)
       VALUES
         ($1::integer, $2::uuid, $3::text, 'Continuity seed facility (inert)',
          'Asia/Kolkata', 'inactive', FALSE,
          '{"seed":true,"activation":"disabled"}'::jsonb)
       ON CONFLICT (tenant_id, facility_code) DO NOTHING`,
      [fixture.facilityId, fixture.tenantId, fixture.facilityCode],
    );

    for (const key of [
      {
        keyId: fixture.policySigningKeyId,
        purpose: 'clinical_continuity_policy_signing',
        publicKey: fixture.policySigningPublicKey,
      },
      {
        keyId: fixture.currentPackSigningKeyId,
        purpose: 'clinical_continuity_pack_signing',
        publicKey: fixture.currentPackSigningPublicKey,
      },
    ]) {
      await client.query(
        `INSERT INTO encryption_keys
           (tenant_id, key_id, provider, provider_reference, algorithm, status, metadata)
         VALUES
           ($1::uuid, $2::text, 'test_fixture', 'public-only:test-fixture',
            'ed25519', 'active', $3::jsonb)
         ON CONFLICT (tenant_id, key_id) DO NOTHING`,
        [
          fixture.tenantId,
          key.keyId,
          JSON.stringify({
            seed: true,
            purpose: key.purpose,
            public_key_spki_pem: key.publicKey,
            private_key_material_present: false,
          }),
        ],
      );
    }

    const existingPolicy = await first(
      'clinical_continuity_policy_versions',
      'id',
      'id = $1::uuid AND tenant_id = $2::uuid AND facility_id = $3::integer',
      [fixture.policyId, fixture.tenantId, fixture.facilityId],
    );
    if (!existingPolicy) {
      await client.query(
        `INSERT INTO clinical_continuity_policy_versions
           (id, tenant_id, facility_id, policy_version, policy_schema_version,
            lifecycle_state, policy_document, policy_checksum, canonicalization,
            signature_algorithm, policy_signing_key_id,
            policy_signing_public_key_sha256, current_pack_signing_key_id,
            current_pack_signing_public_key_sha256, policy_signature,
            revocation_epoch, revoked_key_ids, effective_from)
         VALUES
           ($1::uuid, $2::uuid, $3::integer, 1, 1, 'draft', $4::jsonb,
            $5::text, 'rfc8785-jcs', 'ed25519', $6::text, $7::text,
            $8::text, $9::text, $10::bytea, 0, '[]'::jsonb, $11::timestamptz)`,
        [
          fixture.policyId,
          fixture.tenantId,
          fixture.facilityId,
          JSON.stringify(fixture.policyDocument),
          fixture.policyChecksum,
          fixture.policySigningKeyId,
          fixture.policySigningPublicKeySha256,
          fixture.currentPackSigningKeyId,
          fixture.currentPackSigningPublicKeySha256,
          Buffer.from(fixture.policySignature, 'base64'),
          fixture.effectiveFrom,
        ],
      );
    }
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1::text, true)",
      [DEFAULT_TENANT_ID],
    );
  }

  if (hasSnapshots) {
    const defaultTenantPatient = await first(
      'users',
      'uid',
      "tenant_id = $1::uuid AND role = 'PATIENT'",
      [DEFAULT_TENANT_ID],
    );
    if (!defaultTenantPatient?.uid) {
      throw new Error(
        'Clinical continuity legacy snapshot seed requires a default-tenant patient fixture',
      );
    }
    await insertIfEmpty('downtime_snapshots', [{
      tenant_id: DEFAULT_TENANT_ID,
      patient_uid: defaultTenantPatient.uid,
      scope: 'patient_chart',
      label: 'Seed legacy downtime snapshot',
      payload: JSON.stringify({
        seed: true,
        source: 'seed-comprehensive-test-data',
        governedContinuityPublication: false,
      }),
      expires_at: new Date('2026-07-30T00:00:00.000Z'),
    }]);
  }
}

async function seedFhirVitalObservationReceiptGraph() {
  const ctx = await getCoreRefs();
  if (!ctx.patient?.uid || !ctx.staff?.uid) {
    throw new Error('FHIR vital receipt seed requires patient and staff fixtures');
  }

  const existingVitals = await first(
    'vitals_chart',
    'id',
    `tenant_id = $1::uuid
      AND patient_uid = $2::uuid
      AND source = 'fhir'
      AND source_device = $3
      AND recorded_at = $4::timestamptz`,
    [
      DEFAULT_TENANT_ID,
      ctx.patient.uid,
      FHIR_VITAL_SEED_SET_FINGERPRINT,
      FHIR_VITAL_SEED_OBSERVED_AT,
    ],
  );
  let vitalsChartId = existingVitals?.id;
  if (!vitalsChartId) {
    const insertedVitals = await client.query(
      `INSERT INTO vitals_chart
         (tenant_id, patient_uid, heart_rate, supplemental_o2, source,
          source_device, recorded_by, recorded_at)
       VALUES ($1::uuid, $2::uuid, 80, FALSE, 'fhir', $3, $4::uuid, $5::timestamptz)
       RETURNING id`,
      [
        DEFAULT_TENANT_ID,
        ctx.patient.uid,
        FHIR_VITAL_SEED_SET_FINGERPRINT,
        ctx.staff.uid,
        FHIR_VITAL_SEED_OBSERVED_AT,
      ],
    );
    vitalsChartId = insertedVitals.rows[0].id;
  }

  await client.query(
    `INSERT INTO fhir_vital_observation_receipts
       (tenant_id, resource_fingerprint, patient_uid, resource_id, observed_at, loinc_codes)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::timestamptz, $6::text[])
     ON CONFLICT (tenant_id, resource_fingerprint) DO NOTHING`,
    [
      DEFAULT_TENANT_ID,
      FHIR_VITAL_SEED_RESOURCE_FINGERPRINT,
      ctx.patient.uid,
      FHIR_VITAL_SEED_RESOURCE_ID,
      FHIR_VITAL_SEED_OBSERVED_AT,
      ['8867-4'],
    ],
  );

  await client.query(
    `INSERT INTO fhir_vital_observation_sets
       (tenant_id, set_fingerprint, patient_uid, observed_at, imported_by,
        vitals_chart_id, news2_effects_completed_at, anomaly_effects_completed_at,
        news2_effects_attempts, anomaly_effects_attempts)
     VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, $5::uuid,
             $6, $4::timestamptz, $4::timestamptz, 1, 1)
     ON CONFLICT (tenant_id, set_fingerprint) DO NOTHING`,
    [
      DEFAULT_TENANT_ID,
      FHIR_VITAL_SEED_SET_FINGERPRINT,
      ctx.patient.uid,
      FHIR_VITAL_SEED_OBSERVED_AT,
      ctx.staff.uid,
      vitalsChartId,
    ],
  );

  await client.query(
    `INSERT INTO fhir_vital_observation_set_resources
       (tenant_id, set_fingerprint, resource_fingerprint)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (tenant_id, set_fingerprint, resource_fingerprint) DO NOTHING`,
    [
      DEFAULT_TENANT_ID,
      FHIR_VITAL_SEED_SET_FINGERPRINT,
      FHIR_VITAL_SEED_RESOURCE_FINGERPRINT,
    ],
  );
}

try {
  await client.query('BEGIN');
  await seedCoreData();
  await seedScheduledNotificationFixture();
  await seedInteropHl7v2MessageGraph();
  await seedIdentityProviderTables();
  await seedColdChainTables();
  await seedCarePathwayWorkflowGraph();
  await seedOpInpatientEvidenceGraph();
  await seedLabIngestCriticalAlertGraph();
  await seedCarePathwayReconciliationEvidence();
  await seedDiagnosticResultEvidence();
  await seedDiagnosticResultPatientNotificationEvidence();
  await seedNotificationDeliveryEvidence();
  await seedHl7OutboundDeliveryEvidence();
  await seedReferralClosedLoopGraph();
  const { seeded } = await seedRemainingTables();
  await seedPayrollAttemptGraph();
  await seedFhirVitalObservationReceiptGraph();
  await seedInteropHl7v2DeliveryReceipt();
  await seedEdClosureRecoveryEvidence();
  await seedInsuranceClaimCaps();
  await seedMedicationClosureEvidence();
  await seedLedgerEntries();
  await seedPillarDWorkflowTables();
  await seedRadiologyPeerReviews();
  await seedDonorIntakeTables();
  await seedBiomedCmmsTables();
  await seedMortuarySlots();
  await seedInfusionChairTables();
  await seedMigrationToolkitTables();
  await seedSiemExportTables();
  await seedIcuChartDepthTables();
  await seedPerfusionSignoffs();
  await seedTransplantProgramTables();
  await seedEdEncounterEvidence();
  await seedResuscitationTables();
  await seedNicuPicuChartTables();
  await seedMergedMainCoverageTables();
  await seedClinicalContinuityTables();
  const finalSweep = await seedRemainingTables();
  seeded.push(...finalSweep.seeded);
  const failed = finalSweep.failed;
  await assertNoActiveSyntheticWorkflowDefinitions();
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  const summary = await summarize(failed);
  assertComprehensiveSeedComplete(summary);
  await client.query('COMMIT');
  console.log(JSON.stringify({ ...summary, newlySeededTables: seeded.length }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
