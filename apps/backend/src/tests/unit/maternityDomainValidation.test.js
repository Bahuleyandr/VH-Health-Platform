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
  recordNewborn,
  recordApgar,
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

  describe('newborn birth_order', () => {
    const base = { tenantId, delivery_id: 1, birth_datetime: '2026-09-16T00:00:00Z' };

    it.each([0, -1, 1.5, NaN, Infinity, null, true, false, [], [1], {}, '', ' ',
      '1child', '1.5', '1e2', '0x10', 2147483648, '2147483648'])(
      'rejects %p before any database call', async (value) => {
        await expect(recordNewborn({ ...base, birth_order: value }))
          .rejects.toMatchObject({ statusCode: 400, message: 'birth_order must be a positive integer' });
        expectNoDatabaseCall();
      },
    );

    it.each([undefined, 1, 2, 2147483647, '1', '02', '+3', ' 4 '])(
      'preserves the database boundary for %p', async (value) => {
        await expect(recordNewborn({ ...base, birth_order: value })).rejects.toBe(boundary);
        expect(query).toHaveBeenCalledTimes(1);
        expect(transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('Apgar integer domains', () => {
    const base = { tenantId, newborn_id: 1, time_minute: 1 };
    const invalid = [NaN, Infinity, 0.5, true, false, [], [1], {}, '', ' ',
      'garbled', '1.5', '1e0', '0x1'];

    for (const field of ['appearance', 'pulse', 'grimace', 'activity', 'respiration']) {
      it.each([...invalid, -1, 3])(`${field} rejects %p before any database call`, async (value) => {
        await expect(recordApgar({ ...base, [field]: value })).rejects.toMatchObject({
          statusCode: 400,
          message: expect.stringContaining(field),
        });
        expectNoDatabaseCall();
      });

      it.each([null, undefined, 0, 1, 2, '0', '2', ' 1 ', '+2'])(
        `${field} preserves the database boundary for %p`, async (value) => {
          await expect(recordApgar({ ...base, [field]: value })).rejects.toBe(boundary);
          expect(query).toHaveBeenCalledTimes(1);
          expect(transaction).not.toHaveBeenCalled();
        },
      );
    }

    it.each([...invalid, null, undefined, 0, 2, 15])(
      'time_minute rejects %p before any database call', async (value) => {
        await expect(recordApgar({ ...base, time_minute: value })).rejects.toMatchObject({
          statusCode: 400,
          message: 'time_minute must be 1, 5, or 10',
        });
        expectNoDatabaseCall();
      },
    );

    it.each([1, 5, 10, '1', '5', '10', ' 1 ', '+5'])(
      'time_minute preserves the database boundary for %p', async (value) => {
        await expect(recordApgar({ ...base, time_minute: value })).rejects.toBe(boundary);
        expect(query).toHaveBeenCalledTimes(1);
        expect(transaction).not.toHaveBeenCalled();
      },
    );
  });
});
