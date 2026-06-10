// src/tests/analytics-warehouse.deep.test.js
//
// Roadmap F1 — locks the analytics publication contract (migration 295).
// The publication is the OLTP-side half of the warehouse: if its membership,
// column lists, or replica identities drift, the warehouse subscription
// either misses data or wedges (and a wedged subscription retains WAL on the
// primary). These tests make that drift a review-time failure.
//
// Read-only against catalog tables — no patient rows are touched, nothing
// is written, no cleanup. (clinical_audit_events stays append-only.)

import prisma from '../lib/prisma.js';

const PUB = 'vh_analytics_pub';

// Keep in lockstep with pub_tables in 295_analytics_publication.sql and the
// sources list in infra/kubernetes/optional/analytics-warehouse/dbt/models/sources.yml.
const EXPECTED_TABLES = [
  'admissions', 'appointments', 'emergency_visits', 'icu_admissions',
  'ot_schedules', 'bed_transfers', 'beds', 'wards', 'departments',
  'doctors', 'billing_invoices', 'billing_invoice_items',
  'billing_payments', 'payers', 'tpas', 'tpa_claims', 'insurance_claims',
  'insurance_policies', 'clinical_orders', 'pharmacy_orders',
  'investigations', 'users',
].sort();

// The users column list — identity/demographics/tenancy only.
const EXPECTED_USERS_COLUMNS = [
  'id', 'uid', 'role', 'gender', 'birthday', 'is_active', 'is_minor',
  'registered_at', 'tenant_id',
].sort();

// Columns that must NEVER replicate to the warehouse. If someone widens the
// users column list, this is the tripwire that makes them argue the case in
// review rather than discover it in an audit.
const FORBIDDEN_USERS_COLUMNS = [
  'name', 'phone', 'email', 'address', 'encrypted_password',
  'name_encrypted', 'phone_encrypted', 'address_encrypted',
  'phone_search_hash', 'e2e_public_key', 'abha_number', 'abha_address',
  'pan_number', 'device_token', 'guardian_name', 'guardian_phone',
  'emergency_contact', 'medical_history', 'firebase_uid',
];

describe('Analytics warehouse publication (roadmap F1)', () => {
  test('publication exists and publishes insert/update/delete/truncate', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT puballtables, pubinsert, pubupdate, pubdelete, pubtruncate
         FROM pg_publication WHERE pubname = $1`,
      PUB,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].puballtables).toBe(false); // curated, never FOR ALL TABLES
    expect(rows[0].pubinsert).toBe(true);
    expect(rows[0].pubupdate).toBe(true);
    expect(rows[0].pubdelete).toBe(true);
    expect(rows[0].pubtruncate).toBe(true);
  });

  test('membership matches the curated list exactly', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_publication_tables
        WHERE pubname = $1 AND schemaname = 'public'`,
      PUB,
    );
    const actual = rows.map((r) => r.tablename).sort();
    expect(actual).toEqual(EXPECTED_TABLES);
  });

  test('users replicates only the column-listed allow-list', async () => {
    // attnames is name[] — cast for the Prisma 7 driver adapter (same class
    // of issue as the 42P08 untyped-param rule in the execution log).
    const rows = await prisma.$queryRawUnsafe(
      `SELECT attnames::text[] AS attnames FROM pg_publication_tables
        WHERE pubname = $1 AND schemaname = 'public' AND tablename = 'users'`,
      PUB,
    );
    expect(rows).toHaveLength(1);
    const attnames = [...rows[0].attnames].sort();
    expect(attnames).toEqual(EXPECTED_USERS_COLUMNS);
    for (const forbidden of FORBIDDEN_USERS_COLUMNS) {
      expect(attnames).not.toContain(forbidden);
    }
  });

  test('every published table has a primary key (replica identity)', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT pt.tablename
         FROM pg_publication_tables pt
        WHERE pt.pubname = $1 AND pt.schemaname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
             WHERE i.indrelid = ('public.' || quote_ident(pt.tablename))::regclass
               AND i.indisprimary
          )`,
      PUB,
    );
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });

  test('no audit/credential/AI tables slipped into the publication', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_publication_tables
        WHERE pubname = $1
          AND (tablename LIKE 'clinical_audit%' OR tablename LIKE 'clinical_ai_%'
               OR tablename LIKE 'phi_%' OR tablename LIKE '%password%'
               OR tablename IN ('audit_logs', 'invalidated_tokens', 'payslips',
                                'payroll_runs', 'salary_advances'))`,
      PUB,
    );
    expect(rows).toEqual([]);
  });
});
