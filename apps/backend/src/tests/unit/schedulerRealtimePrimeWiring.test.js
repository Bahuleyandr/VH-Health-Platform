import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scheduler = fs.readFileSync(
  path.resolve(__dirname, '../../utils/scheduler.js'),
  'utf8',
);
const server = fs.readFileSync(path.resolve(__dirname, '../../bin/www.js'), 'utf8');

describe('operational realtime startup prime', () => {
  it('starts only after the WebSocket server exists', () => {
    expect(scheduler).toContain('export async function primeOperationalRealtimeChannels()');
    const initAt = server.indexOf('initWebSocket(server);');
    const primeAt = server.indexOf('schedulerModule?.primeOperationalRealtimeChannels?.();');
    expect(initAt).toBeGreaterThan(0);
    expect(primeAt).toBeGreaterThan(initAt);
    expect(scheduler).toContain(
      "withDbAdvisoryLock('daily-ops-tick', () => runWithSuperAdmin(tickDailyOps))",
    );
    expect(scheduler).toContain(
      "withDbAdvisoryLock('teleconsult-ops-tick', () => runWithSuperAdmin(tickTeleconsultOps))",
    );
  });
});
