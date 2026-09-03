import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(src, relativePath), 'utf8');

const RAW_WRITERS = [
  ['controllers/appointment/appointmentCrudController.js', 1],
  ['controllers/appointment/appointmentDocumentController.js', 1],
  ['controllers/appointment/appointmentWorkflowController.js', 2],
  ['controllers/investigation/bookingController.js', 1],
  ['controllers/patient/patientSearchController.js', 1],
  ['services/abdm/abdmShareIntakeService.js', 1],
  ['services/auth/firebaseAuthService.js', 2],
  ['services/emr/admissionService.js', 1],
  ['services/maternity/maternityService.js', 1],
  ['services/migrationToolkit/migrationToolkitService.js', 1],
  ['services/pharmacy/counterSaleService.js', 1],
  ['services/user/dependentsService.js', 1],
];

const ORM_WRITERS = [
  'routes/auth/devAuthRoutes.js',
  'services/staff/staffService.js',
];

function matchIndexes(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match.index);
}

function expectOneLockAfterEachWrite(source, writeIndexes) {
  writeIndexes.forEach((writeIndex, index) => {
    const nextWrite = writeIndexes[index + 1] ?? source.length;
    const lockIndex = source.indexOf('withAuthIdentityLifecycleLocks(', writeIndex);
    expect(lockIndex).toBeGreaterThan(writeIndex);
    expect(lockIndex).toBeLessThan(nextWrite);
  });
}

describe('auth identity creation writer lifecycle locks', () => {
  it.each(RAW_WRITERS)(
    '%s keeps every users insert on a transaction client and locks its returned uid',
    (relativePath, expectedWrites) => {
      const source = read(relativePath);
      const writeIndexes = matchIndexes(source, /INSERT\s+INTO\s+users\b/gi);
      expect(writeIndexes).toHaveLength(expectedWrites);
      expect(source).toContain('withAuthIdentityLifecycleLocks');
      expect(source).toMatch(/(?:prisma\.\$transaction|setTenantTx)\s*\(/);

      for (const writeIndex of writeIndexes) {
        const queryIndex = source.lastIndexOf('$queryRawUnsafe', writeIndex);
        expect(queryIndex).toBeGreaterThanOrEqual(0);
        const queryReceiver = relativePath === 'services/auth/firebaseAuthService.js'
          ? /\bclient\.$/
          : /\b(?:tx|db)\.$/;
        expect(source.slice(Math.max(0, queryIndex - 16), queryIndex)).toMatch(queryReceiver);
      }
      if (relativePath === 'services/auth/firebaseAuthService.js') {
        expect(source.match(/\n\s+tx,\n\s+\);\n\s+return withAuthIdentityLifecycleLocks/g))
          .toHaveLength(expectedWrites);
      }
      expectOneLockAfterEachWrite(source, writeIndexes);
    },
  );

  it.each(ORM_WRITERS)(
    '%s creates through the transaction client and locks the returned uid',
    (relativePath) => {
      const source = read(relativePath);
      const writeIndexes = matchIndexes(source, /\btx\.users\.create\s*\(/g);
      expect(writeIndexes).toHaveLength(1);
      expect(source).not.toMatch(/\bprisma\.users\.create\s*\(/);
      // Either the bare interactive transaction or the tenant-scoped one:
      // `setTenantTx` is the stronger form (it sets app.current_tenant_id and
      // SET LOCAL ROLE first), so a writer that adopts it must still pass.
      expect(source).toMatch(/(?:prisma\.\$transaction|setTenantTx)\s*\(/);
      expectOneLockAfterEachWrite(source, writeIndexes);
    },
  );

  it('keeps the walk-in anchor public path transactional when no tx is supplied', () => {
    const source = read('services/pharmacy/counterSaleService.js');
    const wrapper = source.slice(source.indexOf('export async function ensureWalkInAnchorUid'));
    expect(wrapper).toContain("typeof db.$transaction === 'function'");
    expect(wrapper).toContain('db.$transaction((tx) => ensureWalkInAnchorUidTx(tenant, tx))');
  });
});
