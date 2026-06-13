/**
 * Phase A1 PR1 — knowledgeBaseService unit tests.
 *
 * Service is thin glue over $queryRawUnsafe; we mock the prisma singleton
 * to assert SQL-arg shape, validation, error mapping, and the
 * userCanAccess permission rank logic without touching a live DB.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const {
  KB_PERMISSIONS,
  KB_TYPES,
  archiveKnowledgeBase,
  createKnowledgeBase,
  getKnowledgeBase,
  grantAccess,
  listAccessPolicies,
  listKnowledgeBases,
  revokeAccess,
  unarchiveKnowledgeBase,
  updateKnowledgeBase,
  userCanAccess,
} = await import('../../services/ai/knowledgeBaseService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

function mockNext(rows) {
  queryUnsafeMock.mockResolvedValueOnce(rows);
}

describe('knowledgeBaseService — KB CRUD', () => {
  describe('createKnowledgeBase', () => {
    it('rejects empty name', async () => {
      await expect(createKnowledgeBase({ tenantId: TENANT })).rejects.toThrow(/name is required/);
    });

    it('rejects unknown kb_type', async () => {
      await expect(
        createKnowledgeBase({ tenantId: TENANT, name: 'x', kbType: 'something_weird' }),
      ).rejects.toThrow(/kb_type/);
    });

    it('inserts with normalised inputs and returns the row', async () => {
      mockNext([{ id: 1, name: 'Sepsis SOPs', kb_type: 'sop', tenant_id: TENANT, status: 'active' }]);
      const kb = await createKnowledgeBase({
        tenantId: TENANT,
        name: '   Sepsis SOPs   ',
        description: 'Internal sepsis protocol bundle',
        kbType: 'SOP',
        createdBy: 'admin-uid',
        metadata: { owner: 'icu' },
      });
      expect(kb.id).toBe(1);
      const args = queryUnsafeMock.mock.calls[0];
      // tenant, name (trimmed), description, kb_type (lowercased), createdBy, metadata
      expect(args.slice(1)).toEqual([
        TENANT,
        'Sepsis SOPs',
        'Internal sepsis protocol bundle',
        'sop',
        'admin-uid',
        JSON.stringify({ owner: 'icu' }),
      ]);
    });

    it('maps unique-violation to a 409 conflict', async () => {
      queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
      await expect(
        createKnowledgeBase({ tenantId: TENANT, name: 'dup', kbType: 'general' }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('listKnowledgeBases', () => {
    it('returns empty list when schema is missing', async () => {
      queryUnsafeMock.mockRejectedValueOnce(new Error('relation "knowledge_bases" does not exist'));
      const result = await listKnowledgeBases({ tenantId: TENANT });
      expect(result).toEqual({ knowledge_bases: [], count: 0 });
    });

    it('passes status + kb_type filters into the WHERE clause', async () => {
      mockNext([{ id: 7, name: 'Antibiotic policy' }]);
      const result = await listKnowledgeBases({
        tenantId: TENANT,
        kbType: 'antibiotic_policy',
        status: 'active',
        limit: 25,
      });
      expect(result.count).toBe(1);
      const args = queryUnsafeMock.mock.calls[0];
      expect(args.slice(1)).toEqual([TENANT, 'antibiotic_policy', 'active', 25]);
    });

    it('rejects unknown status', async () => {
      await expect(listKnowledgeBases({ tenantId: TENANT, status: 'frozen' })).rejects.toThrow(
        /status must be one of/,
      );
    });
  });

  describe('getKnowledgeBase', () => {
    it('throws 404 when no row matches', async () => {
      mockNext([]);
      await expect(getKnowledgeBase({ tenantId: TENANT, id: 99 })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('rejects non-numeric id', async () => {
      await expect(getKnowledgeBase({ tenantId: TENANT, id: 'abc' })).rejects.toThrow(/positive integer/);
    });

    it('returns the row with derived counts when found', async () => {
      mockNext([{ id: 1, name: 'KB', document_count: 3, chunk_count: 17 }]);
      const kb = await getKnowledgeBase({ tenantId: TENANT, id: 1 });
      expect(kb).toMatchObject({ id: 1, document_count: 3, chunk_count: 17 });
    });
  });

  describe('updateKnowledgeBase', () => {
    it('skips DB call and re-fetches when no fields are supplied', async () => {
      mockNext([{ id: 1, name: 'KB' }]);
      const kb = await updateKnowledgeBase({ tenantId: TENANT, id: 1 });
      expect(kb.id).toBe(1);
      expect(queryUnsafeMock).toHaveBeenCalledTimes(1); // only the get call
      expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SELECT/);
    });

    it('builds an UPDATE with only the supplied columns', async () => {
      mockNext([{ id: 1, name: 'New', description: 'desc', kb_type: 'sop', tenant_id: TENANT, status: 'active' }]);
      const kb = await updateKnowledgeBase({
        tenantId: TENANT,
        id: 1,
        name: 'New',
        description: 'desc',
      });
      expect(kb.name).toBe('New');
      const sql = queryUnsafeMock.mock.calls[0][0];
      expect(sql).toMatch(/UPDATE knowledge_bases/);
      expect(sql).toMatch(/name = \$1/);
      expect(sql).toMatch(/description = \$2/);
      expect(sql).not.toMatch(/kb_type =/);
    });

    it('throws 404 when the UPDATE matches no row', async () => {
      mockNext([]);
      await expect(
        updateKnowledgeBase({ tenantId: TENANT, id: 999, name: 'New' }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('archive / unarchive', () => {
    it('archive flips status to archived and returns the row', async () => {
      mockNext([{ id: 1, status: 'archived' }]);
      const kb = await archiveKnowledgeBase({ tenantId: TENANT, id: 1 });
      expect(kb.status).toBe('archived');
      expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SET status = 'archived'/);
    });

    it('unarchive flips status to active', async () => {
      mockNext([{ id: 1, status: 'active' }]);
      const kb = await unarchiveKnowledgeBase({ tenantId: TENANT, id: 1 });
      expect(kb.status).toBe('active');
      expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/SET status = 'active'/);
    });
  });
});

describe('knowledgeBaseService — access policies', () => {
  it('grantAccess upserts and returns the new row', async () => {
    // First call is the getKnowledgeBase existence check.
    mockNext([{ id: 5, name: 'Sepsis SOPs', tenant_id: TENANT }]);
    mockNext([{ id: 9, role: 'DOCTOR', permission: 'read', knowledge_base_id: 5 }]);
    const policy = await grantAccess({
      tenantId: TENANT,
      knowledgeBaseId: 5,
      role: 'doctor',
      permission: 'read',
      grantedBy: 'admin-uid',
    });
    expect(policy).toMatchObject({ role: 'DOCTOR', permission: 'read' });
    const upsertCall = queryUnsafeMock.mock.calls[1];
    expect(upsertCall[3]).toBe('DOCTOR');
    expect(upsertCall[4]).toBe('read');
  });

  it('grantAccess rejects unknown permission', async () => {
    await expect(
      grantAccess({ tenantId: TENANT, knowledgeBaseId: 1, role: 'DOCTOR', permission: 'read-write' }),
    ).rejects.toThrow(/permission must be one of/);
  });

  it('revokeAccess returns 404 when the policy does not exist', async () => {
    mockNext([]);
    await expect(
      revokeAccess({ tenantId: TENANT, knowledgeBaseId: 5, role: 'DOCTOR', permission: 'read' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('listAccessPolicies returns rows for the KB', async () => {
    mockNext([
      { id: 1, role: 'DOCTOR', permission: 'read' },
      { id: 2, role: 'NURSING_STAFF', permission: 'read' },
    ]);
    const result = await listAccessPolicies({ tenantId: TENANT, knowledgeBaseId: 5 });
    expect(result.count).toBe(2);
    expect(result.policies.map((p) => p.role)).toEqual(['DOCTOR', 'NURSING_STAFF']);
  });
});

describe('knowledgeBaseService — userCanAccess', () => {
  it('returns false when role / kb_id missing', async () => {
    expect(await userCanAccess({})).toBe(false);
    expect(await userCanAccess({ knowledgeBaseId: 1 })).toBe(false);
    expect(await userCanAccess({ role: 'DOCTOR' })).toBe(false);
  });

  it('returns false when no matching policy', async () => {
    mockNext([]);
    expect(await userCanAccess({ tenantId: TENANT, knowledgeBaseId: 1, role: 'DOCTOR' })).toBe(false);
  });

  it('returns true when role has at least the requested permission', async () => {
    mockNext([{ permission: 'read' }]);
    expect(
      await userCanAccess({ tenantId: TENANT, knowledgeBaseId: 1, role: 'DOCTOR', permission: 'read' }),
    ).toBe(true);
  });

  it('write covers read but read does not cover write', async () => {
    mockNext([{ permission: 'write' }]);
    expect(
      await userCanAccess({ tenantId: TENANT, knowledgeBaseId: 1, role: 'DOCTOR', permission: 'read' }),
    ).toBe(true);

    mockNext([{ permission: 'read' }]);
    expect(
      await userCanAccess({ tenantId: TENANT, knowledgeBaseId: 1, role: 'DOCTOR', permission: 'write' }),
    ).toBe(false);
  });

  it('manage covers everything', async () => {
    mockNext([{ permission: 'manage' }]);
    expect(
      await userCanAccess({ tenantId: TENANT, knowledgeBaseId: 1, role: 'ADMIN', permission: 'manage' }),
    ).toBe(true);
    mockNext([{ permission: 'manage' }]);
    expect(
      await userCanAccess({ tenantId: TENANT, knowledgeBaseId: 1, role: 'ADMIN', permission: 'write' }),
    ).toBe(true);
    mockNext([{ permission: 'manage' }]);
    expect(
      await userCanAccess({ tenantId: TENANT, knowledgeBaseId: 1, role: 'ADMIN', permission: 'read' }),
    ).toBe(true);
  });

  it('returns false (rather than throwing) when schema is missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "knowledge_access_policies" does not exist'));
    expect(
      await userCanAccess({ tenantId: TENANT, knowledgeBaseId: 1, role: 'DOCTOR' }),
    ).toBe(false);
  });
});

describe('knowledgeBaseService — exported constants', () => {
  it('exports the canonical kb_types in the same order the migration declares', () => {
    expect(KB_TYPES).toEqual([
      'general',
      'sop',
      'antibiotic_policy',
      'patient_education',
      'clinical_guideline',
      'formulary',
      'safety_alert',
      'training',
    ]);
  });

  it('exports the three permission tiers', () => {
    expect(KB_PERMISSIONS).toEqual(['read', 'write', 'manage']);
  });
});
