import { randomUUID } from 'node:crypto';

import { assertLateRecoveryVitalsBoundary } from '../../services/emr/vitalsChartService.js';
import {
  I09_GATEWAY_SEQUENCE_CONTRACT,
  I15_FHIR_SEQUENCE_CONTRACT,
  canonicalResourceSha256,
  i09DuplicateKey,
  i09SourceToken,
  lengthPrefixedSha256,
  sha256Utf8,
  validateI09GatewayRecovery,
  validateI15FhirRecovery,
} from '../../services/integrations/externalVitalsRecoveryService.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const OFFSET_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE = [
  'MSH|^~\\&|MON-7|WARD-ICU|||20260731123100+0530||ORU^R01|MSG-001|P|2.5',
  `PID|||${PATIENT_UID}`,
  'OBR|1|||85354-9|||20260731123000+0530',
  'OBX|1|NM|8867-4^Heart rate||88|/min',
].join('\r');

function i09Envelope() {
  const sourcePartition = 'i09/gateway/41/device/42';
  const messageSha256 = sha256Utf8(MESSAGE);
  const duplicateKey = i09DuplicateKey({
    tenantId: TENANT_ID,
    deviceRegistryId: 42,
    msh10: 'MSG-001',
  });
  const predecessorToken = 'previous-token';
  return {
    schema: I09_GATEWAY_SEQUENCE_CONTRACT,
    interface_family: 'I09',
    arrival_class: 'recovery_backlog',
    tenant_id: TENANT_ID,
    gateway_registry_id: 41,
    device_registry_id: 42,
    offset_id: OFFSET_ID,
    source_partition: sourcePartition,
    generation: 3,
    source_position: '19',
    predecessor_token: predecessorToken,
    msh10: 'MSG-001',
    duplicate_key: duplicateKey,
    message_sha256: messageSha256,
    source_token: i09SourceToken({
      tenantId: TENANT_ID,
      sourcePartition,
      generation: 3,
      sourcePosition: '19',
      predecessorToken,
      duplicateKey,
      messageSha256,
    }),
    gateway_received_at: '2026-07-31T12:31:05+05:30',
    clock_evidence: { source: 'ntp', offset_ms: 14 },
  };
}

