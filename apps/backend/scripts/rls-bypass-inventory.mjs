#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { owningModule, parseModelTables, relocateSites, scanWriters } from './lib/rlsInventorySource.mjs';

export const PROGRAMME_ROLES = [
  'vhhealth_app', 'vhhealth_runtime', 'vhhealth_readonly', 'vhhealth_mcp_reader',
  'vh_warehouse_repl', 'metabase_readonly', 'harbor',
];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const CATALOG_QUERIES = {
  metadata: `SELECT current_database() AS database, session_user AS session_user,
    current_user AS current_user, current_setting('server_version') AS server_version,
    current_setting('transaction_read_only') AS read_only,
    inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
    transaction_timestamp()::text AS captured_at`,
  roles: `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit, rolcreaterole
    FROM pg_catalog.pg_roles ORDER BY rolname`,
  memberships: `SELECT member.rolname AS member, role.rolname AS role,
    grantor.rolname AS grantor, membership.admin_option, membership.inherit_option,
    membership.set_option
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles member ON member.oid = membership.member
    JOIN pg_catalog.pg_roles role ON role.oid = membership.roleid
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = membership.grantor
    ORDER BY member.rolname, role.rolname`,
  relations: `SELECT namespace.nspname AS schemaname, relation.relname AS tablename
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE relation.relkind IN ('r', 'p', 'f', 'v', 'm')
      AND namespace.nspname NOT LIKE 'pg_%' AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname`,
  tables: `SELECT namespace.nspname AS schemaname, relation.relname AS tablename,
    owner.rolname AS owner, relation.relrowsecurity AS rls_enabled,
    relation.relforcerowsecurity AS force_rls, relation.relkind AS kind,
    relation.relispartition AS is_partition,
    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS tenant_type
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_roles owner ON owner.oid = relation.relowner
    JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
      AND attribute.attname = 'tenant_id' AND attribute.attnum > 0 AND NOT attribute.attisdropped
    WHERE relation.relkind IN ('r', 'p', 'f')
      AND namespace.nspname NOT LIKE 'pg_%' AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname`,
  policies: `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    FROM pg_catalog.pg_policies
    WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema'
    ORDER BY schemaname, tablename, policyname`,
};

export async function collectCatalog(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const catalog = {};
    for (const [name, sql] of Object.entries(CATALOG_QUERIES)) {
      catalog[name] = (await client.query(sql)).rows;
    }
    if (catalog.metadata[0]?.read_only !== 'on') { throw new Error('Inventory transaction must be read only'); }
    const tracker = await client.query("SELECT to_regclass('public._migrations')::text AS tracker");
    catalog.migrations = tracker.rows[0]?.tracker ?
      (await client.query('SELECT name, checksum FROM public._migrations ORDER BY name')).rows : [];
    return catalog;
  } finally {
    await client.query('ROLLBACK');
  }
}

function pgBoolean(value) {
  if (value === true || value === 't' || value === 'true') { return true; }
  if (value === false || value === 'f' || value === 'false') { return false; }
  throw new Error(`Invalid catalog boolean: ${String(value)}`);
}

export function parseCatalog(catalog) {
  for (const key of ['metadata', 'roles', 'memberships', 'relations', 'tables', 'policies', 'migrations']) {
    if (!Array.isArray(catalog[key])) { throw new Error(`Missing catalog rows: ${key}`); }
  }
  if (catalog.metadata.length !== 1 || !catalog.roles.length || !catalog.tables.length) {
    throw new Error('Inventory requires one database identity and nonempty role/table populations');
  }
  const roles = catalog.roles.map((role) => ({
    ...role, rolsuper: pgBoolean(role.rolsuper), rolbypassrls: pgBoolean(role.rolbypassrls),
    rolcanlogin: pgBoolean(role.rolcanlogin), rolinherit: pgBoolean(role.rolinherit),
    rolcreaterole: pgBoolean(role.rolcreaterole),
  }));
  const memberships = catalog.memberships.map((membership) => ({
    ...membership, admin_option: pgBoolean(membership.admin_option),
    inherit_option: pgBoolean(membership.inherit_option), set_option: pgBoolean(membership.set_option),
  }));
  const policies = new Map();
  for (const policy of catalog.policies) {
    if (!['PERMISSIVE', 'RESTRICTIVE'].includes(policy.permissive)) { throw new Error(`Invalid policy kind: ${policy.permissive}`); }
    const key = `${policy.schemaname}.${policy.tablename}`;
    policies.set(key, [...(policies.get(key) || []), policy]);
  }
  const tables = catalog.tables.map((table) => {
    const key = `${table.schemaname}.${table.tablename}`;
    const attached = policies.get(key) || [];
    if (!roles.some((role) => role.rolname === table.owner)) { throw new Error(`Missing owner role for ${key}`); }
    return {
      ...table, key, rls_enabled: pgBoolean(table.rls_enabled), force_rls: pgBoolean(table.force_rls),
      policies: attached, restrictive: attached.filter((policy) => policy.permissive === 'RESTRICTIVE'),
    };
  });
  if (new Set(tables.map((table) => table.key)).size !== tables.length) { throw new Error('Duplicate tenant table rows'); }
  return { metadata: catalog.metadata[0], roles, memberships, tables, relations: catalog.relations, migrations: catalog.migrations };
}

