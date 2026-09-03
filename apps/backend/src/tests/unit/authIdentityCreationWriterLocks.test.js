import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(src, relativePath), 'utf8');

// Decision 2026-09-03 (follow-up to the #968 review): identity CREATION takes no
// lifecycle lock. The create and any lock run inside ONE transaction, so MVCC
// hides the new row from every other session until commit whatever the
// statement order, and every identity uid is database-generated
// (gen_random_uuid()), so no concurrent transaction can name it before commit.
// A lock taken after the INSERT therefore protected nothing, and a lock taken
// before it would only be meaningful with an application-known uid, which no
// writer has. The lifecycle lock is for mutations of identities that already
// have committed, discoverable rows (see withAuthIdentityLifecycleLocks in
// utils/tokenBlacklist.js).
//
// This contract must not be satisfiable by deleting a writer: every entry pins
// that creation STILL happens (exact insert/create count, on a transaction
// client, inside prisma.$transaction or setTenantTx) AND that the only
// lifecycle locks left in the file are the mutation-path ones, keyed on an
// identity that was looked up, never on one that was just created.

// [file, expected `INSERT INTO users` count, remaining lifecycle-lock argument lists]
const RAW_USER_WRITERS = [
  ['controllers/appointment/appointmentCrudController.js', 1, []],
  ['controllers/appointment/appointmentDocumentController.js', 1, []],
  ['controllers/appointment/appointmentWorkflowController.js', 2, []],
  ['controllers/investigation/bookingController.js', 1, []],
  ['controllers/patient/patientSearchController.js', 1, []],
  ['services/abdm/abdmShareIntakeService.js', 1, []],
  ['services/auth/firebaseAuthService.js', 2, []],
  ['services/emr/admissionService.js', 1, []],
  ['services/maternity/maternityService.js', 1, []],
  ['services/migrationToolkit/migrationToolkitService.js', 1, []],
  ['services/pharmacy/counterSaleService.js', 1, []],
  // unlinkDependent locks guardian + dependent before revoking the tuple: a mutation.
  ['services/user/dependentsService.js', 1, ['linkedGuardianUid, dependentUid']],
];

// [file, expected `tx.users.create(` count, remaining lifecycle-lock argument lists]
const ORM_USER_WRITERS = [
  ['routes/auth/devAuthRoutes.js', 1, []],
  ['services/staff/staffService.js', 1, []],
  // changeUserStatus and deleteOwnAccount lock a looked-up identity: mutations.
  ['services/user/userService.js', 1, ['user.uid', 'user.uid']],
];

const LOCK_CALL = /withAuthIdentityLifecycleLocks\(\s*(?:tx|db|client),\s*\[([^\]]*)\]/g;

function matchIndexes(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match.index);
}

function remainingLockArguments(source) {
  return [...source.matchAll(LOCK_CALL)].map((match) => match[1].replace(/\s+/g, ' ').trim());
}

function expectRawWritesOnTransactionClient(source, relativePath, writeIndexes) {
  for (const writeIndex of writeIndexes) {
    const queryIndex = source.lastIndexOf('$queryRawUnsafe', writeIndex);
    expect(queryIndex).toBeGreaterThanOrEqual(0);
    const queryReceiver = relativePath === 'services/auth/firebaseAuthService.js'
      ? /\bclient\.$/
      : /\b(?:tx|db)\.$/;
    expect(source.slice(Math.max(0, queryIndex - 16), queryIndex)).toMatch(queryReceiver);
  }
}

// A creation site is the text from its INSERT ... RETURNING (raw) or .create( (ORM)
// through the statement that consumes the returned row. No lifecycle lock may
// appear in that stretch. The windows are generous enough to cover the longest
// parameter list in the tree and short enough not to reach the next function.
const RAW_CREATION_WINDOW = 600;
const ORM_CREATION_WINDOW = 900;

function expectNoLockAfterRawCreation(source, writeIndexes) {
  for (const writeIndex of writeIndexes) {
    const returningIndex = source.indexOf('RETURNING', writeIndex);
    expect(returningIndex).toBeGreaterThan(writeIndex);
    const created = source.slice(returningIndex, returningIndex + RAW_CREATION_WINDOW);
    expect(created).not.toContain('withAuthIdentityLifecycleLocks(');
  }
}

function expectNoLockAfterOrmCreation(source, createIndexes) {
  for (const createIndex of createIndexes) {
    const created = source.slice(createIndex, createIndex + ORM_CREATION_WINDOW);
    expect(created).not.toContain('withAuthIdentityLifecycleLocks(');
  }
}

