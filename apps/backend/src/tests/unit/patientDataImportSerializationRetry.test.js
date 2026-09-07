import { __testing__ } from '../../services/import/patientDataImport.js';

describe('patient data import serializable retry classification', () => {
  it('recognizes every amplified Prisma driver-adapter 40001 carrier', () => {
    const iterations = 50;
    const escaped = Array.from({ length: iterations }, () => ({
      code: 'P2010',
      meta: {
        code: 'P2010',
        driverAdapterError: {
          cause: {
            code: '40001',
            message: 'could not serialize access due to concurrent update',
          },
        },
      },
    })).filter((error) => !__testing__.isRetryableClinicalImportTransactionError(error)).length;

    expect(escaped).toBe(0);
  });
});
