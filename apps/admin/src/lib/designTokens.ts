export const vhDesignTokens = {
  version: "nl11-s04-p1",
  color: {
    brand: {
      primary: "#007A64",
      onPrimary: "#FFFFFF",
      primaryDark: "#4DB8A8",
      onPrimaryDark: "#121212",
    },
    clinical: {
      primary: "#1565C0",
      onPrimary: "#FFFFFF",
      primaryDark: "#90CAF9",
      onPrimaryDark: "#0D1B2A",
      secondary: "#00796B",
      tertiary: "#0097A7",
    },
    surface: {
      light: {
        background: "#E0F5F6",
        staffBackground: "#F5F7FA",
        surface: "#FFFFFF",
        card: "#FFFFFF",
        textPrimary: "#1A237E",
        textSecondary: "#546E7A",
        border: "#ECEFF1",
        inputBorder: "#B0BEC5",
      },
      dark: {
        background: "#121212",
        staffBackground: "#141420",
        surface: "#1E1E1E",
        staffSurface: "#1E1E2C",
        card: "#252536",
        textPrimary: "#E0E0E8",
        textSecondary: "#9E9EAE",
        border: "#2E2E42",
        inputBorder: "#3A3A50",
      },
    },
    status: {
      success: "#2E7D32",
      successOnSurfaceLight: "#2E7D32",
      successOnSurfaceDark: "#66BB6A",
      warning: "#E65100",
      warningOnSurfaceLight: "#A84300",
      warningOnSurfaceDark: "#FFB74D",
      error: "#C62828",
      errorOnSurfaceLight: "#C62828",
      errorOnSurfaceDark: "#FF8A80",
      danger: "#FF5252",
      info: "#007A64",
    },
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
  },
  radius: {
    input: 8,
    control: 10,
    card: 12,
    dialog: 12,
    chip: 20,
    pill: 999,
  },
  typography: {
    baseFontSize: 16,
    bodySmall: 12,
    body: 14,
    title: 18,
    display: 34,
    letterSpacing: 0,
  },
  iconSize: {
    xs: 14,
    sm: 16,
    md: 20,
    lg: 24,
    xl: 32,
  },
  density: {
    compactRowHeight: 40,
    comfortableRowHeight: 48,
    touchTarget: 48,
    desktopScrollbar: 10,
  },
  motion: {
    fastMs: 120,
    standardMs: 200,
    slowMs: 320,
  },
  focus: {
    ringWidth: 2,
    ringOffset: 2,
    minimumContrastRatio: 3,
  },
  componentParityChecklist: [
    "navigationShell",
    "forms",
    "tablesAndLists",
    "clinicalStatusChips",
    "alerts",
    "emptyStates",
    "authSurfaces",
    "printableClinicalAndAdminDocuments",
  ],
} as const;

export type AdminTokenMode = "light" | "dark";
export type CssVariableMap = Record<`--${string}`, string>;

export const tenantPrimaryCssVariables = [
  "--tenant-primary",
  "--vh-color-brand-primary",
] as const;

