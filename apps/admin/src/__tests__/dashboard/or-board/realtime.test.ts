import { orRefetchMs } from "@/app/(with-auth)/dashboard/or-board/realtime";

describe("orRefetchMs", () => {
  it("uses a 5-min safety poll while subscribed", () => {
    expect(orRefetchMs(true)).toBe(300_000);
  });
  it("falls back to the 60s poll when not subscribed", () => {
    expect(orRefetchMs(false)).toBe(60_000);
  });
});
