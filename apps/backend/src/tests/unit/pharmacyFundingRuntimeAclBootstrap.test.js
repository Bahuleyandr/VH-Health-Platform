import { readFileSync } from 'node:fs';

const prismaSource = readFileSync(
  new URL('../../lib/prisma.js', import.meta.url),
  'utf8',
);
const overlaySource = readFileSync(
  new URL(
    '../../../../../infra/kubernetes/overlays/dalekdefender/rls-runtime-role.sql',
    import.meta.url,
  ),
  'utf8',
);

const sources = [
  ['boot-time Prisma grant pass', prismaSource],
  ['DalekDefender provisioning overlay', overlaySource],
];

const insertColumns = new Map([
  ['billing_advance_settlements', [
    'advance_id',
    'invoice_id',
    'amount',
    'settled_by',
  ]],
  ['pharmacy_order_command_receipts', [
    'tenant_id',
    'pharmacy_order_id',
    'action',
    'command_key_sha256',
    'request_sha256',
    'response_payload',
    'response_message',
  ]],
  ['pharmacy_funding_commands', [
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
  ]],
  ['pharmacy_advance_allocation_reversals', [
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
  ]],
  ['pharmacy_advance_allocation_consumptions', [
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
  ]],
]);

const selectOnlyTables = ['pharmacy_advance_allocations'];

const runtimeInsertSequences = [
  'billing_advance_settlements_id_seq',
  'pharmacy_order_command_receipts_id_seq',
  'pharmacy_funding_commands_id_seq',
  'pharmacy_advance_allocation_reversals_id_seq',
  'pharmacy_advance_allocation_consumptions_id_seq',
];

const ownerOnlySequences = ['pharmacy_advance_allocations_id_seq'];

describe('runtime role posture', () => {
  it('keeps the SET ROLE target inert in both provisioning paths', () => {
    expect(prismaSource).toMatch(
      /NOLOGIN\s+NOSUPERUSER\s+NOBYPASSRLS\s+NOCREATEDB\s+NOCREATEROLE\s+NOREPLICATION\s+INHERIT/iu,
    );
    expect(overlaySource).toMatch(
      /ALTER ROLE vhhealth_app\s+NOLOGIN\s+NOSUPERUSER\s+NOBYPASSRLS\s+NOCREATEDB\s+NOCREATEROLE\s+NOREPLICATION\s+INHERIT/iu,
    );
  });

  it('keeps the Dalek connection role unprivileged but login-capable', () => {
    expect(prismaSource).toMatch(
      /LOGIN\s+NOSUPERUSER\s+NOBYPASSRLS\s+NOCREATEDB\s+NOCREATEROLE\s+NOREPLICATION\s+INHERIT/iu,
    );
    expect(overlaySource).toMatch(
      /ALTER ROLE vhhealth_runtime\s+LOGIN\s+NOSUPERUSER\s+NOBYPASSRLS\s+NOCREATEDB\s+NOCREATEROLE\s+NOREPLICATION\s+INHERIT/iu,
    );
  });
});