describe('auth identity creation writers take no lifecycle lock', () => {
  it.each(RAW_USER_WRITERS)(
    '%s still inserts users on a transaction client and locks nothing it just created',
    (relativePath, expectedWrites, remainingLocks) => {
      const source = read(relativePath);
      const writeIndexes = matchIndexes(source, /INSERT\s+INTO\s+users\b/gi);
      expect(writeIndexes).toHaveLength(expectedWrites);
      expect(source).toMatch(/(?:prisma\.\$transaction|setTenantTx)\s*\(/);
      expectRawWritesOnTransactionClient(source, relativePath, writeIndexes);
      expectNoLockAfterRawCreation(source, writeIndexes);
      expect(remainingLockArguments(source)).toEqual(remainingLocks);
      if (remainingLocks.length === 0) {
        expect(source).not.toContain('withAuthIdentityLifecycleLocks');
      }
    },
  );

  it.each(ORM_USER_WRITERS)(
    '%s still creates through the transaction client and locks nothing it just created',
    (relativePath, expectedWrites, remainingLocks) => {
      const source = read(relativePath);
      const createIndexes = matchIndexes(source, /\btx\.users\.create\s*\(/g);
      expect(createIndexes).toHaveLength(expectedWrites);
      expect(source).not.toMatch(/\bprisma\.users\.create\s*\(/);
      expect(source).toMatch(/(?:prisma\.\$transaction|setTenantTx)\s*\(/);
      expectNoLockAfterOrmCreation(source, createIndexes);
      expect(remainingLockArguments(source)).toEqual(remainingLocks);
      if (remainingLocks.length === 0) {
        expect(source).not.toContain('withAuthIdentityLifecycleLocks');
      }
    },
  );

  it('authService creates users and admins through one transactional helper with no lock', () => {
    const source = read('services/auth/authService.js');
    const helperIndexes = matchIndexes(source, /\btx\[realm\]\.create\s*\(/g);
    expect(helperIndexes).toHaveLength(1);
    // The users realm runs inside setTenantTx (pre-auth callers have no tenant
    // context and public.users rejects unscoped inserts under RLS, see
    // preAuthIdentityCreationTenantScope.test.js); admins keeps the bare
    // transaction. Neither takes a lifecycle lock.
    expect(source).toMatch(/async function createIdentityTx\(realm, args, \{ tenantId = null \} = \{\}\)[\s\S]*?prisma\.\$transaction\(/);
    expect(source).not.toMatch(/createIdentityWithLifecycleLock/);
    expect(source.match(/createIdentityTx\('(?:users|admins)'/g)).toHaveLength(4);
    expectNoLockAfterOrmCreation(source, helperIndexes);
    // deactivateAdmin and reactivateAdmin lock a looked-up admin: mutations.
    expect(remainingLockArguments(source)).toEqual(['String(adminId)', 'String(adminId)']);
  });

  it('SCIM creates staff and admin identities without a lock and still locks existing ones', () => {
    const source = read('services/auth/scimProvisioningService.js');
    const userWrites = matchIndexes(source, /INSERT\s+INTO\s+users\b/gi);
    const adminWrites = matchIndexes(source, /INSERT\s+INTO\s+admins\b/gi);
    expect(userWrites).toHaveLength(1);
    expect(adminWrites).toHaveLength(1);
    expectRawWritesOnTransactionClient(source, 'services/auth/scimProvisioningService.js', [
      ...userWrites,
      ...adminWrites,
    ]);
    expectNoLockAfterRawCreation(source, [...userWrites, ...adminWrites]);
    // deactivateScimIdentityTx and both `existing` branches lock looked-up identities.
    expect(remainingLockArguments(source)).toEqual(['uid', 'existing.uid', 'existing.uid']);
  });

  it('keeps the walk-in anchor public path transactional when no tx is supplied', () => {
    const source = read('services/pharmacy/counterSaleService.js');
    const wrapper = source.slice(source.indexOf('export async function ensureWalkInAnchorUid'));
    expect(wrapper).toContain("typeof db.$transaction === 'function'");
    expect(wrapper).toContain('db.$transaction((tx) => ensureWalkInAnchorUidTx(tenant, tx))');
  });

  it('no identity creation anywhere in src is followed by a lifecycle lock', () => {
    const files = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'tests' && entry.name !== 'migrations') walk(full);
        } else if (entry.name.endsWith('.js')) {
          files.push(full);
        }
      }
    };
    walk(src);

    let creationSites = 0;
    const offenders = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const raw = matchIndexes(source, /INSERT\s+INTO\s+(?:users|admins)\b/gi);
      const orm = matchIndexes(source, /\.(?:users|admins|\[realm\])\.create\s*\(/g);
      creationSites += raw.length + orm.length;
      for (const writeIndex of raw) {
        const returningIndex = source.indexOf('RETURNING', writeIndex);
        const start = returningIndex > writeIndex ? returningIndex : writeIndex;
        if (source.slice(start, start + RAW_CREATION_WINDOW).includes('withAuthIdentityLifecycleLocks(')) {
          offenders.push(`${path.relative(src, file)}@${writeIndex}`);
        }
      }
      for (const createIndex of orm) {
        if (source.slice(createIndex, createIndex + ORM_CREATION_WINDOW).includes('withAuthIdentityLifecycleLocks(')) {
          offenders.push(`${path.relative(src, file)}@${createIndex}`);
        }
      }
    }
    // The sweep is only meaningful if it actually saw the writers above.
    expect(creationSites).toBeGreaterThanOrEqual(19);
    expect(offenders).toEqual([]);
  });
});
