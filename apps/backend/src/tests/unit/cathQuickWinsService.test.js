import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const orderSetFindFirstMock = jest.fn();
const orderSetItemsCountMock = jest.fn();
const settingsMock = jest.fn();
const applyOrderSetMock = jest.fn();
const auditMock = jest.fn();
const createTaskMock = jest.fn();

const prismaMock = {
  $queryRawUnsafe: queryUnsafeMock,
  clinical_order_sets: { findFirst: orderSetFindFirstMock },
  clinical_order_set_items: { count: orderSetItemsCountMock },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
}));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  CATH_QUICK_WIN_SLOTS: ['pre_cath', 'post_cath'],
  getCathQuickWinSettings: settingsMock,
}));
jest.unstable_mockModule('../../services/emr/orderEntryService.js', () => ({
  default: {},
  applyOrderSet: applyOrderSetMock,
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  default: {},
  recordClinicalAuditEvent: auditMock,
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createTask: createTaskMock,
}));

const {
  getCaseQuickWins,
  refreshReadinessEvidence,
  applyCathOrderSetSlot,
  resolveBloodReadinessEvidence,
  resolveConsentReadinessEvidence,
  emitCathProcedureCompletionFollowUps,
  __testing__,
} = await import('../../services/clinical/cathQuickWinsService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const ENCOUNTER = '44444444-4444-4444-8444-444444444444';

function inertSettings(overrides = {}) {
  return {
    consentType: null,
    orderSetFamilies: { pre_cath: null, post_cath: null },
    followUpTemplates: [],
    ...overrides,
  };
}

function caseRow(overrides = {}) {
  return {
    id: 7,
    tenant_id: TENANT,
    patient_uid: PATIENT,
    encounter_id: ENCOUNTER,
    appointment_id: null,
    requested_procedure: 'Coronary angiogram',
    status: 'readiness_pending',
    ...overrides,
  };
}

function bloodRow(overrides = {}) {
  return {
    id: 88,
    blood_group: 'O+',
    component: 'prbc',
    units: 2,
    urgency: 'routine',
    status: 'cross_matched',
    cross_match_status: 'compatible',
    cross_matched_at: new Date('2026-07-10T08:00:00.000Z'),
    issued_at: null,
    transfused_at: null,
    created_at: new Date('2026-07-09T08:00:00.000Z'),
    ...overrides,
  };
}

function consentRow(overrides = {}) {
  return {
    consent_id: 501,
    consent_type: 'cath_procedure',
    granted_at: new Date('2026-07-08T10:00:00.000Z'),
    expires_at: null,
    signature_id: 9001,
    signature_version: 1,
    captured_at: new Date('2026-07-08T10:05:00.000Z'),
    mime_type: 'image/png',
    ...overrides,
  };
}

function routeQueries(routes) {
  queryUnsafeMock.mockImplementation(async (sql, ...params) => {
    for (const [needle, result] of routes) {
      if (sql.includes(needle)) {
        return typeof result === 'function' ? result(sql, params) : result;
      }
    }
    throw new Error(`Unrouted SQL in test: ${sql.slice(0, 80)}`);
  });
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  orderSetFindFirstMock.mockReset();
  orderSetItemsCountMock.mockReset();
  settingsMock.mockReset();
  applyOrderSetMock.mockReset();
  auditMock.mockReset();
  createTaskMock.mockReset();
  auditMock.mockResolvedValue({ id: 'audit-1' });
  createTaskMock.mockResolvedValue({ id: 7001, status: 'open' });
});

describe('resolveBloodReadinessEvidence', () => {
  it('returns live crossmatch evidence when a blood request exists', async () => {
    routeQueries([['FROM blood_requests', [bloodRow()]]]);
    const evidence = await resolveBloodReadinessEvidence({ tenantId: TENANT, patientUid: PATIENT });
    expect(evidence.evidence).toBe('blood_bank_crossmatch');
    expect(evidence.blood_request_id).toBe(88);
    expect(evidence.cross_match_status).toBe('compatible');
    expect(evidence.request_status).toBe('cross_matched');
  });

  it('returns null when the patient has no blood request (item stays manual)', async () => {
    routeQueries([['FROM blood_requests', []]]);
    const evidence = await resolveBloodReadinessEvidence({ tenantId: TENANT, patientUid: PATIENT });
    expect(evidence).toBeNull();
  });
});

