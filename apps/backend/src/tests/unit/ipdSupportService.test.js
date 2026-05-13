// Unit coverage for the IPD support service (advance deposits / attendant
// passes / ward indents). The full happy paths exercise Postgres state
// machines, so this file focuses on the contract between the service and
// the Prisma client — specifically that the model accessors the service
// reaches for actually exist on the singleton (snake_case `attendant_passes`,
// not `attendantPass`). Past finding tracked here:
//   2026-05-10-inpatient-admission-admission-attendant-pass-list-500.

import { jest } from '@jest/globals';

const attendantPassesFindMany = jest.fn();
const attendantPassesUpdate = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    attendant_passes: {
      findMany: attendantPassesFindMany,
      update: attendantPassesUpdate,
    },
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const ipdSupportService = (await import('../../services/ipd/ipdSupportService.js')).default;

beforeEach(() => {
  attendantPassesFindMany.mockReset();
  attendantPassesUpdate.mockReset();
});

describe('ipdSupportService.listAdmissionPasses', () => {
  it('queries attendant_passes (snake_case Prisma model) by admission_id, ordered by pass_index', async () => {
    attendantPassesFindMany.mockResolvedValueOnce([
      { id: 1, admission_id: 13, pass_index: 1, pass_number: 'AP-20260510-0001', status: 'active' },
      { id: 2, admission_id: 13, pass_index: 2, pass_number: 'AP-20260510-0002', status: 'active' },
    ]);

    const passes = await ipdSupportService.listAdmissionPasses(13);

    expect(attendantPassesFindMany).toHaveBeenCalledTimes(1);
    expect(attendantPassesFindMany).toHaveBeenCalledWith({
      where: { admission_id: 13 },
      orderBy: { pass_index: 'asc' },
    });
    expect(passes).toHaveLength(2);
    expect(passes[0].pass_number).toBe('AP-20260510-0001');
  });

  it('returns an empty array when no passes exist for the admission', async () => {
    attendantPassesFindMany.mockResolvedValueOnce([]);
    const passes = await ipdSupportService.listAdmissionPasses(9999);
    expect(passes).toEqual([]);
  });
});
