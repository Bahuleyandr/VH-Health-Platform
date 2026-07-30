import { generateKeyPairSync } from 'node:crypto';
import { jest } from '@jest/globals';
import {
  ALLERGY_UNKNOWN_TEXT,
  CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION,
  CLINICAL_CONTINUITY_POLICY_CANONICALIZATION,
  CLINICAL_CONTINUITY_POLICY_TYPE,
  CODE_STATUS_UNKNOWN_TEXT,
  DEFAULT_TENANT_ID,
  REQUIRED_CONTEXT_FIELDS,
  REQUIRED_SAFETY_FIELDS,
  buildClinicalContinuityPolicySigningPayload,
  buildOfflineClinicalContinuityTrustRoot,
  discoverActiveClinicalContinuityPolicyTenantIds,
  enumerateActiveClinicalContinuityPolicies,
  loadActiveClinicalContinuityPolicyForFacilityTx,
  loadActiveClinicalContinuityPoliciesForTenant,
  parseClinicalContinuityPolicyDocument,
  prepareClinicalContinuityPolicyDraft,
  requireClinicalContinuityEdgePolicy,
  verifyActiveClinicalContinuityPolicyRow
} from '../../services/downtime/clinicalContinuityPolicyService.js';
import {
  KEY_STATES,
  hashCanonicalValue,
  sha256Hex,
  signCanonicalValue
} from '../../services/downtime/continuityPackCanonical.js';

const TENANT = '52e31913-c846-4458-a21b-31cd2f457e9b';
const SECOND_TENANT = '885a7ad1-09a8-43fb-8229-d7a139c0de81';
const FACILITY = 41;
const POLICY_ID = '55555555-5555-4555-8555-555555555555';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const EFFECTIVE_FROM = '2026-07-29T00:00:00.000Z';
const EFFECTIVE_UNTIL = '2026-08-29T00:00:00.000Z';
const TRUSTED_NOW = '2026-07-29T01:00:00.000Z';

let policyKeys;
let currentPackKeys;
let nextPackKeys;

beforeAll(() => {
  policyKeys = generateKeyPairSync('ed25519');
  currentPackKeys = generateKeyPairSync('ed25519');
  nextPackKeys = generateKeyPairSync('ed25519');
});

function publicPem(pair) {
  return pair.publicKey.export({ type: 'spki', format: 'pem' });
}

function publicPemSha256(pair) {
  return sha256Hex(publicPem(pair));
}

function policyDocument(overrides = {}) {
  return {
    audience: {
      tenantId: TENANT,
      facilityId: String(FACILITY)
    },
    fieldPolicy: {
      allergyUnknownText: ALLERGY_UNKNOWN_TEXT,
      bloodGroupIncluded: false,
      codeStatusUnknownText: CODE_STATUS_UNKNOWN_TEXT,
      contextFields: [...REQUIRED_CONTEXT_FIELDS],
      isolationSource: 'structured_only',
      opdDestroyAfterClinicDay: true,
      paediatricWeightRequired: true,
      recentlyAdministeredLookbackHours: 12,
      safetyFieldRecordedAtRequired: true,
      safetyFields: [...REQUIRED_SAFETY_FIELDS]
    },
    generation: {
      currentForMinutes: 15,
      hardExpiryHours: 24,
      historicalMode: false,
      intervalMinutes: 15
    },
    includedAreas: {
      ed: true,
      opd: true,
      paediatrics: true,
      wards: true
    },
    medicationsDueWindow: {
      lookaheadHours: 12,
      lookbackHours: 1
    },
    packSchemaVersion: 1,
    policySchemaVersion: 1,
    policyType: CLINICAL_CONTINUITY_POLICY_TYPE,
    recentReleasedResults: {
      itemCodeAllowlist: ['HGB', 'CREATININE'],
      lookbackHours: 72,
      maxPerPatient: 10,
      portalReleaseDelayHours: 24
    },
    requiredCoverage: {
      wards: [{ wardId: 10, locationIdentifier: 'ward-10', label: 'Ward 10' }],
      paediatricWards: [{ wardId: 11, locationIdentifier: 'paeds-11', label: 'PICU' }],
      edBoards: [{ locationIdentifier: 'ed-board', label: 'Emergency' }],
      opdClinicDays: [
        {
          locationIdentifier: 'opd-2026-07-29',
          queueIds: [31, 32],
          label: 'OPD clinic day'
        }
      ]
    },
    ...overrides
  };
}

