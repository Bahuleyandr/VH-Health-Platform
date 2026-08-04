import { readFileSync } from 'node:fs';

const scheduler = readFileSync(
  new URL('../../utils/scheduler.js', import.meta.url),
  'utf8',
);

/**
 * The WardDowntimePacksMissing alert can only fire while something is
 * measuring. If this probe stops being scheduled the series goes absent, so
 * the wiring is pinned here alongside the probe's own behaviour.
 */
describe('Ward downtime-pack output probe scheduler wiring', () => {
  it('registers the probe on a cadence tighter than the 15-minute generation cycle', () => {
    expect(scheduler).toContain(
      "registerCron('*/5 * * * *', withReplicaLocalJobGuard('ward-downtime-pack-output-probe'",
    );
    expect(scheduler).toContain(
      "await import(\n      '../services/downtime/wardDowntimePackOutputProbe.js'\n    )",
    );
    // Dynamic import only — the scheduler must not pull the probe (and through
    // it prisma + the metrics singleton) into its own import graph.
    expect(scheduler).not.toMatch(/^import .*wardDowntimePackOutputProbe\.js/m);
  });

  it('runs the probe on every replica rather than behind the advisory lock', () => {
    // withJobLock grants one replica per tick, leaving every other replica
    // exporting a stale gauge that max() would latch onto forever. An
    // observation job has to refresh on the replica being scraped.
    expect(scheduler).not.toContain("withJobLock('ward-downtime-pack-output-probe'");
    expect(scheduler).toMatch(
      /function withReplicaLocalJobGuard\(jobName, fn\) \{[\s\S]*?runWithSuperAdmin\(fn\)/,
    );
    const guard = scheduler.slice(
      scheduler.indexOf('function withReplicaLocalJobGuard'),
      scheduler.indexOf('import purgeLogs'),
    );
    expect(guard).not.toContain('withDbAdvisoryLock');
  });

  it('keeps the mutating generation path out of the backend scheduler', () => {
    // Regeneration belongs to the ward-downtime-packs CronJob (audit C-5), so
    // the probe must observe only — never generate as a side effect. The name
    // survives in prose explaining who owns regeneration; what must not appear
    // is a call to it or an import of the generator.
    expect(scheduler).not.toMatch(/generateWardDowntimePacks\s*\(/);
    expect(scheduler).not.toMatch(/import[\s\S]{0,120}wardDowntimePackService\.js/);
  });
});
