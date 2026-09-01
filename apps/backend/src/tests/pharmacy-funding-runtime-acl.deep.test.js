import { randomUUID } from 'node:crypto';

import prisma, { ensureTenantRlsRuntimeRoleGrants } from '../lib/prisma.js';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const runtimeRoles = ['vhhealth_app', 'vhhealth_runtime'];

const insertColumns = new Map([
  ['billing_advance_settlements', new Set([
    'advance_id',
    'invoice_id',
    'amount',
    'settled_by',
  ])],
  ['pharmacy_order_command_receipts', new Set([
    'tenant_id',
    'pharmacy_order_id',
    'action',
    'command_key_sha256',
    'request_sha256',
    'response_payload',
    'response_message',
  ])],
  ['pharmacy_funding_commands', new Set([
    'tenant_id',
    'command_key_sha256',
    'command_type',
    'task_id',
    'task_resource_type',
    'task_resource_id',
    'pharmacy_order_id',
    'facility_id',
    'invoice_id',
    'invoice_item_id',
    'tpa_claim_id',
    'approval_receipt_id',
    'consumption_receipt_id',
    'governance_approval_id',
    'proposal_sha256',
    'proposer_uid',
    'release_reason',
    'release_source_approval_id',
    'request_sha256',
    'created_by',
  ])],
  ['pharmacy_advance_allocations', new Set()],
  ['pharmacy_advance_allocation_reversals', new Set([
    'tenant_id',
    'allocation_id',
    'pharmacy_order_id',
    'invoice_id',
    'invoice_item_id',
    'billing_advance_id',
    'source_authority_version',
    'source_authority_sha256',
    'funding_task_id',
    'funding_approval_receipt_id',
    'allocation_evidence_sha256',
    'reversed_amount',
    'reversal_command_sha256',
    'reason',
    'billing_advance_settlement_id',
    'funding_settlement_receipt_id',
    'funding_release_receipt_id',
    'reversed_by',
    'evidence',
  ])],
  ['pharmacy_advance_allocation_consumptions', new Set([
    'tenant_id',
    'allocation_id',
    'pharmacy_order_id',
    'invoice_id',
    'invoice_item_id',
    'billing_advance_id',
    'source_authority_version',
    'source_authority_sha256',
    'funding_task_id',
    'funding_approval_receipt_id',
    'allocation_evidence_sha256',
    'funding_consumption_receipt_id',
    'consumption_command_sha256',
    'consumed_by',
    'evidence',
  ])],
]);

const runtimeInsertSequences = [
  'billing_advance_settlements_id_seq',
  'pharmacy_order_command_receipts_id_seq',
  'pharmacy_funding_commands_id_seq',
  'pharmacy_advance_allocation_reversals_id_seq',
  'pharmacy_advance_allocation_consumptions_id_seq',
];

const ownerOnlySequences = ['pharmacy_advance_allocations_id_seq'];

const tenantAuthoritySources = [
  'pharmacy_orders',
  'billing_invoices',
  'billing_invoice_items',
  'billing_payments',
  'billing_advances',
  'billing_refunds',
  'pharmacy_funding_decision_events',
  'tasks',
  'approvals',
  'users',
  'staff',
  'admissions',
  'pharmacy_staff_facility_grants',
  'tpa_claims',
  'tpa_claim_line_decisions',
  'e_prescriptions',
  'pharmacy_catalog',
  'pharmacy_inventory_items',
  'pharmacy_inventory_batches',
  'facilities',
  'billing_credit_notes',
  'billing_invoice_counter',
  'ledger_accounts',
  'ledger_entries',
  'ledger_postings',
  'ledger_balances',
  'doctors',
  'departments',
];

const bigintAuthoritySources = new Set([
  'pharmacy_staff_facility_grants',
  'billing_credit_notes',
  'pharmacy_funding_decision_events',
  'ledger_accounts',
  'ledger_entries',
  'ledger_postings',
  'ledger_balances',
]);

