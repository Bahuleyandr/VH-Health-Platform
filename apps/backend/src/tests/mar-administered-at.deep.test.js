// Online barcode administration must never replay a client-authored bedside
// timestamp. Retrospective medication facts enter only through the governed
// paper reconciliation path, which supplies admission, checker, occurrence,
// canonical audit, and immutable recovery evidence as one transaction.
import { administerWithScan } from '../services/clinical/marFiveRightsService.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const PATIENT = '10000000-0000-4000-8000-000000000002';
const NURSE = '10000000-0000-4000-8000-000000000003';

function request(administeredAt) {
  return administerWithScan({
    ma_id: 1,
    scanned_patient_uid: PATIENT,
    scanned_barcode: 'Paracetamol',
    administeredBy: NURSE,
    tenantId: TENANT,
    administeredAt,
  });
}

describe('MAR online barcode timestamp boundary', () => {
  it('rejects a plausible retrospective bedside time before any MAR lookup', async () => {
    await expect(request(new Date(Date.now() - 30 * 60_000).toISOString()))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'MAR_RETROSPECTIVE_PATH_REQUIRED',
      });
  });

  it('rejects a future client-authored administration time with the same governed-path code', async () => {
    await expect(request(new Date(Date.now() + 48 * 3600_000).toISOString()))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'MAR_RETROSPECTIVE_PATH_REQUIRED',
      });
  });
});
