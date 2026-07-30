import {
  CLINICAL_CONTINUITY_ACTION_CATALOG,
  CLINICAL_CONTINUITY_ACTIONS_BY_ID
} from '../../config/clinicalContinuityActionCatalog.js';
import {
  evaluateClinicalContinuityAction,
  evaluateClinicalContinuityActionRequest,
  parseClinicalContinuityActionRegistry
} from '../../services/downtime/clinicalContinuityActionRegistryService.js';
import {
  hashCanonicalValue
} from '../../services/downtime/continuityPackCanonical.js';

const ACTION_ID = 'emr.nursing_note.draft.store';
const ACTION = CLINICAL_CONTINUITY_ACTIONS_BY_ID[ACTION_ID];
const TENANT = '52e31913-c846-4458-a21b-31cd2f457e9b';
const POLICY_ID = '55555555-5555-4555-8555-555555555555';
const OLD_POLICY_ID = '44444444-4444-4444-8444-444444444444';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const EFFECTIVE_FROM = '2026-07-30T00:00:00.000Z';
const EFFECTIVE_UNTIL = '2026-08-30T00:00:00.000Z';
const CAPTURED_AT = '2026-07-30T01:00:00.000Z';
const TRUSTED_NOW = '2026-07-30T02:00:00.000Z';

function registry(overrides = {}) {
  const value = {
    actions: CLINICAL_CONTINUITY_ACTION_CATALOG,
    activation: {
      enforcedActionIds: [ACTION_ID],
      mode: 'enforce'
    },
    approvalEvidence: {
      countersignedAt: '2026-07-30',
      decisionId: 'C-D3',
      source: 'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix'
    },
    audience: {
      devicePostures: ['desktop', 'tablet']
    },
    compatibilityRules: [],
    expiresAt: EFFECTIVE_UNTIL,
    issuedAt: EFFECTIVE_FROM,
    minimumAppVersions: {
      desktop: '1.2.3',
      tablet: '1.2.3'
    },
    registrySchemaVersion: 1,
    registryVersion: '7',
    ...overrides
  };
  const withoutChecksum = { ...value };
  delete withoutChecksum.registryChecksum;
  value.registryChecksum = hashCanonicalValue(withoutChecksum);
  return value;
}

function policy(registryValue = registry(), overrides = {}) {
  return {
    id: POLICY_ID,
    actionRegistryChecksum: registryValue.registryChecksum,
    actionRegistryVersion: registryValue.registryVersion,
    effectiveFrom: EFFECTIVE_FROM,
    effectiveUntil: EFFECTIVE_UNTIL,
    facilityId: 41,
    policyChecksum: 'd'.repeat(64),
    policyDocument: {
      actionRegistry: registryValue,
      audience: {
        facilityId: '41',
        tenantId: TENANT
      },
      policySchemaVersion: 3
    },
    policySchemaVersion: 3,
    policySigningKeyId: 'continuity-policy-7',
    policyVersion: '12',
    revocationEpoch: '4',
    revokedKeyIds: [],
    supersedesPolicyId: OLD_POLICY_ID,
    tenantId: TENANT,
    trustedNow: TRUSTED_NOW,
    ...overrides
  };
}

function claims(capturedPolicy, overrides = {}) {
  return {
    actionChecksum: ACTION.actionChecksum,
    actionSchemaChecksum: ACTION.actionSchema.checksum,
    actionSchemaVersion: ACTION.actionSchema.version,
    actionVersion: ACTION.actionVersion,
    policyChecksum: capturedPolicy.policyChecksum,
    policyEffectiveFrom: capturedPolicy.effectiveFrom,
    policyEffectiveUntil: capturedPolicy.effectiveUntil,
    policyId: capturedPolicy.id,
    policySigningKeyId: capturedPolicy.policySigningKeyId,
    policySupersedesId: capturedPolicy.supersedesPolicyId,
    policyVersion: capturedPolicy.policyVersion,
    registryChecksum: capturedPolicy.actionRegistryChecksum,
    registryVersion: capturedPolicy.actionRegistryVersion,
    revocationEpoch: capturedPolicy.revocationEpoch,
    ...overrides
  };
}

function request(currentPolicy, capturedPolicy = currentPolicy, overrides = {}) {
  return {
    actionId: ACTION_ID,
    actorCapabilities: ['nursing_governance'],
    actorRole: 'NURSING_STAFF',
    authorityClaims: claims(capturedPolicy),
    binding: { actionId: ACTION_ID },
    body: {
      content: { assessment: 'bounded test content' },
      note_type: 'nursing_assessment',
      patient_uid: PATIENT
    },
    cachedSourcesSatisfied: true,
    capturedAt: CAPTURED_AT,
    capturedPolicy,
    clientAppVersion: '1.2.3',
    currentPolicy,
    devicePosture: 'desktop',
    identitySatisfied: true,
    trustedNow: TRUSTED_NOW,
    ...overrides
  };
}

