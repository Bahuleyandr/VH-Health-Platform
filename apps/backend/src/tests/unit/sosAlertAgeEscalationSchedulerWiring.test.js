import { readFileSync } from 'node:fs';

const scheduler = readFileSync(
  new URL('../../utils/scheduler.js', import.meta.url),
  'utf8',
);

/**
 * The alert-age escalation sweep is the one cron that pages the emergency team
 * on a timer. Two properties have to hold at once, and they pull against each
 * other — hence a dedicated wiring pin:
 *
 *   1. It must be ON by default. It is the HIGH-1 remediation; an opt-in flag
 *      would ship the fix disabled, which is the exact failure the flag exists
 *      to guard against.
 *   2. An operator must be able to stop it WITHOUT a code change. Production
 *      sync is a manual ArgoCD action, so a revert-and-resync is hours; a
 *      misbehaving sweep re-pages responders every two minutes meanwhile.
 *
 * The only shape satisfying both is default-on with an explicit opt-OUT.
 */
describe('SOS alert-age escalation scheduler wiring', () => {
  // Anchor the end marker to a search that STARTS at the block — several of
  // these job names also appear in the file's summary header near the top, so
  // a bare indexOf() for the following job can resolve to an earlier line and
  // silently yield an empty slice (which passes nothing and fails everything).
  const start = scheduler.indexOf('★ KILL SWITCH');
  const block = scheduler.slice(start, scheduler.indexOf('Escalate stuck orders', start));

  it('locates the sweep registration block', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block.length).toBeGreaterThan(200);
  });

  it('is gated by an opt-OUT flag, so an unset env keeps the remediation live', () => {
    // Unset must mean enabled: the `?? 'true'` fallback plus a !== 'false'
    // comparison. An `=== 'true'` test would silently disable the sweep in
    // every environment that has not set the variable — including production.
    expect(scheduler).toMatch(
      /process\.env\.SOS_ALERT_AGE_ESCALATION_ENABLED \?\? 'true'/,
    );
    expect(block).toMatch(/!==\s*'false'/);
    expect(block).not.toMatch(/===\s*'true'/);
  });

  it('still registers the two-minute sweep under the advisory job lock', () => {
    // withJobLock is load-bearing here: without it every replica sweeps the
    // same tenant on the same tick and multiplies the page-out.
    expect(block).toContain(
      "registerCron('*/2 * * * *', withJobLock('sos-alert-age-escalation'",
    );
    expect(block).toContain("runForEachTenant('sos-alert-age-escalation'");
    // Dynamic import only — the sweep must not pull prisma and the
    // notification stack into the scheduler's own import graph.
    expect(scheduler).not.toMatch(/^import .*sosEscalationService\.js/m);
  });

  it('says so loudly when an operator has disabled it', () => {
    // A silent kill switch is how a hospital discovers months later that
    // nothing has been escalating. The disabled branch must log.
    expect(block).toMatch(/logger\.warn\(/);
    expect(block).toMatch(/DISABLED by SOS_ALERT_AGE_ESCALATION_ENABLED/);
  });
});