export const adminCssVariableMap = {
  light: {
    "--vh-color-brand-primary": vhDesignTokens.color.brand.primary,
    "--vh-color-brand-on-primary": vhDesignTokens.color.brand.onPrimary,
    "--vh-color-background": vhDesignTokens.color.surface.light.background,
    "--vh-color-surface": vhDesignTokens.color.surface.light.surface,
    "--vh-color-card": vhDesignTokens.color.surface.light.card,
    "--vh-color-text-primary": "#111827",
    "--vh-color-text-secondary": "#4B5563",
    "--vh-color-muted": "#F0FAFA",
    "--vh-color-muted-foreground": "#45645F",
    "--vh-color-success": vhDesignTokens.color.status.success,
    "--vh-color-success-on-surface":
      vhDesignTokens.color.status.successOnSurfaceLight,
    "--vh-color-warning": vhDesignTokens.color.status.warning,
    "--vh-color-warning-on-surface":
      vhDesignTokens.color.status.warningOnSurfaceLight,
    "--vh-color-error": vhDesignTokens.color.status.danger,
    "--vh-color-error-on-surface":
      vhDesignTokens.color.status.errorOnSurfaceLight,
    "--vh-color-info": vhDesignTokens.color.brand.primary,
    "--vh-color-border": "color-mix(in oklch, var(--primary) 20%, transparent)",
    "--vh-color-input": "color-mix(in oklch, var(--primary) 30%, transparent)",
    "--background": "var(--vh-color-background)",
    "--foreground": "var(--vh-color-text-primary)",
    "--card": "var(--vh-color-card)",
    "--card-foreground": "var(--vh-color-text-primary)",
    "--muted": "var(--vh-color-muted)",
    "--muted-foreground": "var(--vh-color-muted-foreground)",
    "--success": "var(--vh-color-success)",
    "--success-on-surface": "var(--vh-color-success-on-surface)",
    "--warning": "var(--vh-color-warning)",
    "--warning-on-surface": "var(--vh-color-warning-on-surface)",
    "--info": "var(--vh-color-info)",
    "--danger": "var(--vh-color-error)",
    "--error-on-surface": "var(--vh-color-error-on-surface)",
    "--border": "color-mix(in oklch, var(--primary) 20%, transparent)",
    "--input": "color-mix(in oklch, var(--primary) 30%, transparent)",
    "--vh-radius-input": `${vhDesignTokens.radius.input}px`,
    "--vh-radius-control": `${vhDesignTokens.radius.card}px`,
    "--vh-radius-card": `${vhDesignTokens.radius.card}px`,
    "--vh-focus-ring-width": `${vhDesignTokens.focus.ringWidth}px`,
    "--vh-focus-ring-offset": `${vhDesignTokens.focus.ringOffset}px`,
    "--vh-density-touch-target": `${vhDesignTokens.density.touchTarget}px`,
    "--primary": `var(--tenant-primary, ${vhDesignTokens.color.brand.primary})`,
    "--primary-foreground": vhDesignTokens.color.brand.onPrimary,
    "--ring": "var(--primary)",
  },
  dark: {
    "--vh-color-brand-primary": vhDesignTokens.color.brand.primaryDark,
    "--vh-color-brand-on-primary": vhDesignTokens.color.brand.onPrimaryDark,
    "--vh-color-background": vhDesignTokens.color.surface.dark.background,
    "--vh-color-surface": vhDesignTokens.color.surface.dark.surface,
    "--vh-color-card": vhDesignTokens.color.surface.dark.surface,
    "--vh-color-text-primary": "#FFFFFF",
    "--vh-color-text-secondary": "#9CA3AF",
    "--vh-color-muted": "#2A2A2A",
    "--vh-color-muted-foreground": "#9CA3AF",
    "--vh-color-success": vhDesignTokens.color.status.successOnSurfaceDark,
    "--vh-color-success-on-surface":
      vhDesignTokens.color.status.successOnSurfaceDark,
    "--vh-color-warning": vhDesignTokens.color.status.warningOnSurfaceDark,
    "--vh-color-warning-on-surface":
      vhDesignTokens.color.status.warningOnSurfaceDark,
    "--vh-color-error": vhDesignTokens.color.status.danger,
    "--vh-color-error-on-surface":
      vhDesignTokens.color.status.errorOnSurfaceDark,
    "--vh-color-info": vhDesignTokens.color.brand.primaryDark,
    "--vh-color-border": "color-mix(in oklch, var(--primary) 20%, transparent)",
    "--vh-color-input": "color-mix(in oklch, var(--primary) 25%, transparent)",
    "--background": "var(--vh-color-background)",
    "--foreground": "var(--vh-color-text-primary)",
    "--card": "var(--vh-color-card)",
    "--card-foreground": "var(--vh-color-text-primary)",
    "--muted": "var(--vh-color-muted)",
    "--muted-foreground": "var(--vh-color-muted-foreground)",
    "--success": "var(--vh-color-success)",
    "--success-on-surface": "var(--vh-color-success-on-surface)",
    "--warning": "var(--vh-color-warning)",
    "--warning-on-surface": "var(--vh-color-warning-on-surface)",
    "--info": "var(--vh-color-info)",
    "--danger": "var(--vh-color-error)",
    "--error-on-surface": "var(--vh-color-error-on-surface)",
    "--border": "color-mix(in oklch, var(--primary) 20%, transparent)",
    "--input": "color-mix(in oklch, var(--primary) 25%, transparent)",
    "--vh-radius-input": `${vhDesignTokens.radius.input}px`,
    "--vh-radius-control": `${vhDesignTokens.radius.card}px`,
    "--vh-radius-card": `${vhDesignTokens.radius.card}px`,
    "--vh-focus-ring-width": `${vhDesignTokens.focus.ringWidth}px`,
    "--vh-focus-ring-offset": `${vhDesignTokens.focus.ringOffset}px`,
    "--vh-density-touch-target": `${vhDesignTokens.density.touchTarget}px`,
    "--primary": `var(--tenant-primary, ${vhDesignTokens.color.brand.primaryDark})`,
    "--primary-foreground": vhDesignTokens.color.brand.onPrimaryDark,
    "--ring": "var(--primary)",
  },
} as const satisfies Record<AdminTokenMode, CssVariableMap>;

export function buildAdminDesignTokenCssVariables(
  mode: AdminTokenMode,
  tenantPrimary?: string | null,
): CssVariableMap {
  const variables: CssVariableMap = { ...adminCssVariableMap[mode] };
  if (tenantPrimary) {
    variables["--tenant-primary"] = tenantPrimary;
    variables["--vh-color-brand-primary"] = tenantPrimary;
  }
  return variables;
}

function channelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function parseHexColor(hex: string): [number, number, number] {
  const value = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`Expected #RRGGBB color, received ${hex}`);
  }
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

export function relativeLuminance(hex: string): number {
  const [red, green, blue] = parseHexColor(hex).map(channelToLinear);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}
