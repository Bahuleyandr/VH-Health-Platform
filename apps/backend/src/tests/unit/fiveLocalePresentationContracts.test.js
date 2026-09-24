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
import {
  APPOINTMENT_CONFIRMATION_PRESENTATIONS,
  APPOINTMENT_REMINDER_PRESENTATIONS,
  INVESTIGATION_READY_PRESENTATIONS,
  appointmentConfirmationPresentation,
  appointmentReminderPresentation,
  investigationReadyLocaleKey,
  investigationReadyPresentation,
  NotificationTemplates,
  renderAppointmentConfirmationPush,
  renderAppointmentReminderPush,
} from '../../utils/notifications/templates.js';

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
  const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)]
    .map((match) => match[1]).sort();
  expect(fields.length).toBeGreaterThan(0);
  expect(Object.keys(contract).sort()).toEqual([...FIVE_LOCALES].sort());
  for (const locale of FIVE_LOCALES) {
    expect(Object.keys(contract[locale]).sort()).toEqual([...fields].sort());
    for (const field of fields) {
      expect(typeof contract[locale][field]).toBe('string');
      expect(contract[locale][field].trim()).not.toBe('');
      expect(placeholders(contract[locale][field])).toEqual(placeholders(contract.en[field]));
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
      'INVESTIGATION_READY_PRESENTATIONS',
      'APPOINTMENT_REMINDER_PRESENTATIONS',
      'APPOINTMENT_CONFIRMATION_PRESENTATIONS',
    ]));
    expect(contracts.length).toBeGreaterThanOrEqual(7);

    for (const { file, name } of contracts) {
      const module = await import(pathToFileURL(file).href);
      expectFiveLocaleContract(module[name], Object.keys(module[name]?.en || {}));
    }
  });

  test('rejects an omitted locale, missing field, or changed interpolation tokens', () => {
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
    expect(() => expectFiveLocaleContract({
      ...complete,
      en: { title: 'Technical placeholder', body: 'Hello {name} on {date}' },
      ml: { title: 'Technical placeholder', body: 'Hello {name}' },
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

  test('investigation result notification preserves its copy while routing all five locales', () => {
    expect(Object.keys(NotificationTemplates)).toEqual(['investigationReady']);
    expectFiveLocaleContract(INVESTIGATION_READY_PRESENTATIONS, [
      'pushTitle',
      'smsTitle',
      'body',
    ]);
    for (const [input, expected] of [
      ['ml', 'ml'],
      ['ml-IN', 'ml'],
      ['HI_in', 'hi'],
      ['ta', 'ta'],
      ['te', 'te'],
      ['en-GB', 'en'],
      ['unsupported', 'en'],
      ['constructor', 'en'],
      [null, 'en'],
    ]) {
      expect(investigationReadyLocaleKey(input)).toBe(expected);
      expect(investigationReadyPresentation(input))
        .toBe(INVESTIGATION_READY_PRESENTATIONS[expected]);
    }
    const expectedBody = 'Hello Asha {testName}, your investigation report for "CBC" is now ready. '
      + 'You can view or download it from the VH Health app.';
    expect(NotificationTemplates.investigationReady({
      name: 'Asha {testName}',
      testName: 'CBC',
      language: 'ml-IN',
    })).toBe(expectedBody);
  });

  test('appointment reminders preserve existing English copy under the five-locale contract', () => {
    expectFiveLocaleContract(APPOINTMENT_REMINDER_PRESENTATIONS, [
      'push24Title', 'push24Body', 'push1Title', 'push1Body', 'smsTitle', 'smsBody',
    ]);
    expect(appointmentReminderPresentation('ml-IN'))
      .toBe(APPOINTMENT_REMINDER_PRESENTATIONS.ml);
    expect(appointmentReminderPresentation('unsupported'))
      .toBe(APPOINTMENT_REMINDER_PRESENTATIONS.en);
    expect(renderAppointmentReminderPush({
      time: '10:30', doctorName: 'Rao', tokenNumber: 12,
      hoursAhead: 24, language: 'ml',
    })).toEqual({
      title: 'Appointment Tomorrow 📅',
      body: 'Reminder: Your appointment is tomorrow at 10:30 with Dr. Rao. Token #12',
    });
    expect(renderAppointmentReminderPush({
      time: '10:30', doctorName: 'Rao', tokenNumber: 12,
      hoursAhead: 1, language: 'hi',
    })).toEqual({
      title: 'Appointment in 1 Hour ⏰',
      body: 'Your appointment at 10:30 with Dr. Rao is in ~1 hour. Token #12',
    });
  });

  test('appointment confirmation preserves its patient push copy in every locale branch', () => {
    expectFiveLocaleContract(APPOINTMENT_CONFIRMATION_PRESENTATIONS, [
      'pushTitle', 'pushBody', 'smsTitle', 'smsBody',
    ]);
    expect(appointmentConfirmationPresentation('ml-IN'))
      .toBe(APPOINTMENT_CONFIRMATION_PRESENTATIONS.ml);
    expect(appointmentConfirmationPresentation('unsupported'))
      .toBe(APPOINTMENT_CONFIRMATION_PRESENTATIONS.en);
    const date = '2026-08-20';
    expect(renderAppointmentConfirmationPush({
      date, time: '10:30', tokenNumber: 12, language: 'ml',
    })).toEqual({
      title: 'Appointment Confirmed ✓',
      body: `Your appointment on ${new Date(date).toLocaleDateString('en-IN')} at 10:30 is confirmed. Token #12`,
    });
  });
});