function unsignedPolicyRow(overrides = {}) {
  const document = overrides.policy_document ?? policyDocument();
  return {
    id: POLICY_ID,
    tenant_id: TENANT,
    facility_id: FACILITY,
    policy_version: 9_007_199_254_740_993n,
    policy_schema_version: 1,
    lifecycle_state: 'active',
    policy_document: document,
    policy_checksum: hashCanonicalValue(document),
    canonicalization: CLINICAL_CONTINUITY_POLICY_CANONICALIZATION,
    signature_algorithm: 'ed25519',
    policy_signing_key_id: 'continuity-policy-k1',
    policy_signing_public_key_sha256: publicPemSha256(policyKeys),
    current_pack_signing_key_id: 'continuity-pack-current-k1',
    current_pack_signing_public_key_sha256: publicPemSha256(currentPackKeys),
    next_pack_signing_key_id: 'continuity-pack-next-k2',
    next_pack_signing_public_key_sha256: publicPemSha256(nextPackKeys),
    revocation_epoch: 7n,
    revoked_key_ids: [],
    approval_id: 91,
    approved_by: APPROVER,
    approved_at: '2026-07-28T10:05:00.000Z',
    effective_from: EFFECTIVE_FROM,
    effective_until: EFFECTIVE_UNTIL,
    supersedes_policy_id: null,
    created_at: '2026-07-28T09:00:00.000Z',
    facility_display_name: 'VH Central',
    facility_timezone: 'Asia/Kolkata',
    facility_status: 'active',
    policy_key_algorithm: 'ed25519',
    policy_key_status: 'active',
    policy_key_metadata: {
      purpose: 'clinical_continuity_policy_signing',
      public_key_spki_pem: publicPem(policyKeys)
    },
    current_key_algorithm: 'ed25519',
    current_key_status: 'active',
    current_key_metadata: {
      purpose: 'clinical_continuity_pack_signing',
      public_key_spki_pem: publicPem(currentPackKeys)
    },
    next_key_algorithm: 'ed25519',
    next_key_status: 'active',
    next_key_metadata: {
      purpose: 'clinical_continuity_pack_signing',
      public_key_spki_pem: publicPem(nextPackKeys)
    },
    approval_status: 'approved',
    approval_kind: 'clinical_continuity_policy_governance',
    approval_subject_resource_type: 'clinical_continuity_policy_version',
    approval_subject_resource_id: POLICY_ID,
    approval_required_approvers: 1,
    approval_approved_by: [{ uid: APPROVER, at: '2026-07-28T10:00:00.000Z' }],
    approval_decided_by: APPROVER,
    approval_decided_at: '2026-07-28T10:00:00.000Z',
    approval_metadata: {
      clinical_continuity_policy_governance: {
        countersignature_complete: true,
        policy_checksum: hashCanonicalValue(document)
      }
    },
    trusted_now: TRUSTED_NOW,
    latest_committed_policy_version: 9_007_199_254_740_993n,
    latest_committed_revocation_epoch: 7n,
    ...overrides
  };
}

function signedPolicyRow(overrides = {}) {
  const row = unsignedPolicyRow(overrides);
  if (overrides.policy_document && overrides.policy_checksum === undefined) {
    row.policy_checksum = hashCanonicalValue(row.policy_document);
    row.approval_metadata = {
      clinical_continuity_policy_governance: {
        countersignature_complete: true,
        policy_checksum: row.policy_checksum
      }
    };
  }
  const payload = buildClinicalContinuityPolicySigningPayload(row);
  row.policy_signature = Buffer.from(signCanonicalValue(payload, policyKeys.privateKey), 'base64');
  return row;
}

function verifyRow(overrides = {}, options = {}) {
  return verifyActiveClinicalContinuityPolicyRow(signedPolicyRow(overrides), {
    clockTrusted: true,
    trustedNow: TRUSTED_NOW,
    ...options
  });
}

