import { dialysisRefetchMs, DIALYSIS_LIVE_POLL_MS, DIALYSIS_CHANNEL } from "@/app/(with-auth)/dashboard/dialysis/realtime";

describe("dialysisRefetchMs", () => {
  it("relaxes to the live poll when subscribed", () => {
    expect(dialysisRefetchMs(true, 30_000)).toBe(DIALYSIS_LIVE_POLL_MS);
    expect(dialysisRefetchMs(true, 60_000)).toBe(DIALYSIS_LIVE_POLL_MS);
  });
  it("keeps the base cadence when not subscribed", () => {
    expect(dialysisRefetchMs(false, 30_000)).toBe(30_000);
    expect(dialysisRefetchMs(false, 60_000)).toBe(60_000);
  });
  it("exposes the channel name", () => {
    expect(DIALYSIS_CHANNEL).toBe("staff:dialysis-board");
  });
});
