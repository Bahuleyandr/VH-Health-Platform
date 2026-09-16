import { jest } from '@jest/globals';
const prismaModule = await import('../../lib/prisma.js');
const query = jest.fn();
const execute = jest.fn();
const transaction = jest.fn();
const client = { $queryRawUnsafe: query, $executeRawUnsafe: execute, $transaction: transaction };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  ...prismaModule,
  default: client,
  setTenantTx: transaction,
}));
const {
  admitToLabor,
  recordPartographEntry,
  recordDelivery,
} = await import('../../services/maternity/maternityService.js');

const tenantId = '00000000-0000-4000-8000-000000000001';
const boundary = new Error('database boundary');
const cases = [
  {
    field: 'admission_reason',
    write: admitToLabor,
    base: { tenantId, pregnancy_id: 1 },
    allowed: [null, undefined, 'spontaneous_labour', 'induction', 'elective_lscs',
      'pprom', 'reduced_fm', 'postdated', 'other'],
  },
  {
    field: 'contractions_intensity',
    write: recordPartographEntry,
    base: { tenantId, labor_admission_id: 1 },
    allowed: [null, undefined, 'weak', 'moderate', 'strong'],
  },
  {
    field: 'delivery_mode',
    write: recordDelivery,
    base: { tenantId, pregnancy_id: 1, delivery_datetime: '2026-09-16T00:00:00Z' },
    allowed: ['nvd', 'lscs_emergency', 'lscs_elective', 'instrumental_forceps',
      'instrumental_vacuum', 'breech', 'destructive', 'other'],
  },
];

describe('maternity clinical domain validation', () => {
  beforeEach(() => {
    query.mockReset().mockRejectedValue(boundary);
    execute.mockReset().mockRejectedValue(boundary);
    transaction.mockReset().mockRejectedValue(boundary);
  });

  function expectNoDatabaseCall() {
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  }

  for (const { field, write, base, allowed } of cases) {
    describe(field, () => {
      it.each(['audit_invalid_domain', 'OTHER', ' other ', true, 1, [], {}, ['other']])(
        'rejects %p before any database call', async (value) => {
          await expect(write({ ...base, [field]: value })).rejects.toMatchObject({
            statusCode: 400,
            code: 'MATERNITY_CLINICAL_VALUE_INVALID',
          });
          expectNoDatabaseCall();
        },
      );

      it.each(allowed)('preserves the database boundary for %p', async (value) => {
        await expect(write({ ...base, [field]: value })).rejects.toBe(boundary);
        expect(query).toHaveBeenCalledTimes(1);
        expect(execute).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      });

      it('rejects an empty string before any database call', async () => {
        await expect(write({ ...base, [field]: '' })).rejects.toMatchObject({ statusCode: 400 });
        expectNoDatabaseCall();
      });
    });
  }

  describe('descent_fifths_above_brim', () => {
    const base = { tenantId, labor_admission_id: 1 };

    it.each([-1, 6, 1.5, NaN, Infinity, '-1', '6', '1.5', 'garbled', '', ' ',
      true, false, [], [1], {}, '1e0', '0x1'])('rejects %p before any database call', async (value) => {
      await expect(recordPartographEntry({ ...base, descent_fifths_above_brim: value }))
        .rejects.toMatchObject({ statusCode: 400, code: 'MATERNITY_CLINICAL_VALUE_OUT_OF_RANGE' });
      expectNoDatabaseCall();
    });

    it.each([null, undefined, 0, 1, 2, 3, 4, 5, '0', '5', ' 2 ', '+3'])(
      'preserves the database boundary for %p', async (value) => {
        await expect(recordPartographEntry({ ...base, descent_fifths_above_brim: value }))
          .rejects.toBe(boundary);
        expect(query).toHaveBeenCalledTimes(1);
        expect(execute).not.toHaveBeenCalled();
        expect(transaction).not.toHaveBeenCalled();
      },
    );
  });
});