async function asRuntimeRole(role, sql, params = [], tenantContext) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    if (tenantContext !== undefined) {
      await client.query(
        "SELECT pg_catalog.set_config('app.current_tenant_id',$1,TRUE)",
        [tenantContext],
      );
    }
    const result = await client.query(sql, params);
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function asRuntimeRoleCommitted(role, sql, params, tenantContext) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(
      "SELECT pg_catalog.set_config('app.current_tenant_id',$1,TRUE)",
      [tenantContext],
    );
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function seedTenantAuthoritySources({
  tenantId,
  patientUid,
  probeId,
  suffix,
}) {
  const fixtureCode = `ACL-${suffix.slice(0, 16)}`;
  const inserts = [
    [
      `INSERT INTO public.users (id,uid,tenant_id,updated_at)
       VALUES ($1::integer,$2::uuid,$3::uuid,NOW())`,
      [probeId, patientUid, tenantId],
    ],
    [
      `INSERT INTO public.staff (id,user_id,tenant_id,updated_at)
       VALUES ($1::integer,$2::uuid,$3::uuid,NOW())`,
      [probeId, patientUid, tenantId],
    ],
    [
      `INSERT INTO public.facilities
         (id,tenant_id,facility_code,display_name)
       VALUES ($1::integer,$2::uuid,$3,'ACL probe')`,
      [probeId, tenantId, fixtureCode],
    ],
    [
      `INSERT INTO public.departments (id,tenant_id,name,updated_at)
       VALUES ($1::integer,$2::uuid,$3,NOW())`,
      [probeId, tenantId, fixtureCode],
    ],
    [
      `INSERT INTO public.doctors (id,tenant_id,department,updated_at)
       VALUES ($1::integer,$2::uuid,$3,NOW())`,
      [probeId, tenantId, fixtureCode],
    ],
    [
      `INSERT INTO public.admissions (id,tenant_id,patient_uid)
       VALUES ($1::integer,$2::uuid,$3::uuid)`,
      [probeId, tenantId, patientUid],
    ],
    [
      `INSERT INTO public.pharmacy_orders
         (id,tenant_id,phone,order_note,status,updated_at)
       VALUES ($1::integer,$2::uuid,$3,'ACL probe','CANCELLED',NOW())`,
      [probeId, tenantId, `7${suffix.slice(0, 9).replaceAll(/[^0-9]/gu, '0')}`],
    ],
    [
      `INSERT INTO public.e_prescriptions (id,tenant_id)
       VALUES ($1::integer,$2::uuid)`,
      [probeId, tenantId],
    ],
    [
      `INSERT INTO public.pharmacy_catalog (id,tenant_id,name)
       VALUES ($1::integer,$2::uuid,'ACL probe')`,
      [probeId, tenantId],
    ],
    [
      `INSERT INTO public.pharmacy_inventory_items
         (id,tenant_id,sku_code,display_name,status)
       VALUES ($1::integer,$2::uuid,$3,'ACL probe','inactive')`,
      [probeId, tenantId, fixtureCode],
    ],
    [
      `INSERT INTO public.pharmacy_inventory_batches
         (id,tenant_id,inventory_item_id,batch_number,expiry_date,
          received_quantity,remaining_quantity,status)
       VALUES ($1::integer,$2::uuid,$1::integer,$3,'2000-01-01',1,1,'expired')`,
      [probeId, tenantId, fixtureCode],
    ],
    [
      `INSERT INTO public.billing_invoices (id,tenant_id,patient_uid)
       VALUES ($1::integer,$2::uuid,$3::uuid)`,
      [probeId, tenantId, patientUid],
    ],
    [
      `INSERT INTO public.billing_invoice_items
         (id,tenant_id,invoice_id,description,unit_price,line_subtotal,line_total)
       VALUES ($1::integer,$2::uuid,$1::integer,'ACL probe',1,1,1)`,
      [probeId, tenantId],
    ],
    [
      `INSERT INTO public.billing_payments
         (id,tenant_id,patient_uid,amount,mode)
       VALUES ($1::integer,$2::uuid,$3::uuid,1,'CASH')`,
      [probeId, tenantId, patientUid],
    ],
    [
      `INSERT INTO public.billing_advances
         (id,tenant_id,patient_uid,amount,balance,mode)
       VALUES ($1::integer,$2::uuid,$3::uuid,1,1,'CASH')`,
      [probeId, tenantId, patientUid],
    ],
    [
      `INSERT INTO public.billing_refunds
         (id,tenant_id,patient_uid,amount,reason,mode,invoice_id)
       VALUES ($1::integer,$2::uuid,$3::uuid,1,'ACL probe','CASH',
               $1::integer)`,
      [probeId, tenantId, patientUid],
    ],
    [
      `INSERT INTO public.tpa_claims
         (id,tenant_id,claim_number,policy_id,patient_uid,
          total_billed,claimed_amount)
       VALUES ($1::integer,$2::uuid,$3,$1::integer,$4::uuid,1,1)`,
      [probeId, tenantId, fixtureCode, patientUid],
    ],
    [
      `INSERT INTO public.tpa_claim_line_decisions
         (id,tenant_id,claim_id,invoice_item_id,reason_code)
       VALUES ($1::integer,$2::uuid,$1::integer,$1::integer,'other')`,
      [probeId, tenantId],
    ],
    [
      `INSERT INTO public.pharmacy_funding_decision_events
         (id,tenant_id,facility_id,pharmacy_order_id,event_type,
          source_authority_version,source_authority_sha256,invoice_id,
          invoice_item_id,command_key_sha256,recorded_by)
       VALUES ($1::bigint,$2::uuid,$3::integer,$3::integer,
               'LINE_MATERIALIZED',1,$4,$3::integer,$3::integer,$4,$5::uuid)`,
      [probeId, tenantId, probeId, '0'.repeat(64), patientUid],
    ],
    [
      `INSERT INTO public.tasks (id,tenant_id,title)
       VALUES ($1::integer,$2::uuid,'ACL probe')`,
      [probeId, tenantId],
    ],
    [
      `INSERT INTO public.approvals (id,tenant_id,approval_kind)
       VALUES ($1::integer,$2::uuid,'acl_probe')`,
      [probeId, tenantId],
    ],
    [
      `INSERT INTO public.pharmacy_staff_facility_grants
         (id,tenant_id,facility_id,staff_uid,grant_source,
          grant_reason,granted_by)
       VALUES ($1::bigint,$2::uuid,$3::integer,$4::uuid,
               'acl_probe','ACL probe evidence',$4::uuid)`,
      [probeId, tenantId, probeId, patientUid],
    ],
    [
      `INSERT INTO public.billing_credit_notes
         (id,tenant_id,credit_note_number,invoice_id,patient_uid,
          source_financial_event_id,amount_minor,reason,raised_by)
       VALUES ($1::bigint,$2::uuid,$3,$4::integer,$5::uuid,
               $1::bigint,1,'ACL probe',$5::uuid)`,
      [probeId, tenantId, fixtureCode, probeId, patientUid],
    ],
    [
      `INSERT INTO public.billing_invoice_counter
         (tenant_id,fiscal_year,next_value)
       VALUES ($1::uuid,$2::integer,1)`,
      [tenantId, probeId],
    ],
    [
      `INSERT INTO public.ledger_accounts (id,tenant_id,code,type)
       VALUES ($1::bigint,$2::uuid,$3,'ASSET')`,
      [probeId, tenantId, fixtureCode],
    ],
    [
      `INSERT INTO public.ledger_entries (id,tenant_id,entry_type)
       VALUES ($1::bigint,$2::uuid,'acl_probe')`,
      [probeId, tenantId],
    ],
    [
      `INSERT INTO public.ledger_postings
         (id,tenant_id,entry_id,account_id,amount_paise)
       VALUES ($1::bigint,$2::uuid,$1::bigint,$1::bigint,1)`,
      [probeId, tenantId],
    ],
    [
      `INSERT INTO public.ledger_balances (id,tenant_id,account_id)
       VALUES ($1::bigint,$2::uuid,$1::bigint)`,
      [probeId, tenantId],
    ],
  ];

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_catalog.set_config('app.current_tenant_id',$1,TRUE)",
      tenantId,
    );
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
    for (const [sql, params] of inserts) {
      await tx.$executeRawUnsafe(sql, ...params);
    }
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='origin'");
  });
}

