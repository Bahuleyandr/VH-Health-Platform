import {
  GATEWAY_REFUND_RECONCILIATION_PRESENTATIONS,
} from '../../services/billing/paymentGatewayService.js';
import {
  PAYMENT_LINK_PRESENTATIONS,
  paymentLinkLocaleKey,
  paymentLinkPresentation,
} from '../../services/billing/paymentLinkService.js';
import {
  CATH_INVENTORY_SHORTFALL_PRESENTATIONS,
} from '../../services/clinical/cathLabService.js';
import {
  CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS,
} from '../../services/clinical/clinicalAlertDeliveryObligationService.js';

const FIVE_LOCALES = ['en', 'hi', 'ta', 'te', 'ml'];

function expectFiveLocaleContract(contract, fields) {
  expect(Object.keys(contract).sort()).toEqual([...FIVE_LOCALES].sort());
  for (const locale of FIVE_LOCALES) {
    expect(Object.keys(contract[locale]).sort()).toEqual([...fields].sort());
    for (const field of fields) {
      expect(typeof contract[locale][field]).toBe('string');
      expect(contract[locale][field].trim()).not.toBe('');
    }
  }
}

describe('five-locale backend notification presentation contracts', () => {
  test('payment links resolve Malayalam and preserve all template fields', () => {
    expectFiveLocaleContract(PAYMENT_LINK_PRESENTATIONS, [
      'subject',
      'billReady',
      'payGateway',
      'payUpi',
      'secondaryLine',
      'emailLead',
      'emailReadySuffix',
      'emailAction',
    ]);
    // The five presentations are the same frozen object until wording is
    // approved, so `toBe` on the returned value cannot tell a working
    // resolver from `return PAYMENT_LINK_PRESENTATIONS.hi`. Assert the
    // resolved KEY, which is distinguishable, and keep one identity check so
    // the two stay wired together.
    for (const [input, expected] of [
      ['ml', 'ml'],
      ['ml-IN', 'ml'],
      ['ML_in', 'ml'],
      ['  ta-IN  ', 'ta'],
      ['te', 'te'],
      ['hi-IN', 'hi'],
      ['en-GB', 'en'],
      ['unsupported', 'en'],
      ['constructor', 'en'],
      ['', 'en'],
      [null, 'en'],
      [undefined, 'en'],
    ]) {
      expect([input, paymentLinkLocaleKey(input)]).toEqual([input, expected]);
    }
    expect(paymentLinkPresentation('ml-IN'))
      .toBe(PAYMENT_LINK_PRESENTATIONS[paymentLinkLocaleKey('ml-IN')]);
  });

  test('gateway refund reconciliation includes Malayalam', () => {
    expectFiveLocaleContract(GATEWAY_REFUND_RECONCILIATION_PRESENTATIONS, [
      'title',
      'body',
    ]);
  });

  test('clinical alert recovery escalation includes Malayalam', () => {
    expectFiveLocaleContract(CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS, [
      'title',
      'manualHoldBody',
      'recipientCoverageBody',
    ]);
  });

  test('Cath inventory shortfall includes Malayalam', () => {
    expectFiveLocaleContract(CATH_INVENTORY_SHORTFALL_PRESENTATIONS, [
      'title',
      'body',
    ]);
  });
});
