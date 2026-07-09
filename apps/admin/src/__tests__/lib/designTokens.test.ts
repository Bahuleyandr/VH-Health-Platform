import fs from "node:fs";
import path from "node:path";
import {
  adminCssVariableMap,
  buildAdminDesignTokenCssVariables,
  contrastRatio,
  tenantPrimaryCssVariables,
  vhDesignTokens,
} from "@/lib/designTokens";

type TokenContract = {
  colors: {
    brand: {
      primary: string;
      onPrimary: string;
      primaryDark: string;
      onPrimaryDark: string;
    };
    clinical: {
      primary: string;
      onPrimary: string;
      primaryDark: string;
      onPrimaryDark: string;
    };
    status: {
      warningOnSurfaceLight: string;
      warningOnSurfaceDark: string;
    };
  };
  componentParityChecklist: readonly string[];
};

function readContract(): TokenContract {
  const file = path.join(
    process.cwd(),
    "..",
    "..",
    "docs",
    "superpowers",
    "design-system",
    "vhhealth-design-tokens.json",
  );
  return JSON.parse(fs.readFileSync(file, "utf8")) as TokenContract;
}

describe("admin design token adapter", () => {
  it("stays pinned to the shared NL11-S04 token contract", () => {
    const contract = readContract();

    expect(vhDesignTokens.color.brand.primary).toBe(
      contract.colors.brand.primary,
    );
    expect(vhDesignTokens.color.brand.onPrimary).toBe(
      contract.colors.brand.onPrimary,
    );
    expect(vhDesignTokens.color.brand.primaryDark).toBe(
      contract.colors.brand.primaryDark,
    );
    expect(vhDesignTokens.color.clinical.primary).toBe(
      contract.colors.clinical.primary,
    );
    expect(vhDesignTokens.componentParityChecklist).toEqual(
      contract.componentParityChecklist,
    );
  });

  it("maps semantic colors into admin CSS variables with tenant fallback", () => {
    expect(adminCssVariableMap.light["--primary"]).toBe(
      "var(--tenant-primary, #007A64)",
    );
    expect(adminCssVariableMap.light["--warning-on-surface"]).toBe(
      "var(--vh-color-warning-on-surface)",
    );
    expect(adminCssVariableMap.light["--vh-color-warning-on-surface"]).toBe(
      "#A84300",
    );

    const branded = buildAdminDesignTokenCssVariables("light", "#AA0011");
    expect(branded["--tenant-primary"]).toBe("#AA0011");
    expect(branded["--vh-color-brand-primary"]).toBe("#AA0011");
    expect(branded["--primary"]).toBe("var(--tenant-primary, #007A64)");
  });

  it("declares the bridge variables TenantProvider owns", () => {
    expect(tenantPrimaryCssVariables).toEqual([
      "--tenant-primary",
      "--vh-color-brand-primary",
    ]);
  });

  it("keeps primary and focus colors above contrast thresholds", () => {
    expect(
      contrastRatio(
        vhDesignTokens.color.brand.primary,
        vhDesignTokens.color.brand.onPrimary,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        vhDesignTokens.color.brand.primaryDark,
        vhDesignTokens.color.brand.onPrimaryDark,
      ),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        vhDesignTokens.color.brand.primary,
        vhDesignTokens.color.surface.light.background,
      ),
    ).toBeGreaterThanOrEqual(vhDesignTokens.focus.minimumContrastRatio);
    expect(
      contrastRatio(
        vhDesignTokens.color.status.warningOnSurfaceLight,
        vhDesignTokens.color.surface.light.surface,
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
