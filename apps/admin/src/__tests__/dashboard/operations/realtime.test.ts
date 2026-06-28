import { opsRefetchMs } from "@/app/(with-auth)/dashboard/operations/realtime";

describe("opsRefetchMs", () => {
  it("uses a 5-min safety poll while subscribed", () => {
    expect(opsRefetchMs(true)).toBe(300_000);
  });
  it("falls back to the 60s poll when not subscribed", () => {
    expect(opsRefetchMs(false)).toBe(60_000);
  });
});
