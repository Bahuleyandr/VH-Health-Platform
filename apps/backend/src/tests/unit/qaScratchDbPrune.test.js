import { selectPruneTargets, PROTECTED_DATABASES } from '../../../scripts/lib/qaScratchDbSelect.mjs';

function db(datname, overrides = {}) {
  return {
    datname,
    isTemplate: false,
    numbackends: 0,
    ageDays: 30,
    ...overrides,
  };
}

describe('qa-scratch-db prune target selection', () => {
  it('never selects the protected databases, however old or idle', () => {
    const { targets, skipped } = selectPruneTargets(
      [
        db('postgres', { ageDays: 400 }),
        db('vhhealth_test', { ageDays: 400 }),
        db('template0', { isTemplate: true, ageDays: 400 }),
        db('template1', { isTemplate: true, ageDays: 400 }),
      ],
      {},
    );
    expect(targets).toEqual([]);
    expect(skipped.map((s) => s.datname).sort()).toEqual([
      'postgres', 'template0', 'template1', 'vhhealth_test',
    ]);
    expect(PROTECTED_DATABASES).toEqual(expect.arrayContaining(['postgres', 'vhhealth_test']));
  });

  it('selects idle scratch databases older than maxAgeDays, sorted by name', () => {
    const { targets } = selectPruneTargets(
      [db('vhhealth_zebra_probe', { ageDays: 9 }), db('vhhealth_alpha_probe', { ageDays: 9 })],
      { maxAgeDays: 3 },
    );
    expect(targets).toEqual(['vhhealth_alpha_probe', 'vhhealth_zebra_probe']);
  });

  it('keeps databases at or under maxAgeDays with reason too-recent', () => {
    const { targets, skipped } = selectPruneTargets(
      [db('vhhealth_recent', { ageDays: 3 }), db('vhhealth_old', { ageDays: 3.5 })],
      { maxAgeDays: 3 },
    );
    expect(targets).toEqual(['vhhealth_old']);
    expect(skipped).toEqual([{ datname: 'vhhealth_recent', reason: 'too-recent' }]);
  });

  it('honors an explicit keep list', () => {
    const { targets, skipped } = selectPruneTargets(
      [db('vh_pr_timeline_598', { ageDays: 10 }), db('vhhealth_roll489', { ageDays: 10 })],
      { keep: ['vh_pr_timeline_598'] },
    );
    expect(targets).toEqual(['vhhealth_roll489']);
    expect(skipped).toEqual([{ datname: 'vh_pr_timeline_598', reason: 'kept' }]);
  });

  it('skips databases with live connections unless includeActive is set', () => {
    const rows = [db('vhhealth_busy', { ageDays: 10, numbackends: 2 })];
    expect(selectPruneTargets(rows, {}).targets).toEqual([]);
    expect(selectPruneTargets(rows, {}).skipped).toEqual([
      { datname: 'vhhealth_busy', reason: 'active' },
    ]);
    expect(selectPruneTargets(rows, { includeActive: true }).targets).toEqual(['vhhealth_busy']);
  });

  it('is conservative about unknown age', () => {
    const { targets, skipped } = selectPruneTargets(
      [db('vhhealth_mystery', { ageDays: null })],
      { maxAgeDays: 0 },
    );
    expect(targets).toEqual([]);
    expect(skipped).toEqual([{ datname: 'vhhealth_mystery', reason: 'unknown-age' }]);
  });

  it('defaults maxAgeDays to 3 and deduplicates input rows', () => {
    const { targets } = selectPruneTargets(
      [db('vhhealth_dup', { ageDays: 4 }), db('vhhealth_dup', { ageDays: 4 })],
      {},
    );
    expect(targets).toEqual(['vhhealth_dup']);
  });
});