export function reachableBypassRoles(roleName, roles, memberships) {
  const visited = new Set([roleName]);
  const pending = [roleName];
  while (pending.length) {
    const member = pending.shift();
    for (const grant of memberships.filter((entry) => entry.member === member && entry.set_option)) {
      if (!visited.has(grant.role)) { visited.add(grant.role); pending.push(grant.role); }
    }
  }
  return roles.filter((role) => visited.has(role.rolname) && (role.rolsuper || role.rolbypassrls))
    .map((role) => role.rolname).sort();
}

export function sourceInventory(root, roleNames, relations) {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'apps/backend', 'infra', 'scripts', '.github', '.forgejo'], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  const sources = new Map();
  const roleUses = new Map(roleNames.map((role) => [role, []]));
  const bypassUses = [];
  const migrationRoles = new Map();
  for (const file of files) {
    if (file === 'apps/backend/scripts/rls-bypass-inventory.mjs') { continue; }
    if (!/\.(?:js|mjs|cjs|sql|ya?ml|sh|ps1)$/.test(file) || /\/(?:tests|__tests__|mocks)\/|\.test\./.test(file)) { continue; }
    const source = readFileSync(path.join(root, file), 'utf8');
    if (/^apps\/backend\/src\/.*\.js$/.test(file) && !file.includes('/migrations/')) { sources.set(file, source); }
    source.split(/\r?\n/).forEach((line, index) => {
      for (const role of roleNames) {
        if (new RegExp(`\\b${role}\\b`).test(line)) { roleUses.get(role).push(`${file}:${index + 1}`); }
      }
      if (/superAdmin\s*:\s*true|runWithSuperAdmin\s*\(|['"]bypass['"]/.test(line)) {
        bypassUses.push(`${file}:${index + 1}`);
      }
      if (file.includes('/migrations/')) {
        const created = line.match(/\bCREATE\s+(?:ROLE|USER)\s+"?([a-z_][a-z_0-9]*)"?/i);
        if (created) { migrationRoles.set(created[1], [...(migrationRoles.get(created[1]) || []), `${file}:${index + 1}`]); }
      }
    });
  }
  const models = parseModelTables(readFileSync(path.join(root, 'apps/backend/prisma/schema.prisma'), 'utf8'));
  const relationNames = new Set(relations.map((relation) => `${relation.schemaname}.${relation.tablename}`));
  return { sites: relocateSites(sources, undefined, relationNames), writers: scanWriters(sources, models), roleUses, bypassUses, migrationRoles };
}

const escapeCell = (value) => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
const yesNo = (value) => value ? 'yes' : 'no';
function markdownTable(headers, rows) {
  return [headers, headers.map(() => '---'), ...rows].map((row) => `| ${row.map(escapeCell).join(' | ')} |`).join('\n');
}
const refs = (values) => values.length ? values.map((value) => `\`${value}\``).join(', ') : 'none located';

export function renderInventory(catalog, source, { date, revision }) {
  const { metadata, roles, memberships, tables } = catalog;
  const missing = tables.filter((table) => !table.restrictive.length);
  const ownerByName = new Map(roles.map((role) => [role.rolname, role]));
  const names = new Set([...PROGRAMME_ROLES, ...source.migrationRoles.keys(),
    ...roles.filter((role) => role.rolsuper || role.rolbypassrls || reachableBypassRoles(role.rolname, roles, memberships).length).map((role) => role.rolname)]);
  const roleRows = [...names].sort().map((name) => {
    const role = ownerByName.get(name);
    const capabilities = role ? `superuser=${yesNo(role.rolsuper)}; bypassrls=${yesNo(role.rolbypassrls)}; login=${yesNo(role.rolcanlogin)}; inherit=${yesNo(role.rolinherit)}; createrole=${yesNo(role.rolcreaterole)}` : 'ABSENT from target cluster';
    const bypass = role ? reachableBypassRoles(name, roles, memberships) : [];
    return [name, capabilities, bypass.join(', ') || 'none',
      refs(memberships.filter((grant) => grant.member === name).map((grant) => grant.role)),
      refs(memberships.filter((grant) => grant.role === name).map((grant) => grant.member)),
      refs(source.migrationRoles.get(name) || []), refs(source.roleUses.get(name) || [])];
  });
  const decisionRows = roles.flatMap((role) => {
    const bypass = reachableBypassRoles(role.rolname, roles, memberships);
    const unforced = tables.filter((table) => table.owner === role.rolname && !table.force_rls);
    if (!bypass.length && !unforced.length) { return []; }
    return [[role.rolname, bypass.join(', ') || 'none', refs(unforced.map((table) => table.key)), 'owner to decide']];
  });
  const grouped = new Map();
  for (const table of missing) {
    const writers = source.writers.get(table.key) || [];
    const module = owningModule(writers);
    grouped.set(module, [...(grouped.get(module) || []), { table, writers }]);
  }
  const lines = [
    `# RLS bypass inventory — ${date}`, '',
    'Generated by `apps/backend/scripts/rls-bypass-inventory.mjs`. Tranche 0: catalog reads and source inventory only; no role or policy changes.', '',
    markdownTable(['Evidence', 'Observed value'], [
      ['Source revision', revision], ['Database', metadata.database],
      ['Server', `${metadata.server_address}:${metadata.server_port}`], ['PostgreSQL', metadata.server_version],
      ['Session / effective role', `${metadata.session_user} / ${metadata.current_user}`],
      ['Snapshot time', metadata.captured_at], ['Transaction read only', metadata.read_only],
      ['Tenant-bearing tables', tables.length], ['With at least one RESTRICTIVE policy', tables.length - missing.length],
      ['Without any RESTRICTIVE policy', missing.length], ['RLS disabled', tables.filter((table) => !table.rls_enabled).length],
      ['FORCE RLS absent', tables.filter((table) => !table.force_rls).length],
      ['Recorded migrations', catalog.migrations.length], ['Last recorded migration', catalog.migrations.at(-1)?.name || 'no tracker rows'],
      ['Confirmed audit finding groups relocated', source.sites.length],
    ]), '',
    'This is the named database snapshot, not a production-role attestation. Cluster roles are observed globally; memberships and table ownership may differ between environments. No patient rows or credential values are read.', '',
    'Tenant-bearing means a non-dropped `tenant_id` column on an ordinary, partitioned, or foreign table outside PostgreSQL internal schemas. The census tests `permissive = RESTRICTIVE`, independently of policy names. Presence alone does not prove that a predicate is correct or applies to every role/command; Tranche 2 must prove that separately.', '',
    '## Roles and bypass paths', '',
    'SUPERUSER and BYPASSRLS apply even with FORCE RLS. These role attributes are not inherited like ordinary privileges; the reachable-role column follows only membership edges that allow SET ROLE. Owner privileges and role administration still require owner review. Source references identify declared usage, including comments, rather than proving deployed connections.', '',
    markdownTable(['Role', 'Observed capabilities', 'Reachable privileged roles via SET ROLE', 'Member of', 'Members', 'Literal migration creation', 'Repository references'], roleRows), '',
    '## Owner decisions for observed bypass paths', '',
    'Decision rows are limited to SUPERUSER/BYPASSRLS roles, roles able to SET ROLE to them, and owners of tenant-bearing tables without FORCE RLS. Ordinary or absent roles and companion-census rows do not require a bypass replacement decision.', '',
    markdownTable(['Role', 'Reachable SUPERUSER / BYPASSRLS roles', 'Owned tables without FORCE RLS', 'DECISION'], decisionRows), '',
    '## All observed role memberships', '',
    markdownTable(['Member', 'Granted role', 'Grantor', 'ADMIN', 'INHERIT', 'SET ROLE'], memberships.map((grant) => [
      grant.member, grant.role, grant.grantor, yesNo(grant.admin_option), yesNo(grant.inherit_option), yesNo(grant.set_option),
    ])), '',
    '## Every tenant-bearing table: ownership and FORCE coverage', '',
    markdownTable(['Table', 'Owner', 'Owner SUPERUSER / BYPASSRLS', 'RLS', 'FORCE', 'RESTRICTIVE policies'], tables.map((table) => {
      const owner = ownerByName.get(table.owner);
      return [table.key, table.owner, `${yesNo(owner.rolsuper)} / ${yesNo(owner.rolbypassrls)}`,
        yesNo(table.rls_enabled), yesNo(table.force_rls), table.restrictive.map((policy) => policy.policyname).join(', ') || 'none'];
    })), '',
    '## Tables without a RESTRICTIVE companion, grouped by inferred owning module', '',
    'Module assignment uses directories of static SQL or Prisma delegate writers, preferring services, then controllers/routes, then other backend code. Unqualified table names are resolved as public. Multiple writer modules remain visible. Dynamic SQL/delegates and indirect stored-function writes can be missed; UNASSIGNED is unresolved ownership, never evidence of no callers. All callers must be hand-triaged before closure.', '',
  ];
  for (const [module, entries] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`### ${module} (${entries.length})`, '',
      markdownTable(['Table', 'Writer evidence'], entries.map(({ table, writers }) => [
        table.key, refs(writers.map((writer) => `${writer.file}:${writer.line} (${writer.kind})`)),
      ])), '');
  }
  lines.push('## Confirmed audit symbol relocation', '',
    'The 22 rows preserve the audit finding groups: list/count and the three SLA aggregates are grouped findings, not single SQL statements. Function and SQL literal lines are re-derived from the current source AST. Tables include statically named joins matched against catalog relations, excluding CTE names and expression operands; this inventory makes no claim that these sites have been fixed.', '',
    markdownTable(['Step', 'File', 'Function / route', 'Current function line', 'Current SQL lines', 'Tables', 'R/W', 'Audit line at 5857298dc'], source.sites.map((entry) => [
      entry.module, entry.file, entry.symbol, entry.line, entry.statementLines.join(', '), entry.tables.join(', '), entry.access, entry.auditLine,
    ])), '',
    '## Bypass GUC and cross-tenant execution leads', '',
    'Source occurrences of the bypass literal, `superAdmin: true`, or `runWithSuperAdmin(...)` are leads, including comments and unrelated uses of the same literal. They do not establish a live dependency or authorize a replacement role. The restrictive companion makes the tenant GUC bypass literal inert; trace each relevant maintenance path before closing its tables.', '',
    markdownTable(['Source lead'], source.bypassUses.map((ref) => [ref])), '',
    '## Reproduction', '',
    'From `apps/backend`, with Node 26.5.0 and the repository test setup selecting the QA database:', '',
    '```powershell',
    `node --require ./src/scripts/testing/jest.setup.cjs scripts/rls-bypass-inventory.mjs --date ${date} --output ../../docs/security/rls-bypass-inventory-${date}.md`,
    '```', '',
    'For a different authorized target, explicitly set `DATABASE_URL` before invoking the script. The connection requests read-only mode from startup and uses one REPEATABLE READ, READ ONLY transaction, rolled back after catalog collection. Output contains no connection URL or passwords.', '',
  );
  return lines.join('\n');
}

