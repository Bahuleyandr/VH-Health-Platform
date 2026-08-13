import { AdminRoleEnum, StoredAdminUserSchema } from "@/lib/schemas";
import {
  PORTAL_ROLE_RANK,
  PORTAL_ROLE_VALUES,
  normalizePortalRole,
} from "@/lib/roles";

describe("canonical admin portal role contract", () => {
  it("uses one role set for route rank, profile, and cache validation", () => {
    expect(Object.keys(PORTAL_ROLE_RANK)).toEqual([...PORTAL_ROLE_VALUES]);
    for (const role of PORTAL_ROLE_VALUES) {
      expect(AdminRoleEnum.parse(role)).toBe(role);
      expect(
        StoredAdminUserSchema.parse({ role, permissions: [] }).role,
      ).toBe(role);
      expect(normalizePortalRole(role.toLowerCase())).toBe(role);
    }
  });

  it.each([null, undefined, "", "PATIENT", "WEBHOOK_CLIENT", "DEVICE_GATEWAY", "UNKNOWN_ROLE"])(
    "rejects non-portal role %p",
    (role) => {
      expect(normalizePortalRole(role)).toBeNull();
      expect(StoredAdminUserSchema.safeParse({ role }).success).toBe(false);
    },
  );
});
