import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectBypassReachers } from '../../../scripts/lib/rlsBypassReacherSource.mjs';
import { buildPin, migrationStatements } from '../../../scripts/lib/rlsBypassReacherPin.mjs';

let fixtureRoot;
let files;
const put = (name, text) => {
  const target = path.join(fixtureRoot, 'apps/backend', name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
  files.push(target);
};

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'rls-reacher-source-'));
  files = [];
  put(
    'src/lib/prisma.js',
    `export const prisma = {}; export const prismaReadOnly = {};
export function setTenantTx(tenant, callback, options) { return callback(prisma); }
export function runWithSuperAdmin(callback) { return callback(); }
`
  );
  put(
    'src/services/queries.js',
    `import { prisma, prismaReadOnly, setTenantTx } from '../lib/prisma.js';
export function raw(tx, sql) { return tx.$queryRawUnsafe(sql); }
const CONTRACTS = { patients: { sql: 'SELECT uid FROM users' }, clinicians: { sql: 'SELECT id FROM doctors' } };
function queryFor(type) { const contract = CONTRACTS[type]; const sql = contract.sql; return { sql }; }
export async function job() {
  await prisma.$queryRawUnsafe('SELECT uid FROM users'); await prisma.$queryRawUnsafe('SELECT id FROM appointments');
  await setTenantTx('tenant-A', tx => raw(tx, 'SELECT id FROM staff'));
  await setTenantTx(null, tx => raw(tx, 'SELECT id FROM appointments'), { superAdmin: true });
  const { sql } = queryFor('patients'); await raw(prisma, sql);
  await prisma.$queryRawUnsafe('WITH users AS (SELECT id FROM staff) SELECT * FROM users');
  await dynamicWrite('users');
  await raw(prisma, 'SELECT uid FROM users'); await raw(prisma, 'SELECT id FROM staff');
}
function dynamicWrite(realm) { return prisma[realm].create({ data: {} }); }
export function requestOnly() { return prisma.$queryRawUnsafe('SELECT id FROM report_updates'); }
export function replicaOnly() { return prismaReadOnly.$queryRawUnsafe('SELECT id FROM wards'); }
export function replicaTxOnly() { return setTenantTx('tenant-A', tx => raw(tx, 'SELECT id FROM e_prescriptions'), { readOnly: true }); }
export function bareOnly() { return prisma.$transaction(tx => tx.$executeRawUnsafe('DELETE FROM leave_applications')); }
export function timerOnly() { setInterval(() => prisma.$queryRawUnsafe('SELECT id FROM staff_attendance'), 1000); }
`
  );
  put(
    'src/utils/scheduler.js',
    `import { job } from '../services/queries.js';
function withJobLock(name, callback) { return callback; }
function registerCron(schedule, callback) { return callback; }
if (process.env.FEATURE === 'true') registerCron('* * * * *', withJobLock('fixture-job', job));
`
  );
  put(
    'src/routes/public.js',
    `import { prisma } from '../lib/prisma.js';
const router = {}; router.get('/', () => prisma.$queryRawUnsafe('SELECT id FROM incident_reports'));
export default router;`
  );
  put(
    'src/app.js',
    `import router from './routes/public.js';
import { requestOnly } from './services/queries.js';
const app = {}; const tenantRlsMiddleware = () => {};
app.use('/public', router); app.use(tenantRlsMiddleware); app.get('/private', requestOnly);`
  );
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

let trace;
beforeAll(() => {
  trace = collectBypassReachers(fixtureRoot, { sourceFiles: files });
});

it('counts literal registrations across feature guards, separately from wrapper calls', () => {
  expect(trace.registrations).toHaveLength(1);
  expect(trace.registrations[0]).toMatchObject({
    job: 'fixture-job',
    conditions: ["process.env.FEATURE === 'true'"],
    loop: false
  });
  expect(trace.roots.filter(row => row.kind === 'withJobLock')).toHaveLength(1);
  expect(trace.registrationErrors).toEqual([]);
});

