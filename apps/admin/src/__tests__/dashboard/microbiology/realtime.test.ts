import { microRefetchMs, MICRO_LIVE_POLL_MS } from "@/app/(with-auth)/dashboard/microbiology/realtime";

describe("microRefetchMs", () => {
  it("relaxes the resistance poll to the 2-min live cadence while subscribed", () => {
    expect(microRefetchMs(true, 60_000)).toBe(120_000);
    expect(microRefetchMs(true, 60_000)).toBe(MICRO_LIVE_POLL_MS);
  });
  it("keeps the original 60s cadence when not subscribed", () => {
    expect(microRefetchMs(false, 60_000)).toBe(60_000);
  });
});
