import { readFileSync } from 'node:fs';

import {
  CLINICAL_CONTINUITY_ACTION_CATALOG,
  CLINICAL_CONTINUITY_ACTION_IDS,
  CLINICAL_CONTINUITY_UNKNOWN_ACTION_FALLBACK
} from '../../config/clinicalContinuityActionCatalog.js';
import {
  __testing__,
  assertClinicalContinuityActionBindings,
  resolveClinicalContinuityActionBinding,
  resolveClinicalContinuityRouteTemplate
} from '../../services/downtime/clinicalContinuityActionBindingRegistry.js';

function copies(values) {
  return values.map(value => ({ ...value }));
}

function expectBindingFailure(run, actionId, text) {
  expect(run).toThrow(new RegExp(`Clinical continuity binding ${actionId}:.*${text}`));
}

describe('clinical continuity action binding boot assertion', () => {
  const expected = copies(__testing__.expectedBindings);

  test('succeeds for the approved 17-action catalogue and two exact bindings', () => {
    expect(
      assertClinicalContinuityActionBindings({
        expectedBindings: expected,
        mountedBindings: copies(expected)
      })
    ).toEqual({
      approvedActionCount: 17,
      executableBindingCount: 2
    });
  });

  test('fails closed on a typoed action ID and names it', () => {
    const mounted = copies(expected);
    mounted[0].actionId = 'emr.nursing_note.draft.stroe';
    expectBindingFailure(
      () =>
        assertClinicalContinuityActionBindings({
          expectedBindings: expected,
          mountedBindings: mounted
        }),
      'emr.nursing_note.draft.stroe',
      'not in the approved catalogue'
    );
  });

  test('fails closed on a duplicate binding and names it', () => {
    const mounted = [...copies(expected), { ...expected[0] }];
    expectBindingFailure(
      () =>
        assertClinicalContinuityActionBindings({
          expectedBindings: expected,
          mountedBindings: mounted
        }),
      expected[0].actionId,
      'duplicate mounted'
    );
  });

  test('fails closed on a missing binding and names it', () => {
    expectBindingFailure(
      () =>
        assertClinicalContinuityActionBindings({
          expectedBindings: expected,
          mountedBindings: [expected[1]]
        }),
      expected[0].actionId,
      'missing mounted'
    );
  });

  test('fails closed on the wrong method and names it', () => {
    const mounted = copies(expected);
    mounted[0].method = 'POST';
    expectBindingFailure(
      () =>
        assertClinicalContinuityActionBindings({
          expectedBindings: expected,
          mountedBindings: mounted
        }),
      expected[0].actionId,
      'method mismatch'
    );
  });

  test('fails closed on the wrong handler and names it', () => {
    const mounted = copies(expected);
    mounted[0].handler = () => {};
    expectBindingFailure(
      () =>
        assertClinicalContinuityActionBindings({
          expectedBindings: expected,
          mountedBindings: mounted
        }),
      expected[0].actionId,
      'handler reference mismatch'
    );
  });

  test('fails closed on a schema mismatch and names it', () => {
    const mounted = copies(expected);
    mounted[0].schema = { ...mounted[0].schema };
    expectBindingFailure(
      () =>
        assertClinicalContinuityActionBindings({
          expectedBindings: expected,
          mountedBindings: mounted
        }),
      expected[0].actionId,
      'schema reference mismatch'
    );
  });

  test('fails closed when a default-deny action gains an executable binding', () => {
    const actionId = 'op.prescription.draft';
    const mounted = [...copies(expected), { ...expected[0], actionId }];
    expectBindingFailure(
      () =>
        assertClinicalContinuityActionBindings({
          expectedBindings: expected,
          mountedBindings: mounted
        }),
      actionId,
      'unexpected executable action'
    );
  });

  test('fails closed on non-disjoint same-route discriminators and names the action', () => {
    const changedExpected = copies(expected);
    const changedMounted = copies(expected);
    changedExpected[1].schema = changedExpected[0].schema;
    changedMounted[1].schema = changedExpected[0].schema;
    expectBindingFailure(
      () =>
        assertClinicalContinuityActionBindings({
          expectedBindings: changedExpected,
          mountedBindings: changedMounted
        }),
      expected[1].actionId,
      'non-disjoint discriminator'
    );
  });

  test('succeeds against the registrations mounted by the real route module', async () => {
    await import('../../routes/emr/clinicalNotesRoutes.js');
    expect(assertClinicalContinuityActionBindings()).toEqual({
      approvedActionCount: 17,
      executableBindingCount: 2
    });
    expect(
      resolveClinicalContinuityActionBinding({
        actionId: 'emr.nursing_note.draft.store',
        method: 'PUT',
        path: '/api/v1/emr/notes/draft'
      })
    ).toEqual(expect.objectContaining({ method: 'PUT' }));
    expect(
      resolveClinicalContinuityActionBinding({
        actionId: 'emr.nursing_note.draft.store',
        method: 'POST',
        path: '/api/v1/emr/notes/draft'
      })
    ).toBeNull();
    expect(
      resolveClinicalContinuityRouteTemplate({
        actionId: 'mar.administration.backfill',
        method: 'POST',
        path: '/api/v1/clinical/mar/12345/administer-with-scan'
      })
    ).toBe('/api/v1/clinical/mar/:id/administer-with-scan');
    expect(
      resolveClinicalContinuityActionBinding({
        actionId: 'mar.administration.backfill',
        method: 'POST',
        path: '/api/v1/clinical/mar/12345/administer-with-scan'
      })
    ).toBeNull();
  });
});

describe('countersigned C0.2 action census', () => {
  test('derives the 17 catalogue IDs and unknown fallback from section 6', () => {
    const inventory = readFileSync(
      new URL(
        '../../../../../docs/continuity/c0-2-action-route-inventory.md',
        import.meta.url
      ),
      'utf8'
    );
    const section = inventory
      .split('## 6. Proposed default-deny registry')[1]
      .split('## 7. Explicit contradiction and gap list')[0];
    const sourceIds = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);

    expect(sourceIds).toHaveLength(18);
    expect(sourceIds).toEqual([
      ...CLINICAL_CONTINUITY_ACTION_IDS,
      CLINICAL_CONTINUITY_UNKNOWN_ACTION_FALLBACK.actionId
    ]);
  });
});
