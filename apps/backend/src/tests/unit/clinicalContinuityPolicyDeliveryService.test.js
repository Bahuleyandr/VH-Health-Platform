import { createHash } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';

import { __clinicalContinuityPolicyDeliveryRepresentationForTests } from '../../services/downtime/clinicalContinuityPolicyService.js';
import {
  __clinicalContinuityPolicyDeliveryContractForTests,
  ifNoneMatchMatches,
  loadClinicalContinuityPolicyDelivery
} from '../../services/downtime/clinicalContinuityPolicyDeliveryService.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TRUSTED_NOW = '2026-07-31T10:00:00.000Z';

function activeRow(overrides = {}) {
  return {
    lifecycle_state: 'active',
    policy_schema_version: 3,
    policy_version: 7n,
    effective_from: new Date('2026-07-31T09:00:00.000Z'),
    effective_until: new Date('2026-07-31T11:00:00.000Z'),
    supersedes_policy_id: null,
    policy_signing_key_id: 'policy-key-1',
    revoked_key_ids: [],
    policy_key_status: 'active',
    trusted_now: new Date(TRUSTED_NOW),
    ...overrides
  };
}

function harness(rows, policyOverrides = {}) {
  const query = jest.fn().mockResolvedValue(rows);
  const tx = { $queryRawUnsafe: query };
  const scopeRunner = jest.fn(async (tenantId, callback, options) => {
    expect(tenantId).toBe(TENANT);
    expect(options).toEqual({ readOnly: true, isolationLevel: 'RepeatableRead' });
    return callback(tx);
  });
  const canonicalBody = '{"format":"test"}';
  const policyLoader = jest.fn().mockResolvedValue({
    policySchemaVersion: 3,
    policyChecksum: 'a'.repeat(64),
    trustedNow: TRUSTED_NOW,
    policyDelivery: {
      byteLength: Buffer.byteLength(canonicalBody),
      canonicalBody,
      contentDigest: `sha-256=:${Buffer.alloc(32).toString('base64')}:`,
      envelopeSha256: 'b'.repeat(64),
      etag: `"pc-${'a'.repeat(64)}.rep-${'b'.repeat(64)}"`,
      mediaType: 'application/vnd.vhhealth.clinical-continuity-policy+json'
    },
    ...policyOverrides
  });
  return { query, scopeRunner, policyLoader };
}

describe('clinical continuity policy delivery service', () => {
  it('builds the exact canonical representation consumed by the delivery path', () => {
    const policyChecksum = 'a'.repeat(64);
    const representation = __clinicalContinuityPolicyDeliveryRepresentationForTests.build({
      policyId: '55555555-5555-4555-8555-555555555555',
      payload: {
        actionRegistryChecksum: 'b'.repeat(64),
        actionRegistryVersion: '7',
        policyChecksum,
        policySchemaVersion: 3
      },
      signature: Buffer.alloc(64).toString('base64')
    });

    const envelope = JSON.parse(representation.canonicalBody);
    expect(Object.keys(envelope).sort()).toEqual(['format', 'payload', 'policyId', 'signature']);
    expect(envelope.payload).toMatchObject({
      actionRegistryChecksum: 'b'.repeat(64),
      actionRegistryVersion: '7',
      policyChecksum,
      policySchemaVersion: 3
    });
    expect(createHash('sha256').update(representation.canonicalBody).digest('hex')).toBe(
      representation.envelopeSha256
    );
    expect(representation.byteLength).toBe(Buffer.byteLength(representation.canonicalBody));
  });

  it('selects and returns one verified representation in one read transaction', async () => {
    const { query, scopeRunner, policyLoader } = harness([activeRow()]);

    const delivery = await loadClinicalContinuityPolicyDelivery({
      tenantId: TENANT,
      facilityId: 41,
      scopeRunner,
      policyLoader
    });

    expect(delivery.body.toString('utf8')).toBe('{"format":"test"}');
    expect(delivery.trustedNow).toBe(TRUSTED_NOW);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('clinical_continuity_policy_versions'),
      TENANT,
      41,
      3
    );
    expect(policyLoader).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, facilityId: 41 })
    );
    expect(__clinicalContinuityPolicyDeliveryContractForTests.stateSql).toContain(
      'transaction_timestamp()'
    );
  });

  it.each([
    [[], 404, 'CONTINUITY_POLICY_NOT_PUBLISHED'],
    [[activeRow({ lifecycle_state: 'approved' })], 409, 'CONTINUITY_POLICY_NOT_ACTIVATED'],
    [[activeRow({ lifecycle_state: 'retired' })], 410, 'CONTINUITY_POLICY_SUPERSEDED'],
    [[activeRow({ policy_key_status: 'revoked' })], 410, 'CONTINUITY_POLICY_REVOKED']
  ])('returns typed lifecycle states', async (rows, statusCode, code) => {
    const { scopeRunner, policyLoader } = harness(rows);
    await expect(
      loadClinicalContinuityPolicyDelivery({
        tenantId: TENANT,
        facilityId: 41,
        scopeRunner,
        policyLoader
      })
    ).rejects.toMatchObject({ statusCode, code });
  });

  it('maps verified-representation drift to the integrity error', async () => {
    const { scopeRunner, policyLoader } = harness([activeRow()], {
      policyDelivery: { canonicalBody: '{}', byteLength: 3 }
    });
    await expect(
      loadClinicalContinuityPolicyDelivery({
        tenantId: TENANT,
        facilityId: 41,
        scopeRunner,
        policyLoader
      })
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED'
    });
  });

  it('maps invalid database lifecycle timestamps to the integrity error', async () => {
    const { scopeRunner, policyLoader } = harness([activeRow({ trusted_now: 'not-a-timestamp' })]);
    await expect(
      loadClinicalContinuityPolicyDelivery({
        tenantId: TENANT,
        facilityId: 41,
        scopeRunner,
        policyLoader
      })
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'CONTINUITY_POLICY_DELIVERY_INTEGRITY_FAILED'
    });
    expect(policyLoader).not.toHaveBeenCalled();
  });

  it('implements list, weak, and wildcard If-None-Match semantics', () => {
    const etag = `"pc-${'a'.repeat(64)}.rep-${'b'.repeat(64)}"`;
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
    expect(ifNoneMatchMatches(`"other", W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches('*', etag)).toBe(true);
    expect(ifNoneMatchMatches('"other"', etag)).toBe(false);
  });
});
