import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const setTenantMock = jest.fn();
const txMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  setTenant: setTenantMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) throw new Error('Tenant context required');
    return tenantId;
  },
}));

const {
  getAdoptionCatalog,
  recordLearningCompletion,
  recordTourEvent,
  trainingEvidenceToCsv,
} = await import('../../services/adoption/adoptionService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  setTenantMock.mockReset();
  setTenantMock.mockImplementation(async (_tenantId, fn) => fn(txMock));
});

describe('adoptionService catalog visibility', () => {
  it('loads role-filtered manuals, help categories, and tours under tenant scope', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 1, category_key: 'privacy-compliance', status: 'active', role_scope: ['*'] }])
      .mockResolvedValueOnce([{ id: 2, module_key: 'staff-confidentiality-basics', status: 'published', role_scope: ['*'] }])
      .mockResolvedValueOnce([{ id: 3, tour_key: 'admin-adoption-overview', status: 'published', role_scope: ['ADMIN'] }]);

    const result = await getAdoptionCatalog({ tenantId: TENANT, role: 'ADMIN' });

    expect(result.counts).toEqual({ categories: 1, modules: 1, tours: 1 });
    expect(setTenantMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryUnsafeMock.mock.calls[0][1]).toBe(TENANT);
    expect(queryUnsafeMock.mock.calls[0][2]).toBe('ADMIN');
  });
});

describe('adoptionService completion and evidence writes', () => {
  it('records a learning completion and creates a NABH evidence ledger row', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 7,
        tenant_id: TENANT,
        module_key: 'staff-confidentiality-basics',
        title: 'Staff confidentiality basics',
        module_type: 'role_manual',
        role_scope: ['*'],
        required_for_roles: ['*'],
        status: 'published',
        version: 1,
        metadata: { nabh_control_code: 'NABH_STAFF_CONFIDENTIALITY_TRAINING' },
      }])
      .mockResolvedValueOnce([{
        id: 11,
        tenant_id: TENANT,
        module_id: 7,
        actor_uid: ACTOR,
        actor_role: 'NURSING_STAFF',
        module_version: 1,
        status: 'completed',
        completion_source: 'in_app',
        completed_at: new Date('2026-07-09T08:00:00Z'),
        evidence_metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 22,
        tenant_id: TENANT,
        evidence_key: `learning:7:${ACTOR}:1`,
        source_type: 'learning_completion',
        source_id: 11,
        control_code: 'NABH_STAFF_CONFIDENTIALITY_TRAINING',
        subject_uid: ACTOR,
        subject_role: 'NURSING_STAFF',
        title: 'Staff confidentiality basics',
        evidence_status: 'captured',
        metadata: {},
      }]);

    const result = await recordLearningCompletion({
      tenantId: TENANT,
      moduleKey: 'staff-confidentiality-basics',
      actorUid: ACTOR,
      actorRole: 'NURSING_STAFF',
    });

    expect(result.completion.id).toBe(11);
    expect(result.evidence.control_code).toBe('NABH_STAFF_CONFIDENTIALITY_TRAINING');
    const sql = queryUnsafeMock.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toMatch(/INSERT INTO learning_completions/);
    expect(sql).toMatch(/INSERT INTO training_evidence_ledger/);
    expect(queryUnsafeMock.mock.calls[1][1]).toBe(TENANT);
  });

  it('records tour completion evidence only for completed events', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 9,
        tenant_id: TENANT,
        tour_key: 'admin-adoption-overview',
        title: 'Adoption evidence overview',
        surface: 'admin',
        role_scope: ['ADMIN'],
        steps: [],
        status: 'published',
        version: 1,
        metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 31,
        tenant_id: TENANT,
        tour_id: 9,
        actor_uid: ACTOR,
        actor_role: 'ADMIN',
        tour_version: 1,
        event_type: 'completed',
        metadata: {},
        created_at: new Date('2026-07-09T08:00:00Z'),
      }])
      .mockResolvedValueOnce([{
        id: 32,
        evidence_key: `tour:9:${ACTOR}:1`,
        control_code: 'VH_TOUR_COMPLETION',
        evidence_status: 'captured',
      }]);

    const result = await recordTourEvent({
      tenantId: TENANT,
      tourKey: 'admin-adoption-overview',
      actorUid: ACTOR,
      actorRole: 'ADMIN',
      eventType: 'completed',
    });

    expect(result.event.event_type).toBe('completed');
    expect(result.evidence.control_code).toBe('VH_TOUR_COMPLETION');
  });

  it('exports assessor-friendly training evidence CSV', () => {
    const csv = trainingEvidenceToCsv([
      {
        evidence_key: 'learning:1:u:1',
        control_code: 'NABH_STAFF_CONFIDENTIALITY_TRAINING',
        source_type: 'learning_completion',
        subject_uid: ACTOR,
        subject_role: 'NURSING_STAFF',
        title: 'Staff confidentiality basics',
        evidence_status: 'captured',
        created_at: '2026-07-09T08:00:00.000Z',
        verified_at: null,
        evidence_uri: null,
      },
    ]);

    expect(csv.split('\n')[0]).toBe('evidence_key,control_code,source_type,subject_uid,subject_role,title,evidence_status,created_at,verified_at,evidence_uri');
    expect(csv).toContain('NABH_STAFF_CONFIDENTIALITY_TRAINING');
    expect(csv).toContain('Staff confidentiality basics');
  });
});
