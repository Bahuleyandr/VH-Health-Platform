import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { splitStatements } from '../../src/utils/migrations/splitStatements.js';
import { parseMigrationDirectives } from './migrationDirectives.mjs';
import { tableReferences } from './rlsInventorySource.mjs';

const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
const sorted = values => [...new Set(values)].sort();
const location = row => `${row.file}:${row.line}`;

export function owningClosure(table) {
  if (table.startsWith('housekeeping_')) return 'feat/rls-t2-housekeeping';
  if (['investigations', 'investigation_bookings'].includes(table))
    return 'feat/rls-t2-investigations';
  if (
    [
      'users',
      'doctors',
      'appointments',
      'appointment_queues',
      'emergency_visits',
      'maternity_pregnancies'
    ].includes(table)
  )
    return 'feat/rls-t2-appointments';
  if (['wards', 'patient_data_rights_requests', 'e_prescriptions'].includes(table))
    return 'feat/rls-t2-wards-consent-roster-rx';
  return 'feat/rls-t2-staff-admin';
}

export function migrationStatements(repoRoot, targetTables) {
  const directory = 'apps/backend/src/migrations';
  const statements = [];
  const manifest = [];
  let population = 0;
  for (const name of readdirSync(path.join(repoRoot, directory))
    .filter(name => name.endsWith('.sql'))
    .sort()) {
    const file = `${directory}/${name}`;
    const source = readFileSync(path.join(repoRoot, file), 'utf8').replaceAll('\r\n', '\n');
    manifest.push({ file, sha256: hash(source) });
    const directives = parseMigrationDirectives(source);
    let cursor = 0;
    for (const [index, statement] of splitStatements(source).entries()) {
      population += 1;
      const offset = source.indexOf(statement, cursor);
      if (offset < 0)
        throw new Error(`Cannot locate split migration statement: ${file} #${index + 1}`);
      cursor = offset + statement.length;
      const line = source.slice(0, offset).split('\n').length;
      const catalogExpansion =
        /\bEXECUTE\b/i.test(statement) &&
        /\b(?:pg_tables|pg_class|information_schema\.(?:tables|columns))\b/i.test(statement);
      const dynamicLiteralTables = /\bEXECUTE\b/i.test(statement)
        ? targetTables.filter(table => new RegExp(`['"]${table}['"]`, 'i').test(statement))
        : [];
      const tables = catalogExpansion
        ? [...targetTables]
        : sorted([
            ...tableReferences(statement)
              .map(table => table.replace(/^public\./, ''))
              .filter(table => targetTables.includes(table)),
            ...dynamicLiteralTables
          ]);
      if (!tables.length) continue;
      statements.push({
        id: `${file}:statement-${index + 1}`,
        file,
        line,
        statement: index + 1,
        tables,
        sql: statement,
        sha256: hash(statement),
        context: 'administrative-migration-candidate',
        catalogExpansion,
        sink: directives.noTransaction
          ? 'apps/backend/src/utils/migrations/applyNoTransactionMigration.js:runPgStatements'
          : 'apps/backend/src/utils/migrations/runMigrations.js:runStatements',
        reason: catalogExpansion
          ? 'Catalog-driven dynamic SQL may address every target relation; prove this historical statement is unreachable from the application using the applied-migration ledger and deployment role/configuration.'
          : 'Historical migration statement or stored routine body; prove application unreachability from the applied-migration ledger, routine callers and deployment role/configuration.'
      });
    }
  }
  return { population, manifest, statements };
}