describe('clinical continuity policy document', () => {
  test('normalizes the closed v1 C-D2 contract and explicit audience', () => {
    const parsed = parseClinicalContinuityPolicyDocument(policyDocument(), {
      tenantId: TENANT.toUpperCase(),
      facilityId: FACILITY,
      policySchemaVersion: 1
    });

    expect(parsed).toMatchObject({
      policyType: CLINICAL_CONTINUITY_POLICY_TYPE,
      policySchemaVersion: 1,
      packSchemaVersion: 1,
      audience: { tenantId: TENANT, facilityId: '41' },
      generation: {
        intervalMinutes: 15,
        currentForMinutes: 15,
        hardExpiryHours: 24,
        historicalMode: false
      },
      medicationsDueWindow: { lookbackHours: 1, lookaheadHours: 12 },
      recentReleasedResults: {
        lookbackHours: 72,
        maxPerPatient: 10,
        portalReleaseDelayHours: 24,
        itemCodeAllowlist: ['HGB', 'CREATININE']
      }
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test('requires explicit signed C-D4/C-D10 fields in the closed v2 contract', () => {
    const document = policyDocument({
      policySchemaVersion: CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION,
      edgeAccess: {
        authenticationMode: 'mtls_client_certificate',
        credentialLifetimeMinutes: 480,
        emergencyReadPosture: 'read_only',
        maximumOfflineAuthorizationMinutes: 60
      },
      retention: {
        accessLogRetentionHours: 720,
        edgePackRetentionHours: 48,
        sourcePackRetentionHours: 72
      }
    });
    const parsed = parseClinicalContinuityPolicyDocument(document, {
      tenantId: TENANT,
      facilityId: FACILITY,
      policySchemaVersion: CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION
    });

    expect(parsed.edgeAccess).toEqual(document.edgeAccess);
    expect(parsed.retention).toEqual(document.retention);
  });

  test('does not invent edge-access or retention defaults for schema v2', () => {
    expect(() =>
      parseClinicalContinuityPolicyDocument(
        policyDocument({
          policySchemaVersion: CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION
        }),
        {
          tenantId: TENANT,
          facilityId: FACILITY,
          policySchemaVersion: CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION
        }
      )
    ).toThrow('unsupported shape');
  });

  test('rejects unsupported authentication and a lifetime below the risk window', () => {
    const base = {
      policySchemaVersion: CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION,
      edgeAccess: {
        authenticationMode: 'shared_password',
        credentialLifetimeMinutes: 30,
        emergencyReadPosture: 'read_only',
        maximumOfflineAuthorizationMinutes: 60
      },
      retention: {
        accessLogRetentionHours: 720,
        edgePackRetentionHours: 48,
        sourcePackRetentionHours: 72
      }
    };
    expect(() =>
      parseClinicalContinuityPolicyDocument(policyDocument(base), {
        tenantId: TENANT,
        facilityId: FACILITY,
        policySchemaVersion: CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION
      })
    ).toThrow('authentication mode');

    base.edgeAccess.authenticationMode = 'mtls_client_certificate';
    expect(() =>
      parseClinicalContinuityPolicyDocument(policyDocument(base), {
        tenantId: TENANT,
        facilityId: FACILITY,
        policySchemaVersion: CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION
      })
    ).toThrow('cannot be shorter');
  });

  test('keeps a verified schema-v1 policy insufficient for edge operations', () => {
    expect(() => requireClinicalContinuityEdgePolicy(verifyRow())).toThrow(
      'policy-schema v2'
    );
  });

  test('allows edge decisions only from the verified active schema-v2 object', () => {
    const policy_document = policyDocument({
      policySchemaVersion: CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION,
      edgeAccess: {
        authenticationMode: 'mtls_client_certificate',
        credentialLifetimeMinutes: 480,
        emergencyReadPosture: 'read_only',
        maximumOfflineAuthorizationMinutes: 60
      },
      retention: {
        accessLogRetentionHours: 720,
        edgePackRetentionHours: 48,
        sourcePackRetentionHours: 72
      }
    });
    const verified = verifyRow({
      policy_document,
      policy_schema_version: CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION
    });

    expect(requireClinicalContinuityEdgePolicy(verified)).toEqual({
      edgeAccess: policy_document.edgeAccess,
      retention: policy_document.retention
    });
    expect(() => requireClinicalContinuityEdgePolicy({
      ...verified
    })).toThrow('policy-schema v2');
  });

  test.each([
    [
      'calm allergy wording',
      () =>
        policyDocument({
          fieldPolicy: {
            ...policyDocument().fieldPolicy,
            allergyUnknownText: 'No known allergies'
          }
        }),
      'CONTINUITY_POLICY_DATASET_BELOW_FLOOR'
    ],
    [
      'default full-code wording',
      () =>
        policyDocument({
          fieldPolicy: {
            ...policyDocument().fieldPolicy,
            codeStatusUnknownText: 'Full code'
          }
        }),
      'CONTINUITY_POLICY_DATASET_BELOW_FLOOR'
    ],
    [
      'missing date of birth',
      () =>
        policyDocument({
          fieldPolicy: {
            ...policyDocument().fieldPolicy,
            safetyFields: REQUIRED_SAFETY_FIELDS.filter(field => field !== 'identity.dateOfBirth')
          }
        }),
      'CONTINUITY_POLICY_DATASET_BELOW_FLOOR'
    ],
    [
      'blood-group field',
      () =>
        policyDocument({
          fieldPolicy: {
            ...policyDocument().fieldPolicy,
            contextFields: [...REQUIRED_CONTEXT_FIELDS, 'bloodGroup']
          }
        }),
      'CONTINUITY_POLICY_BLOOD_GROUP_FORBIDDEN'
    ],
    [
      'blood-group result code',
      () =>
        policyDocument({
          recentReleasedResults: {
            ...policyDocument().recentReleasedResults,
            itemCodeAllowlist: ['883-9']
          }
        }),
      'CONTINUITY_POLICY_BLOOD_GROUP_FORBIDDEN'
    ],
    [
      'empty result allowlist',
      () =>
        policyDocument({
          recentReleasedResults: {
            ...policyDocument().recentReleasedResults,
            itemCodeAllowlist: []
          }
        }),
      'CONTINUITY_POLICY_RESULT_ALLOWLIST_REQUIRED'
    ],
    [
      'coverage mismatch',
      () =>
        policyDocument({
          includedAreas: {
            ...policyDocument().includedAreas,
            ed: false
          }
        }),
      'CONTINUITY_POLICY_COVERAGE_INVALID'
    ],
    [
      'unknown top-level field',
      () => policyDocument({ unapprovedExtension: true }),
      'CONTINUITY_POLICY_DOCUMENT_INVALID'
    ],
    [
      'path-changing location identifier',
      () =>
        policyDocument({
          requiredCoverage: {
            ...policyDocument().requiredCoverage,
            edBoards: [{ locationIdentifier: 'ed/board' }]
          }
        }),
      'CONTINUITY_POLICY_DOCUMENT_INVALID'
    ],
    [
      'Windows-invalid location identifier',
      () =>
        policyDocument({
          requiredCoverage: {
            ...policyDocument().requiredCoverage,
            edBoards: [{ locationIdentifier: 'ed:board' }]
          }
        }),
      'CONTINUITY_POLICY_DOCUMENT_INVALID'
    ]
  ])('fails closed on %s', (_label, buildDocument, code) => {
    expect(() =>
      parseClinicalContinuityPolicyDocument(buildDocument(), {
        tenantId: TENANT,
        facilityId: FACILITY,
        policySchemaVersion: 1
      })
    ).toThrow(expect.objectContaining({ code }));
  });

  test('rejects wrong audience, default tenant, and unsupported schema', () => {
    expect(() =>
      parseClinicalContinuityPolicyDocument(policyDocument(), {
        tenantId: SECOND_TENANT,
        facilityId: FACILITY,
        policySchemaVersion: 1
      })
    ).toThrow(
      expect.objectContaining({
        code: 'CONTINUITY_POLICY_AUDIENCE_MISMATCH'
      })
    );
    expect(() =>
      parseClinicalContinuityPolicyDocument(
        policyDocument({
          audience: { tenantId: DEFAULT_TENANT_ID, facilityId: '41' }
        }),
        {
          tenantId: DEFAULT_TENANT_ID,
          facilityId: FACILITY,
          policySchemaVersion: 1
        }
      )
    ).toThrow(
      expect.objectContaining({
        code: 'CONTINUITY_POLICY_DEFAULT_TENANT_REJECTED'
      })
    );
    expect(() =>
      parseClinicalContinuityPolicyDocument(
        policyDocument({
          policySchemaVersion: 3
        }),
        {
          tenantId: TENANT,
          facilityId: FACILITY,
          policySchemaVersion: 3
        }
      )
    ).toThrow(
      expect.objectContaining({
        code: 'CONTINUITY_POLICY_SCHEMA_UNSUPPORTED'
      })
    );
  });
});

describe('append-only policy preparation and active verification', () => {
  test('prepares only an externally signed monotonic draft without generating keys', () => {
    const value = {
      ...unsignedPolicyRow({
        lifecycle_state: 'draft',
        policy_version: 8n,
        revocation_epoch: 3n,
        supersedes_policy_id: POLICY_ID
      })
    };
    const payload = buildClinicalContinuityPolicySigningPayload(value);
    value.policy_signature = Buffer.from(
      signCanonicalValue(payload, policyKeys.privateKey),
      'base64'
    );

    const prepared = prepareClinicalContinuityPolicyDraft(value, {
      policySigningPublicKey: policyKeys.publicKey,
      previousPolicyId: POLICY_ID,
      previousPolicyVersion: 7n,
      previousRevocationEpoch: 3n
    });

    expect(prepared).toMatchObject({
      lifecycleState: 'draft',
      policyVersion: '8',
      revocationEpoch: '3',
      supersedesPolicyId: POLICY_ID,
      policySigningKeyId: 'continuity-policy-k1',
      policySigningPublicKeySha256: publicPemSha256(policyKeys),
      currentPackSigningPublicKeySha256: publicPemSha256(currentPackKeys),
      nextPackSigningPublicKeySha256: publicPemSha256(nextPackKeys)
    });
    expect(prepared).not.toHaveProperty('privateKey');
  });

  test.each([
    ['same version', { policy_version: 7n, revocation_epoch: 3n }],
    ['revocation rollback', { policy_version: 8n, revocation_epoch: 2n }],
    [
      'wrong supersession',
      {
        policy_version: 8n,
        revocation_epoch: 3n,
        supersedes_policy_id: '66666666-6666-4666-8666-666666666666'
      }
    ]
  ])('rejects %s while preparing the next append-only draft', (_label, overrides) => {
    const value = unsignedPolicyRow({
      lifecycle_state: 'draft',
      supersedes_policy_id: POLICY_ID,
      ...overrides
    });
    const payload = buildClinicalContinuityPolicySigningPayload(value);
    value.policy_signature = Buffer.from(
      signCanonicalValue(payload, policyKeys.privateKey),
      'base64'
    );
    expect(() =>
      prepareClinicalContinuityPolicyDraft(value, {
        policySigningPublicKey: policyKeys.publicKey,
        previousPolicyId: POLICY_ID,
        previousPolicyVersion: 7n,
        previousRevocationEpoch: 3n
      })
    ).toThrow(
      expect.objectContaining({
        code: 'CONTINUITY_POLICY_SUPERSESSION_INVALID'
      })
    );
  });

  test('verifies active approval, canonical signature, BIGINT floors, and key overlap', () => {
    const policy = verifyRow();

    expect(policy).toMatchObject({
      id: POLICY_ID,
      tenantId: TENANT,
      facilityId: FACILITY,
      facilityTimezone: 'Asia/Kolkata',
      policyVersion: '9007199254740993',
      revocationEpoch: '7',
      minimumPolicyVersion: '9007199254740993',
      minimumRevocationEpoch: '7',
      currentPackSigningKeyId: 'continuity-pack-current-k1',
      currentPackSigningPublicKeySha256: publicPemSha256(currentPackKeys),
      nextPackSigningKeyId: 'continuity-pack-next-k2',
      nextPackSigningPublicKeySha256: publicPemSha256(nextPackKeys),
      policySigningPublicKeySha256: publicPemSha256(policyKeys),
      trustedKeys: {
        'continuity-pack-current-k1': {
          publicKeySha256: publicPemSha256(currentPackKeys),
          state: KEY_STATES.CURRENT
        },
        'continuity-pack-next-k2': {
          publicKeySha256: publicPemSha256(nextPackKeys),
          state: KEY_STATES.NEXT
        }
      }
    });

    const trustRoot = buildOfflineClinicalContinuityTrustRoot(policy);
    expect(trustRoot).toMatchObject({
      format: 'vhhealth_clinical_continuity_trust/v1',
      distribution: 'operator_provisioned_out_of_band',
      audience: { tenantId: TENANT, facilityId: '41' },
      minimumPolicyVersion: '9007199254740993',
      minimumRevocationEpoch: '7',
      refusalPolicy: {
        compromisedOrRevokedKey: 'reject_pack_use_paper_and_phone',
        uncertainClock: 'refuse_as_current_use_paper_and_phone',
        versionRollback: 'reject_pack_use_paper_and_phone'
      }
    });
    expect(trustRoot.packSigningKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyId: 'continuity-pack-current-k1',
          publicKeySha256: publicPemSha256(currentPackKeys),
          state: KEY_STATES.CURRENT
        }),
        expect.objectContaining({
          keyId: 'continuity-pack-next-k2',
          publicKeySha256: publicPemSha256(nextPackKeys),
          state: KEY_STATES.NEXT
        })
      ])
    );
    expect(trustRoot.policySigningKey).toMatchObject({
      keyId: 'continuity-policy-k1',
      publicKeySha256: publicPemSha256(policyKeys)
    });
  });

  test.each([
    ['policy signing key', 'policy_key_metadata', 'clinical_continuity_policy_signing'],
    ['current pack signing key', 'current_key_metadata', 'clinical_continuity_pack_signing'],
    ['next pack signing key', 'next_key_metadata', 'clinical_continuity_pack_signing']
  ])('rejects registry substitution of the %s', (_label, metadataField, purpose) => {
    const substituteKeys = generateKeyPairSync('ed25519');
    const row = signedPolicyRow();
    row[metadataField] = {
      purpose,
      public_key_spki_pem: publicPem(substituteKeys)
    };

    expect(() =>
      verifyActiveClinicalContinuityPolicyRow(row, {
        clockTrusted: true,
        trustedNow: TRUSTED_NOW
      })
    ).toThrow(
      expect.objectContaining({
        code: 'CONTINUITY_POLICY_KEY_SUBSTITUTION'
      })
    );
  });

  test('hashes the exact UTF-8 PEM bytes rather than a normalized key representation', () => {
    const row = signedPolicyRow();
    row.current_key_metadata = {
      ...row.current_key_metadata,
      public_key_spki_pem: `${row.current_key_metadata.public_key_spki_pem}\n`
    };

    expect(() =>
      verifyActiveClinicalContinuityPolicyRow(row, {
        clockTrusted: true,
        trustedNow: TRUSTED_NOW
      })
    ).toThrow(
      expect.objectContaining({
        code: 'CONTINUITY_POLICY_KEY_SUBSTITUTION'
      })
    );
  });

  test.each([
    ['missing policy-key hash', () => ({ policy_signing_public_key_sha256: null })],
    ['missing current pack-key hash', () => ({ current_pack_signing_public_key_sha256: null })],
    ['malformed key hash', () => ({ current_pack_signing_public_key_sha256: 'A'.repeat(64) })],
    ['next key ID without its hash', () => ({ next_pack_signing_public_key_sha256: null })],
    ['next key hash without its ID', () => ({ next_pack_signing_key_id: null })]
  ])('rejects %s', (_label, overrides) => {
    expect(() =>
      buildClinicalContinuityPolicySigningPayload(unsignedPolicyRow(overrides()))
    ).toThrow(
      expect.objectContaining({
        code: 'CONTINUITY_POLICY_KEY_BINDING_INVALID'
      })
    );
  });

  test('binds an approved registry-key hash inside the policy signature', () => {
    const substituteKeys = generateKeyPairSync('ed25519');
    const substitutePublicKey = publicPem(substituteKeys);
    const row = signedPolicyRow();
    row.current_key_metadata = {
      purpose: 'clinical_continuity_pack_signing',
      public_key_spki_pem: substitutePublicKey
    };
    row.current_pack_signing_public_key_sha256 = sha256Hex(substitutePublicKey);

    expect(() =>
      verifyActiveClinicalContinuityPolicyRow(row, {
        clockTrusted: true,
        trustedNow: TRUSTED_NOW
      })
    ).toThrow(
      expect.objectContaining({
        code: 'CONTINUITY_POLICY_SIGNATURE_INVALID'
      })
    );
  });

  test('does not build an offline trust root from an unverified object', () => {
    expect(() =>
      buildOfflineClinicalContinuityTrustRoot({
        tenantId: TENANT,
        facilityId: FACILITY
      })
    ).toThrow(
      expect.objectContaining({
        code: 'CONTINUITY_POLICY_NOT_VERIFIED'
      })
    );
  });

  test.each([
    [
      'tampered signature',
      () => ({ policy_signature: Buffer.alloc(64) }),
      {},
      'CONTINUITY_POLICY_SIGNATURE_INVALID'
    ],
    [
      'compromised current key',
      () => ({ current_key_status: 'compromised' }),
      {},
      'CONTINUITY_POLICY_KEY_COMPROMISED'
    ],
    [
      'revoked next key',
      () => ({ revoked_key_ids: ['continuity-pack-next-k2'] }),
      {},
      'CONTINUITY_POLICY_KEY_REVOKED'
    ],
    [
      'policy rollback',
      () => ({ latest_committed_policy_version: 9_007_199_254_740_994n }),
      {},
      'CONTINUITY_POLICY_ROLLBACK'
    ],
    [
      'persisted policy-floor rollback',
      () => ({}),
      { minimumPolicyVersion: 9_007_199_254_740_994n },
      'CONTINUITY_POLICY_ROLLBACK'
    ],
    [
      'revocation rollback',
      () => ({ latest_committed_revocation_epoch: 8n }),
      {},
      'CONTINUITY_POLICY_REVOCATION_ROLLBACK'
    ],
    [
      'expired effective window',
      () => ({}),
      { trustedNow: EFFECTIVE_UNTIL },
      'CONTINUITY_POLICY_NOT_EFFECTIVE'
    ],
    ['uncertain clock', () => ({}), { clockTrusted: false }, 'CONTINUITY_POLICY_CLOCK_UNCERTAIN'],
    [
      'approval checksum mismatch',
      () => ({
        approval_metadata: {
          clinical_continuity_policy_governance: {
            countersignature_complete: true,
            policy_checksum: 'a'.repeat(64)
          }
        }
      }),
      {},
      'CONTINUITY_POLICY_APPROVAL_INVALID'
    ]
  ])('fails closed on %s', (_label, rowOverrides, options, code) => {
    const row = signedPolicyRow(rowOverrides());
    if (_label === 'tampered signature') {
      row.policy_signature = Buffer.alloc(64);
    }
    expect(() =>
      verifyActiveClinicalContinuityPolicyRow(row, {
        clockTrusted: true,
        trustedNow: TRUSTED_NOW,
        ...options
      })
    ).toThrow(expect.objectContaining({ code }));
  });
});

