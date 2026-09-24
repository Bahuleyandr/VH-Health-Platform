import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
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
const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function presentationContractsIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (['tests', 'docs', 'migrations'].includes(entry.name)) return [];
      return presentationContractsIn(path.join(directory, entry.name));
    }
    if (!entry.isFile() || !/\.[cm]?js$/.test(entry.name)) return [];
    const file = path.join(directory, entry.name);
    const source = readFileSync(file, 'utf8');
    return [...source.matchAll(/^\s*export\s+const\s+([A-Z][A-Z0-9_]*_PRESENTATIONS)\s*=/gm)]
      .map((match) => ({ file, name: match[1] }));
  });
}

function expectFiveLocaleContract(contract, fields) {
  expect(fields.length).toBeGreaterThan(0);
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
  test('discovers every exported presentation contract and checks its locale and field parity', async () => {
    const contracts = presentationContractsIn(SOURCE_ROOT);
    const names = contracts.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining([
      'PAYMENT_LINK_PRESENTATIONS',
      'GATEWAY_REFUND_RECONCILIATION_PRESENTATIONS',
      'CLINICAL_ALERT_RECOVERY_ESCALATION_PRESENTATIONS',
      'CATH_INVENTORY_SHORTFALL_PRESENTATIONS',
    ]));
    expect(contracts.length).toBeGreaterThanOrEqual(4);

    for (const { file, name } of contracts) {
      const module = await import(pathToFileURL(file).href);
      expectFiveLocaleContract(module[name], Object.keys(module[name]?.en || {}));
    }
  });

  test('rejects an omitted locale or a missing presentation field', () => {
    const complete = Object.fromEntries(FIVE_LOCALES.map((locale) => [
      locale, { title: 'Technical placeholder', body: 'Technical placeholder' },
    ]));
    const withoutMalayalam = { ...complete };
    delete withoutMalayalam.ml;
    expect(() => expectFiveLocaleContract(withoutMalayalam, ['title', 'body'])).toThrow();
    expect(() => expectFiveLocaleContract({
      ...complete,
      ml: { title: 'Technical placeholder' },
    }, ['title', 'body'])).toThrow();
  });

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
