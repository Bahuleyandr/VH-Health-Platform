# NL11-S04 Design Token Parity Checklist

This checklist is the P1 parity harness for the admin portal, patient app, staff app, and printable surfaces. The machine-readable token contract lives beside it in `vhhealth-design-tokens.json`.

## Token Inventory

| Token family | P1 contract | Admin adapter | Flutter adapter |
|---|---|---|---|
| Semantic colors | Brand, clinical, surface, text, status, focus | `apps/admin/src/lib/designTokens.ts` and `apps/admin/src/app/globals.css` | `packages/vhhealth_core/lib/theme/design_tokens.dart` |
| Spacing | xs, sm, md, lg, xl, xxl | CSS custom properties and TypeScript constants | `VhDesignTokens.spacing*` |
| Radii | input, control, card, dialog, chip, pill | CSS custom properties and Tailwind theme variables | `VhShapeTokens` theme extension |
| Typography | base, body, title, display, zero letter spacing | TypeScript constants for parity tests | `VhDesignTokens` constants |
| Elevation | three shared shadow levels | CSS custom properties and existing `.shadow-elev-*` utilities | `VhDesignTokens.elevation*` |
| Icon sizing | xs through xl | TypeScript constants | `VhDesignTokens.icon*` |
| Density | compact row, comfortable row, touch target, desktop scrollbar | TypeScript constants and CSS variables | `VhDesignTokens.density*` |
| Motion | fast, standard, slow | CSS variables and TypeScript constants | `VhDesignTokens.motion*` |

## Component Parity Matrix

| Component family | Required parity checks |
|---|---|
| Navigation shell | Active route color, inactive text, focus ring, compact desktop density, mobile touch target |
| Forms | Input radius, focus ring width, label/hint contrast, error text contrast, primary action color |
| Tables and lists | Row height, hover/focus states, divider color, empty/loading state placement |
| Clinical status chips | Success, warning, error, info role mapping; body-text variants use `*OnSurface` tokens |
| Alerts | Icon size, title/body contrast, dismiss focus state, severity color mapping |
| Empty states | Icon size, muted text contrast, primary recovery action style |
| Auth surfaces | Primary button contrast, input focus, card radius, background/surface pairing |
| Printable clinical and admin documents | Brand color, status legends, readable grayscale fallback, no tenant-only color dependency |

## Contrast And Focus Gates

- Text and icon foregrounds on filled primary controls must meet at least 4.5:1 contrast.
- Focus rings must meet at least 3:1 non-text contrast against the active surface.
- Warning text must use `warningOnSurfaceLight` or `warningOnSurfaceDark`; the orange fill token is not approved for body text on white.
- Tenant primary overrides are allowed to change the admin primary CSS variable, but the default token contract remains the fallback when tenant branding is missing.
- Flutter themes must attach `VhColorTokens` and `VhShapeTokens` extensions so future screen rewrites can read semantic roles without duplicating constants.
