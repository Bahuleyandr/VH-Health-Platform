import { appendPharmacyFundingAuthorityStateTx } from '../../services/billing/billingV2Service.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_UID = '20000000-0000-4000-8000-000000000002';
const ITEMS_SHA256 = 'a'.repeat(64);

function concurrentFundingStore() {
  const events = [];
  let nextId = 1;
  let lockTail = Promise.resolve();

  async function transaction(callback) {
    let releaseLock = null;
    const tx = {
      async $queryRawUnsafe(sql, ...params) {
        if (sql.includes('pg_advisory_xact_lock')) {
          const prior = lockTail;
          lockTail = new Promise((resolve) => { releaseLock = resolve; });
          await prior;
          return [{ pg_advisory_xact_lock: null }];
        }
        if (sql.includes('FROM pharmacy_funding_decision_events event')) {
          const [tenantId, orderId, orderVersion, orderItemsSha256] = params;
          const superseded = new Set(events.map((event) => event.supersedes_event_id)
            .filter((id) => id != null));
          return events.filter((event) => event.tenant_id === tenantId
            && event.pharmacy_order_id === orderId
            && event.source_authority_version === orderVersion
            && event.source_authority_sha256 === orderItemsSha256
            && event.authority_generation != null
            && !superseded.has(event.id))
            .sort((left, right) => Number(right.authority_generation - left.authority_generation))
            .slice(0, 2);
        }
        if (sql.includes('INSERT INTO pharmacy_funding_decision_events')) {
          const row = {
            id: BigInt(nextId++),
            tenant_id: params[0],
            facility_id: params[1],
            pharmacy_order_id: params[2],
            admission_id: params[3],
            event_type: params[4],
            source_authority_version: params[5],
            source_authority_sha256: params[6],
            invoice_id: params[7],
            invoice_item_id: params[8],
            tpa_claim_id: params[9],
            billing_payment_id: params[10],
            task_id: params[11],
            amount: params[12],
            command_key_sha256: params[13],
            evidence: JSON.parse(params[14]),
            recorded_by: params[15],
            authority_generation: BigInt(params[16]),
            supersedes_event_id: params[17] == null ? null : BigInt(params[17]),
          };
          events.push(row);
          return [row];
        }
        throw new Error(`Unexpected funding-chain SQL: ${sql}`);
      },
    };
    try {
      return await callback(tx);
    } finally {
      releaseLock?.();
    }
  }

  return { events, transaction };
}

function authority() {
  return {
    tenantId: TENANT_ID,
    facilityId: 7,
    orderId: 71,
    orderVersion: 3,
    orderItemsSha256: ITEMS_SHA256,
    actorUid: ACTOR_UID,
  };
}

function append(store, eventType, evidence) {
  return store.transaction((tx) => appendPharmacyFundingAuthorityStateTx(tx, {
    authority: authority(),
    eventType,
    admissionId: null,
    invoiceId: 81,
    invoiceItemId: 91,
    amount: 125,
    evidence,
  }));
}

describe('pharmacy funding event current-authority chain', () => {
  it('serializes concurrent first-generation writers into one insert and one replay', async () => {
    const store = concurrentFundingStore();
    const evidence = { contract: 'pharmacy_funding_authority_v1', payment_ids: [1] };

    const results = await Promise.all([
      append(store, 'FUNDING_RESOLVED', evidence),
      append(store, 'FUNDING_RESOLVED', evidence),
    ]);

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      event_type: 'FUNDING_RESOLVED',
      authority_generation: 1n,
      supersedes_event_id: null,
    });
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
  });

  it('keeps one current head across invalidation and a concurrent replacement replay', async () => {
    const store = concurrentFundingStore();
    await append(store, 'FUNDING_RESOLVED', {
      contract: 'pharmacy_funding_authority_v1', payment_ids: [1],
    });
    await append(store, 'AUTHORITY_INVALIDATED', {
      contract: 'pharmacy_funding_authority_state_v1', invalidation_reason: 'payment_reversed',
    });

    const replacement = {
      contract: 'pharmacy_funding_authority_v1', payment_ids: [2],
    };
    const results = await Promise.all([
      append(store, 'FUNDING_RESOLVED', replacement),
      append(store, 'FUNDING_RESOLVED', replacement),
    ]);

    expect(store.events.map((event) => event.event_type)).toEqual([
      'FUNDING_RESOLVED', 'AUTHORITY_INVALIDATED', 'FUNDING_RESOLVED',
    ]);
    expect(store.events.map((event) => event.authority_generation)).toEqual([1n, 2n, 3n]);
    expect(store.events.map((event) => event.supersedes_event_id)).toEqual([null, 1n, 2n]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
  });
});
