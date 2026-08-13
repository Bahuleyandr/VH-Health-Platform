import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tailwindcss from "eslint-plugin-tailwindcss";
import unusedImports from "eslint-plugin-unused-imports";

// NOTE (2026-08-09 hygiene audit, AD-M7): the legacy .eslintrc.cjs was dead
// config — this flat config is what `npm run lint` actually loads. The
// unused-imports / import / tailwindcss / jsx-a11y coverage the legacy file
// configured is ported here so it runs again.
//
// - `import` and `jsx-a11y` plugins are already registered by
//   eslint-config-next/core-web-vitals, so their extra rules are enabled
//   without re-registering the plugins (flat config forbids redefinition).
// - `import/no-unresolved` from the legacy config is intentionally not
//   ported: `tsc --noEmit` (npm run type-check) already fails on unresolved
//   imports, and the typescript resolver setup doubles lint time.

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    name: "vhhealth/react-compiler-lint-exceptions",
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
    },
  },
  {
    name: "vhhealth/unused-imports",
    plugins: { "unused-imports": unusedImports },
    rules: {
      // kill dead imports fast
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    name: "vhhealth/tailwindcss",
    plugins: { tailwindcss },
    settings: {
      tailwindcss: { callees: ["classnames", "clsx", "ctl"] },
    },
    rules: {
      ...tailwindcss.configs.recommended.rules,
      // Tailwind v4: keep plugin, mute rules that need a resolvable JS config
      // or are noisy on v4 syntax (carried over from the legacy config).
      "tailwindcss/no-custom-classname": "off",
      "tailwindcss/classnames-order": "off",
      "tailwindcss/no-contradicting-classname": "off",
      "tailwindcss/no-unnecessary-arbitrary-value": "off",
      "tailwindcss/enforces-shorthand": "off",
    },
  },
  {
    name: "vhhealth/jsx-a11y-recommended",
    // Plugin instance comes from eslint-config-next; only the rule set is
    // widened from Next's subset to the full recommended set.
    //
    // Pragmatic scoping (AD-M7): the full recommended set surfaces ~285
    // pre-existing violations (267 of them label-has-associated-control),
    // accumulated while this linting was dead. They are downgraded to
    // warnings so a11y coverage is visible again without a portal-wide
    // markup rewrite in the same PR; promoting these back to errors is
    // follow-up work.
    rules: {
      ...Object.fromEntries(
        Object.entries(jsxA11y.flatConfigs.recommended.rules).map(
          ([rule, severity]) => [
            rule,
            severity === "off" || severity === 0 ? severity : "warn",
          ],
        ),
      ),
      // These rules protect assistive-technology semantics and currently have
      // no legacy violations. Keep them blocking while the noisier label and
      // interaction findings are reduced under the warning ratchet.
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-role": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
      "jsx-a11y/tabindex-no-positive": "error",
    },
  },
  {
    name: "vhhealth/import-order",
    rules: {
      // keep imports tidy (warn: advisory, does not fail CI)
      "import/order": [
        "warn",
        {
          groups: [
            ["builtin", "external", "internal"],
            ["parent", "sibling", "index"],
          ],
          alphabetize: { order: "asc", caseInsensitive: true },
          "newlines-between": "always",
        },
      ],
    },
  },
];

export default eslintConfig;