export function buildPin(
  trace,
  migrations,
  { revision = 'fixture', lexical = {}, connections = [] } = {}
) {
  if (trace.registrationErrors?.length) throw new Error(trace.registrationErrors.join('\n'));
  const unexplained = (trace.unresolvedSql || []).filter(
    row =>
      ![
        'apps/backend/src/utils/migrations/runMigrations.js',
        'apps/backend/src/utils/migrations/applyNoTransactionMigration.js'
      ].includes(row.file)
  );
  if (unexplained.length)
    throw new Error(`Unresolved reachable SQL: ${JSON.stringify(unexplained)}`);
  if (!trace.registrations.length || !trace.roots.length || !trace.sql.length)
    throw new Error('Census requires nonempty job, entry-point and statement populations');
  if (trace.registrations.some(job => !job.job || !job.callbacks.length))
    throw new Error('Unresolved scheduler registration');
  if (new Set(trace.registrations.map(job => job.job)).size !== trace.registrations.length)
    throw new Error('Duplicate scheduler job names require explicit multiplicity accounting');
  const statements = new Map();
  for (const row of trace.reachers) {
    if (!statements.has(row.id))
      statements.set(row.id, {
        id: row.id,
        file: row.file,
        line: row.line,
        expression: row.expression,
        sink: row.sink || null,
        sql: row.sql,
        sha256: hash(row.sql || row.expression),
        tables: sorted(row.tables),
        contexts: [],
        origins: [],
        paths: []
      });
    const entry = statements.get(row.id);
    entry.contexts = sorted([...entry.contexts, row.context]);
    entry.origins = sorted([...entry.origins, ...row.origins]);
    if (!entry.paths.some(route => JSON.stringify(route) === JSON.stringify(row.samplePath)))
      entry.paths.push(row.samplePath);
  }
  for (const row of migrations.statements)
    statements.set(row.id, {
      ...row,
      contexts: [row.context],
      origins: ['administrative:pending-migrations'],
      paths: []
    });
  const all = [...statements.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const tables = trace.targetTables.map(table => {
    const entries = all
      .filter(row => row.tables.includes(table))
      .map(row => {
        const administrative = row.contexts.includes('administrative-migration-candidate');
        const alreadyTenant = row.contexts.every(context => context === 'tenant');
        const timerOnly = row.contexts.every(context => context === 'timer-context-candidate');
        const intendedDisposition =
          administrative || alreadyTenant || timerOnly ? 'proven-unreachable' : 'converted';
        return {
          statement: row.id,
          status: 'PENDING',
          intendedDisposition,
          modulePr: owningClosure(table),
          reason: administrative
            ? row.reason
            : alreadyTenant
              ? 'The static path enters tenant scope; prove the bypass path cannot execute this statement without that scope under vhhealth_app.'
              : timerOnly
                ? 'Timer may inherit caller ALS; prove all registrations retain tenant scope or convert the worker in this module PR.'
                : 'Convert every listed bypass/no-context path to per-tenant scope and prove nonzero tenant work under vhhealth_app.'
        };
      });
    const runtime = entries.filter(
      entry => !entry.statement.startsWith('apps/backend/src/migrations/')
    ).length;
    return {
      table,
      modulePr: owningClosure(table),
      reachers: entries.length,
      dispositioned: 0,
      pending: entries.length,
      equation: `${entries.length} reachers = 0 dispositioned + ${entries.length} pending`,
      runtimeCandidates: runtime,
      administrativeCandidates: entries.length - runtime,
      sourceTableStatementCandidates: trace.sql.filter(row => row.tables.includes(table)).length,
      entries
    };
  });
  return {
    schemaVersion: 1,
    kind: 'CENSUS_ONLY',
    revision,
    method:
      'Static conservative enumeration. PENDING includes paths whose context, activation, historical ledger or dynamic dispatch still needs disposition proof. No job was invoked and no disposition is accepted here.',
    closureRule:
      'K = 0 for the table, exact list and count, disposition tests in the same closure PR; each test explicitly enables AUTH_ENFORCE_TENANT_RLS=true and AUTH_TENANT_RLS_RUNTIME_ROLE=vhhealth_app and asserts current_user/rolsuper/rolbypassrls, population first and nonzero job work.',
    lexical,
    counts: trace.counts,
    sourceManifest: trace.sourceManifest,
    directPgImports: trace.directPgImports,
    expandedMigrationDispatchers: trace.unresolvedSql,
    callbackBoundaries: trace.callbackBoundaries,
    migrationManifest: migrations.manifest,
    migrationStatementPopulation: migrations.population,
    registrations: trace.registrations.map(
      ({ file, line, job, schedule, guard, conditions, callbacks }) => ({
        file,
        line,
        job,
        schedule,
        guard,
        conditions,
        callbacks
      })
    ),
    entryPoints: trace.roots.map(({ file, line, kind, callbacks }) => ({
      file,
      line,
      kind,
      callbacks
    })),
    residualEntryPoints: trace.residualRoots
      .filter(root => root.callbacks.length)
      .map(({ file, line, kind, callbacks }) => ({ file, line, kind, callbacks })),
    connections,
    tables,
    statements: all
  };
}

export function assertTablePin(actual, expected) {
  if (!actual || !expected || actual.table !== expected.table) throw new Error('Missing table pin');
  for (const row of [actual, expected]) {
    if (row.reachers !== row.dispositioned + row.pending || row.reachers !== row.entries.length)
      throw new Error(`${row.table}: N != M + K or list length`);
    for (const entry of row.entries) {
      if (
        entry.status === 'PENDING' &&
        (!['converted', '736-routine', 'proven-unreachable'].includes(entry.intendedDisposition) ||
          !entry.modulePr)
      )
        throw new Error(`${row.table}: pending disposition/owner missing`);
    }
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `${actual.table}: statement census changed; regenerate and review the exact list`
    );
}

export function serializePin(pin) {
  const fields = Object.entries(pin)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      if (key === 'tables') {
        const rows = value.map(
          ({ entries, ...table }) =>
            `    {\n      ${JSON.stringify(table).slice(1, -1)},\n      "entries": [\n${entries.map(entry => `        ${JSON.stringify(entry)}`).join(',\n')}\n      ]\n    }`
        );
        return `  "tables": [\n${rows.join(',\n')}\n  ]`;
      }
      if (Array.isArray(value))
        return `  ${JSON.stringify(key)}: [\n${value.map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`;
      return `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    });
  return `{\n${fields.join(',\n')}\n}\n`;
}

const cell = value =>
  String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
export function renderPin(pin) {
  const lines = [
    '# RLS bypass-reacher census — 2026-09-08',
    '',
    `Source revision: \`${pin.revision}\`. Exact normalized source and migration SHA-256 manifests are in the adjacent JSON pin.`,
    '',
    '**Census only: no policy changes, conversions, completed dispositions or runtime acceptance claims.** Every entry is PENDING with an intended disposition and future module PR. A closure must reduce K to zero for its table and carry the disposition tests in that same PR.',
    '',
    pin.method,
    '',
    '## Reproduction and counting predicates',
    '',
    'Run from apps/backend: `node scripts/rls-bypass-reacher-census.mjs --check`. Regenerate intentionally with `--write`. The source reader parses JavaScript and follows imported functions, callbacks, SQL wrappers and immutable SQL/handler maps; it never imports the application or connects to a database. The JSON stores the resolved SQL, physical sink, all origins and representative call paths for each statement.',
    '',
    '- ENTRY POINTS: actual AST call expressions named runWithSuperAdmin, withJobLock or withReplicaLocalJobGuard. Definitions and comments do not count. A callback argument may be forwarded by a helper; registered jobs supply the concrete callback roots.',
    '- JOBS: every registerCron call in src/utils/scheduler.js, across all feature guards, with its unique literal job name and resolved callback. These are potential source registrations, not simultaneously active jobs. Registration in a loop or function fails generation until expanded; this source has neither. No invoked-job count is claimed.',
    '- RUNTIME REACHING STATEMENTS: distinct table + SQL origin (line and column), through registered jobs, explicit bypass callbacks, bare transaction callbacks, timers, module initialization/startup, public routes mounted before global tenant middleware, and read-only clients. Repeated paths/contexts are merged into one entry. Tenant-switched, dedicated pre-auth middleware and timer-inherited paths remain candidates pending proof. Plain request-path receiver calls alone are not census roots. Dynamic Prisma model selectors resolve through their literal caller arguments and model maps.',
    '- ADMINISTRATIVE STATEMENTS: expand the migration runner using its actual splitStatements parser. One SQL statement is one entry; deferred function bodies are conservative candidates, not claimed executions at CREATE FUNCTION time. Catalog-driven EXECUTE statements expand to every target table pending ledger/role proof. This administrative set is shown separately from runtime jobs and included in N so unknown migration dispatch cannot create a false empty pin.',
    '- SQL tables: resolve FROM/JOIN/UPDATE/INTO/LOCK/TRUNCATE relation tokens and target Prisma model operations, including SQL passed through wrappers. Dynamic fragments retain every possible target; CTE names do not count as relations. Generation-specific projector handlers are expanded to all imported handlers; generation/event filtering remains pending proof.',
    '',
    `Lexical planning predicates (src excluding tests): ${pin.lexical.runWithSuperAdminLines} lines in ${pin.lexical.runWithSuperAdminFiles} files match \`runWithSuperAdmin\\(\`; ${pin.lexical.withJobLockLines} scheduler lines match \`withJobLock\\(\`. These include comments/definitions and are not reaching statements.`,
    '',
    `Measured populations: **${pin.entryPoints.length} entry-point calls; ${pin.registrations.length} registered jobs; ${pin.counts.sql} database-call/source-statement records; ${pin.migrationStatementPopulation} split migration statements.** Entry points by kind: ${['runWithSuperAdmin', 'withJobLock', 'withReplicaLocalJobGuard'].map(kind => `${kind}=${pin.entryPoints.filter(row => row.kind === kind).length}`).join(', ')}.`,
    '',
    '## Table pins (users first)',
    '',
    'The 22 relations are the unique tenant-bearing tables at the original 22 confirmed findings; the global investigation_test_catalog is excluded. Shared users, emergency_visits, maternity_pregnancies and report_updates are included in the census. Their module labels assign future disposition ownership; this document does not authorize an early policy closure.',
    '',
    '| Table | Runtime candidates | Administrative candidates | N reachers = M dispositioned + K pending | Owning module PR |',
    '|---|---:|---:|---|---|'
  ];
  for (const table of pin.tables)
    lines.push(
      `| ${table.table} | ${table.runtimeCandidates} | ${table.administrativeCandidates} | ${table.equation} | ${table.modulePr} |`
    );
  lines.push(
    '',
    'An empty runtime set means the complete nonempty registered-job/root population produced no table statement; the source-table candidate count is printed below for comparison. It does not excuse pending administrative entries or establish unreachability for closure.',
    '',
    '## Connection roles and direct pg consumers',
    '',
    'These are deployment declarations and source paths, not a live credential inspection. Any configured DSN override must be verified in the owning closure PR. The census executes no database query.',
    '',
    '| Consumer | DSN and declared role | BYPASSRLS | Table reach / proof still required |',
    '|---|---|---|---|'
  );
  for (const row of pin.connections)
    lines.push(
      `| ${cell(row.consumer)} | ${cell(row.role)} | ${cell(row.bypassrls)} | ${cell(row.evidence)} |`
    );
  lines.push(
    '',
    'Required role query on each actual connection, with enforcement enabled in each disposition test:',
    '',
    '```sql',
    'SELECT current_user, rolsuper, rolbypassrls',
    'FROM pg_catalog.pg_roles WHERE rolname = current_user;',
    'SELECT name, checksum FROM public._migrations ORDER BY name;',
    '```',
    '',
    'The second query must reconcile to the migration manifest before a historical administrative candidate can be proven unreachable; stored routine bodies additionally require caller/context proof. No such proof is claimed by this census.',
    '',
    '## Registered jobs',
    '',
    '| Job | Registration | Wrapper | Schedule | Registration conditions |',
    '|---|---|---|---|---|'
  );
  for (const row of pin.registrations)
    lines.push(
      `| ${row.job} | ${location(row)} | ${row.guard} | ${cell(row.schedule)} | ${cell(row.conditions?.join(' AND ') || 'unconditional source registration')} |`
    );
  const statements = new Map(pin.statements.map(row => [row.id, row]));
  for (const table of pin.tables) {
    lines.push(
      '',
      `## ${table.table}`,
      '',
      `**${table.equation}.** ${table.sourceTableStatementCandidates} source statement candidates reference this table before root tracing. Module PR: \`${table.modulePr}\`.`,
      '',
      '| Statement | Contexts | Entry/job origins | PENDING intended disposition |',
      '|---|---|---|---|'
    );
    for (const entry of table.entries.filter(
      entry => !entry.statement.startsWith('apps/backend/src/migrations/')
    )) {
      const row = statements.get(entry.statement);
      lines.push(
        `| ${cell(row.id)}${row.sink ? ` (sink: ${cell(row.sink)})` : ''} | ${cell(row.contexts.join(', '))} | ${cell(row.origins.join('; '))} | ${entry.intendedDisposition}; ${cell(entry.reason)} |`
      );
    }
    if (!table.runtimeCandidates)
      lines.push(
        '| none | no runtime root reached the table | all registered jobs and residual roots traced | administrative entries below remain PENDING |'
      );
    lines.push(
      '',
      `Administrative entries (${table.administrativeCandidates}); each is **PENDING → proven-unreachable**, owned by \`${table.modulePr}\`. The shared statement catalog below resolves each ID to its source SQL; the JSON repeats each table-specific disposition explicitly.`,
      '',
      table.entries
        .filter(entry => entry.statement.startsWith('apps/backend/src/migrations/'))
        .map(entry => `- \`${entry.statement}\``)
        .join('\n')
    );
  }
  lines.push(
    '',
    '## Administrative statement catalog',
    '',
    '| Statement | Source line | Possible target tables | Catalog expansion | SQL preview (full SQL and hash in JSON) |',
    '|---|---:|---|---|---|'
  );
  for (const row of pin.statements.filter(row =>
    row.contexts.includes('administrative-migration-candidate')
  ))
    lines.push(
      `| ${row.id} | ${row.line} | ${row.tables.join(', ')} | ${row.catalogExpansion ? 'all 22; pending proof' : 'resolved references'} | ${cell(row.sql.slice(0, 180))} |`
    );
  lines.push(
    '',
    '## Source dispatch boundaries',
    '',
    'The JSON also enumerates indirect callback calls encountered on the source trace. Callback arguments and defaults are followed at their callers; the immutable projector registry is expanded explicitly. These are source-analysis boundaries, not empirical dispatch evidence or accepted unreachability dispositions. Two unresolved migration SQL dispatchers are expanded by the administrative statement catalog; any other unresolved reachable raw SQL stops generation.',
    '',
    ...(pin.callbackBoundaries || []).map(
      row => `- ${row.file}:${row.line}: ${cell(row.expression)} — ${cell(row.resolution)}`
    ),
    '',
    '## Closure acceptance remains outstanding',
    '',
    pin.closureRule,
    '',
    'No three-run runtime mutation is asserted here. The census mutation removes one users entry from the expected pin, requires exactly the users row to fail while the other 21 pass, then restores the file and verifies its SHA-256. Runtime conversion, migration-736 routine and unreachability tests belong in the owning module PR. The restrictive policy retains the plan4NewRelationRlsContextMatrix shape.',
    ''
  );
  return lines.join('\n');
}
