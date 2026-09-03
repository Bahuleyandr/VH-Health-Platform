import { readFileSync } from 'node:fs';

const serviceSource = readFileSync(
  new URL(
    '../../services/clinical/clinicalAlertDeliveryObligationService.js',
    import.meta.url,
  ),
  'utf8',
);

function escalationFunction() {
  const match = serviceSource.match(
    /export async function escalateClinicalAlertRecoveryCases\([\s\S]*?\n}\n\nexport default/,
  );
  expect(match).not.toBeNull();
  return match[0];
}

describe('clinical alert recovery escalation database clock contract', () => {
  it('rounds every receipt-bound timestamp above millisecond outbox precision', () => {
    const source = escalationFunction();
    const upwardDatabaseClocks = source.match(
      /date_trunc\('milliseconds', NOW\(\)\)\s*\+ INTERVAL '1 millisecond'/g,
    );

    expect(upwardDatabaseClocks).toHaveLength(6);
    expect(source).not.toContain('new Date(');
    expect(source.indexOf('await outbox.queue')).toBeLessThan(
      source.indexOf("date_trunc('milliseconds', NOW())"),
    );
  });
});
