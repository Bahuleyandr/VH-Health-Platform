import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(__prismaDefaultMock));
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();
const publishEventMock = jest.fn();
const requireTenantIdMock = jest.fn((tenantId) => tenantId);
const recordCanonicalClinicalEventMock = jest.fn(async () => ({
  timeline: { id: 1 },
  audit: { id: 2 },
}));

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
  },
}));

jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: publishEventMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: requireTenantIdMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const {
  acceptPrehospitalHandover,
  appendPrehospitalTimelineEvent,
  createPrehospitalHandover,
  recordPartnerSuppliedPayload,
} = await import('../../services/ed/ambulancePrehospitalService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

function ambulanceRow(overrides = {}) {
  return {
    id: 42,
    tenant_id: TENANT,
    request_number: 'AMB-42',
    patient_uid: PATIENT,
    patient_name: 'Patient',
    presenting_complaint: 'Chest pain',
    status: 'dispatched',
    priority: 'red',
    ...overrides,
  };
}

function handoverRow(overrides = {}) {
  return {
    id: 900,
    tenant_id: TENANT,
    handover_number: 'PH-AMB-42',
    ambulance_request_id: 42,
    emergency_visit_id: 77,
    partner_config_id: 12,
    patient_uid: PATIENT,
    status: 'ready_for_acceptance',
    manual_entry: true,
    source_type: 'manual',
    pickup_context: 'Home',
    scene_observations: 'Diaphoretic',
    allergies_reported: 'NKDA',
    medications_reported: 'Aspirin given',
    eta_first_at: '2026-07-10T08:00:00.000Z',
    eta_latest_at: '2026-07-10T08:12:00.000Z',
    eta_change_reason: null,
    presenting_complaint: 'Chest pain',
    sbar: { situation: 'Chest pain' },
    metadata: { manual_first: true },
    created_by: ACTOR,
    updated_by: ACTOR,
    created_at: '2026-07-10T07:50:00.000Z',
    updated_at: '2026-07-10T07:50:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  setTenantTxMock.mockClear();
  loggerInfoMock.mockClear();
  loggerWarnMock.mockClear();
  loggerErrorMock.mockClear();
  publishEventMock.mockReset();
  requireTenantIdMock.mockClear();
  recordCanonicalClinicalEventMock.mockClear().mockResolvedValue({
    timeline: { id: 1 },
    audit: { id: 2 },
  });
});

describe('ambulance pre-hospital handover service', () => {
  it('creates a manual-first handover and optional ED visit inside tenant scope', async () => {
    const createdVisit = {
      id: 77,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      ambulance_request_id: 42,
      visit_number: 'ED-AMB-AMB-42',
    };
    const createdHandover = handoverRow();
    queryRawUnsafeMock
      .mockResolvedValueOnce([ambulanceRow()])
      .mockResolvedValueOnce([createdVisit])
      .mockResolvedValueOnce([createdHandover]);

    const row = await createPrehospitalHandover({
      tenantId: TENANT,
      ambulanceRequestId: 42,
      createEmergencyVisit: true,
      sceneObservations: 'Diaphoretic',
      medicationsReported: 'Aspirin given',
      createdBy: ACTOR,
      actorRole: 'NURSE',
    });

    expect(row).toEqual(createdHandover);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryRawUnsafeMock.mock.calls[1][0]).toContain('INSERT INTO emergency_visits');
    expect(queryRawUnsafeMock.mock.calls[2][0]).toContain('INSERT INTO prehospital_handovers');
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        patientUid: PATIENT,
        eventType: 'prehospital_handover.created',
        sourceTable: 'prehospital_handovers',
        sourceId: createdHandover.id,
      }),
      { db: __prismaDefaultMock },
    );
    expect(publishEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'clinical.prehospital_handover.created',
      aggregateId: createdHandover.id,
      tenantId: TENANT,
      tx: __prismaDefaultMock,
    }));
  });

  it('appends timeline observations through the canonical clinical timeline', async () => {
    const eventRow = {
      id: 55,
      tenant_id: TENANT,
      handover_id: 900,
      event_type: 'vital',
      event_at: '2026-07-10T08:01:00.000Z',
      recorded_by: ACTOR,
      source_type: 'manual',
      summary: 'BP 90/60, HR 122',
      observation: {},
      intervention: {},
      vital_signs: { bp: '90/60', hr: 122 },
      external_reference: null,
      metadata: {},
    };
    queryRawUnsafeMock
      .mockResolvedValueOnce([handoverRow()])
      .mockResolvedValueOnce([eventRow]);

    const event = await appendPrehospitalTimelineEvent({
      tenantId: TENANT,
      handoverId: 900,
      eventType: 'vital',
      summary: 'BP 90/60, HR 122',
      vitalSigns: { bp: '90/60', hr: 122 },
      recordedBy: ACTOR,
      actorRole: 'PARAMEDIC',
    });

    expect(event).toEqual(eventRow);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'prehospital_handover.vital',
        patientUid: PATIENT,
        sourceTable: 'prehospital_handover_events',
        sourceId: eventRow.id,
      }),
      { db: __prismaDefaultMock },
    );
  });

  it('accepts the handover before partner payloads can affect the chart', async () => {
    const acceptance = {
      id: 12,
      tenant_id: TENANT,
      handover_id: 900,
      accepted_by_uid: ACTOR,
      accepted_by_role: 'NURSE',
      acceptance_role: 'receiving_nurse',
      signature_method: 'typed',
      clinical_attestation: 'Reviewed',
    };
    const accepted = handoverRow({ status: 'accepted', updated_by: ACTOR });
    queryRawUnsafeMock
      .mockResolvedValueOnce([handoverRow()])
      .mockResolvedValueOnce([acceptance])
      .mockResolvedValueOnce([accepted]);

    const result = await acceptPrehospitalHandover({
      tenantId: TENANT,
      handoverId: 900,
      acceptedByUid: ACTOR,
      acceptedByRole: 'NURSE',
      clinicalAttestation: 'Reviewed',
    });

    expect(result.handover.status).toBe('accepted');
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'prehospital_handover.accepted',
        eventStatus: 'accepted',
        sourceTable: 'prehospital_handover_acceptances',
        sourceId: acceptance.id,
      }),
      { db: __prismaDefaultMock },
    );
    expect(publishEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'clinical.prehospital_handover.accepted',
      aggregateId: accepted.id,
      tenantId: TENANT,
    }));
  });

  it('blocks partner payloads before ED handover acceptance', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      handoverRow({ status: 'ready_for_acceptance' }),
    ]);

    await expect(recordPartnerSuppliedPayload({
      tenantId: TENANT,
      handoverId: 900,
      deviceLinkId: 10,
      payload: { summary: 'Partner vitals' },
      receivedBy: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PREHOSPITAL_HANDOVER_NOT_ACCEPTED',
    });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('blocks partner payloads without an active verified NL-7 device link', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([
      handoverRow({ status: 'accepted' }),
    ]);

    await expect(recordPartnerSuppliedPayload({
      tenantId: TENANT,
      handoverId: 900,
      payload: { summary: 'Partner vitals' },
      receivedBy: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PREHOSPITAL_DEVICE_LINK_REQUIRED',
    });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps partner ingestion inert until the reviewed policy is active', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([handoverRow({ status: 'accepted', partner_config_id: 12 })])
      .mockResolvedValueOnce([{ id: 10, verification_status: 'verified', link_status: 'active' }])
      .mockResolvedValueOnce([{ id: 12, status: 'inert' }]);

    await expect(recordPartnerSuppliedPayload({
      tenantId: TENANT,
      handoverId: 900,
      deviceLinkId: 10,
      payload: { summary: 'Partner vitals' },
      receivedBy: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PREHOSPITAL_PARTNER_POLICY_INERT',
    });
  });
});
