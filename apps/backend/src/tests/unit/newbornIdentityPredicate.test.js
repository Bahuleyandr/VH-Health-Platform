// D7 E-3 predicate unit coverage — classifyNewbornIdentityCandidate is the
// pure decision arm of the signed newborn-identity subject rule (decision
// record obgyn-d7-decision-record.md, SHA-256 E82EEC9A054CA3708A31F48568
// 818BB27F9986D8F5A02C37AF9407F4D5DB9562). Every arm must fail closed.

import {
  assertExclusiveNewbornLink,
  classifyNewbornIdentityCandidate,
  IDENTITY_MINTING_OUTCOMES,
  NEWBORN_OUTCOMES,
} from '../../services/maternity/newbornIdentity.js';

const MOTHER_UID = '6a3c9c8e-6a1f-4b04-8b3e-2f4d5e6a7b8c';
const INFANT_UID = '0f1e2d3c-4b5a-4968-8776-655443322110';

function validRow(overrides = {}) {
  return {
    uid: INFANT_UID,
    id: 4321,
    role: 'PATIENT',
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    merged_away: false,
    ...overrides,
  };
}

describe('classifyNewbornIdentityCandidate (signed E-3 predicate)', () => {
  test('accepts an active, undeleted, unmerged PATIENT that is not the mother', () => {
    expect(
      classifyNewbornIdentityCandidate(validRow(), { motherPatientUid: MOTHER_UID }),
    ).toEqual({ valid: true, reason: null });
  });

  test('rejects a missing row (not found in tenant) as not_found', () => {
    expect(classifyNewbornIdentityCandidate(null, { motherPatientUid: MOTHER_UID }))
      .toEqual({ valid: false, reason: 'not_found' });
    expect(classifyNewbornIdentityCandidate(undefined, {}))
      .toEqual({ valid: false, reason: 'not_found' });
  });

  test('rejects every non-PATIENT role', () => {
    for (const role of ['DOCTOR', 'NURSING_STAFF', 'ADMIN', 'SUPER_ADMIN', '', null]) {
      expect(classifyNewbornIdentityCandidate(validRow({ role }), {}))
        .toEqual({ valid: false, reason: 'not_patient' });
    }
  });

  test('rejects an inactive patient (is_active must be strictly true)', () => {
    for (const isActive of [false, null, undefined, 'true', 1]) {
      expect(classifyNewbornIdentityCandidate(validRow({ is_active: isActive }), {}))
        .toEqual({ valid: false, reason: 'inactive' });
    }
  });

  test('rejects soft-deleted patients on EITHER deletion marker', () => {
    expect(classifyNewbornIdentityCandidate(validRow({ is_deleted: true }), {}))
      .toEqual({ valid: false, reason: 'deleted' });
    expect(
      classifyNewbornIdentityCandidate(
        validRow({ deleted_at: new Date('2026-07-01T00:00:00Z') }),
        {},
      ),
    ).toEqual({ valid: false, reason: 'deleted' });
    expect(
      classifyNewbornIdentityCandidate(
        validRow({ is_deleted: true, deleted_at: new Date('2026-07-01T00:00:00Z') }),
        {},
      ),
    ).toEqual({ valid: false, reason: 'deleted' });
  });

  test('rejects a merged-away identity (executed patient_merge_requests probe)', () => {
    expect(classifyNewbornIdentityCandidate(validRow({ merged_away: true }), {}))
      .toEqual({ valid: false, reason: 'merged_away' });
  });

  test('mother-exclusion arm: the delivery mother uid is never a valid infant subject', () => {
    expect(
      classifyNewbornIdentityCandidate(
        validRow({ uid: MOTHER_UID }),
        { motherPatientUid: MOTHER_UID },
      ),
    ).toEqual({ valid: false, reason: 'mother_identity' });
    // Case-insensitive uid comparison.
    expect(
      classifyNewbornIdentityCandidate(
        validRow({ uid: MOTHER_UID.toUpperCase() }),
        { motherPatientUid: MOTHER_UID },
      ),
    ).toEqual({ valid: false, reason: 'mother_identity' });
  });

  test('without a mother uid in context the mother-exclusion arm does not fire', () => {
    expect(
      classifyNewbornIdentityCandidate(validRow({ uid: MOTHER_UID }), {}),
    ).toEqual({ valid: true, reason: null });
  });

  test('predicate arms are evaluated fail-closed in order (role before activity before deletion)', () => {
    expect(
      classifyNewbornIdentityCandidate(
        validRow({ role: 'DOCTOR', is_active: false, is_deleted: true }),
        {},
      ),
    ).toEqual({ valid: false, reason: 'not_patient' });
  });
});

describe('assertExclusiveNewbornLink (E-c1 exclusivity re-check)', () => {
  const TENANT = 'c1d2e3f4-0000-4000-8000-00000000c0de';

  function dbReturning(rows) {
    return { $queryRawUnsafe: async () => rows };
  }

  test('pre-link (newbornId null): any existing row for the uid rejects as already_linked', async () => {
    await expect(assertExclusiveNewbornLink({
      db: dbReturning([{ id: 5 }]),
      tenantId: TENANT,
      candidateUid: INFANT_UID,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'NEWBORN_IDENTITY_INVALID',
      details: { reason: 'already_linked' },
    });
    await expect(assertExclusiveNewbornLink({
      db: dbReturning([]),
      tenantId: TENANT,
      candidateUid: INFANT_UID,
    })).resolves.toBeUndefined();
  });

  test('post-link: rows other than the expected newborn reject as ambiguous_identity', async () => {
    // Structurally impossible in a post-577 database (A-1 unique index);
    // this arm keeps the write path fail-closed against residual pre-577
    // data, so it is pinned here with a stubbed db.
    await expect(assertExclusiveNewbornLink({
      db: dbReturning([{ id: 1 }, { id: 2 }]),
      tenantId: TENANT,
      candidateUid: INFANT_UID,
      newbornId: 1,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'NEWBORN_IDENTITY_INVALID',
      details: { reason: 'ambiguous_identity' },
    });
    await expect(assertExclusiveNewbornLink({
      db: dbReturning([{ id: 7 }]),
      tenantId: TENANT,
      candidateUid: INFANT_UID,
      newbornId: 3,
    })).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'ambiguous_identity' },
    });
    await expect(assertExclusiveNewbornLink({
      db: dbReturning([{ id: 3 }]),
      tenantId: TENANT,
      candidateUid: INFANT_UID,
      newbornId: 3,
    })).resolves.toBeUndefined();
  });
});

describe('signed outcome vocabulary (B-2)', () => {
  test('identity mints for live and early_neonatal_death only', () => {
    expect(IDENTITY_MINTING_OUTCOMES.has('live')).toBe(true);
    expect(IDENTITY_MINTING_OUTCOMES.has('early_neonatal_death')).toBe(true);
    expect(IDENTITY_MINTING_OUTCOMES.has('fresh_stillbirth')).toBe(false);
    expect(IDENTITY_MINTING_OUTCOMES.has('macerated_stillbirth')).toBe(false);
  });

  test('every minting outcome is part of the bounded outcome vocabulary', () => {
    for (const outcome of IDENTITY_MINTING_OUTCOMES) {
      expect(NEWBORN_OUTCOMES).toContain(outcome);
    }
    // Stillbirth arms present and stable.
    expect(NEWBORN_OUTCOMES).toEqual(
      expect.arrayContaining(['fresh_stillbirth', 'macerated_stillbirth']),
    );
  });
});