async function main() {
  const options = { date: new Date().toISOString().slice(0, 10) };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i];
    if (!['--date', '--output', '--snapshot'].includes(key) || !process.argv[i + 1]) { throw new Error('Usage: rls-bypass-inventory.mjs [--date YYYY-MM-DD] [--output path] [--snapshot path]'); }
    options[key.slice(2)] = process.argv[i + 1];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) { throw new Error('Date must be YYYY-MM-DD'); }
  if (!process.env.DATABASE_URL) { throw new Error('DATABASE_URL must select an authorized target'); }
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL, application_name: 'rls-bypass-inventory',
    options: '-c default_transaction_read_only=on -c statement_timeout=30000', connectionTimeoutMillis: 10000,
  });
  let raw;
  await client.connect();
  try { raw = await collectCatalog(client); } finally { await client.end(); }
  const catalog = parseCatalog(raw);
  const source = sourceInventory(repoRoot, [...new Set([...PROGRAMME_ROLES, ...catalog.roles.map((role) => role.rolname)])], catalog.relations);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const report = renderInventory(catalog, source, { date: options.date, revision });
  const output = path.resolve(options.output || path.join(repoRoot, `docs/security/rls-bypass-inventory-${options.date}.md`));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, report);
  if (options.snapshot) { writeFileSync(options.snapshot, JSON.stringify(raw, null, 2) + '\n'); }
  process.stdout.write(`Generated ${output}: ${catalog.tables.length} tenant tables; ${catalog.tables.filter((table) => !table.restrictive.length).length} without RESTRICTIVE; ${source.sites.length} audit groups.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`RLS inventory failed: ${error.message}\n`); process.exitCode = 1; });
}
