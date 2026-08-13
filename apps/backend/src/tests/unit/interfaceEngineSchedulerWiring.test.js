import fs from 'node:fs';
import path from 'node:path';

const scheduler = fs.readFileSync(
  path.resolve(process.cwd(), 'src/utils/scheduler.js'),
  'utf8',
);

describe('interface-engine scheduler wiring', () => {
  test('runs a locked tenant fanout with bounded dispatch inputs', () => {
    expect(scheduler).toContain(
      "registerCron('* * * * *', withJobLock('interface-engine-outbound-dispatch'",
    );
    expect(scheduler).toContain(
      "runForEachTenant('interface-engine-outbound-dispatch', tenantId => (",
    );
    expect(scheduler).toContain(
      'dispatchOutboundMessages({ tenantId, batchSize: 25, maxInFlight: 100 })',
    );
  });
});
