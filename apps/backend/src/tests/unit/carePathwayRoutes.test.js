import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const startCarePathwayInstance = jest.fn();
const executePathwayCommand = jest.fn();
const getCarePathwayInstance = jest.fn();
const authorizePatientAccessRequest = jest.fn();
const resolvePatientForResourceAccess = jest.fn();
const resolveEnforcementModeForRequest = jest.fn();

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  authorizePatientAccessRequest,
  resolvePatientForResourceAccess,
  shouldSkipAccessCheckError: () => false,
  patientAccessErrorPayload: (decision) => ({
    success: false,
    message: decision.safe_denial_message,
    code: decision.safe_reason_code,
    break_glass_available: Boolean(decision.break_glass_available),
    policy_code: decision.policy_code,
    policy_version: decision.policy_version,
    policy_hash: decision.policy_hash,
  }),
}));

jest.unstable_mockModule('../../services/security/careTeamEnforcement.js', () => ({
  CARE_TEAM_ENFORCEMENT_MODES: {
    OFF: 'off',
    SHADOW: 'shadow',
    ENFORCE: 'enforce',
  },
  resolveEnforcementModeForRequest,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: (req) => req.tenantId,
}));

jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/pathways/pathwayExecutorService.js', () => ({
  startCarePathwayInstance,
  executePathwayCommand,
  getCarePathwayInstance,
}));

jest.unstable_mockModule('../../services/idempotency/idempotencyService.js', () => ({
  isValidIdempotencyKey: (value) => (
    typeof value === 'string'
    && value.length >= 1
    && value.length <= 200
    && /^[A-Za-z0-9_.:-]+$/.test(value)
  ),
}));

const { default: router } = await import('../../routes/carePathwayRoutes.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const UNRESOLVED_PATIENT_UID = '44444444-4444-4444-8444-444444444444';
const UNAUTHORIZED_PATIENT_UID = '55555555-5555-4555-8555-555555555555';
const INVALID_PATIENT_UID = 'not-a-patient-uuid';
const QUERY_PATIENT_UID = '66666666-6666-4666-8666-666666666666';
const CREATE_PATIENT_QUERY_SELECTOR_ALIASES = [
  'patient_uid',
  'patientUid',
  'patientId',
  'patient_id',
  'phone',
  'patient_phone',
  'patientPhone',
];
const SAFE_DENIAL = Object.freeze({
  allowed: false,
  accessDecision: 'deny',
  accessSource: 'unknown',
  safe_denial_message: 'Patient access is denied',
  safe_reason_code: 'PATIENT_ACCESS_DENIED',
  break_glass_available: false,
  policy_code: 'patient.clinical_workflow.write',
  policy_version: 'test-policy-v1',
  policy_hash: 'test-policy-hash',
});

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ''));
}

function makeApp(onFinish = null) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.tenantId = TENANT_ID;
    req.user = { uid: ACTOR_UID, role: 'DOCTOR', roles: ['DOCTOR'] };
    if (onFinish) res.on('finish', () => onFinish(req));
    next();
  });
  app.use('/api/v1/care-pathways', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({
    code: err.code,
    message: err.message,
  }));
  return app;
}

function makeAppWithAccessDecision(accessDecision, user = {
  uid: ACTOR_UID,
  role: 'DOCTOR',
  roles: ['DOCTOR'],
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT_ID;
    req.user = user;
    req.patientAccessDecision = accessDecision;
    next();
  });
  app.use('/api/v1/care-pathways', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({
    code: err.code,
    message: err.message,
  }));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveEnforcementModeForRequest.mockResolvedValue('shadow');
  resolvePatientForResourceAccess.mockImplementation(async (_req, { resourceId }) => (
    isUuid(resourceId) ? { id: 27, uid: PATIENT_UID } : null
  ));
  authorizePatientAccessRequest.mockImplementation(async (req, options = {}) => {
    let decision = req.patientAccessDecision || null;
    if (!decision && [UNRESOLVED_PATIENT_UID, INVALID_PATIENT_UID].includes(req.body?.patient_uid)) {
      decision = options.requireResolvedPatient
        ? { ...SAFE_DENIAL, reason: 'Patient context could not be resolved' }
        : { allowed: true, no_patient_context: true };
    }
    if (!decision && req.body?.patient_uid === UNAUTHORIZED_PATIENT_UID) {
      decision = { ...SAFE_DENIAL, reason: 'No active patient relationship' };
    }
    if (!decision && options.requireResolvedPatient && options.patient == null && req.params?.id) {
      decision = { ...SAFE_DENIAL, reason: 'Patient context could not be resolved' };
    }
    decision ||= {
      allowed: true,
      accessDecision: 'allow',
      accessSource: 'care_team',
      shadow_mode: false,
    };
    req.patientAccessDecision = decision;
    return decision;
  });
});