describe('explicit tenant enumeration and loading', () => {
  test('loads one exact verified facility policy inside the caller RepeatableRead tx', async () => {
    const row = signedPolicyRow();
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ tenant_scope: TENANT, isolation_level: 'repeatable read' }])
      .mockResolvedValueOnce([row]);

    const policy = await loadActiveClinicalContinuityPolicyForFacilityTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT,
      facilityId: String(FACILITY),
      minimumPolicyVersion: 0,
      minimumRevocationEpoch: 0
    });

    expect(policy).toMatchObject({
      tenantId: TENANT,
      facilityId: FACILITY,
      policyVersion: '9007199254740993',
      revocationEpoch: '7'
    });
    expect(query.mock.calls[1][0]).toContain('policy.facility_id = $2::integer');
    expect(query.mock.calls[1][0]).toContain('policy.current_pack_signing_public_key_sha256');
    expect(query.mock.calls[1].slice(1)).toEqual([TENANT, FACILITY]);
  });

  test.each([
    [
      'wrong tenant',
      { tenant_scope: SECOND_TENANT, isolation_level: 'repeatable read' },
      'CONTINUITY_POLICY_TENANT_SCOPE_MISMATCH'
    ],
    [
      'weaker isolation',
      { tenant_scope: TENANT, isolation_level: 'read committed' },
      'CONTINUITY_POLICY_TX_ISOLATION_INVALID'
    ]
  ])('refuses a tx-bound facility read with %s', async (_label, scope, code) => {
    const query = jest.fn().mockResolvedValueOnce([scope]);
    await expect(
      loadActiveClinicalContinuityPolicyForFacilityTx({
        tx: { $queryRawUnsafe: query },
        tenantId: TENANT,
        facilityId: FACILITY
      })
    ).rejects.toMatchObject({ code });
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('fails closed when an exact facility has zero or ambiguous active policies', async () => {
    for (const [rows, code] of [
      [[], 'CONTINUITY_POLICY_NOT_ACTIVE'],
      [[signedPolicyRow(), signedPolicyRow()], 'CONTINUITY_POLICY_ACTIVE_AMBIGUOUS']
    ]) {
      const query = jest
        .fn()
        .mockResolvedValueOnce([{ tenant_scope: TENANT, isolation_level: 'repeatable read' }])
        .mockResolvedValueOnce(rows);
      await expect(
        loadActiveClinicalContinuityPolicyForFacilityTx({
          tx: { $queryRawUnsafe: query },
          tenantId: TENANT,
          facilityId: FACILITY
        })
      ).rejects.toMatchObject({ code });
    }
  });

  test('discovers only active non-default tenant IDs from tenants under bypass', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ tenant_scope: 'bypass' }])
      .mockResolvedValueOnce([{ tenant_id: TENANT }, { tenant_id: SECOND_TENANT }]);
    const scopeRunner = jest.fn(async (tenantId, fn, options) => {
      expect(tenantId).toBeNull();
      expect(options).toEqual({
        superAdmin: true,
        readOnly: true,
        isolationLevel: 'RepeatableRead'
      });
      return fn({ $queryRawUnsafe: query });
    });

    await expect(discoverActiveClinicalContinuityPolicyTenantIds({ scopeRunner })).resolves.toEqual(
      [TENANT, SECOND_TENANT]
    );
    expect(query.mock.calls[1][0]).toContain('FROM tenants');
    expect(query.mock.calls[1][0]).not.toContain('clinical_continuity_policy_versions');
    expect(query.mock.calls[1][1]).toBe(DEFAULT_TENANT_ID);
  });

  test('loads active policy rows only inside the exact tenant scope', async () => {
    const row = signedPolicyRow();
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ tenant_scope: TENANT }])
      .mockResolvedValueOnce([row]);
    const scopeRunner = jest.fn(async (tenantId, fn, options) => {
      expect(tenantId).toBe(TENANT);
      expect(options).toEqual({
        readOnly: true,
        isolationLevel: 'RepeatableRead'
      });
      return fn({ $queryRawUnsafe: query });
    });

    const policies = await loadActiveClinicalContinuityPoliciesForTenant(TENANT, {
      scopeRunner,
      minimumPolicyVersionsByFacility: { [FACILITY]: 0 },
      minimumRevocationEpochsByFacility: { [FACILITY]: 0 }
    });

    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ tenantId: TENANT, facilityId: FACILITY });
    expect(query.mock.calls[1][0]).toContain('WHERE policy.tenant_id = $1::uuid');
    expect(query.mock.calls[1][1]).toBe(TENANT);
  });

  test('fails before policy reads when the transaction scope is wrong', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ tenant_scope: SECOND_TENANT }]);
    const scopeRunner = async (_tenantId, fn) => fn({ $queryRawUnsafe: query });

    await expect(
      loadActiveClinicalContinuityPoliciesForTenant(TENANT, {
        scopeRunner
      })
    ).rejects.toMatchObject({
      code: 'CONTINUITY_POLICY_TENANT_SCOPE_MISMATCH'
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('enumerates each tenant separately and never runs policy SQL under bypass', async () => {
    const scopeCalls = [];
    const scopeRunner = jest.fn(async (tenantId, fn, options) => {
      scopeCalls.push({ tenantId, options });
      if (tenantId === null) {
        let call = 0;
        return fn({
          $queryRawUnsafe: async sql => {
            call += 1;
            if (call === 1) return [{ tenant_scope: 'bypass' }];
            expect(sql).toContain('FROM tenants');
            expect(sql).not.toContain('clinical_continuity_policy_versions');
            return [{ tenant_id: TENANT }, { tenant_id: SECOND_TENANT }];
          }
        });
      }
      let call = 0;
      return fn({
        $queryRawUnsafe: async sql => {
          call += 1;
          if (call === 1) return [{ tenant_scope: tenantId }];
          expect(sql).toContain('policy.tenant_id = $1::uuid');
          return [];
        }
      });
    });

    await expect(enumerateActiveClinicalContinuityPolicies({ scopeRunner })).resolves.toEqual([]);
    expect(scopeCalls.map(call => call.tenantId)).toEqual([null, TENANT, SECOND_TENANT]);
    expect(scopeCalls.every(call => call.options.readOnly === false)).toBe(true);
  });

  test('allows an explicit read-only enumeration while defaulting Cron enumeration to primary', async () => {
    const calls = [];
    const scopeRunner = async (tenantId, fn, options) => {
      calls.push({ tenantId, options });
      let call = 0;
      return fn({
        $queryRawUnsafe: async () => {
          call += 1;
          return call === 1 ? [{ tenant_scope: tenantId }] : [];
        }
      });
    };

    await enumerateActiveClinicalContinuityPolicies({
      tenantId: TENANT,
      scopeRunner,
      readOnly: true
    });
    expect(calls).toEqual([
      {
        tenantId: TENANT,
        options: { isolationLevel: 'RepeatableRead', readOnly: true }
      }
    ]);
  });

  test('rejects default-tenant entrypoints before opening a transaction', async () => {
    const scopeRunner = jest.fn();
    await expect(
      loadActiveClinicalContinuityPoliciesForTenant(DEFAULT_TENANT_ID, { scopeRunner })
    ).rejects.toMatchObject({
      code: 'CONTINUITY_POLICY_DEFAULT_TENANT_REJECTED'
    });
    expect(scopeRunner).not.toHaveBeenCalled();
  });
});
