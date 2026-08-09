// Audit 2026-08-09 finding F7 — regression guard for the SMS provider seam.
//
// `services/smsService.js` is a dry-run stub: nothing it is handed reaches a
// patient. Before this guard, six request-path and cron callers imported it
// directly, so booking confirmations, pharmacy updates, payment links and
// reminders were "sent" into a log line with no durable record and no signal
// to staff. Patient-facing SMS now goes through
// `utils/notifications/smsOutbox.js` → the migration-609 notification outbox.
//
// This test reads the source tree rather than exercising behaviour on
// purpose: it is the only check that catches a NEW caller wiring itself back
// to the dry-run path.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The drain layer is where a real gateway will be called from once one is
// wired; nothing else may reach the provider module.
const ALLOWED_IMPORTERS = new Set([
  'services/smsService.js',
  'utils/notifications/notificationOutboxDelivery.js',
  'utils/notifications/notificationDispatcher.js',
]);

const SMS_IMPORT_RE = /(?:from|import)\s*\(?\s*['"][^'"]*services\/smsService\.js['"]/;

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'tests' || entry === 'node_modules') continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const sourceFiles = collectSourceFiles(SRC_ROOT);
const relPath = file => relative(SRC_ROOT, file).split(sep).join('/');

describe('SMS provider seam', () => {
  it('finds the backend source tree (guards against a silent empty scan)', () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it('is imported by no request path or cron job', () => {
    const importers = sourceFiles
      .filter(file => SMS_IMPORT_RE.test(readFileSync(file, 'utf8')))
      .map(relPath)
      .filter(file => !ALLOWED_IMPORTERS.has(file));

    expect(importers).toEqual([]);
  });

  it('exposes only the raw provider call — message composition moved to the outbox layer', async () => {
    const smsService = await import('../../services/smsService.js');
    expect(Object.keys(smsService).sort()).toEqual(['sendSMS']);
  });

  it('keeps every rewired patient-SMS call site on the outbox helper', () => {
    const callSites = [
      'controllers/investigation/bookingController.js',
      'controllers/pharmacy/pharmacyOrderController.js',
      'controllers/appointment/appointmentWorkflowController.js',
      'services/billing/paymentLinkService.js',
      'services/notificationRetryService.js',
      'utils/notifications/InvestigationNotificationJob.js',
      'utils/notifications/appointmentReminderJob.js',
    ];
    // Siblings inside utils/notifications import it as './smsOutbox.js'.
    const OUTBOX_IMPORT_RE = /(?:from|import)\s*\(?\s*['"][^'"]*smsOutbox\.js['"]/;
    for (const site of callSites) {
      const source = readFileSync(join(SRC_ROOT, site), 'utf8');
      expect({ site, usesOutbox: OUTBOX_IMPORT_RE.test(source) })
        .toEqual({ site, usesOutbox: true });
    }
  });
});
