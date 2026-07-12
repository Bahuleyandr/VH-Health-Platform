import { jest } from '@jest/globals';

import prisma from '../../lib/prisma.js';
import { __testing__ } from '../../services/insurance/claimsService.js';

describe('final cashless claim clinical billing traceability', () => {
  let originalQueryRaw;

  beforeEach(() => {
    originalQueryRaw = prisma.$queryRawUnsafe;
  });

  afterEach(() => {
    prisma.$queryRawUnsafe = originalQueryRaw;
  });

  it.each([
    'dialysis_session',
    'cath_procedure_log',
    'cath_consumable_usage',
  ])('accepts %s as a traceable clinical billing source', async (sourceRefType) => {
    prisma.$queryRawUnsafe = jest.fn().mockResolvedValue([{
      id: 1,
      description: 'Clinical billing line',
      line_total: '125.00',
      source_ref_type: sourceRefType,
      source_ref_id: 9_007_199_254_740_993n,
    }]);

    await expect(
      __testing__.assertFinalCashlessInvoiceLinesTraceable(12),
    ).resolves.toBeUndefined();
  });

  it('preserves unsafe BIGINT source ids in traceability error details', async () => {
    prisma.$queryRawUnsafe = jest.fn().mockResolvedValue([{
      id: 2,
      description: 'Untraceable manual line',
      line_total: '125.00',
      source_ref_type: 'manual',
      source_ref_id: 9_007_199_254_740_993n,
    }]);

    await expect(
      __testing__.assertFinalCashlessInvoiceLinesTraceable(12),
    ).rejects.toMatchObject({
      code: 'TPA_INVOICE_LINE_TRACE_REQUIRED',
      details: {
        examples: [{
          source_ref_type: 'manual',
          source_ref_id: '9007199254740993',
        }],
      },
    });
  });
});
