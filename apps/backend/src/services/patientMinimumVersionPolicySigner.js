import { signCanonicalValue } from './downtime/continuityPackCanonical.js';

export function createSignedPatientMinimumVersionPolicy(
  {
    keyId,
    tenantId,
    revision,
    minPatientVersionCode,
    issuedAt,
    graceUntil
  },
  privateKey
) {
  const unsigned = {
    algorithm: 'Ed25519',
    format: 'vhhealth_patient_minimum_version/v1',
    key_id: keyId,
    policy: {
      audience: 'vhhealth-patient-minimum-version',
      tenant_id: tenantId,
      revision,
      min_patient_version_code: minPatientVersionCode,
      issued_at: issuedAt,
      grace_until: graceUntil
    }
  };
  return {
    ...unsigned,
    signature: signCanonicalValue(unsigned, privateKey)
  };
}