async function deleteTenantAuthoritySources({ tenantId, probeId }) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "SELECT pg_catalog.set_config('app.current_tenant_id',$1,TRUE)",
      tenantId,
    );
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
    for (const table of [...tenantAuthoritySources].reverse()) {
      if (table === 'billing_invoice_counter') {
        await tx.$executeRawUnsafe(
          `DELETE FROM public.billing_invoice_counter
            WHERE tenant_id=$1::uuid AND fiscal_year=$2::integer`,
          tenantId,
          probeId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `DELETE FROM public.${table} WHERE id=$1::bigint`,
          probeId,
        );
      }
    }
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='origin'");
  });
}

describeIfDb('migration-753 runtime ACL bootstrap', () => {
  let previousRuntimeRole;

  beforeAll(async () => {
    previousRuntimeRole = process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    for (const role of runtimeRoles) {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = role;
      const result = await ensureTenantRlsRuntimeRoleGrants();
      expect(result).toEqual({ skipped: false, role });
    }
  });

  afterAll(async () => {
    if (previousRuntimeRole === undefined) {
      delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    } else {
      process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = previousRuntimeRole;
    }
    await prisma.$disconnect().catch(() => {});
  });

  test.each(runtimeRoles)('%s has exact table and column privileges', async (role) => {
    for (const [table, allowedInsertColumns] of insertColumns) {
      const tablePrivilege = await prisma.$queryRawUnsafe(
        `SELECT has_table_privilege($1::name,$2::text,'SELECT') AS can_select,
                has_table_privilege($1::name,$2::text,'INSERT') AS table_insert,
                has_table_privilege($1::name,$2::text,'UPDATE') AS table_update,
                has_table_privilege($1::name,$2::text,'DELETE') AS can_delete,
                has_table_privilege($1::name,$2::text,'TRUNCATE') AS can_truncate`,
        role,
        `public.${table}`,
      );
      expect(tablePrivilege[0]).toEqual({
        can_select: true,
        table_insert: false,
        table_update: false,
        can_delete: false,
        can_truncate: false,
      });

      const columns = await prisma.$queryRawUnsafe(
        `SELECT attribute.attname AS column_name,
                has_column_privilege(
                  $1::name,$2::text,attribute.attname,'INSERT'
                ) AS can_insert,
                has_column_privilege(
                  $1::name,$2::text,attribute.attname,'UPDATE'
                ) AS can_update
           FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid=$2::regclass
            AND attribute.attnum>0
            AND NOT attribute.attisdropped
          ORDER BY attribute.attnum`,
        role,
        `public.${table}`,
      );
      expect(columns).not.toHaveLength(0);
      for (const column of columns) {
        expect(column.can_insert).toBe(allowedInsertColumns.has(column.column_name));
        expect(column.can_update).toBe(false);
      }
      // Compare as a SET. ALTER TABLE ... ADD COLUMN appends, so a column the
      // lane declared inline inside 753 now lands at the end of the table when
      // the remainder arrives forward-only in 758. Physical column order is not
      // a schema invariant and nothing may depend on it; the allowlist is about
      // WHICH columns are insertable, not the order the catalog stores them in.
      expect(columns.filter((column) => column.can_insert).map((column) => column.column_name).sort())
        .toEqual([...allowedInsertColumns].sort());
    }
  });

  test('PUBLIC has no protected relation, column, sequence, or function privileges', async () => {
    const privileges = await prisma.$queryRawUnsafe(
      `SELECT relation.relname AS object_name,
              privilege.privilege_type
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid=relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault(
              CASE relation.relkind
                WHEN 'S' THEN 'S'::"char"
                ELSE 'r'::"char"
              END,
              relation.relowner
            )
          )
        ) privilege
        WHERE namespace.nspname='public'
          AND privilege.grantee=0
          AND (
            pg_catalog.left(relation.relname,17)='pharmacy_advance_'
            OR relation.relname IN (
              'billing_advance_settlements',
              'billing_advance_settlements_id_seq',
              'pharmacy_order_command_receipts',
              'pharmacy_funding_commands',
              'pharmacy_order_command_receipts_id_seq',
              'pharmacy_funding_commands_id_seq'
            )
          )
        UNION ALL
       SELECT relation.relname || '.' || attribute.attname AS object_name,
              privilege.privilege_type
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid=relation.relnamespace
         JOIN pg_catalog.pg_attribute attribute
           ON attribute.attrelid=relation.oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          CASE
            WHEN pg_catalog.cardinality(attribute.attacl)>0
              THEN attribute.attacl
            ELSE NULL::aclitem[]
          END
        ) privilege
        WHERE namespace.nspname='public'
          AND relation.relkind IN ('r','p')
          AND attribute.attnum>0
          AND NOT attribute.attisdropped
          AND privilege.grantee=0
          AND (
            pg_catalog.left(relation.relname,17)='pharmacy_advance_'
            OR relation.relname IN (
              'billing_advance_settlements',
              'pharmacy_order_command_receipts',
              'pharmacy_funding_commands'
            )
          )
        UNION ALL
       SELECT routine.oid::pg_catalog.regprocedure::text AS object_name,
              privilege.privilege_type
         FROM pg_catalog.pg_proc routine
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid=routine.pronamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f'::"char",routine.proowner)
          )
        ) privilege
        WHERE namespace.nspname='public'
          AND routine.prokind='f'
          AND routine.prosecdef
          AND pg_catalog.right(routine.proname,4)='_753'
          AND privilege.grantee=0`,
    );
    expect(privileges).toEqual([]);
  });

  test('reconciliation removes stale column-level SELECT grants', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const table = `pharmacy_advance_stale_acl_probe_${suffix}`;
    const qualifiedTable = `public.${table}`;
    try {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE public.${table} (tenant_id UUID NOT NULL)`,
      );
      await prisma.$executeRawUnsafe(
        `GRANT SELECT (tenant_id) ON TABLE public.${table}
         TO PUBLIC,vhhealth_app,vhhealth_runtime`,
      );
      for (const role of runtimeRoles) {
        const seeded = await prisma.$queryRawUnsafe(
          `SELECT has_column_privilege(
                    $1::name,$2::text,'tenant_id','SELECT'
                  ) AS can_select`,
          role,
          qualifiedTable,
        );
        expect(seeded).toEqual([{ can_select: true }]);
      }

      const result = await ensureTenantRlsRuntimeRoleGrants();
      expect(result).toEqual({
        skipped: false,
        role: process.env.AUTH_TENANT_RLS_RUNTIME_ROLE,
      });

      for (const role of runtimeRoles) {
        const privileges = await prisma.$queryRawUnsafe(
          `SELECT has_table_privilege($1::name,$2::text,'SELECT') AS table_select,
                  has_column_privilege(
                    $1::name,$2::text,'tenant_id','SELECT'
                  ) AS column_select`,
          role,
          qualifiedTable,
        );
        expect(privileges).toEqual([{
          table_select: false,
          column_select: false,
        }]);
        await expect(asRuntimeRole(
          role,
          `SELECT tenant_id FROM public.${table}`,
        )).rejects.toMatchObject({ code: '42501' });
      }

      const publicPrivileges = await prisma.$queryRawUnsafe(
        `SELECT privilege.privilege_type
           FROM pg_catalog.pg_attribute attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            CASE
              WHEN pg_catalog.cardinality(attribute.attacl)>0
                THEN attribute.attacl
              ELSE NULL::aclitem[]
            END
          ) privilege
          WHERE attribute.attrelid=$1::regclass
            AND attribute.attname='tenant_id'
            AND privilege.grantee=0`,
        qualifiedTable,
      );
      expect(publicPrivileges).toEqual([]);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TABLE IF EXISTS public.${table}`,
      );
    }
  });

  test('future objects inherit no runtime or PUBLIC authority before reconciliation', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const table = `pharmacy_advance_acl_probe_${suffix}`;
    const qualifiedTable = `public.${table}`;
    const functionName = `pharmacy_advance_acl_probe_${suffix}_753`;
    const functionSignature = `public.${functionName}()`;
    let sequence;
    try {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE public.${table} (
           id BIGSERIAL PRIMARY KEY,
           tenant_id UUID NOT NULL
         )`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION public.${functionName}()
         RETURNS INTEGER
         LANGUAGE sql
         SECURITY DEFINER
         SET search_path = pg_catalog, pg_temp
         SET row_security = off
         AS $function$ SELECT 1 $function$`,
      );
      const sequenceRows = await prisma.$queryRawUnsafe(
        'SELECT pg_catalog.pg_get_serial_sequence($1,$2) AS sequence_name',
        qualifiedTable,
        'id',
      );
      sequence = sequenceRows[0].sequence_name;
      expect(sequence).toEqual(expect.any(String));

      const owners = await prisma.$queryRawUnsafe(
        `SELECT current_user AS object_creator,
                table_owner.rolname AS table_owner,
                function_owner.rolname AS function_owner
           FROM pg_catalog.pg_class relation
           JOIN pg_catalog.pg_roles table_owner
             ON table_owner.oid=relation.relowner
           JOIN pg_catalog.pg_proc routine
             ON routine.oid=pg_catalog.to_regprocedure($2::text)
           JOIN pg_catalog.pg_roles function_owner
             ON function_owner.oid=routine.proowner
          WHERE relation.oid=$1::regclass`,
        qualifiedTable,
        functionSignature,
      );
      expect(owners).toHaveLength(1);
      expect(owners[0]).toEqual({
        object_creator: owners[0].object_creator,
        table_owner: owners[0].object_creator,
        function_owner: owners[0].object_creator,
      });
      expect(runtimeRoles).not.toContain(owners[0].object_creator);

      const leakedDefaults = await prisma.$queryRawUnsafe(
        // defaclobjtype is Postgres's internal one-byte "char"; the driver
        // cannot deserialize it, so the query threw before asserting anything.
        `SELECT defaults.defaclobjtype::text AS object_type,
                COALESCE(grantee.rolname,'PUBLIC') AS grantee,
                privilege.privilege_type
           FROM pg_catalog.pg_default_acl defaults
           LEFT JOIN pg_catalog.pg_namespace namespace
             ON namespace.oid=defaults.defaclnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) privilege
           LEFT JOIN pg_catalog.pg_roles grantee
             ON grantee.oid=privilege.grantee
          WHERE defaults.defaclrole=(SELECT oid FROM pg_catalog.pg_roles
                                      WHERE rolname=current_user)
            AND (
              defaults.defaclnamespace=0
              OR namespace.nspname='public'
            )
            AND defaults.defaclobjtype IN ('r','S','f')
            AND (
              privilege.grantee=0
              OR grantee.rolname=ANY($1::text[])
            )
          ORDER BY object_type,grantee,privilege.privilege_type`,
        runtimeRoles,
      );
      expect(leakedDefaults).toEqual([]);

      for (const role of runtimeRoles) {
        const privileges = await prisma.$queryRawUnsafe(
          `SELECT has_table_privilege($1::name,$2::text,'SELECT') AS table_select,
                  has_table_privilege($1::name,$2::text,'INSERT') AS table_insert,
                  has_table_privilege($1::name,$2::text,'UPDATE') AS table_update,
                  has_table_privilege($1::name,$2::text,'DELETE') AS table_delete,
                  has_table_privilege($1::name,$2::text,'TRUNCATE') AS table_truncate,
                  has_sequence_privilege($1::name,$3::text,'USAGE') AS sequence_usage,
                  has_sequence_privilege($1::name,$3::text,'SELECT') AS sequence_select,
                  has_sequence_privilege($1::name,$3::text,'UPDATE') AS sequence_update,
                  has_function_privilege(
                    $1::name,pg_catalog.to_regprocedure($4::text),'EXECUTE'
                  ) AS function_execute`,
          role,
          qualifiedTable,
          sequence,
          functionSignature,
        );
        expect(privileges[0]).toEqual({
          table_select: false,
          table_insert: false,
          table_update: false,
          table_delete: false,
          table_truncate: false,
          sequence_usage: false,
          sequence_select: false,
          sequence_update: false,
          function_execute: false,
        });
        for (const [statement, params] of [
          [`SELECT * FROM public.${table}`, []],
          [
            `INSERT INTO public.${table} (tenant_id)
             VALUES ('00000000-0000-4000-8000-000000000001'::uuid)`,
            [],
          ],
          ['SELECT pg_catalog.nextval($1::regclass)', [sequence]],
          [`SELECT public.${functionName}()`, []],
        ]) {
          await expect(asRuntimeRole(role, statement, params))
            .rejects.toMatchObject({ code: '42501' });
        }
      }

      const publicPrivilege = await prisma.$queryRawUnsafe(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc routine
            CROSS JOIN LATERAL pg_catalog.aclexplode(
              COALESCE(
                routine.proacl,
                pg_catalog.acldefault('f'::"char",routine.proowner)
              )
            ) privilege
            WHERE routine.oid=pg_catalog.to_regprocedure($1::text)
              AND privilege.grantee=0
              AND privilege.privilege_type='EXECUTE'
         ) AS can_execute`,
        functionSignature,
      );
      expect(publicPrivilege).toEqual([{ can_execute: false }]);

      const publicRelationPrivileges = await prisma.$queryRawUnsafe(
        `SELECT relation.relname AS object_name,privilege.privilege_type
           FROM pg_catalog.pg_class relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(
              relation.relacl,
              pg_catalog.acldefault(
                CASE relation.relkind
                  WHEN 'S' THEN 'S'::"char"
                  ELSE 'r'::"char"
                END,
                relation.relowner
              )
            )
          ) privilege
          WHERE relation.oid=ANY(ARRAY[$1::regclass,$2::regclass]::oid[])
            AND privilege.grantee=0`,
        qualifiedTable,
        sequence,
      );
      expect(publicRelationPrivileges).toEqual([]);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS public.${functionName}()`,
      );
      await prisma.$executeRawUnsafe(
        `DROP TABLE IF EXISTS public.${table} CASCADE`,
      );
    }
  });

  test('runtime roles have their exact unprivileged posture', async () => {
    const roles = await prisma.$queryRawUnsafe(
      `SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,
              rolcreaterole,rolreplication,rolinherit
         FROM pg_catalog.pg_roles
        WHERE rolname=ANY($1::text[])
        ORDER BY rolname`,
      runtimeRoles,
    );
    expect(roles).toEqual([
      {
        rolname: 'vhhealth_app',
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolinherit: true,
      },
      {
        rolname: 'vhhealth_runtime',
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolinherit: true,
      },
    ]);
  });

  test('runtime roles cannot use or SET ROLE to privileged or object-owner authority', async () => {
    const assumable = await prisma.$queryRawUnsafe(
      `SELECT runtime.rolname AS runtime_role,
              candidate.rolname AS assumable_role
         FROM pg_catalog.pg_roles runtime
        CROSS JOIN pg_catalog.pg_roles candidate
        WHERE runtime.rolname=ANY($1::text[])
          AND candidate.oid<>runtime.oid
          AND (
            pg_catalog.pg_has_role(runtime.oid,candidate.oid,'MEMBER')
            OR pg_catalog.pg_has_role(runtime.oid,candidate.oid,'USAGE')
            OR pg_catalog.pg_has_role(runtime.oid,candidate.oid,'SET')
          )
          AND (
            candidate.rolsuper
            OR candidate.rolbypassrls
            OR candidate.rolcreatedb
            OR candidate.rolcreaterole
            OR candidate.rolreplication
            OR candidate.oid=(
              SELECT database.datdba
                FROM pg_catalog.pg_database database
               WHERE database.datname=pg_catalog.current_database()
            )
            OR EXISTS (
              SELECT 1
                FROM pg_catalog.pg_namespace namespace
               WHERE namespace.nspname='public'
                 AND namespace.nspowner=candidate.oid
            )
            OR EXISTS (
              SELECT 1
                FROM pg_catalog.pg_class relation
                JOIN pg_catalog.pg_namespace namespace
                  ON namespace.oid=relation.relnamespace
               WHERE namespace.nspname='public'
                 AND relation.relowner=candidate.oid
            )
            OR EXISTS (
              SELECT 1
                FROM pg_catalog.pg_proc routine
                JOIN pg_catalog.pg_namespace namespace
                  ON namespace.oid=routine.pronamespace
               WHERE namespace.nspname='public'
                 AND routine.proowner=candidate.oid
            )
          )
        ORDER BY runtime.rolname,candidate.rolname`,
      runtimeRoles,
    );
    expect(assumable).toEqual([]);
  });

  test('legacy advance settlements retain only their governed create path', async () => {
    const tenantId = randomUUID();
    const wrongTenantId = randomUUID();
    const patientUid = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    const phone = `7${String(Date.now()).slice(-9)}${suffix.replace(/\D/gu, '').padEnd(5, '0').slice(0, 5)}`;
    let advanceId;
    let invoiceId;
    const settlementIds = [];
    try {
      const parents = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
        await tx.$executeRawUnsafe(
          `INSERT INTO public.tenants (id,slug,name)
           VALUES ($1::uuid,$2,$3),($4::uuid,$5,$6)`,
          tenantId,
          `acl753-${suffix.slice(0, 12)}`,
          'ACL 753 settlement tenant',
          wrongTenantId,
          `acl753-wrong-${suffix.slice(0, 12)}`,
          'ACL 753 wrong tenant',
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO public.users
             (uid,phone,name,role,is_active,tenant_id,updated_at)
           VALUES ($1::uuid,$2,'ACL 753 patient','PATIENT',TRUE,$3::uuid,NOW())`,
          patientUid,
          phone,
          tenantId,
        );
        const invoices = await tx.$queryRawUnsafe(
          `INSERT INTO public.billing_invoices
             (patient_uid,invoice_type,status,subtotal,total_amount,
              amount_paid,amount_due,tenant_id)
           VALUES ($1::uuid,'OP','ISSUED',10,10,0,10,$2::uuid)
           RETURNING id`,
          patientUid,
          tenantId,
        );
        const advances = await tx.$queryRawUnsafe(
          `INSERT INTO public.billing_advances
             (patient_uid,amount,balance,mode,status,tenant_id,collected_at)
           VALUES ($1::uuid,10,10,'CASH','ACTIVE',$2::uuid,NOW())
           RETURNING id`,
          patientUid,
          tenantId,
        );
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role='origin'");
        return {
          advanceId: Number(advances[0].id),
          invoiceId: Number(invoices[0].id),
        };
      });
      advanceId = parents.advanceId;
      invoiceId = parents.invoiceId;

      for (const role of runtimeRoles) {
        const inserted = await asRuntimeRoleCommitted(
          role,
          `INSERT INTO public.billing_advance_settlements
             (advance_id,invoice_id,amount,settled_by)
           VALUES ($1::integer,$2::integer,1,$3::uuid)
           RETURNING id,tenant_id::text`,
          [advanceId, invoiceId, patientUid],
          tenantId,
        );
        expect(inserted.rows).toHaveLength(1);
        expect(inserted.rows[0].tenant_id).toBe(tenantId);
        settlementIds.push(Number(inserted.rows[0].id));

        await expect(asRuntimeRole(
          role,
          `INSERT INTO public.billing_advance_settlements
             (advance_id,invoice_id,amount,settled_by)
           VALUES ($1::integer,$2::integer,1,$3::uuid)`,
          [advanceId, invoiceId, patientUid],
          wrongTenantId,
        )).rejects.toMatchObject({ code: '23503' });
        await expect(asRuntimeRole(
          role,
          `INSERT INTO public.billing_advance_settlements
             (tenant_id,advance_id,invoice_id,amount,settled_by)
           VALUES ($1::uuid,$2::integer,$3::integer,1,$4::uuid)`,
          [wrongTenantId, advanceId, invoiceId, patientUid],
          tenantId,
        )).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
        if (settlementIds.length > 0) {
          await tx.$executeRawUnsafe(
            `DELETE FROM public.billing_advance_settlements
              WHERE id=ANY($1::integer[])`,
            settlementIds,
          );
        }
        if (advanceId !== undefined) {
          await tx.$executeRawUnsafe(
            'DELETE FROM public.billing_advances WHERE id=$1::integer',
            advanceId,
          );
        }
        if (invoiceId !== undefined) {
          await tx.$executeRawUnsafe(
            'DELETE FROM public.billing_invoices WHERE id=$1::integer',
            invoiceId,
          );
        }
        await tx.$executeRawUnsafe(
          'DELETE FROM public.users WHERE uid=$1::uuid',
          patientUid,
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM public.tenants WHERE id IN ($1::uuid,$2::uuid)',
          tenantId,
          wrongTenantId,
        );
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role='origin'");
      });
    }
  });

  test('every funding authority source enforces its tenant boundary', async () => {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const wrongTenantId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    const probeId = -(Number.parseInt(suffix.slice(0, 7), 16) + 1);
    const crossTenantProbeId = probeId - 1;
    let seeded = false;
    try {
      await seedTenantAuthoritySources({
        tenantId,
        patientUid,
        probeId,
        suffix,
      });
      seeded = true;

      for (const role of runtimeRoles) {
        for (const table of tenantAuthoritySources) {
          const keyColumn = table === 'billing_invoice_counter'
            ? 'fiscal_year'
            : 'id';
          const keyCast = bigintAuthoritySources.has(table)
            ? 'bigint'
            : 'integer';
          const qualifiedTable = `public.${table}`;
          const policyStatus = await asRuntimeRole(
            role,
            `SELECT pg_catalog.row_security_active($1::regclass) AS active`,
            [qualifiedTable],
            tenantId,
          );
          expect(policyStatus.rows).toEqual([{ active: true }]);

          const privileges = await prisma.$queryRawUnsafe(
            `SELECT has_column_privilege(
                      $1::name,$2::text,'tenant_id','UPDATE'
                    ) AS can_update_tenant,
                    has_column_privilege(
                      $1::name,$2::text,$3::name,'INSERT'
                    ) AS can_insert_key,
                    has_column_privilege(
                      $1::name,$2::text,'tenant_id','INSERT'
                    ) AS can_insert_tenant`,
            role,
            qualifiedTable,
            keyColumn,
          );
          expect(privileges).toHaveLength(1);

          const selectStatement = `SELECT COUNT(*)::integer AS visible_count
             FROM public.${table}
            WHERE ${keyColumn}=$1::${keyCast}`;
          for (const context of [undefined, '', 'bypass', wrongTenantId]) {
            const hidden = await asRuntimeRole(
              role,
              selectStatement,
              [probeId],
              context,
            );
            expect(hidden.rows).toEqual([{ visible_count: 0 }]);

            const updateStatement = `UPDATE public.${table}
               SET tenant_id=tenant_id
             WHERE ${keyColumn}=$1::${keyCast}
             RETURNING ${keyColumn}`;
            if (privileges[0].can_update_tenant) {
              const update = await asRuntimeRole(
                role,
                updateStatement,
                [probeId],
                context,
              );
              expect(update.rows).toEqual([]);
            } else {
              await expect(asRuntimeRole(
                role,
                updateStatement,
                [probeId],
                context,
              )).rejects.toMatchObject({ code: '42501' });
            }
          }

          const visible = await asRuntimeRole(
            role,
            selectStatement,
            [probeId],
            tenantId,
          );
          expect(visible.rows).toEqual([{ visible_count: 1 }]);

          const crossTenantInsert = table === 'billing_invoice_counter'
            ? `INSERT INTO public.billing_invoice_counter
                 (tenant_id,fiscal_year)
               VALUES ($1::uuid,$2::integer)`
            : `INSERT INTO public.${table} (${keyColumn},tenant_id)
               VALUES ($2::${keyCast},$1::uuid)`;
          let crossTenantError;
          try {
            await asRuntimeRole(
              role,
              crossTenantInsert,
              [wrongTenantId, crossTenantProbeId],
              tenantId,
            );
          } catch (error) {
            crossTenantError = error;
          }
          // Two independent properties, asserted separately.
          //
          // (a) The write was REFUSED. Which governed mechanism refuses it is
          //     not the point and is not stable: the privilege layer answers
          //     42501, while the lane's governed CHECK constraints answer 23514
          //     because they fire first. Pinning one code reads a mechanism
          //     change as a regression.
          expect(crossTenantError).toBeDefined();
          expect(['42501', '23514']).toContain(crossTenantError.code);

          // (b) The structural guarantee that makes a cross-tenant write
          //     impossible in the first place. Accepting either code above
          //     would, on its own, be weaker than what this test used to
          //     assert — a real privilege leak could hide behind a constraint
          //     that happened to catch the row first. So prove the posture
          //     directly: row level security must be ENABLED and FORCED, the
          //     latter being what stops object ownership from bypassing the
          //     tenant policy. The original assertion never checked this.
          const rlsPosture = await prisma.$queryRawUnsafe(
            `SELECT relation.relrowsecurity AS enabled,
                    relation.relforcerowsecurity AS forced
               FROM pg_catalog.pg_class relation
               JOIN pg_catalog.pg_namespace namespace
                 ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'public'
                AND relation.relname = $1`,
            table,
          );
          expect(rlsPosture[0]).toMatchObject({ enabled: true, forced: true });
        }
      }
    } finally {
      if (seeded) {
        await deleteTenantAuthoritySources({
          tenantId,
          probeId,
        });
      }
    }
  });

  test.each(runtimeRoles)('%s can use but cannot set protected sequences', async (role) => {
    for (const sequence of runtimeInsertSequences) {
      const privileges = await prisma.$queryRawUnsafe(
        `SELECT has_sequence_privilege($1::name,$2::text,'USAGE') AS can_use,
                has_sequence_privilege($1::name,$2::text,'SELECT') AS can_select,
                has_sequence_privilege($1::name,$2::text,'UPDATE') AS can_update`,
        role,
        `public.${sequence}`,
      );
      expect(privileges[0]).toEqual({
        can_use: true,
        can_select: true,
        can_update: false,
      });
    }
    for (const sequence of ownerOnlySequences) {
      const privileges = await prisma.$queryRawUnsafe(
        `SELECT has_sequence_privilege($1::name,$2::text,'USAGE') AS can_use,
                has_sequence_privilege($1::name,$2::text,'SELECT') AS can_select,
                has_sequence_privilege($1::name,$2::text,'UPDATE') AS can_update`,
        role,
        `public.${sequence}`,
      );
      expect(privileges[0]).toEqual({
        can_use: false,
        can_select: false,
        can_update: false,
      });
      await expect(
        asRuntimeRole(role, 'SELECT pg_catalog.nextval($1::regclass)', [
          `public.${sequence}`,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  test.each(runtimeRoles)('%s is denied direct command mutation and setval', async (role) => {
    const deniedStatements = [
      `UPDATE public.pharmacy_funding_commands
          SET status=status
        WHERE FALSE`,
      `DELETE FROM public.pharmacy_funding_commands WHERE FALSE`,
      'TRUNCATE TABLE public.pharmacy_funding_commands',
      `UPDATE public.billing_advance_settlements
          SET amount=amount
        WHERE FALSE`,
      'DELETE FROM public.billing_advance_settlements WHERE FALSE',
      'TRUNCATE TABLE public.billing_advance_settlements',
      `INSERT INTO public.pharmacy_advance_allocations (allocated_at)
       VALUES (transaction_timestamp())`,
      `SELECT setval('public.pharmacy_advance_allocations_id_seq',1,FALSE)`,
      `SELECT setval('public.billing_advance_settlements_id_seq',1,FALSE)`,
      'SELECT public.resolve_billing_patient_terminal_753(NULL::uuid,NULL::uuid)',
    ];
    for (const statement of deniedStatements) {
      await expect(asRuntimeRole(role, statement)).rejects.toMatchObject({ code: '42501' });
    }
  });

  test.each(runtimeRoles)(
    '%s can execute only frozen governed migration-753 SECURITY DEFINER wrappers',
    async (role) => {
      const functions = await prisma.$queryRawUnsafe(
        `SELECT routine.proname,
                pg_catalog.pg_get_function_identity_arguments(routine.oid) AS arguments,
                routine.oid=ANY(ARRAY[
                  pg_catalog.to_regprocedure(
                    'public.complete_pharmacy_funding_command_753(uuid,bigint,uuid,jsonb)'
                  ),
                  pg_catalog.to_regprocedure(
                    'public.reserve_pharmacy_advance_allocations_753(uuid,bigint,uuid)'
                  )
                ]::oid[]) AS is_governed_wrapper,
                has_function_privilege($1::name,routine.oid,'EXECUTE') AS can_execute
           FROM pg_catalog.pg_proc routine
           JOIN pg_catalog.pg_namespace namespace
             ON namespace.oid=routine.pronamespace
          WHERE namespace.nspname='public'
            AND routine.prokind='f'
            AND routine.prosecdef
            AND pg_catalog.right(routine.proname,4)='_753'
          ORDER BY routine.proname,arguments`,
        role,
      );
      expect(functions).not.toHaveLength(0);
      for (const routine of functions) {
        expect(routine.can_execute).toBe(routine.is_governed_wrapper);
      }
      expect(functions.filter((routine) => routine.can_execute).map((routine) => routine.proname))
        .toEqual([
          'complete_pharmacy_funding_command_753',
          'reserve_pharmacy_advance_allocations_753',
        ]);
    },
  );

  test('governed wrappers pin execution context and cannot elevate runtime roles', async () => {
    const safety = await prisma.$queryRawUnsafe(
      `SELECT routine.proname,
              owner.rolname AS owner_name,
              runtime.rolname AS runtime_role,
              routine.prosecdef AS security_definer,
              COALESCE(routine.proconfig,'{}'::text[]) @>
                ARRAY['search_path=public, pg_temp','row_security=off']::text[]
                AS context_pinned,
              NOT (
                pg_catalog.pg_has_role(runtime.oid,owner.oid,'MEMBER')
                OR pg_catalog.pg_has_role(runtime.oid,owner.oid,'USAGE')
                OR pg_catalog.pg_has_role(runtime.oid,owner.oid,'SET')
              )
                AS owner_not_assumable
         FROM pg_catalog.pg_proc routine
         JOIN pg_catalog.pg_roles owner
           ON owner.oid=routine.proowner
        CROSS JOIN pg_catalog.pg_roles runtime
        WHERE runtime.rolname=ANY($1::text[])
          AND routine.oid=ANY(ARRAY[
            pg_catalog.to_regprocedure(
              'public.complete_pharmacy_funding_command_753(uuid,bigint,uuid,jsonb)'
            ),
            pg_catalog.to_regprocedure(
              'public.reserve_pharmacy_advance_allocations_753(uuid,bigint,uuid)'
            )
          ]::oid[])
        ORDER BY routine.proname,runtime.rolname`,
      runtimeRoles,
    );
    expect(safety).toHaveLength(4);
    for (const row of safety) {
      expect(runtimeRoles).toContain(row.runtime_role);
      expect(runtimeRoles).not.toContain(row.owner_name);
      expect(row).toMatchObject({
        security_definer: true,
        context_pinned: true,
        owner_not_assumable: true,
      });
    }
  });

  test.each(runtimeRoles)('%s retains required SECURITY INVOKER helpers', async (role) => {
    const privileges = await prisma.$queryRawUnsafe(
      `SELECT has_function_privilege(
                $1::name,
                'public.pharmacy_funding_duplicate_line_snapshot_753(uuid,integer)',
                'EXECUTE'
              ) AS can_snapshot,
              has_function_privilege(
                $1::name,
                'public.cath_inventory_authority_assert_contract_753(uuid,bigint)',
                'EXECUTE'
              ) AS can_assert_cath_authority`,
      role,
    );
    expect(privileges[0]).toEqual({
      can_snapshot: true,
      can_assert_cath_authority: true,
    });
  });
});
