import { jest } from '@jest/globals';

const rootQueryRawUnsafeMock = jest.fn();
const rootExecuteRawUnsafeMock = jest.fn();
const txQueryRawUnsafeMock = jest.fn();
const txExecuteRawUnsafeMock = jest.fn();
const transactionMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: rootQueryRawUnsafeMock,
    $executeRawUnsafe: rootExecuteRawUnsafeMock,
    $transaction: transactionMock,
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  CLINICAL_AI_MODULES,
  listClinicalAiModules,
} = await import('../../services/ai/clinicalAiModuleService.js');

describe('clinicalAiModuleService module registry seeding', () => {
  beforeEach(() => {
    rootQueryRawUnsafeMock.mockReset();
    rootExecuteRawUnsafeMock.mockReset();
    txQueryRawUnsafeMock.mockReset();
    txExecuteRawUnsafeMock.mockReset();
    transactionMock.mockReset();

    rootQueryRawUnsafeMock.mockImplementation(async (sql) => {
      if (/SELECT module_key, display_name, description, enabled/i.test(String(sql))) {
        return [];
      }
      return [];
    });
  });

  it('serializes concurrent cold-cache module seeding behind one advisory lock', async () => {
    let releaseAdvisoryLock;
    const advisoryLockWait = new Promise((resolve) => {
      releaseAdvisoryLock = resolve;
    });

    txQueryRawUnsafeMock.mockImplementation(async (sql) => {
      if (/pg_advisory_xact_lock/i.test(String(sql))) {
        await advisoryLockWait;
      }
      return [];
    });
    txExecuteRawUnsafeMock.mockResolvedValue(1);
    transactionMock.mockImplementation(async (callback) => callback({
      $queryRawUnsafe: txQueryRawUnsafeMock,
      $executeRawUnsafe: txExecuteRawUnsafeMock,
    }));

    const first = listClinicalAiModules({ refresh: true });
    await Promise.resolve();
    const second = listClinicalAiModules({ refresh: true });
    releaseAdvisoryLock();

    await Promise.all([first, second]);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txQueryRawUnsafeMock.mock.calls[0][0]).toMatch(/pg_advisory_xact_lock/);
    expect(txQueryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(txExecuteRawUnsafeMock).toHaveBeenCalledTimes(CLINICAL_AI_MODULES.length);
    expect(txExecuteRawUnsafeMock.mock.calls[0][0]).toMatch(/ON CONFLICT \(module_key\)/);
  });
});
