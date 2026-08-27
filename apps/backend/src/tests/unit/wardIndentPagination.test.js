import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const findManyIndents = jest.fn();
const findManySlas = jest.fn();
const queryRaw = jest.fn();
const tx = {
  ward_indents: { findMany: findManyIndents },
  workflow_sla_instances: { findMany: findManySlas },
  $queryRawUnsafe: queryRaw,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: tx,
  prismaReadOnly: tx,
  setTenantTx: async (_tenantId, operation) => operation(tx),
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  cancelWorkflowSla: jest.fn(),
  completeWorkflowSla: jest.fn(),
  recordCanonicalClinicalEvent: jest.fn(),
  startWorkflowSla: jest.fn(),
}));

const { listWardIndentPage } = await import(
  '../../services/ipd/wardIndentWorkflowService.js'
);

function row(id, requestedAt, { sourceId = `ward-indent:${id}:v1` } = {}) {
  return {
    id,
    tenant_id: TENANT,
    status: 'requested',
    requested_at: requestedAt,
    active_sla_source_id: sourceId,
    owner_role_codes: ['PHARMACY_STAFF'],
    items: [],
  };
}

beforeEach(() => {
  findManyIndents.mockReset();
  findManySlas.mockReset();
  queryRaw.mockReset();
});

test('uses a deterministic keyset cursor and returns an exact next-page cursor', async () => {
  const cursorTime = new Date('2026-08-27T10:30:00.000Z');
  const first = row(72, new Date('2026-08-27T10:29:00.000Z'));
  const probe = row(71, new Date('2026-08-27T10:28:00.000Z'));
  findManyIndents.mockResolvedValue([first, probe]);
  findManySlas.mockResolvedValue([]);

  const page = await listWardIndentPage({
    tenantId: TENANT,
    worklist: 'open',
    beforeRequestedAt: cursorTime.toISOString(),
    beforeId: 73,
    limit: 1,
  });

  expect(findManyIndents).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      tenant_id: TENANT,
      status: { notIn: ['rejected', 'cancelled', 'closed'] },
      OR: [
        { requested_at: { lt: cursorTime } },
        { requested_at: cursorTime, id: { lt: 73 } },
      ],
    }),
    orderBy: [{ requested_at: 'desc' }, { id: 'desc' }],
    take: 2,
  }));
  expect(page.items.map((item) => item.id)).toEqual([72]);
  expect(page.pagination).toEqual({
    has_more: true,
    limit: 1,
    before_requested_at: first.requested_at.toISOString(),
    before_id: 72,
  });
});

test('overdue worklists filter through the SLA join before applying the limit', async () => {
  const overdue = row(300, new Date('2026-08-27T08:40:00.000Z'));
  queryRaw.mockResolvedValue([{ id: overdue.id }]);
  findManyIndents.mockResolvedValue([overdue]);
  findManySlas.mockResolvedValue([{
    id: 'sla-overdue',
    source_id: overdue.active_sla_source_id,
    status: 'breached',
  }]);

  const page = await listWardIndentPage({
    tenantId: TENANT,
    worklist: 'overdue',
    limit: 1,
  });

  expect(queryRaw).toHaveBeenCalledTimes(1);
  const [sql, tenantId, terminalStatuses, take] = queryRaw.mock.calls[0];
  expect(sql).toContain('EXISTS (');
  expect(sql).toContain("sla.status IN ('breached', 'escalated')");
  expect(sql).toContain('ORDER BY indent.requested_at DESC, indent.id DESC');
  expect(tenantId).toBe(TENANT);
  expect(terminalStatuses).toEqual(['rejected', 'cancelled', 'closed']);
  expect(take).toBe(2);
  expect(findManyIndents).toHaveBeenCalledTimes(1);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    id: overdue.id,
    workflow: {
      active_slas: [expect.objectContaining({ status: 'breached' })],
    },
  });
  expect(page.pagination).toEqual({ has_more: false, limit: 1 });
});

test('owned worklists are filtered by the authenticated role before paging', async () => {
  findManyIndents.mockResolvedValue([]);

  await listWardIndentPage({
    tenantId: TENANT,
    worklist: 'owned',
    actorRoleCodes: ['pharmacy_incharge', 'PHARMACY_INCHARGE'],
  });

  expect(findManyIndents).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({
      tenant_id: TENANT,
      status: { notIn: ['rejected', 'cancelled', 'closed'] },
      owner_role_codes: { hasSome: ['PHARMACY_INCHARGE'] },
    }),
  }));
});

test('rejects partial cursors and conflicting list filters before querying', async () => {
  await expect(listWardIndentPage({
    tenantId: TENANT,
    beforeRequestedAt: '2026-08-27T10:30:00.000Z',
  })).rejects.toMatchObject({ code: 'WARD_INDENT_CURSOR_INCOMPLETE' });
  await expect(listWardIndentPage({
    tenantId: TENANT,
    status: 'requested',
    worklist: 'open',
  })).rejects.toMatchObject({ code: 'WARD_INDENT_FILTER_CONFLICT' });
  await expect(listWardIndentPage({
    tenantId: TENANT,
    beforeRequestedAt: '1',
    beforeId: 73,
  })).rejects.toMatchObject({ code: 'WARD_INDENT_CURSOR_INVALID' });
  await expect(listWardIndentPage({
    tenantId: TENANT,
    worklist: 'owned',
  })).rejects.toMatchObject({ code: 'WARD_INDENT_OWNER_ROLE_REQUIRED' });
  await expect(listWardIndentPage({
    tenantId: TENANT,
    worklist: 'owned',
    actorRoleCodes: ['PHARMACY_STAFF'],
    overdueOnly: true,
  })).rejects.toMatchObject({ code: 'WARD_INDENT_FILTER_CONFLICT' });
  expect(findManyIndents).not.toHaveBeenCalled();
});
