import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(src, relativePath), 'utf8');

// Pre-auth identity creation runs BEFORE the tenant middleware, so nothing
// sets app.current_tenant_id for it. public.users carries the RESTRICTIVE
// explicit_tenant_context_753 policy (migration 758) under FORCE ROW LEVEL
// SECURITY (migration 272): with the GUC unset an INSERT is rejected 42501
// even when tenant_id is named. Production connects as an RLS-subject role
// (vhhealth_runtime), so every pre-auth users write MUST run inside
// setTenantTx(tenantId, ...), which sets the GUC (and the runtime role) as the
// transaction's first statements. A bare prisma.$transaction is not scoped:
// its tx client skips the tenant wrapper. CI cannot see any of this (its
// Postgres user is a superuser), which is why this is pinned at the source.
//
// Non-vacuous: every entry pins the exact number of creation sites, so the
// contract cannot be satisfied by deleting a writer.

function indexesOf(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match.index);
}

function nearestWrapperBefore(source, index) {
  const scoped = source.lastIndexOf('setTenantTx(', index);
  const bare = source.lastIndexOf('prisma.$transaction(', index);
  if (scoped < 0 && bare < 0) return null;
  return scoped > bare ? 'setTenantTx' : 'prisma.$transaction';
}

describe('pre-auth identity creation is tenant scoped', () => {
  it('firebaseAuthService creates users only inside setTenantTx(tenantId, ...)', () => {
    const source = read('services/auth/firebaseAuthService.js');
    const writes = indexesOf(source, /INSERT\s+INTO\s+users\b/gi);
    expect(writes).toHaveLength(2);
    for (const writeIndex of writes) {
      expect(nearestWrapperBefore(source, writeIndex)).toBe('setTenantTx');
      const wrapperIndex = source.lastIndexOf('setTenantTx(', writeIndex);
      expect(source.slice(wrapperIndex, wrapperIndex + 40)).toMatch(/^setTenantTx\(tenantId,/);
      // The tenant the row is stamped with is the one the transaction is scoped to.
      expect(source.slice(writeIndex, writeIndex + 120)).toMatch(/INSERT INTO users \(\s*tenant_id,/);
    }
    expect(source).toMatch(/import prisma, \{[^}]*\bsetTenantTx\b[^}]*\} from '\.\.\/\.\.\/lib\/prisma\.js'/);
  });

  it('authService creates users through its helper inside setTenantTx and stamps the tenant', () => {
    const source = read('services/auth/authService.js');
    const helperStart = source.indexOf('tx[realm].create(');
    expect(helperStart).toBeGreaterThan(0);
    const helperOpen = source.lastIndexOf('async function ', helperStart);
    const helper = source.slice(helperOpen, source.indexOf('\n}\n', helperStart) + 3);
    // users realm → tenant-scoped transaction with the tenant stamped on the row;
    // admins keep the bare transaction (admins carries only a permissive policy).
    expect(helper).toMatch(/realm === 'users'/);
    expect(helper).toMatch(/setTenantTx\(tenantId,/);
    expect(helper).toMatch(/tenant_id: tenantId/);
    expect(helper).toMatch(/prisma\.\$transaction\(/);

    const helperName = /async function (\w+)\(realm, args/.exec(source)?.[1];
    expect(helperName).toBeTruthy();
    const userCalls = indexesOf(source, new RegExp(`${helperName}\\('users'`, 'g'));
    const adminCalls = indexesOf(source, new RegExp(`${helperName}\\('admins'`, 'g'));
    expect(userCalls).toHaveLength(3);
    expect(adminCalls).toHaveLength(1);
    for (const callIndex of userCalls) {
      // Every users call passes the tenant it resolved from the request first.
      const methodStart = source.lastIndexOf('static async ', callIndex);
      const method = source.slice(methodStart, callIndex);
      expect(method).toMatch(/const tenantId = await resolveTenantForRequest\(req\)/);
      const call = source.slice(callIndex, source.indexOf(');', callIndex) + 2);
      expect(call).toMatch(/\{ tenantId \}\s*\)/);
    }
    expect(source).toMatch(/import \{[^}]*\bresolveTenantForRequest\b[^}]*\} from '\.\.\/tenant\/tenantService\.js'/);
  });

  it('the whole pre-auth surface runs inside a host-resolved tenant context', () => {
    // The explicit setTenantTx above covers the INSERTs (a bare transaction is
    // never proxied). Every other statement in the login/registration/OTP
    // handlers relies on the prisma proxy, which only scopes under an active
    // tenant context — and tenantContextMiddleware leaves req.tenantId null on
    // public routes, so the global tenantRlsMiddleware seeds an EMPTY context
    // there. The pre-auth mount must seed the host-resolved tenant itself.
    const app = read('app.js');
    const mount = "app.use('/api/v1/auth', preAuthTenantContextMiddleware);";
    const mountIndex = app.indexOf(mount);
    expect(mountIndex).toBeGreaterThan(0);
    expect(mountIndex).toBeLessThan(app.indexOf("app.use('/api/v1/auth', authRoutes);"));
    expect(app).toMatch(/import preAuthTenantContextMiddleware from '\.\/middleware\/preAuthTenantContextMiddleware\.js'/);

    const middleware = read('middleware/preAuthTenantContextMiddleware.js');
    expect(middleware).toMatch(/resolveTenantForRequest\(req\)/);
    expect(middleware).toMatch(/runInTenantContext\(tenantId, \(\) => next\(\)\)/);
    expect(middleware).not.toMatch(/req\.tenantId\s*=/);
  });

  it('the dev-only patient login creates users inside setTenantTx with the tenant stamped', () => {
    const source = read('routes/auth/devAuthRoutes.js');
    const creates = indexesOf(source, /\btx\.users\.create\s*\(/g);
    expect(creates).toHaveLength(1);
    expect(nearestWrapperBefore(source, creates[0])).toBe('setTenantTx');
    expect(source.slice(creates[0], creates[0] + 400)).toMatch(/tenant_id: tenantId/);
    expect(source).toMatch(/const tenantId = await resolveTenantForRequest\(req\)/);
  });
});
