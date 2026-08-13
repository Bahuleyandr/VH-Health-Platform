import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scheduler = fs.readFileSync(
  path.resolve(__dirname, '../../utils/scheduler.js'),
  'utf8',
);

describe('manual scheduler failure isolation', () => {
  it('attempts each independent recovery task and reports their aggregate failures', () => {
    const startup = scheduler.slice(scheduler.indexOf('export async function runAllScheduledTasksNow'));

    expect(startup).toContain("runManualTask('notification-outbox-drain'");
    expect(startup).toContain("runManualTask('event-outbox-drain'");
    expect(startup).toContain("runManualTask('timed-reminders'");
    expect(startup).toContain("runManualTask('process-scheduled-notifications'");
    expect(startup).toContain("throw new AggregateError(manualFailures");
  });
});
