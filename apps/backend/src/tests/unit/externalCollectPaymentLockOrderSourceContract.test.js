import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const servicesRoot = path.resolve(here, '../../services');

function readService(...parts) {
  return fs.readFileSync(path.join(servicesRoot, ...parts), 'utf8');
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectOrdered(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker);
    expect(current).toBeGreaterThan(previous);
    previous = current;
  }
}

function serviceFiles(dir = servicesRoot) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return serviceFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

describe('external collectPayment transaction lock order', () => {
  it('locks patient-merge stability before payment-link authority and propagates ownership', () => {
    const paymentLink = readService('billing', 'paymentLinkService.js');
    const reconciliation = sliceBetween(
      paymentLink,
      'export async function markPaymentLinkPaid',
      'export async function cancelPaymentLink',
    );

    expectOrdered(reconciliation, [
      'setTenantTx(tenant',
      'lockTenantPatientMergeStability(tx, tenant)',
      'FROM billing_payment_links',
      'FOR UPDATE',
      'collectPayment({',
      'mergeStabilityHeld: true',
    ]);
    expect(reconciliation.match(/lockTenantPatientMergeStability\(tx, tenant\)/g))
      .toHaveLength(1);
  });

  it('reuses the counter-sale finalize lock instead of acquiring it inside collectPayment', () => {
    const counterSale = readService('pharmacy', 'counterSaleService.js');
    const finalize = sliceBetween(
      counterSale,
      'const result = await setTenantTx(tenant, async (tx) => {',
      "const updated = await tx.$queryRawUnsafe(\n        `UPDATE pharmacy_counter_sales",
    );

    expectOrdered(finalize, [
      'lockTenantPatientMergeStability(tx, tenant)',
      'assertPharmacyFacilityGrant(tx',
      'issueInvoiceTx(tx',
      'collectPayment({',
      'mergeStabilityHeld: true',
    ]);
    expect(finalize.match(/lockTenantPatientMergeStability\(tx, tenant\)/g))
      .toHaveLength(1);
  });

  it('requires every production service that supplies collectPayment tx to own merge stability', () => {
    const callers = [];
    const safeCall = /await collectPayment\(\{[\s\S]{0,1200}?\},\s*\{\s*tx,\s*mergeStabilityHeld:\s*true\s*\}\)/g;

    for (const file of serviceFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      const externalCalls = source.match(/await collectPayment\(\{/g) || [];
      if (!externalCalls.length) continue;
      expect(source.match(safeCall) || []).toHaveLength(externalCalls.length);
      callers.push(path.relative(servicesRoot, file).replaceAll('\\', '/'));
    }

    expect(callers.sort()).toEqual([
      'billing/paymentGatewayService.js',
      'billing/paymentLinkService.js',
      'pharmacy/counterSaleService.js',
    ]);
  });
});