describe('closed action registry', () => {
  test('parses the countersigned 17-action contract and checksum', () => {
    const parsed = parseClinicalContinuityActionRegistry(registry(), {
      effectiveFrom: EFFECTIVE_FROM,
      effectiveUntil: EFFECTIVE_UNTIL
    });
    expect(parsed.actions).toHaveLength(17);
    expect(parsed.registryVersion).toBe('7');
  });

  test('rejects a classification change even with a recomputed registry checksum', () => {
    const changedActions = structuredClone(CLINICAL_CONTINUITY_ACTION_CATALOG);
    changedActions[0].classification.captureReady = true;
    const changed = registry({ actions: changedActions });
    expect(() =>
      parseClinicalContinuityActionRegistry(changed, {
        effectiveFrom: EFFECTIVE_FROM,
        effectiveUntil: EFFECTIVE_UNTIL
      })
    ).toThrow('does not match the countersigned C-D3 contract');
  });
});

describe('action policy decisions', () => {
  test('allows only an exact current v3 authority and binding', () => {
    const current = policy();
    expect(evaluateClinicalContinuityAction(request(current))).toEqual(
      expect.objectContaining({
        decision: 'allow',
        proceed: true,
        reasonCode: 'CONTINUITY_ACTION_ALLOWED'
      })
    );
  });

  test.each([1, 2])('never lets policy schema v%s authorize capture', schemaVersion => {
    const current = policy(registry(), {
      policySchemaVersion: schemaVersion,
      policyDocument: { policySchemaVersion: schemaVersion }
    });
    expect(evaluateClinicalContinuityAction(request(current))).toEqual(
      expect.objectContaining({
        decision: 'deny',
        proceed: false,
        reasonCode: 'CONTINUITY_ACTION_POLICY_V3_REQUIRED'
      })
    );
  });

  test('refuses unknown actions even in shadow mode', () => {
    const shadow = registry({
      activation: { enforcedActionIds: [], mode: 'shadow' }
    });
    const current = policy(shadow);
    expect(
      evaluateClinicalContinuityAction(
        request(current, current, {
          actionId: 'unknown.new.action',
          authorityClaims: {}
        })
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'deny',
        proceed: false,
        reasonCode: 'CONTINUITY_ACTION_UNKNOWN'
      })
    );
  });

  test('refuses a client below the signed minimum safe version in shadow mode', () => {
    const shadow = registry({
      activation: { enforcedActionIds: [], mode: 'shadow' }
    });
    const current = policy(shadow);
    expect(
      evaluateClinicalContinuityAction(
        request(current, current, { clientAppVersion: '1.2.2' })
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'deny',
        proceed: false,
        reasonCode: 'CONTINUITY_ACTION_APP_VERSION_UNSAFE'
      })
    );
  });

  test('refuses a mismatch in the pinned signed audience', () => {
    const current = policy();
    expect(
      evaluateClinicalContinuityAction(
        request(current, current, {
          authorityClaims: claims(current, { policySigningKeyId: 'wrong-key' })
        })
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'deny',
        proceed: false,
        reasonCode: 'CONTINUITY_ACTION_SIGNED_AUDIENCE_MISMATCH'
      })
    );
  });

  test('refuses a known action outside the exact facility enforcement set', () => {
    const exactOtherSet = registry({
      activation: {
        enforcedActionIds: ['emr.op_note.draft.store'],
        mode: 'enforce'
      }
    });
    const current = policy(exactOtherSet);
    expect(evaluateClinicalContinuityAction(request(current))).toEqual(
      expect.objectContaining({
        decision: 'deny',
        proceed: false,
        reasonCode: 'CONTINUITY_ACTION_NOT_IN_ENFORCED_SET'
      })
    );
  });

  test('shadow mode records review evidence without authorizing by classification', () => {
    const shadow = registry({
      activation: { enforcedActionIds: [], mode: 'shadow' }
    });
    const current = policy(shadow);
    expect(
      evaluateClinicalContinuityAction(
        request(current, current, { identitySatisfied: false })
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'would_deny',
        proceed: true,
        reasonCode: 'CONTINUITY_ACTION_IDENTITY_INCOMPLETE'
      })
    );
  });

  test('allows an expired and superseded capture policy only through an exact rule', () => {
    const capturedPolicy = policy(registry(), {
      id: OLD_POLICY_ID,
      actionRegistryChecksum: 'a'.repeat(64),
      actionRegistryVersion: '6',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      effectiveUntil: '2026-07-15T00:00:00.000Z',
      policyChecksum: 'b'.repeat(64),
      policySigningKeyId: 'continuity-policy-6',
      policyVersion: '11',
      revocationEpoch: '3',
      supersedesPolicyId: null,
      trustState: 'historical'
    });
    const compatibilityRule = {
      actionChecksum: ACTION.actionChecksum,
      actionId: ACTION_ID,
      actionSchemaChecksum: ACTION.actionSchema.checksum,
      actionSchemaVersion: ACTION.actionSchema.version,
      actionVersion: ACTION.actionVersion,
      fromPolicyChecksum: capturedPolicy.policyChecksum,
      fromPolicyEffectiveFrom: capturedPolicy.effectiveFrom,
      fromPolicyEffectiveUntil: capturedPolicy.effectiveUntil,
      fromPolicyId: capturedPolicy.id,
      fromPolicySigningKeyId: capturedPolicy.policySigningKeyId,
      fromPolicySupersedesId: capturedPolicy.supersedesPolicyId,
      fromPolicyVersion: capturedPolicy.policyVersion,
      fromRegistryChecksum: capturedPolicy.actionRegistryChecksum,
      fromRegistryVersion: capturedPolicy.actionRegistryVersion,
      fromRevocationEpoch: capturedPolicy.revocationEpoch,
      maximumCaptureAgeMinutes: 50_000,
      outcome: 'allow'
    };
    const currentRegistry = registry({ compatibilityRules: [compatibilityRule] });
    const current = policy(currentRegistry);
    expect(
      evaluateClinicalContinuityAction(
        request(current, capturedPolicy, {
          capturedAt: '2026-07-10T01:00:00.000Z'
        })
      )
    ).toEqual(
      expect.objectContaining({
        decision: 'allow',
        proceed: true
      })
    );
  });

  test('routes a now-revoked captured policy to owned review', () => {
    const current = policy(registry(), {
      revokedKeyIds: ['continuity-policy-6']
    });
    const capturedPolicy = {
      ...current,
      id: OLD_POLICY_ID,
      policySigningKeyId: 'continuity-policy-6',
      policyVersion: '11',
      trustState: 'historical'
    };
    expect(
      evaluateClinicalContinuityAction(request(current, capturedPolicy))
    ).toEqual(
      expect.objectContaining({
        decision: 'needs_review',
        proceed: false,
        reasonCode: 'CONTINUITY_ACTION_CAPTURE_POLICY_UNTRUSTED',
        owner: 'nursing_privacy_and_security_governance'
      })
    );
  });

  test('pins current evaluation and denied audit to one RepeatableRead transaction', async () => {
    const current = policy();
    const auditWrites = [];
    let scope;
    const context = request(current, current, {
      actionId: 'unknown.hostile.action',
      actorUid: '22222222-2222-4222-8222-222222222222',
      authorityClaims: {},
      binding: null,
      requestId: '77777777-7777-4777-8777-777777777777',
      routeTemplate: 'unmatched'
    });
    delete context.currentPolicy;
    delete context.capturedPolicy;
    delete context.trustedNow;

    const result = await evaluateClinicalContinuityActionRequest({
      tenantId: TENANT,
      facilityId: 41,
      capturedPolicyId: current.id,
      capturedPolicyVersion: current.policyVersion,
      requestContext: context,
      activePolicyLoader: async () => current,
      historicalPolicyLoader: async () => {
        throw new Error('historical loader must not run for the current policy');
      },
      scopeRunner: async (tenantId, callback, options) => {
        scope = { tenantId, options };
        return callback({
          audit_logs: {
            create: async value => {
              auditWrites.push(value);
              return value;
            }
          }
        });
      }
    });

    expect(scope).toEqual({
      tenantId: TENANT,
      options: {
        isolationLevel: 'RepeatableRead',
        readOnly: false
      }
    });
    expect(result).toEqual(
      expect.objectContaining({
        decision: 'deny',
        proceed: false,
        reasonCode: 'CONTINUITY_ACTION_UNKNOWN'
      })
    );
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0].data).toEqual(
      expect.objectContaining({
        action: 'CONTINUITY_ACTION_DENY',
        resource_id: 'unknown'
      })
    );
    expect(auditWrites[0].data).not.toHaveProperty('tenant_id');
  });

  test('moves an unverifiable historical authority to owned review and audits it', async () => {
    const current = policy();
    const auditWrites = [];
    const context = request(current, current, {
      actorUid: '22222222-2222-4222-8222-222222222222',
      requestId: '77777777-7777-4777-8777-777777777777',
      routeTemplate: '/api/v1/emr/notes/draft'
    });
    delete context.currentPolicy;
    delete context.capturedPolicy;
    delete context.trustedNow;

    const result = await evaluateClinicalContinuityActionRequest({
      tenantId: TENANT,
      facilityId: 41,
      capturedPolicyId: OLD_POLICY_ID,
      capturedPolicyVersion: '11',
      requestContext: context,
      activePolicyLoader: async () => current,
      historicalPolicyLoader: async () => {
        const failure = new Error('retired policy signature no longer verifies');
        failure.code = 'CONTINUITY_ACTION_CAPTURE_POLICY_INVALID';
        throw failure;
      },
      scopeRunner: async (_tenantId, callback) =>
        callback({
          audit_logs: {
            create: async value => {
              auditWrites.push(value);
              return value;
            }
          }
        })
    });

    expect(result).toEqual(
      expect.objectContaining({
        decision: 'needs_review',
        owner: 'nursing_privacy_and_security_governance',
        proceed: false,
        reasonCode: 'CONTINUITY_ACTION_CAPTURE_POLICY_INVALID'
      })
    );
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0].data.action).toBe('CONTINUITY_ACTION_NEEDS_REVIEW');
  });
});
