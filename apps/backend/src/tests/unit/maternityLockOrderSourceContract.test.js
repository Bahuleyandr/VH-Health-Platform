import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const service = fs.readFileSync(
  path.join(sourceRoot, 'services/maternity/maternityService.js'),
  'utf8',
);

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

// The three shapes that take a row lock on `maternity_pregnancies`. The
// `[^`]` bound keeps the FOR UPDATE inside the SAME template literal, so a
// plain unlocked read (updatePregnancy resolves patient_uid that way, and it
// holds no row lock) does not match by borrowing a FOR UPDATE from a later
// statement.
const PREGNANCY_ROW_LOCK =
  /INSERT INTO maternity_pregnancies|UPDATE maternity_pregnancies|FROM maternity_pregnancies[^`]*?FOR UPDATE/;

// Index of the FOR UPDATE that belongs to the `users` row lock: the first
// FOR UPDATE that follows the first `FROM users`, within that same literal.
function usersRowLockIndex(body) {
  const match = /FROM users[^`]*?FOR UPDATE/.exec(body);
  expect(match).not.toBeNull();
  return match.index + match[0].length;
}

// Every writer that mutates a patient's pregnancy state locks the `users` row
// and a `maternity_pregnancies` row in the SAME transaction. They serialize
// instead of deadlocking only because all of them take `users` FIRST.
// The runtime test in maternity-atomicity.deep.test.js proves two of them
// settle, but it cannot prove the ORDER: it parks one writer after both of its
// locks are already held, so no lock cycle is constructible there and a writer
// with a flipped order would still pass it. This contract is what pins the
// order, and it fails the moment any writer below reaches a pregnancy row
// first.
const WRITERS = [
  {
    name: 'createPregnancy',
    start: 'export async function createPregnancy',
    end: 'export async function getPregnancy',
  },
  {
    name: 'updatePregnancy',
    start: 'export async function updatePregnancy',
    end: 'export async function recordAncVisit',
  },
  {
    name: 'recordAncVisit',
    start: 'export async function recordAncVisit',
    end: 'export async function runAncPreeclampsiaPostCommitCheck',
  },
  {
    name: 'recordDelivery',
    start: 'export async function recordDelivery',
    end: 'export async function getDelivery',
  },
];

describe('maternity pregnancy-writer lock order source contract', () => {
  it.each(WRITERS)(
    '$name locks the users row before it locks or writes a pregnancy row',
    ({ start, end }) => {
      const body = sliceBetween(service, start, end);
      const pregnancyLock = PREGNANCY_ROW_LOCK.exec(body);
      expect(pregnancyLock).not.toBeNull();
      expect(usersRowLockIndex(body)).toBeLessThan(pregnancyLock.index);
    },
  );

  it('every one of those writers takes the users row lock at all', () => {
    for (const { name, start, end } of WRITERS) {
      const body = sliceBetween(service, start, end);
      expect(`${name}:${/FROM users[^`]*?FOR UPDATE/.test(body)}`).toBe(`${name}:true`);
    }
  });
});
