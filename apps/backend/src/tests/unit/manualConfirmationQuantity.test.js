import { readFileSync } from 'node:fs';
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/pharmacy/compositionIdentityService.js', () => ({
  resolveCompositionIdentitiesByCatalogIds: jest.fn(),
}));
jest.unstable_mockModule('../../../scripts/backfill-drug-compositions.mjs', () => ({
  enrichCatalogRowForWrite: jest.fn((row) => row),
}));
jest.unstable_mockModule('../../services/pharmacy/pharmacyOrderInventoryService.js', () => ({
  allocateOrderInventoryTx: jest.fn(),
  applyAuthoritativeDeliveryAllocations: jest.fn(),
  applyOrderPrescriptionProjectionTx: jest.fn(),
  createDispenseCommandIdentity: jest.fn(),
  dispenseSubstitutionCommand: jest.fn(),
  resolveCounterDispenseAuthorityTx: jest.fn(),
  resolvePrescriptionLineIndexes: jest.fn(),
  substitutionWitnessPayload: jest.fn(),
}));

const { canonicalManualConfirmationQuantity } = await import(
  '../../controllers/pharmacy/pharmacyOrderController.js'
);

const controllerSource = readFileSync(
  new URL('../../controllers/pharmacy/pharmacyOrderController.js', import.meta.url),
  'utf8',
);
const manualResolverSource = controllerSource.slice(
  controllerSource.indexOf('async function resolveManualConfirmationLinesTx'),
  controllerSource.indexOf('export const confirmOrder'),
);

describe('manual order confirmation NUMERIC(14,4) quantity boundary', () => {
  test('preserves the exact positive NUMERIC(14,4) ceiling', () => {
    expect(canonicalManualConfirmationQuantity('9999999999.9999', 0))
      .toBe(9999999999.9999);
  });

  test.each([
    ['a fifth decimal', '9999999999.99999'],
    ['an overflowing whole value', '10000000000'],
    ['exponent notation', '1e2'],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['a negative value', -1],
  ])('rejects %s with the existing catalog-recovery error', (_label, quantity) => {
    let thrown;
    try {
      canonicalManualConfirmationQuantity(quantity, 3);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      statusCode: 422,
      code: 'PHARMACY_ORDER_CATALOG_RESOLUTION_REQUIRED',
      details: {
        order_line_index: 3,
        recovery_action: 'select_catalog_item',
      },
    });
  });

  test('wires the exact parser into manual line resolution without Number coercion', () => {
    expect(manualResolverSource).toMatch(
      /canonicalManualConfirmationQuantity\(\s*line\?\.quantity \?\? line\?\.qty,\s*index,\s*\)/,
    );
    expect(manualResolverSource).not.toMatch(
      /const quantity = Number\(line\?\.quantity \?\? line\?\.qty\)/,
    );
  });
});
