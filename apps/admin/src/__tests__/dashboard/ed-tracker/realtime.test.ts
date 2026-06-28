import { edRefetchMs } from "@/app/(with-auth)/dashboard/ed-tracker/realtime";

describe("edRefetchMs", () => {
  it("uses a 2-min safety poll while subscribed", () => {
    expect(edRefetchMs(true)).toBe(120_000);
  });
  it("falls back to the 30s poll when not subscribed", () => {
    expect(edRefetchMs(false)).toBe(30_000);
  });
});
