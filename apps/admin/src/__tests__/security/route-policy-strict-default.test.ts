import { roleSatisfiesPolicy } from "@/lib/routePolicy";

describe("route policy strict default", () => {
  it("defaults a policy without a rank or allowlist to ADMIN", () => {
    expect(roleSatisfiesPolicy("STAFF", {})).toBe(false);
    expect(roleSatisfiesPolicy("ADMIN", {})).toBe(true);
  });
});
