// Unit test for addInvoiceItem's source_ref integrity guard.
// The guard fires before any DB access (no service_code path), so it is
// exercised without a prisma mock. Finding 2026-05-20-tpa-insurance-claim-
// billing-013275c3: a source-backed line (room_day, lab_order, …) must carry
// a source_ref_id so the charge is auditable to its originating record.

import { addInvoiceItem } from '../../services/billing/billingV2Service.js';

describe('billingV2Service.addInvoiceItem — source_ref integrity guard', () => {
  it('rejects a source-backed room_day line with no source_ref_id', async () => {
    await expect(
      addInvoiceItem(1, {
        description: 'IPD semi-private room, running charge',
        unit_price: 65000,
        source_ref_type: 'room_day',
        // source_ref_id deliberately omitted
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SOURCE_REF_ID_REQUIRED' });
  });

  it('rejects an order-backed lab_order line with no source_ref_id', async () => {
    await expect(
      addInvoiceItem(1, {
        description: 'Complete blood count',
        unit_price: 300,
        source_ref_type: 'lab_order',
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'SOURCE_REF_ID_REQUIRED' });
  });
});
