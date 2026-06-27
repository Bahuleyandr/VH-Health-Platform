import { bedsRefetchMs } from "@/app/(with-auth)/dashboard/beds/realtime";

describe("bedsRefetchMs", () => {
  it("uses a slow 5-min safety poll while subscribed", () => {
    expect(bedsRefetchMs(true)).toBe(300_000);
  });
  it("falls back to the 60s poll when not subscribed", () => {
    expect(bedsRefetchMs(false)).toBe(60_000);
  });
});