describe('C6.1-B I09/I15 recovery contracts', () => {
  it('pins length-prefixed hashes without delimiter ambiguity', () => {
    expect(lengthPrefixedSha256(['ab', 'c'])).not.toBe(lengthPrefixedSha256(['a', 'bc']));
    expect(i09DuplicateKey({
      tenantId: TENANT_ID,
      deviceRegistryId: 42,
      msh10: 'MSG-001',
    })).toBe('991f87c0783f2f4b19850de0d952198307c3b1270b7fed6ef7e660711cee17eb');
  });

  it('rederives every I09 identity and preserves the source occurrence', async () => {
    const tx = {
      $queryRawUnsafe: async (_sql, _tenantId, id) => [{
        id,
        device_code: Number(id) === 42 ? 'MON-7' : 'GATEWAY-1',
        kind: Number(id) === 42 ? 'monitor' : 'monitor_gateway',
        status: 'active',
      }],
    };
    const result = await validateI09GatewayRecovery({
      tenantId: TENANT_ID,
      message: MESSAGE,
      deviceCode: 'MON-7',
      patientUid: PATIENT_UID,
      recovery: i09Envelope(),
    }, { tx });
    expect(result).toMatchObject({
      interfaceFamily: 'I09',
      sourcePartition: 'i09/gateway/41/device/42',
      sourcePosition: '19',
      occurredAt: '2026-07-31T07:00:00.000Z',
      commandFingerprint: sha256Utf8(MESSAGE),
      command: {
        kind: 'i09',
        patient_uid: PATIENT_UID,
        device_registry_id: 42,
        vitals: { heart_rate: 88 },
      },
    });
  });

  it('refuses unknown I09 fields and evidence mismatches', async () => {
    const tx = {
      $queryRawUnsafe: async (_sql, _tenantId, id) => [{
        id,
        device_code: Number(id) === 42 ? 'MON-7' : 'GATEWAY-1',
        kind: Number(id) === 42 ? 'monitor' : 'monitor_gateway',
        status: 'active',
      }],
    };
    await expect(validateI09GatewayRecovery({
      tenantId: TENANT_ID,
      message: MESSAGE,
      deviceCode: 'MON-7',
      recovery: { ...i09Envelope(), inferred_head: true },
    }, { tx })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_ENVELOPE_REFUSED' });
    await expect(validateI09GatewayRecovery({
      tenantId: TENANT_ID,
      message: `${MESSAGE}\rNTE|1||changed bytes`,
      deviceCode: 'MON-7',
      recovery: i09Envelope(),
    }, { tx })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_ENVELOPE_REFUSED' });
  });

  it('refuses same-device and wrong-kind gateway identities', async () => {
    const wrongGatewayKindTx = {
      $queryRawUnsafe: async (_sql, _tenantId, id) => [{
        id,
        device_code: Number(id) === 42 ? 'MON-7' : 'GATEWAY-1',
        kind: 'monitor',
        status: 'active',
      }],
    };
    await expect(validateI09GatewayRecovery({
      tenantId: TENANT_ID,
      message: MESSAGE,
      deviceCode: 'MON-7',
      recovery: i09Envelope(),
    }, { tx: wrongGatewayKindTx })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_DEVICE_REFUSED' });

    const wrongDeviceKindTx = {
      $queryRawUnsafe: async (_sql, _tenantId, id) => [{
        id,
        device_code: Number(id) === 42 ? 'MON-7' : 'GATEWAY-1',
        kind: Number(id) === 42 ? 'cold_chain_sensor' : 'monitor_gateway',
        status: 'active',
      }],
    };
    await expect(validateI09GatewayRecovery({
      tenantId: TENANT_ID,
      message: MESSAGE,
      deviceCode: 'MON-7',
      recovery: i09Envelope(),
    }, { tx: wrongDeviceKindTx })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_DEVICE_REFUSED' });

    await expect(validateI09GatewayRecovery({
      tenantId: TENANT_ID,
      message: MESSAGE,
      deviceCode: 'GATEWAY-1',
      recovery: {
        ...i09Envelope(),
        device_registry_id: 41,
        source_partition: 'i09/gateway/41/device/41',
      },
    }, { tx: wrongGatewayKindTx })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_DEVICE_REFUSED' });
  });

  it('accepts I15 FHIR writes but keeps SMART OAuth outside recovery', () => {
    const resource = {
      resourceType: 'Observation',
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
      subject: { reference: `Patient/${PATIENT_UID}` },
      effectiveDateTime: '2026-07-31T12:30:00+05:30',
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
      valueQuantity: { value: 88, unit: '/min' },
    };
    const clientId = 'client-recovery-1';
    const partition = `i15/client/${clientId}/resource/Observation`;
    const duplicateKey = lengthPrefixedSha256([
      'vh-i15-duplicate-v1', TENANT_ID, clientId, 'event-19',
    ]);
    const predecessorToken = 'previous-token';
    const resourceSha256 = canonicalResourceSha256(resource);
    const recovery = {
      schema: I15_FHIR_SEQUENCE_CONTRACT,
      interface_family: 'I15',
      arrival_class: 'recovery_backlog',
      tenant_id: TENANT_ID,
      api_client_id: clientId,
      offset_id: OFFSET_ID,
      source_partition: partition,
      generation: 2,
      source_position: '19',
      predecessor_token: predecessorToken,
      event_identity: 'event-19',
      duplicate_key: duplicateKey,
      resource_sha256: resourceSha256,
      source_token: lengthPrefixedSha256([
        'vh-i15-source-token-v1', TENANT_ID, partition, '2', '19',
        predecessorToken, duplicateKey, resourceSha256,
      ]),
      client_received_at: '2026-07-31T12:31:00+05:30',
      clock_evidence: {},
    };
    expect(validateI15FhirRecovery({ tenantId: TENANT_ID, apiClientId: clientId, resource, recovery }))
      .toMatchObject({
        interfaceFamily: 'I15',
        subpath: 'fhir_write',
        occurredAt: '2026-07-31T07:00:00.000Z',
        command: { patient_uid: PATIENT_UID, vitals: { heart_rate: 88 } },
      });
  });

  it('keeps the vitals/NEWS2/triage boundary absolute', () => {
    expect(() => assertLateRecoveryVitalsBoundary({
      interfaceFamily: 'I09', source: 'device', deviceVerified: false, triageAcuity: null,
    })).not.toThrow();
    expect(() => assertLateRecoveryVitalsBoundary({
      interfaceFamily: 'I15', source: 'fhir', deviceVerified: null, triageAcuity: null,
    })).not.toThrow();
    expect(() => assertLateRecoveryVitalsBoundary({
      interfaceFamily: 'I09', source: 'device', deviceVerified: false, triageAcuity: 2,
    })).toThrow('observation-only pending review');
  });
});
