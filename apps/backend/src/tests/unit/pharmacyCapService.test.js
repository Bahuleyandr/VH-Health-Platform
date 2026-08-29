// Unit tests for pharmacyCapService — the pure pieces. The DB-touching
// probePharmacyCap is covered by the dispense integration suite.
//
// Regression for 2026-05-09-tpa-insurance-claim-billing-pharmacy-cap-not-enforced.

import { jest } from '@jest/globals';

import {
  assertPharmacyCapForDispenseTx,
  extractPharmacyCapFromRaw,
  resolveAuthoritativeCounterFundingTx,
  shouldBlockDispense,
  PHARMACY_CAP_CRITICAL_PCT,
  PHARMACY_CAP_WARN_PCT,
} from '../../services/pharmacy/pharmacyCapService.js';
import { clinicalOrderItemsSha256 } from '../../services/pharmacy/pharmacistVerificationService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ACTOR_UID = '22222222-2222-4222-8222-222222222222';
const ITEMS = [{ catalog_id: 7, quantity: 1, unit_price: 75 }];
const ITEMS_SHA256 = clinicalOrderItemsSha256(ITEMS);
const COMMAND_SHA256 = 'a'.repeat(64);

function capTx({ cap = 100, rawCap = null, spend = 50 } = {}) {
  const query = jest.fn(async (sql) => {
    if (sql.includes('SELECT patient.uid')) return [{ uid: PATIENT_UID }];
    if (sql.includes('pg_advisory_xact_lock')) return [{}];
    if (sql.includes('SELECT id,uid') && sql.includes('FROM users')) {
      return [{ id: 91, uid: PATIENT_UID }];
    }
    if (sql.includes('FROM pharmacy_orders') && sql.includes('funding_admission_id')) {
      return [{
        id: 71,
        patient_id: 91,
        uid: PATIENT_UID,
        facility_id: 7,
        status: 'READY',
        inventory_authority_version: 3,
        items_list: ITEMS,
        funding_admission_id: 44,
        funding_admission_order_version: 3,
        funding_admission_items_sha256: ITEMS_SHA256,
      }];
    }
    if (sql.includes('FROM admissions')) {
      return [{ id: 44, tenant_id: TENANT, patient_uid: PATIENT_UID, status: 'admitted' }];
    }
    if (sql.includes('FROM insurance_claim_caps')) {
      return cap == null ? [] : [{ max_amount: cap }];
    }
    if (sql.includes('FROM insurance_preauth_responses')) {
      return rawCap == null ? [] : [{ raw_response: { pharmacy_cap: rawCap } }];
    }
    if (sql.includes('FROM billing_invoice_items')) return [{ spend }];
    if (sql.includes('COALESCE(SUM(reserved_amount)')) return [{ spend: 0 }];
    if (sql.includes('UPPER(role) AS role')) {
      return [{ uid: ACTOR_UID, role: 'PHARMACY_INCHARGE' }];
    }
    if (sql.includes('SELECT uid FROM users')) return [{ uid: PATIENT_UID }];
    if (sql.includes('FROM tpa_claims')) return [{ id: 301 }];
    if (sql.includes('FROM pharmacy_cap_reservation_events')) return [];
    if (sql.includes('SELECT * FROM pharmacy_cap_reservations')) return [];
    if (sql.includes('INSERT INTO pharmacy_cap_reservations')) {
      return [{
        id: 501, tenant_id: TENANT, pharmacy_order_id: 71, admission_id: 44,
        facility_id: 7, reserved_amount: 75, authorised_funding_amount: 75,
        funding_source: 'tpa_claim', funding_reference: 'tpa:301',
        funding_tpa_claim_id: 301,
      }];
    }
    if (sql.includes('INSERT INTO pharmacy_cap_reservation_events')) return [{ id: 601 }];
    throw new Error(`Unexpected cap SQL: ${sql}`);
  });
  return { tx: { $queryRawUnsafe: query }, query };
}