it('follows imported jobs and SQL dispatchers while preserving tenant and explicit bypass transactions', () => {
  expect(
    trace.reachers.some(row => row.table === 'users' && row.origins.includes('job:fixture-job'))
  ).toBe(true);
  expect(
    trace.reachers.some(row => row.table === 'staff' && row.context === 'tenant' && row.sink)
  ).toBe(true);
  expect(
    trace.reachers.some(row => row.table === 'appointments' && row.context === 'bypass' && row.sink)
  ).toBe(true);
  const sameLine = trace.sql.filter(
    row => row.file.endsWith('/services/queries.js') && row.line === 6
  );
  expect(sameLine).toHaveLength(2);
  expect(new Set(sameLine.map(row => row.id)).size).toBe(2);
  const sameLineWrappers = trace.sql.filter(
    row => row.file.endsWith('/services/queries.js') && row.line === 12 && row.sink
  );
  expect(sameLineWrappers).toHaveLength(2);
  expect(new Set(sameLineWrappers.map(row => row.id)).size).toBe(2);
});

it('resolves destructured SQL maps and excludes a shadowing CTE name', () => {
  const mapCalls = trace.sql.filter(
    row =>
      row.sink &&
      row.sql.includes('SELECT uid FROM users') &&
      row.sql.includes('SELECT id FROM doctors')
  );
  expect(mapCalls.length).toBeGreaterThan(0);
  const cte = trace.sql.find(row => row.sql.startsWith('WITH users AS'));
  expect(cte.tables).toEqual(['staff']);
});

it('includes replica, replica transaction, bare transaction and timer residuals without making ordinary requests roots', () => {
  for (const table of ['wards', 'e_prescriptions', 'leave_applications', 'staff_attendance'])
    expect(trace.reachers.some(row => row.table === table)).toBe(true);
  expect(trace.reachers.some(row => row.table === 'report_updates')).toBe(false);
  expect(
    trace.reachers.some(
      row => row.table === 'incident_reports' && row.context === 'pre-global-tenant-route'
    )
  ).toBe(true);
  expect(trace.reachers.some(row => row.table === 'users' && row.method === 'create')).toBe(true);
});

it('refuses loop registrations instead of silently treating one token as one job', () => {
  const scheduler = files.find(file => file.endsWith('scheduler.js'));
  const previous = readFileSync(scheduler, 'utf8');
  try {
    writeFileSync(
      scheduler,
      `${previous}\nfor (const name of ['a','b']) registerCron('* * * * *', withJobLock(name, () => {}));\n`
    );
    const loopTrace = collectBypassReachers(fixtureRoot, { sourceFiles: files });
    expect(loopTrace.registrationErrors).toHaveLength(1);
    expect(() => buildPin(loopTrace, { statements: [], manifest: [], population: 0 })).toThrow(
      'multiplicity'
    );
  } finally {
    writeFileSync(scheduler, previous);
  }
});

it('expands split migration statements and catalog-driven SQL instead of counting dispatcher lines', () => {
  put(
    'src/migrations/001_fixture.sql',
    `SELECT uid FROM users; SELECT id FROM doctors;
DO $$ BEGIN FOR r IN SELECT relname FROM pg_class LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.relname); END LOOP; END $$;`
  );
  const migration = migrationStatements(fixtureRoot, trace.targetTables);
  expect(migration.population).toBe(3);
  expect(migration.statements).toHaveLength(3);
  expect(migration.statements[0]).toMatchObject({ statement: 1, line: 1, tables: ['users'] });
  expect(migration.statements[2].tables).toEqual(trace.targetTables);
  const pin = buildPin(trace, migration);
  for (const table of pin.tables) {
    expect(table.reachers).toBe(table.entries.length);
    expect(table.reachers).toBe(table.dispositioned + table.pending);
    expect(table.dispositioned).toBe(0);
    for (const entry of table.entries)
      expect(entry).toMatchObject({
        status: 'PENDING',
        modulePr: expect.stringMatching(/^feat\/rls-t2-/),
        intendedDisposition: expect.stringMatching(/^(converted|736-routine|proven-unreachable)$/)
      });
  }
});
