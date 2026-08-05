import { jest } from '@jest/globals';

import { publishEvent } from '../../services/events/eventOutboxService.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const FACT_ID = '30000000-0000-4000-8000-000000000001';
const OCCURRED_AT = '2026-08-01T03:00:00.000Z';

function paperEvent(overrides = {}) {
  return {
    eventType: 'clinical_continuity.paper_fact.recorded',
    aggregateType: 'clinical_continuity_retrospective_fact',
    aggregateId: FACT_ID,
    patientUid: PATIENT_UID,
    tenantId: TENANT_ID,
    occurredAt: OCCURRED_AT,
    retrospectiveEffectDisposition: 'late_pending_only',
    payload: { effect_disposition: 'late_pending_only' },
    tx: { $queryRawUnsafe: jest.fn(async () => [{ id: '71' }]) },
    ...overrides,
  };
}

describe('event_outbox retrospective paper disposition', () => {
  test('writes the non-inbox late disposition only for the exact paper-fact shape', async () => {
    const options = paperEvent();
    await expect(publishEvent(options)).resolves.toEqual({ id: '71' });
    expect(options.tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(options.tx.$queryRawUnsafe.mock.calls[0].at(-1)).toBe('late_pending_only');
  });

  test.each([
    ['arbitrary event', { eventType: 'clinical_continuity.paper_fact.other' }, 'EVENT_OUTBOX_RETROSPECTIVE_DISPOSITION_INVALID'],
    ['arbitrary aggregate', { aggregateType: 'other_fact' }, 'EVENT_OUTBOX_RETROSPECTIVE_DISPOSITION_INVALID'],
    ['missing fact identity', { aggregateId: null }, 'EVENT_OUTBOX_RETROSPECTIVE_DISPOSITION_INVALID'],
    ['missing patient identity', { patientUid: null }, 'EVENT_OUTBOX_RETROSPECTIVE_DISPOSITION_INVALID'],
    ['missing tenant identity', { tenantId: null }, 'EVENT_OUTBOX_RETROSPECTIVE_DISPOSITION_INVALID'],
    ['missing occurrence', { occurredAt: null }, 'EVENT_OUTBOX_OCCURRENCE_REQUIRED'],
    ['signed exception', { retrospectiveEffectDisposition: 'signed_exception' }, 'EVENT_OUTBOX_RETROSPECTIVE_DISPOSITION_INVALID'],
    ['mixed recovery authority', {
      recovery: {
        inboxId: '40000000-0000-4000-8000-000000000001',
        fingerprint: 'a'.repeat(64),
        effectDisposition: 'late_pending_only',
      },
    }, 'EVENT_OUTBOX_RETROSPECTIVE_DISPOSITION_INVALID'],
  ])('rejects %s before SQL', async (_label, override, code) => {
    const options = paperEvent(override);
    await expect(publishEvent(options)).rejects.toMatchObject({
      code,
    });
    expect(options.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