describe('assertPharmacyCapForDispenseTx', () => {
  it('locks the active admission and blocks against the authoritative transaction amount', async () => {
    const { tx, query } = capTx();

    await expect(assertPharmacyCapForDispenseTx(tx, {
      tenantId: TENANT,
      patientId: 91,
      additionalAmount: 75,
      orderId: 71,
      fundingSource: 'tpa_claim',
      fundingReference: 'tpa:301',
      fundingTpaClaimId: 301,
      authorisedFundingAmount: 75,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'TPA_PHARMACY_CAP_EXCEEDED',
      details: {
        cap_amount: 100,
        current_spend: 50,
        projected_total: 125,
        utilisation_pct: 125,
      },
    });

    expect(query.mock.calls.some(([sql]) => /pharmacy_orders[\s\S]*FOR UPDATE/.test(sql))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /admissions[\s\S]*FOR UPDATE/.test(sql))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /c\.id = \$3::int/.test(sql))).toBe(true);
  });

  it('uses the same locked amount but permits an explicitly authorised override', async () => {
    const { tx } = capTx();

    await expect(assertPharmacyCapForDispenseTx(
      tx,
      {
        tenantId: TENANT,
        patientId: 91,
        additionalAmount: 75,
        allowOverride: true,
        orderId: 71,
        facilityId: 7,
        actorUid: ACTOR_UID,
        actorRole: 'PHARMACY_INCHARGE',
        commandKeySha256: COMMAND_SHA256,
        fundingSource: 'tpa_claim',
        fundingReference: 'tpa:301',
        fundingTpaClaimId: 301,
        authorisedFundingAmount: 75,
      },
    )).resolves.toMatchObject({
      level: 'critical',
      projectedTotal: 125,
    });
  });

  it('tenant-binds the raw preauthorisation fallback independently of RLS', async () => {
    const { tx, query } = capTx({ cap: null, rawCap: 200, spend: 20 });

    await expect(assertPharmacyCapForDispenseTx(
      tx,
      {
        tenantId: TENANT,
        patientId: 91,
        additionalAmount: 10,
        orderId: 71,
        facilityId: 7,
        actorUid: ACTOR_UID,
        actorRole: 'PHARMACY_INCHARGE',
        commandKeySha256: COMMAND_SHA256,
        fundingSource: 'tpa_claim',
        fundingReference: 'tpa:301',
        fundingTpaClaimId: 301,
        authorisedFundingAmount: 10,
      },
    )).resolves.toMatchObject({ pharmacyCap: 200, projectedTotal: 30 });

    const fallbackCall = query.mock.calls.find(([sql]) => sql.includes('insurance_preauth_responses'));
    expect(fallbackCall[0]).toMatch(/c\.id = \$3::int/);
    expect(fallbackCall.slice(1)).toEqual([44, TENANT, 301, PATIENT_UID]);
  });

  it('hard-blocks any positive dispense against an authoritative zero cap', async () => {
    const { tx } = capTx({ cap: 0, spend: 0 });

    await expect(assertPharmacyCapForDispenseTx(
      tx,
      {
        tenantId: TENANT,
        patientId: 91,
        additionalAmount: 0.01,
        orderId: 71,
        fundingSource: 'tpa_claim',
        fundingReference: 'tpa:301',
        fundingTpaClaimId: 301,
        authorisedFundingAmount: 0.01,
      },
    )).rejects.toMatchObject({
      code: 'TPA_PHARMACY_CAP_EXCEEDED',
      details: {
        cap_amount: 0,
        projected_total: 0.01,
        utilisation_pct: 100,
      },
    });
  });

  it('durably records even a zero-value cap reservation with exact custody identity', async () => {
    const { tx, query } = capTx({ cap: 0, spend: 0 });

    await expect(assertPharmacyCapForDispenseTx(
      tx,
      {
        tenantId: TENANT,
        patientId: 91,
        additionalAmount: 0,
        orderId: 71,
        facilityId: 7,
        actorUid: ACTOR_UID,
        actorRole: 'PHARMACY_INCHARGE',
        commandKeySha256: COMMAND_SHA256,
        fundingSource: 'tpa_claim',
        fundingReference: 'tpa:301',
        fundingTpaClaimId: 301,
      },
    )).resolves.toMatchObject({
      hasCap: true,
      pharmacyCap: 0,
      projectedTotal: 0,
      level: 'ok',
    });

    const reservation = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO pharmacy_cap_reservations'));
    expect(reservation[0]).toMatch(/INSERT INTO pharmacy_cap_reservations/);
    expect(reservation.slice(1, 6)).toEqual([TENANT, 7, 71, 44, 0]);
  });
});

describe('resolveAuthoritativeCounterFundingTx', () => {
  it('rejects a caller shape that omits the exact current order tuple', async () => {
    await expect(resolveAuthoritativeCounterFundingTx(
      { $queryRawUnsafe: jest.fn() },
      { tenantId: TENANT, patientId: 91, orderId: 71, paymentMode: 'insurance' },
    )).rejects.toMatchObject({
      statusCode: 400,
      code: 'COUNTER_FUNDING_AUTHORITY_REQUIRED',
    });
  });
});

describe('extractPharmacyCapFromRaw', () => {
  it('returns null for empty / non-object input', () => {
    expect(extractPharmacyCapFromRaw(null)).toBeNull();
    expect(extractPharmacyCapFromRaw(undefined)).toBeNull();
    expect(extractPharmacyCapFromRaw('string')).toBeNull();
    expect(extractPharmacyCapFromRaw({})).toBeNull();
  });

  it('reads the nested caps.pharmacy.max_amount shape', () => {
    expect(extractPharmacyCapFromRaw({
      caps: { pharmacy: { max_amount: 15000, currency: 'INR' } },
    })).toBe(15000);
  });

  it('falls back to flat pharmacy_cap', () => {
    expect(extractPharmacyCapFromRaw({ pharmacy_cap: 15000 })).toBe(15000);
  });

  it('prefers nested over flat when both present', () => {
    expect(extractPharmacyCapFromRaw({
      caps: { pharmacy: { max_amount: 20000 } },
      pharmacy_cap: 99999,
    })).toBe(20000);
  });

  it('returns null for non-numeric / NaN caps', () => {
    expect(extractPharmacyCapFromRaw({ pharmacy_cap: 'abc' })).toBeNull();
  });
});

describe('shouldBlockDispense', () => {
  // Phase 1 hard-block rule.
  it('skips when probe has no cap', () => {
    expect(shouldBlockDispense({ hasCap: false, level: 'critical' })).toBe(false);
  });

  it('passes through ok / warn levels even with no override', () => {
    expect(shouldBlockDispense({ hasCap: true, level: 'ok' })).toBe(false);
    expect(shouldBlockDispense({ hasCap: true, level: 'warn' })).toBe(false);
  });

  it('blocks critical without override', () => {
    expect(shouldBlockDispense({ hasCap: true, level: 'critical' })).toBe(true);
  });

  it('allows critical with explicit override', () => {
    expect(shouldBlockDispense(
      { hasCap: true, level: 'critical' },
      { allowOverride: true },
    )).toBe(false);
  });

  it('threshold ladder is 80% warn / 100% critical', () => {
    expect(PHARMACY_CAP_WARN_PCT).toBe(80);
    expect(PHARMACY_CAP_CRITICAL_PCT).toBe(100);
  });
});
