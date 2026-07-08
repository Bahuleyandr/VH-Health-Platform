import { runSoakReplay } from '../scripts/soak-replay.mjs';

describe('fixture soak replay', () => {
  it('drains accepted fixtures with no loss and no duplicate ingest', async () => {
    const result = await runSoakReplay({ cycles: 20, duplicateEvery: 7 });

    expect(result.fixtures).toBeGreaterThan(0);
    expect(result.rejected).toBe(result.cycles);
    expect(result.accepted + result.rejected).toBe(result.fixtures * result.cycles);
    expect(result.ingested).toBe(result.accepted);
    expect(result.duplicateAcks).toBeGreaterThan(0);
  });
});