describe('carePathwayRoutes', () => {
  it('derives the actor from authentication and requires header idempotency', async () => {
    startCarePathwayInstance.mockResolvedValueOnce({ id: INSTANCE_ID, patient_uid: PATIENT_UID });
    const response = await request(makeApp())
      .post('/api/v1/care-pathways/instances')
      .set('Idempotency-Key', 'start:diagnostics:episode-7')
      .send({
        workflow_definition_id: 19,
        patient_uid: PATIENT_UID,
        pathway_key: 'diagnostics_order_to_action',
      });

    expect(response.statusCode).toBe(201);
    expect(startCarePathwayInstance).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      idempotencyKey: 'start:diagnostics:episode-7',
      triggerKind: 'manual',
      triggerPayload: {},
      sourceEpisodeType: 'patient',
      sourceEpisodeId: PATIENT_UID,
      actor: {
        kind: 'user',
        uid: ACTOR_UID,
        roles: ['DOCTOR'],
        primaryRole: 'DOCTOR',
        authorizationMode: 'patient_access_care_team',
      },
    }));
    expect(authorizePatientAccessRequest).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        patient: { uid: PATIENT_UID },
        requireResolvedPatient: true,
      }),
    );

    const missing = await request(makeApp())
      .post('/api/v1/care-pathways/instances')
      .send({ patient_uid: PATIENT_UID });
    expect(missing.statusCode).toBe(400);
    expect(missing.body.code).toBe('PATHWAY_IDEMPOTENCY_KEY_REQUIRED');

    const invalid = await request(makeApp())
      .post('/api/v1/care-pathways/instances')
      .set('Idempotency-Key', 'contains spaces')
      .send({ patient_uid: PATIENT_UID });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body.code).toBe('PATHWAY_IDEMPOTENCY_KEY_INVALID');
    expect(startCarePathwayInstance).toHaveBeenCalledTimes(1);
  });

  it.each(CREATE_PATIENT_QUERY_SELECTOR_ALIASES)(
    'rejects create query selector %s before authorization even when the body names an allowed patient',
    async (selector) => {
      const response = await request(makeApp())
        .post('/api/v1/care-pathways/instances')
        .query({ [selector]: QUERY_PATIENT_UID })
        .set('Idempotency-Key', `start:query-selector:${selector}`)
        .send({
          workflow_definition_id: 19,
          patient_uid: PATIENT_UID,
          pathway_key: 'diagnostics_order_to_action',
        });

      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual(expect.objectContaining({
        code: 'PATIENT_ACCESS_DENIED',
        message: 'Patient access is denied',
      }));
      expect(authorizePatientAccessRequest).not.toHaveBeenCalled();
      expect(startCarePathwayInstance).not.toHaveBeenCalled();
    },
  );

  it('authorizes the create body patient when no query selector is present', async () => {
    startCarePathwayInstance.mockResolvedValueOnce({ id: INSTANCE_ID, patient_uid: PATIENT_UID });
    const response = await request(makeApp())
      .post('/api/v1/care-pathways/instances')
      .set('Idempotency-Key', 'start:body-patient-only')
      .send({ patient_uid: PATIENT_UID, pathway_key: 'diagnostics_order_to_action' });

    expect(response.statusCode).toBe(201);
    expect(authorizePatientAccessRequest).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ patient: { uid: PATIENT_UID } }),
    );
    expect(startCarePathwayInstance).toHaveBeenCalledTimes(1);
  });

  it('returns the same generic denial for nonexistent, invalid, and unauthorized patients', async () => {
    const responses = [];
    for (const [index, patientUid] of [
      UNRESOLVED_PATIENT_UID,
      INVALID_PATIENT_UID,
      UNAUTHORIZED_PATIENT_UID,
    ].entries()) {
      responses.push(await request(makeApp())
        .post('/api/v1/care-pathways/instances')
        .set('Idempotency-Key', `start:denied:${index}`)
        .send({
          workflow_definition_id: 19,
          patient_uid: patientUid,
          pathway_key: 'diagnostics_order_to_action',
        }));
    }

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([403, 403, 403]);
    expect(responses.map(({ body }) => ({ code: body.code, message: body.message })))
      .toEqual([
        { code: 'PATIENT_ACCESS_DENIED', message: 'Patient access is denied' },
        { code: 'PATIENT_ACCESS_DENIED', message: 'Patient access is denied' },
        { code: 'PATIENT_ACCESS_DENIED', message: 'Patient access is denied' },
      ]);
    expect(authorizePatientAccessRequest.mock.calls.map(([, options]) => options.requireResolvedPatient))
      .toEqual([true, true, true]);
    expect(startCarePathwayInstance).not.toHaveBeenCalled();
  });

  it('rejects caller-selected runtime state and provenance fields', async () => {
    const response = await request(makeApp())
      .post(`/api/v1/care-pathways/instances/${INSTANCE_ID}/commands`)
      .set('Idempotency-Key', 'command:1')
      .send({ signal: { kind: 'resume' }, next_status: 'completed' });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('PATHWAY_ROUTE_FIELD_UNSUPPORTED');
    expect(executePathwayCommand).not.toHaveBeenCalled();

    const start = await request(makeApp())
      .post('/api/v1/care-pathways/instances')
      .set('Idempotency-Key', 'start:spoofed-trigger')
      .send({
        patient_uid: PATIENT_UID,
        trigger_kind: 'event',
        trigger_payload: { source_event_id: '123' },
      });
    expect(start.statusCode).toBe(400);
    expect(start.body.code).toBe('PATHWAY_ROUTE_FIELD_UNSUPPORTED');
    expect(startCarePathwayInstance).not.toHaveBeenCalled();

    const sourceSpoof = await request(makeApp())
      .post('/api/v1/care-pathways/instances')
      .set('Idempotency-Key', 'start:spoofed-source')
      .send({
        patient_uid: PATIENT_UID,
        source_episode_type: 'investigation_order',
        source_episode_id: 'another-patient-resource',
      });
    expect(sourceSpoof.statusCode).toBe(400);
    expect(sourceSpoof.body.code).toBe('PATHWAY_ROUTE_FIELD_UNSUPPORTED');
    expect(startCarePathwayInstance).not.toHaveBeenCalled();
  });

  it('passes only the signal and authenticated actor to the command executor', async () => {
    executePathwayCommand.mockResolvedValueOnce({
      instance: { id: INSTANCE_ID, patient_uid: PATIENT_UID },
      events: [],
    });
    const response = await request(makeApp())
      .post(`/api/v1/care-pathways/instances/${INSTANCE_ID}/commands`)
      .set('Idempotency-Key', 'command:resume:1')
      .send({ signal: { kind: 'resume' } });

    expect(response.statusCode).toBe(200);
    expect(executePathwayCommand).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      pathwayInstanceId: INSTANCE_ID,
      idempotencyKey: 'command:resume:1',
      signal: { kind: 'resume' },
      actor: {
        kind: 'user',
        uid: ACTOR_UID,
        roles: ['DOCTOR'],
        primaryRole: 'DOCTOR',
        authorizationMode: 'patient_access_care_team',
      },
    });
  });

  it('carries guard-derived break-glass provenance without accepting it from the body', async () => {
    executePathwayCommand.mockResolvedValueOnce({
      instance: { id: INSTANCE_ID, patient_uid: PATIENT_UID },
      events: [],
    });
    const response = await request(makeAppWithAccessDecision({
      allowed: true,
      accessSource: 'break_glass',
      breakGlassId: 44,
      breakGlassReason: 'Emergency access for active resuscitation',
      shadow_mode: false,
    }))
      .post(`/api/v1/care-pathways/instances/${INSTANCE_ID}/commands`)
      .set('Idempotency-Key', 'command:break-glass:1')
      .send({ signal: { kind: 'resume' } });

    expect(response.statusCode).toBe(200);
    expect(executePathwayCommand).toHaveBeenCalledWith(expect.objectContaining({
      actor: {
        kind: 'user',
        uid: ACTOR_UID,
        roles: ['DOCTOR'],
        primaryRole: 'DOCTOR',
        authorizationMode: 'patient_access_break_glass',
        overrideReason: 'Emergency access for active resuscitation',
        breakGlassId: 44,
      },
    }));

    const spoofed = await request(makeAppWithAccessDecision({
      allowed: true,
      accessSource: 'care_team',
      shadow_mode: false,
    }))
      .post(`/api/v1/care-pathways/instances/${INSTANCE_ID}/commands`)
      .set('Idempotency-Key', 'command:spoofed-break-glass')
      .send({ signal: { kind: 'resume' }, break_glass_id: 99 });
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.body.code).toBe('PATHWAY_ROUTE_FIELD_UNSUPPORTED');
  });

  it('blocks a would-be shadow denial because pathway ABAC is always enforced', async () => {
    const response = await request(makeAppWithAccessDecision({
      allowed: false,
      accessSource: 'unknown',
      reason: 'No active care-team relationship',
      safe_denial_message: 'Patient access is denied',
      safe_reason_code: 'PATIENT_ACCESS_DENIED',
      break_glass_available: false,
      policy_code: 'patient.clinical_workflow.write',
      policy_version: 'test-policy-v1',
      policy_hash: 'test-policy-hash',
    }))
      .post(`/api/v1/care-pathways/instances/${INSTANCE_ID}/commands`)
      .set('Idempotency-Key', 'command:shadow-denied:1')
      .send({ signal: { kind: 'resume' } });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual(expect.objectContaining({
      code: 'PATIENT_ACCESS_DENIED',
      message: 'Patient access is denied',
    }));
    expect(executePathwayCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['off', () => resolveEnforcementModeForRequest.mockResolvedValue('off')],
    ['shadow', () => resolveEnforcementModeForRequest.mockResolvedValue('shadow')],
    ['resolver error', () => resolveEnforcementModeForRequest.mockRejectedValue(new Error('mode unavailable'))],
  ])('keeps create, read, and command denials enforced when tenant mode is %s', async (_label, configureMode) => {
    configureMode();
    const deniedDecision = { ...SAFE_DENIAL, reason: 'No active patient relationship' };

    const create = await request(makeAppWithAccessDecision(deniedDecision))
      .post('/api/v1/care-pathways/instances')
      .set('Idempotency-Key', 'start:always-enforced')
      .send({ patient_uid: PATIENT_UID, pathway_key: 'diagnostics_order_to_action' });
    const read = await request(makeAppWithAccessDecision(deniedDecision))
      .get(`/api/v1/care-pathways/instances/${INSTANCE_ID}`);
    const command = await request(makeAppWithAccessDecision(deniedDecision))
      .post(`/api/v1/care-pathways/instances/${INSTANCE_ID}/commands`)
      .set('Idempotency-Key', 'command:always-enforced')
      .send({ signal: { kind: 'resume' } });

    expect([create.statusCode, read.statusCode, command.statusCode]).toEqual([403, 403, 403]);
    for (const response of [create, read, command]) {
      expect(response.body).toEqual(expect.objectContaining({
        code: 'PATIENT_ACCESS_DENIED',
        message: 'Patient access is denied',
      }));
    }
    expect(resolveEnforcementModeForRequest).not.toHaveBeenCalled();
    expect(startCarePathwayInstance).not.toHaveBeenCalled();
    expect(getCarePathwayInstance).not.toHaveBeenCalled();
    expect(executePathwayCommand).not.toHaveBeenCalled();
  });

  it('returns a generic 403 for malformed instance ids without reaching a pathway service', async () => {
    const read = await request(makeApp())
      .get('/api/v1/care-pathways/instances/not-a-uuid');
    const command = await request(makeApp())
      .post('/api/v1/care-pathways/instances/not-a-uuid/commands')
      .set('Idempotency-Key', 'command:malformed-id')
      .send({ signal: { kind: 'resume' } });

    expect([read.statusCode, command.statusCode]).toEqual([403, 403]);
    for (const response of [read, command]) {
      expect(response.body).toEqual(expect.objectContaining({
        code: 'PATIENT_ACCESS_DENIED',
        message: 'Patient access is denied',
      }));
    }
    expect(resolvePatientForResourceAccess).toHaveBeenCalledTimes(2);
    expect(getCarePathwayInstance).not.toHaveBeenCalled();
    expect(executePathwayCommand).not.toHaveBeenCalled();
  });

  it('returns the same denial for inaccessible, nonexistent, and malformed resources despite every patient alias', async () => {
    const scenarios = [
      {
        label: 'inaccessible',
        resourceId: INSTANCE_ID,
        resolvedPatient: { id: 27, uid: PATIENT_UID },
        app: () => makeAppWithAccessDecision({ ...SAFE_DENIAL, reason: 'No active patient relationship' }),
      },
      {
        label: 'nonexistent',
        resourceId: '77777777-7777-4777-8777-777777777777',
        resolvedPatient: null,
        app: () => makeApp(),
      },
      {
        label: 'malformed',
        resourceId: 'not-a-pathway-uuid',
        resolvedPatient: null,
        app: () => makeApp(),
      },
    ];
    const denialTuples = [];

    for (const scenario of scenarios) {
      for (const [index, selector] of CREATE_PATIENT_QUERY_SELECTOR_ALIASES.entries()) {
        resolvePatientForResourceAccess.mockResolvedValueOnce(scenario.resolvedPatient);
        const queryResponse = await request(scenario.app())
          .post(`/api/v1/care-pathways/instances/${scenario.resourceId}/commands`)
          .query({ [selector]: PATIENT_UID })
          .set('Idempotency-Key', `command:${scenario.label}:query:${index}`)
          .send({ signal: { kind: 'resume' } });

        resolvePatientForResourceAccess.mockResolvedValueOnce(scenario.resolvedPatient);
        const bodyResponse = await request(scenario.app())
          .post(`/api/v1/care-pathways/instances/${scenario.resourceId}/commands`)
          .set('Idempotency-Key', `command:${scenario.label}:body:${index}`)
          .send({ signal: { kind: 'resume' }, [selector]: PATIENT_UID });

        for (const response of [queryResponse, bodyResponse]) {
          denialTuples.push([response.statusCode, response.body.code, response.body.message]);
          expect(response.body).toEqual(expect.objectContaining({
            code: 'PATIENT_ACCESS_DENIED',
            message: 'Patient access is denied',
          }));
        }
      }
    }

    expect(new Set(denialTuples.map((tuple) => JSON.stringify(tuple)))).toEqual(new Set([
      JSON.stringify([403, 'PATIENT_ACCESS_DENIED', 'Patient access is denied']),
    ]));
    expect(authorizePatientAccessRequest).toHaveBeenCalledTimes(
      scenarios.length * CREATE_PATIENT_QUERY_SELECTOR_ALIASES.length * 2,
    );
    expect(getCarePathwayInstance).not.toHaveBeenCalled();
    expect(executePathwayCommand).not.toHaveBeenCalled();
  });

  it('preserves the authenticated primary role ahead of secondary roles', async () => {
    executePathwayCommand.mockResolvedValueOnce({
      instance: { id: INSTANCE_ID, patient_uid: PATIENT_UID },
      events: [],
    });
    const response = await request(makeAppWithAccessDecision({
      allowed: true,
      accessSource: 'care_team',
      shadow_mode: false,
    }, {
      uid: ACTOR_UID,
      role: 'NURSING_STAFF',
      roles: ['DOCTOR', 'NURSING_STAFF'],
    }))
      .post(`/api/v1/care-pathways/instances/${INSTANCE_ID}/commands`)
      .set('Idempotency-Key', 'command:primary-role:1')
      .send({ signal: { kind: 'resume' } });

    expect(response.statusCode).toBe(200);
    expect(executePathwayCommand).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({
        primaryRole: 'NURSING_STAFF',
        roles: ['NURSING_STAFF', 'DOCTOR'],
      }),
    }));
  });

  it('sets PHI context from instance reads for the access audit', async () => {
    let finishedContext = null;
    getCarePathwayInstance.mockResolvedValueOnce({ id: INSTANCE_ID, patient_uid: PATIENT_UID });
    const response = await request(makeApp((req) => { finishedContext = req.phiContext; }))
      .get(`/api/v1/care-pathways/instances/${INSTANCE_ID}`);

    expect(response.statusCode).toBe(200);
    expect(finishedContext).toEqual({ patientUid: PATIENT_UID });
  });
});