describe('resolveConsentReadinessEvidence', () => {
  it('returns null without querying when the tenant has no consent mapping', async () => {
    const evidence = await resolveConsentReadinessEvidence({
      tenantId: TENANT,
      patientUid: PATIENT,
      consentType: null,
    });
    expect(evidence).toBeNull();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('returns signed_consent evidence with an artifact link when mapped and signed', async () => {
    routeQueries([['FROM patient_consents', [consentRow()]]]);
    const evidence = await resolveConsentReadinessEvidence({
      tenantId: TENANT,
      patientUid: PATIENT,
      consentType: 'cath_procedure',
    });
    expect(evidence.evidence).toBe('signed_consent');
    expect(evidence.consent_id).toBe(501);
    expect(evidence.artifact_path).toBe('/api/v1/consent/501/pdf');
  });

  it('returns null when the mapped consent exists but has no patient signature', async () => {
    routeQueries([['FROM patient_consents', []]]);
    const evidence = await resolveConsentReadinessEvidence({
      tenantId: TENANT,
      patientUid: PATIENT,
      consentType: 'cath_procedure',
    });
    expect(evidence).toBeNull();
  });
});

describe('getCaseQuickWins', () => {
  it('composes live evidence and deployed order-set slots', async () => {
    settingsMock.mockResolvedValue(inertSettings({
      consentType: 'cath_procedure',
      orderSetFamilies: { pre_cath: 'CATH-PRE', post_cath: null },
    }));
    routeQueries([
      ['FROM cath_lab_cases', [caseRow()]],
      ['FROM blood_requests', [bloodRow()]],
      ['FROM patient_consents', [consentRow()]],
    ]);
    orderSetFindFirstMock.mockResolvedValue({
      id: 31,
      code: 'CATH-PRE-V2',
      family_key: 'CATH-PRE',
      title: 'Pre-cath bundle',
      description: null,
      specialty: 'cardiology',
      version: 2,
    });
    orderSetItemsCountMock.mockResolvedValue(3);

    const quickWins = await getCaseQuickWins(7, { tenantId: TENANT });

    expect(quickWins.case_id).toBe(7);
    expect(quickWins.readiness_evidence.blood_bank.cross_match_status).toBe('compatible');
    expect(quickWins.readiness_evidence.consent.evidence).toBe('signed_consent');
    expect(quickWins.order_sets.pre_cath).toMatchObject({
      order_set_id: 31,
      family_key: 'CATH-PRE',
      item_count: 3,
    });
    expect(quickWins.order_sets.post_cath).toBeNull();
    expect(orderSetFindFirstMock).toHaveBeenCalledTimes(1);
  });

  it('stays fully inert when nothing is configured and no source rows exist', async () => {
    settingsMock.mockResolvedValue(inertSettings());
    routeQueries([
      ['FROM cath_lab_cases', [caseRow()]],
      ['FROM blood_requests', []],
    ]);

    const quickWins = await getCaseQuickWins(7, { tenantId: TENANT });

    expect(quickWins.readiness_evidence.blood_bank).toBeNull();
    expect(quickWins.readiness_evidence.consent).toBeNull();
    expect(quickWins.order_sets).toEqual({ pre_cath: null, post_cath: null });
    expect(quickWins.follow_up.configured_template_count).toBe(0);
    expect(orderSetFindFirstMock).not.toHaveBeenCalled();
  });
});

describe('refreshReadinessEvidence', () => {
  it('persists evidence onto readiness rows without touching status and audits each attach', async () => {
    settingsMock.mockResolvedValue(inertSettings({ consentType: 'cath_procedure' }));
    const updateCalls = [];
    routeQueries([
      ['FROM cath_lab_cases', [caseRow()]],
      ['FROM blood_requests', [bloodRow()]],
      ['FROM patient_consents', [consentRow()]],
      ['UPDATE cath_lab_readiness_checks', (sql, params) => {
        updateCalls.push({ sql, params });
        const checkType = params[2];
        return [{
          id: checkType === 'blood_bank' ? 11 : 12,
          check_type: checkType,
          status: 'pending',
          evidence_owner: params[3],
          source_name: params[4],
          attachment_ref: params[5],
          metadata: {},
        }];
      }],
    ]);

    const result = await refreshReadinessEvidence(7, { tenantId: TENANT }, { actorUid: ACTOR });

    expect(result.attached).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(updateCalls).toHaveLength(2);
    for (const call of updateCalls) {
      expect(call.sql).not.toMatch(/SET\s+status/i);
      expect(call.sql).not.toMatch(/completed_at/i);
    }
    expect(auditMock).toHaveBeenCalledTimes(2);
    for (const [input] of auditMock.mock.calls) {
      expect(input.action).toBe('cath_lab.readiness_evidence_attached');
      expect(input.resourceTable).toBe('cath_lab_readiness_checks');
    }
  });

  it('never fabricates evidence: absent sources leave rows untouched and unaudited', async () => {
    settingsMock.mockResolvedValue(inertSettings());
    routeQueries([
      ['FROM cath_lab_cases', [caseRow()]],
      ['FROM blood_requests', []],
    ]);

    const result = await refreshReadinessEvidence(7, { tenantId: TENANT }, { actorUid: ACTOR });

    expect(result.attached).toEqual([]);
    expect(result.skipped).toEqual([
      { check_type: 'blood_bank', reason: 'no_live_evidence' },
      { check_type: 'consent', reason: 'no_live_evidence' },
    ]);
    expect(auditMock).not.toHaveBeenCalled();
    const updateCalls = queryUnsafeMock.mock.calls.filter(
      ([sql]) => sql.includes('UPDATE cath_lab_readiness_checks'),
    );
    expect(updateCalls).toHaveLength(0);
  });
});

describe('applyCathOrderSetSlot', () => {
  it('rejects junk slots', async () => {
    settingsMock.mockResolvedValue(inertSettings());
    await expect(applyCathOrderSetSlot(7, 'mid_cath', { tenantId: TENANT }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_QW_BAD_SLOT' });
    expect(__testing__.assertSlot('PRE_CATH')).toBe('pre_cath');
  });

  it('is inert when the slot is unmapped: no CPOE call, no orders', async () => {
    settingsMock.mockResolvedValue(inertSettings());
    await expect(applyCathOrderSetSlot(7, 'pre_cath', { tenantId: TENANT }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_QW_ORDER_SET_UNMAPPED' });
    expect(applyOrderSetMock).not.toHaveBeenCalled();
  });

  it('fails closed when the mapped family has no deployed version', async () => {
    settingsMock.mockResolvedValue(inertSettings({
      orderSetFamilies: { pre_cath: 'CATH-PRE', post_cath: null },
    }));
    orderSetFindFirstMock.mockResolvedValue(null);
    await expect(applyCathOrderSetSlot(7, 'pre_cath', { tenantId: TENANT }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_QW_ORDER_SET_NOT_DEPLOYED' });
    expect(applyOrderSetMock).not.toHaveBeenCalled();
  });

  it('stages the deployed set through the existing CPOE path only', async () => {
    settingsMock.mockResolvedValue(inertSettings({
      orderSetFamilies: { pre_cath: 'CATH-PRE', post_cath: null },
    }));
    orderSetFindFirstMock.mockResolvedValue({
      id: 31,
      code: 'CATH-PRE-V2',
      family_key: 'CATH-PRE',
      title: 'Pre-cath bundle',
      description: null,
      specialty: 'cardiology',
      version: 2,
    });
    orderSetItemsCountMock.mockResolvedValue(3);
    routeQueries([['FROM cath_lab_cases', [caseRow()]]]);
    applyOrderSetMock.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const result = await applyCathOrderSetSlot(7, 'pre_cath', { tenantId: TENANT }, { actorUid: ACTOR });

    expect(applyOrderSetMock).toHaveBeenCalledWith(PATIENT, ENCOUNTER, 31, ACTOR, TENANT);
    expect(result.order_set.order_set_id).toBe(31);
    expect(result.orders).toHaveLength(3);
    // Orders ride CPOE's canonical path — this service must never write order
    // tables directly.
    for (const [sql] of queryUnsafeMock.mock.calls) {
      expect(sql).not.toMatch(/clinical_orders/i);
    }
    expect(auditMock).toHaveBeenCalledTimes(1);
    const [auditInput] = auditMock.mock.calls[0];
    expect(auditInput.action).toBe('cath_lab.order_set_applied');
    expect(auditInput.metadata.staged_count).toBe(3);
    expect(auditInput.metadata.failed_count).toBe(0);
  });

  it('refuses to stage orders on a cancelled case', async () => {
    settingsMock.mockResolvedValue(inertSettings({
      orderSetFamilies: { pre_cath: 'CATH-PRE', post_cath: null },
    }));
    orderSetFindFirstMock.mockResolvedValue({ id: 31, code: 'X', family_key: 'CATH-PRE', title: 'T', description: null, specialty: null, version: 1 });
    orderSetItemsCountMock.mockResolvedValue(1);
    routeQueries([['FROM cath_lab_cases', [caseRow({ status: 'cancelled' })]]]);
    await expect(applyCathOrderSetSlot(7, 'pre_cath', { tenantId: TENANT }, { actorUid: ACTOR }))
      .rejects.toMatchObject({ code: 'CATH_QW_CASE_CANCELLED' });
    expect(applyOrderSetMock).not.toHaveBeenCalled();
  });
});

describe('emitCathProcedureCompletionFollowUps', () => {
  function template(overrides = {}) {
    return {
      templateKey: 'post_pci_review',
      title: 'Post-PCI review',
      description: 'Owner-authored instructions',
      procedureTypes: ['pci'],
      offsetDays: 2,
      staffTaskRole: 'DOCTOR',
      ...overrides,
    };
  }

  function procedureRow(overrides = {}) {
    return {
      id: 42,
      case_id: 7,
      patient_uid: PATIENT,
      encounter_id: ENCOUNTER,
      procedure_type: 'PCI',
      status: 'finalized',
      appointment_id: null,
      ...overrides,
    };
  }

  it('is a no-op when the owner has published no templates', async () => {
    settingsMock.mockResolvedValue(inertSettings());
    const result = await emitCathProcedureCompletionFollowUps({
      tenantId: TENANT,
      procedureLogId: 42,
      actorUid: ACTOR,
    });
    expect(result).toEqual({ created: [], skipped: [], reason: 'no_templates_configured' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('does not trigger for non-finalized procedure logs', async () => {
    settingsMock.mockResolvedValue(inertSettings({ followUpTemplates: [template()] }));
    routeQueries([['FROM cath_procedure_logs', [procedureRow({ status: 'draft' })]]]);
    const result = await emitCathProcedureCompletionFollowUps({
      tenantId: TENANT,
      procedureLogId: 42,
      actorUid: ACTOR,
    });
    expect(result.reason).toBe('procedure_not_finalized');
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('does not trigger when no template maps the procedure type', async () => {
    settingsMock.mockResolvedValue(inertSettings({
      followUpTemplates: [template({ procedureTypes: ['tavr'] })],
    }));
    routeQueries([['FROM cath_procedure_logs', [procedureRow()]]]);
    const result = await emitCathProcedureCompletionFollowUps({
      tenantId: TENANT,
      procedureLogId: 42,
      actorUid: ACTOR,
    });
    expect(result.reason).toBe('no_matching_template');
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('creates one loop + staff task per matching owner template', async () => {
    settingsMock.mockResolvedValue(inertSettings({
      followUpTemplates: [template(), template({ templateKey: 'dapt_review', title: 'DAPT review' })],
    }));
    const loopInserts = [];
    let nextLoopId = 5001;
    routeQueries([
      ['FROM cath_procedure_logs', [procedureRow()]],
      ['FROM engagement_follow_up_loops', []],
      ['INSERT INTO engagement_follow_up_loops', (sql, params) => {
        loopInserts.push(params);
        return [{
          id: nextLoopId++,
          tenant_id: TENANT,
          source_type: 'cath_procedure',
          source_ref: params[1],
          patient_uid: PATIENT,
          loop_type: 'cath_procedure_follow_up',
          status: 'scheduled',
          consent_type: params[4],
          due_policy: {},
          due_at: params[6],
          safe_link_path: '/appointments',
          metadata: {},
          created_at: new Date('2026-07-12T00:00:00.000Z'),
        }];
      }],
      ['INSERT INTO engagement_follow_up_events', []],
      ['INSERT INTO engagement_follow_up_steps', (sql, params) => [{
        id: 9001,
        loop_id: params[1],
        step_kind: 'staff_task',
        status: 'scheduled',
        suppression_reason: null,
      }]],
    ]);

    const result = await emitCathProcedureCompletionFollowUps({
      tenantId: TENANT,
      procedureLogId: 42,
      actorUid: ACTOR,
    });

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(loopInserts).toHaveLength(2);
    expect(loopInserts[0][1]).toBe('42:post_pci_review');
    expect(loopInserts[1][1]).toBe('42:dapt_review');
    expect(loopInserts[0][4]).toBe('cath_followup');
    expect(createTaskMock).toHaveBeenCalledTimes(2);
    const firstTask = createTaskMock.mock.calls[0][0];
    expect(firstTask.title).toBe('Post-PCI review');
    expect(firstTask.description).toBe('Owner-authored instructions');
    expect(firstTask.relatedResourceType).toBe('engagement_follow_up_loop');
    expect(firstTask.onConflictResourceDoNothing).toBe(true);
  });

  it('skips templates that already have an open loop (idempotent re-emission)', async () => {
    settingsMock.mockResolvedValue(inertSettings({ followUpTemplates: [template()] }));
    routeQueries([
      ['FROM cath_procedure_logs', [procedureRow()]],
      ['FROM engagement_follow_up_loops', [{ id: 5001, status: 'scheduled' }]],
    ]);

    const result = await emitCathProcedureCompletionFollowUps({
      tenantId: TENANT,
      procedureLogId: 42,
      actorUid: ACTOR,
    });

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([
      { template_key: 'post_pci_review', reason: 'open_loop_exists', loop_id: 5001 },
    ]);
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});
