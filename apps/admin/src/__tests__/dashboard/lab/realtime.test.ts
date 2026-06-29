import { labRefetchMs, LAB_LIVE_POLL_MS } from "@/app/(with-auth)/dashboard/lab/realtime";

describe("labRefetchMs", () => {
  it("relaxes the alerts poll to the 2-min live cadence while subscribed", () => {
    expect(labRefetchMs(true, 60_000)).toBe(120_000);
    expect(labRefetchMs(true, 60_000)).toBe(LAB_LIVE_POLL_MS);
  });
  it("keeps the original 60s cadence when not subscribed", () => {
    expect(labRefetchMs(false, 60_000)).toBe(60_000);
  });
});
