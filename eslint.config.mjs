// eslint.config.mjs
// Bridge from ESLint 9 flat config to the legacy .eslintrc.cjs rules
import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  // Import ALL rules from .eslintrc.cjs via FlatCompat
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  ...compat.config({
    extends: ["./.eslintrc.cjs"],
  }),
];

export default eslintConfig;
