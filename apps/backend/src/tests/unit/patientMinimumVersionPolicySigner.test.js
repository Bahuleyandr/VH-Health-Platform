import { generateKeyPairSync } from 'node:crypto';
import {
  verifyCanonicalValue
} from '../../services/downtime/continuityPackCanonical.js';
import { patientMinimumVersionPolicyFromEnv } from '../../services/patientMinimumVersionPolicy.js';
import { createSignedPatientMinimumVersionPolicy } from '../../services/patientMinimumVersionPolicySigner.js';

describe('patient minimum-version offline signer', () => {
  it('uses the shared RFC 8785 and Ed25519 primitive', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const envelope = createSignedPatientMinimumVersionPolicy(
      {
        keyId: 'patient-minimum-version-2026-01',
        tenantId: '00000000-0000-4000-8000-000000000001',
        revision: 3,
        minPatientVersionCode: 42,
        issuedAt: '2026-08-13T00:00:00.000Z',
        graceUntil: '2026-08-15T00:00:00.000Z'
      },
      privateKey
    );
    const unsigned = { ...envelope };
    delete unsigned.signature;

    expect(
      patientMinimumVersionPolicyFromEnv(
        JSON.stringify(envelope),
        envelope.policy.tenant_id
      )
    ).toEqual(envelope);
    expect(
      verifyCanonicalValue(unsigned, envelope.signature, publicKey)
    ).toBe(true);
    expect(
      verifyCanonicalValue(
        {
          ...unsigned,
          policy: { ...unsigned.policy, min_patient_version_code: 1 }
        },
        envelope.signature,
        publicKey
      )
    ).toBe(false);
  });
});