function grantInsertColumns(source, table) {
  const grantStart = 'GRANT INSERT (';
  const grantEnd = `) ON TABLE public.${table} TO %I`;
  const end = source.indexOf(grantEnd);
  if (end < 0) return null;
  const start = source.lastIndexOf(grantStart, end);
  if (start < 0) return null;
  return source.slice(start + grantStart.length, end)
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

function protectedAclBlock(source) {
  const start = source.indexOf(
    '-- Migration 753 funding receipts and advance reservations',
  );
  const end = source.indexOf(
    '-- End of the fail-closed migration-753 funding ACL reconciliation.',
    start,
  );
  return { start, end, text: source.slice(start, end) };
}

describe.each(sources)('%s funding ACL bootstrap', (_name, source) => {
  it('fails closed on unsafe posture or transitive authority membership', () => {
    const protectedBlock = protectedAclBlock(source);
    expect(protectedBlock.text).toContain(
      'migration-753 runtime role posture is unsafe',
    );
    expect(protectedBlock.text).toContain(
      'migration-753 runtime role can assume privileged authority',
    );
    expect(protectedBlock.text).toMatch(
      /pg_catalog\.pg_has_role\(\s*runtime_posture\.oid,assumable_role\.oid,'MEMBER'\s*\)/u,
    );
    expect(protectedBlock.text).toMatch(
      /pg_catalog\.pg_has_role\(\s*runtime_posture\.oid,assumable_role\.oid,'USAGE'\s*\)/u,
    );
    expect(protectedBlock.text).toMatch(
      /pg_catalog\.pg_has_role\(\s*runtime_posture\.oid,assumable_role\.oid,'SET'\s*\)/u,
    );
    for (const ownerPredicate of [
      'database.datdba',
      'namespace.nspowner=assumable_role.oid',
      'relation.relowner=assumable_role.oid',
      'routine.proowner=assumable_role.oid',
    ]) {
      expect(protectedBlock.text).toContain(ownerPredicate);
    }
    if (_name === 'boot-time Prisma grant pass') {
      expect(protectedBlock.text).toContain(
        "ARRAY['${role}','vhhealth_app','vhhealth_runtime']::TEXT[]",
      );
    } else {
      expect(protectedBlock.text).toContain(
        "runtime_posture.rolname IN ('vhhealth_app','vhhealth_runtime')",
      );
    }
  });

  it('denies the complete protected relation family before re-granting known objects', () => {
    expect(source).toContain(
      "pg_catalog.left(relation.relname,17)='pharmacy_advance_'",
    );
    expect(source).toContain("'pharmacy_order_command_receipts'");
    expect(source).toContain("'pharmacy_funding_commands'");
    expect(source).toContain("'billing_advance_settlements'");
    expect(source).toContain(
      "'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I'",
    );
    expect(source).toContain(
      "'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC'",
    );
    expect(source).toContain(
      "'REVOKE SELECT (%s) ON TABLE public.%I FROM %I'",
    );
    expect(source).toContain(
      "'REVOKE SELECT (%s) ON TABLE public.%I FROM PUBLIC'",
    );
    expect(source).toContain(
      "'REVOKE INSERT (%s) ON TABLE public.%I FROM %I'",
    );
    expect(source).toContain(
      "'REVOKE INSERT (%s) ON TABLE public.%I FROM PUBLIC'",
    );
    expect(source).toContain(
      "'REVOKE UPDATE (%s) ON TABLE public.%I FROM %I'",
    );
    expect(source).toContain(
      "'REVOKE UPDATE (%s) ON TABLE public.%I FROM PUBLIC'",
    );
    expect(source).toContain(
      "'REVOKE REFERENCES (%s) ON TABLE public.%I FROM %I'",
    );
    expect(source).toContain(
      "'REVOKE REFERENCES (%s) ON TABLE public.%I FROM PUBLIC'",
    );
    const broadGrant = source.lastIndexOf(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public',
    );
    const unsafeDefaultTableGrant = source.lastIndexOf(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO',
    );
    const protectedBlock = protectedAclBlock(source);
    const familyDeny = protectedBlock.text.indexOf(
      "pg_catalog.left(relation.relname,17)='pharmacy_advance_'",
    );
    const runtimeFamilyDeny = protectedBlock.text.lastIndexOf(
      "'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I'",
    );
    const defaultTableDeny = protectedBlock.text.lastIndexOf(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
    );
    const knownGrant = protectedBlock.text.indexOf(
      "'GRANT SELECT ON TABLE public.pharmacy_order_command_receipts TO %I'",
    );
    expect(broadGrant).toBeGreaterThanOrEqual(0);
    expect(unsafeDefaultTableGrant).toBe(-1);
    expect(protectedBlock.start).toBeGreaterThan(broadGrant);
    expect(runtimeFamilyDeny).toBeGreaterThanOrEqual(0);
    expect(familyDeny).toBeGreaterThanOrEqual(0);
    expect(defaultTableDeny).toBeGreaterThanOrEqual(0);
    expect(runtimeFamilyDeny).toBeGreaterThan(defaultTableDeny);
    expect(knownGrant).toBeGreaterThan(runtimeFamilyDeny);
  });

  it.each([...insertColumns])('%s has only its exact INSERT allowlist', (table, expected) => {
    expect(grantInsertColumns(source, table)).toEqual(expected);
    expect(source).toContain(
      `'GRANT SELECT ON TABLE public.${table} TO %I'`,
    );
  });

  it.each(selectOnlyTables)('%s cannot be inserted directly', (table) => {
    expect(grantInsertColumns(source, table)).toBeNull();
    expect(source).toContain(
      `'GRANT SELECT ON TABLE public.${table} TO %I'`,
    );
  });

  it('does not add a special billing-payments grant around its RLS boundary', () => {
    expect(source).not.toMatch(/GRANT[^;]*billing_payments/iu);
  });

  it('never restores setval authority on current or future sequences', () => {
    expect(source).toContain('REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public');
    expect(source).not.toMatch(/GRANT\s+USAGE,\s*SELECT,\s*UPDATE\s+ON\s+(?:ALL\s+)?SEQUENCES/i);
    for (const sequence of runtimeInsertSequences) {
      expect(source).toContain(`'${sequence}'`);
    }
    for (const sequence of ownerOnlySequences) {
      expect(source).not.toContain(`'${sequence}'`);
    }
    expect(source).toContain(
      "'GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I'",
    );
    expect(source).toContain(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
    );
    expect(source).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
    );
  });

  it('keeps every future object closed until the next explicit reconciliation', () => {
    expect(source).not.toMatch(
      /ALTER DEFAULT PRIVILEGES(?: IN SCHEMA public)?\s+GRANT [^;]+ ON (?:TABLES|SEQUENCES|FUNCTIONS) TO/iu,
    );
    expect(source).toContain(
      'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES FROM %I',
    );
    expect(source).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
    );
    expect(source).toContain(
      'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM %I',
    );
    expect(source).toContain(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I',
    );
    expect(source).toMatch(
      /ALTER DEFAULT PRIVILEGES\s+REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC/iu,
    );
    expect(source).toMatch(
      /ALTER DEFAULT PRIVILEGES\s+REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC/iu,
    );
    expect(source).toMatch(
      /ALTER DEFAULT PRIVILEGES\s+REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/iu,
    );
    expect(source).toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA public\s+REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC/iu,
    );
    expect(source).toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA public\s+REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC/iu,
    );
    expect(source).toMatch(
      /ALTER DEFAULT PRIVILEGES IN SCHEMA public\s+REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/iu,
    );
  });

  it('cannot downgrade a protected-family reconciliation failure to NOTICE', () => {
    const protectedBlock = protectedAclBlock(source);
    expect(protectedBlock.start).toBeGreaterThanOrEqual(0);
    expect(protectedBlock.end).toBeGreaterThan(protectedBlock.start);
    expect(protectedBlock.text).not.toContain('EXCEPTION WHEN insufficient_privilege');
    expect(protectedBlock.text).not.toMatch(/RAISE NOTICE/iu);
    if (_name === 'boot-time Prisma grant pass') {
      expect(protectedBlock.text).toContain("ERRCODE='V7530'");
      const fatalCatch = source.indexOf(
        "const fundingAclFailure = err?.meta?.code === 'V7530'",
      );
      expect(fatalCatch).toBeGreaterThan(protectedBlock.end);
      expect(source.indexOf('throw err;', fatalCatch)).toBeGreaterThan(fatalCatch);
    }
  });

  it('makes broad provisioning grants and the protected reconciliation atomic', () => {
    if (_name === 'boot-time Prisma grant pass') {
      expect(source).toContain('DO $$');
      return;
    }
    const protectedBlock = protectedAclBlock(source);
    const transactionStart = source.indexOf(
      '-- Keep broad grants and the reservation ACL reconciliation atomic.',
    );
    const begin = source.indexOf('BEGIN;', transactionStart);
    const commit = source.lastIndexOf('COMMIT;', protectedBlock.end);
    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThan(transactionStart);
    expect(begin).toBeLessThan(source.indexOf(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public',
    ));
    expect(commit).toBeGreaterThan(protectedBlock.start);
    expect(commit).toBeLessThan(protectedBlock.end);
  });

  it('revokes every migration-753 SECURITY DEFINER routine and exposes only frozen governed wrappers', () => {
    expect(source).toContain('AND routine.prosecdef');
    expect(source).toContain("pg_catalog.right(routine.proname,4)='_753'");
    expect(source).toContain(
      "'REVOKE ALL PRIVILEGES ON FUNCTION public.%I(%s) FROM PUBLIC'",
    );
    expect(source).toContain(
      "'REVOKE ALL PRIVILEGES ON FUNCTION public.%I(%s) FROM %I'",
    );
    const direct753Grants = source.match(
      /GRANT EXECUTE ON FUNCTION public\.[A-Za-z0-9_]*_753\([^']*\) TO %I/g,
    ) || [];
    expect(direct753Grants).toEqual([
      'GRANT EXECUTE ON FUNCTION public.complete_pharmacy_funding_command_753(UUID,BIGINT,UUID,JSONB) TO %I',
      'GRANT EXECUTE ON FUNCTION public.reserve_pharmacy_advance_allocations_753(UUID,BIGINT,UUID) TO %I',
    ]);
    const functionDeny = source.lastIndexOf(
      "pg_catalog.right(routine.proname,4)='_753'",
    );
    const defaultFunctionDeny = source.lastIndexOf(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I',
    );
    expect(functionDeny)
      .toBeGreaterThan(source.lastIndexOf('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public'));
    expect(functionDeny)
      .toBeGreaterThan(source.lastIndexOf('GRANT EXECUTE ON FUNCTIONS TO'));
    expect(functionDeny).toBeGreaterThan(defaultFunctionDeny);
    for (const grant of direct753Grants) {
      expect(source.indexOf(grant)).toBeGreaterThan(functionDeny);
    }
  });
});
