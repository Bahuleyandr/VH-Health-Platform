import { icuRefetchMs, ICU_LIVE_POLL_MS } from "@/app/(with-auth)/dashboard/icu/realtime";

describe("icuRefetchMs", () => {
  it("relaxes every polling tab to the 2-min live poll while subscribed", () => {
    expect(icuRefetchMs(true, 30_000)).toBe(120_000);
    expect(icuRefetchMs(true, 60_000)).toBe(120_000);
    expect(icuRefetchMs(true, 30_000)).toBe(ICU_LIVE_POLL_MS);
  });
  it("keeps each tab's original cadence when not subscribed", () => {
    expect(icuRefetchMs(false, 30_000)).toBe(30_000);
    expect(icuRefetchMs(false, 60_000)).toBe(60_000);
  });
});
