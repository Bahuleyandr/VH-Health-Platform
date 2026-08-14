import { __testing__ as fhirTesting } from '../../services/fhir/fhirAllergyIntoleranceService.js';
import { __testing__ as hl7Testing } from '../../services/hl7/hl7InboundClinicalCommandService.js';
import { parseADTToAdmission } from '../../services/hl7/hl7Transformer.js';

const TENANT_ID = 'fa110000-0000-4000-8000-000000000001';
const PATIENT_UID = 'fa110000-0000-4000-8000-000000000002';

describe('canonical interoperability identities', () => {
  it('normalizes an exact FHIR allergy retry onto one identity and payload', () => {
    const first = fhirTesting.normalizeAllergyInput({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      allergen: 'Canonical Penicillin',
      severity: 'SEVERE',
      reaction: 'Anaphylaxis',
    });
    const retry = fhirTesting.normalizeAllergyInput({
      tenantId: TENANT_ID.toUpperCase(),
      patientUid: PATIENT_UID.toUpperCase(),
      allergen: '  CANONICAL   PENICILLIN ',
      severity: 'severe',
      reaction: 'ANAPHYLAXIS',
    });

    expect(retry).toEqual(expect.objectContaining({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      allergen: 'CANONICAL PENICILLIN',
      severity: 'SEVERE',
      reaction: 'ANAPHYLAXIS',
      resourceFingerprint: first.resourceFingerprint,
      payloadSha256: first.payloadSha256,
    }));
  });

  it('keeps FHIR allergy identity stable while detecting changed clinical content', () => {
    const first = fhirTesting.normalizeAllergyInput({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      allergen: 'Canonical Penicillin',
      severity: 'SEVERE',
      reaction: 'Anaphylaxis',
    });
    const changed = fhirTesting.normalizeAllergyInput({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      allergen: 'Canonical Penicillin',
      severity: 'SEVERE',
      reaction: 'Rash',
    });

    expect(changed.resourceFingerprint).toBe(first.resourceFingerprint);
    expect(changed.payloadSha256).not.toBe(first.payloadSha256);
  });

  it('binds the HL7 durable identity to tenant, sender, and MSH-10', () => {
    const identity = {
      tenantId: TENANT_ID,
      senderIdentity: 'hl7-inbound-credential:481',
      messageControlId: 'CAN-ADT-001',
    };
    const baseline = hl7Testing.receiptIdentityHash(identity);

    expect(hl7Testing.receiptIdentityHash(identity)).toBe(baseline);
    expect(hl7Testing.receiptIdentityHash({
      ...identity,
      tenantId: 'fb110000-0000-4000-8000-000000000001',
    })).not.toBe(baseline);
    expect(hl7Testing.receiptIdentityHash({
      ...identity,
      senderIdentity: 'hl7-inbound-credential:482',
    })).not.toBe(baseline);
    expect(hl7Testing.receiptIdentityHash({
      ...identity,
      messageControlId: 'CAN-ADT-002',
    })).not.toBe(baseline);
  });

  it('treats any changed HL7 wire payload as outcome-identity drift', () => {
    const message = 'MSH|^~\\&|CANONICAL-SENDER|CANONICAL-SITE|VH|CANONICAL-INTEROP|20260813080500+0530||ADT^A01|CAN-ADT-001|P|2.5';

    expect(hl7Testing.messageFingerprint(message)).toBe(
      hl7Testing.messageFingerprint(message),
    );
    expect(hl7Testing.messageFingerprint(`${message}\rPID|1||patient-a`)).not.toBe(
      hl7Testing.messageFingerprint(message),
    );
  });

  it('threads the PV1-19 visit identity through the inbound ADT transformer', () => {
    const pv1 = Array(46).fill('');
    pv1[0] = 'PV1';
    pv1[1] = '1';
    pv1[2] = 'I';
    pv1[3] = 'WARD-1^BED-1';
    pv1[19] = 'VISIT-ADT-1042';
    const message = [
      'MSH|^~\\&|CANONICAL-SENDER|CANONICAL-SITE|VH|CANONICAL-INTEROP|20260813080500+0530||ADT^A02|CAN-ADT-002|P|2.5',
      `PID|1||${PATIENT_UID}`,
      pv1.join('|'),
    ].join('\r');

    const { admission } = parseADTToAdmission(message);

    expect(admission).toEqual(expect.objectContaining({
      visit_number: 'VISIT-ADT-1042',
      status: 'TRANSFERRED',
      ward: 'WARD-1',
      bed_number: 'BED-1',
    }));
  });
});
