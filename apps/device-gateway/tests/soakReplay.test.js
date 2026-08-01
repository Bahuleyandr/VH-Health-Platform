import { runSoakReplay } from '../scripts/soak-replay.mjs';

describe('fixture soak replay', () => {
  it('drains accepted fixtures with no loss and no duplicate ingest', async () => {
    const result = await runSoakReplay({ cycles: 20, duplicateEvery: 7, restartEvery: 13 });

    expect(result.fixtures).toBeGreaterThan(0);
    expect(result.rejected).toBe(result.cycles);
    expect(result.accepted + result.rejected).toBe(result.fixtures * result.cycles);
    expect(result.ingested).toBe(result.accepted);
    expect(result.duplicateAcks).toBeGreaterThan(0);
    expect(result.restarts).toBeGreaterThan(1);
    expect(result.positions).toBe(result.accepted);
    expect(result).toMatchObject({
      recoveryState: 'ready',
      lost: 0,
      duplicated: 0,
      renumbered: 0,
      silentlyDiscarded: 0,
    });
  }, 60_000);
});
