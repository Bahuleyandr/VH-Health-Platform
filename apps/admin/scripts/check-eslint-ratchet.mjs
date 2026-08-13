import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");

export function findWarningRegressions(warningCounts, baseline) {
  const totalWarnings = [...warningCounts.values()].reduce(
    (total, count) => total + count,
    0,
  );
  const regressions = [];

  for (const [rule, count] of warningCounts) {
    const ceiling = baseline.rules[rule] ?? 0;
    if (count > ceiling) regressions.push(`${rule}: ${count} > ${ceiling}`);
  }
  if (totalWarnings > baseline.total) {
    regressions.push(`total: ${totalWarnings} > ${baseline.total}`);
  }

  return { regressions: regressions.sort(), totalWarnings };
}

export function selectWarningBaseline(config, hasFile) {
  const matches = (config.variants ?? []).filter((variant) =>
    variant.requiredFiles.every(hasFile),
  );
  if (matches.length > 1) {
    throw new Error(
      `multiple ESLint warning baseline variants match: ${matches.map(({ name }) => name).join(", ")}`,
    );
  }
  return matches[0] ?? config;
}

async function main() {
  const baselinePath = path.join(root, "eslint-warning-baseline.json");
  const config = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const baseline = selectWarningBaseline(config, (relativePath) =>
    fs.existsSync(path.join(root, relativePath)),
  );
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(["src/**/*.{js,jsx,ts,tsx}"]);
  const errorResults = results
    .map((result) => ({
      ...result,
      messages: result.messages.filter((message) => message.severity === 2),
    }))
    .filter((result) => result.messages.length > 0);

  if (errorResults.length > 0) {
    const formatter = await eslint.loadFormatter("stylish");
    console.error(await formatter.format(errorResults));
    process.exitCode = 1;
  }

  const warningCounts = new Map();
  for (const result of results) {
    for (const message of result.messages) {
      if (message.severity !== 1) continue;
      const rule = message.ruleId ?? "eslint/unused-disable";
      warningCounts.set(rule, (warningCounts.get(rule) ?? 0) + 1);
    }
  }

  const { regressions, totalWarnings } = findWarningRegressions(
    warningCounts,
    baseline,
  );
  if (regressions.length > 0) {
    console.error("ESLint warning ratchet failed:");
    for (const regression of regressions) console.error(`  ${regression}`);
    process.exitCode = 1;
  } else if (!process.exitCode) {
    console.log(
      `ESLint ratchet OK (${baseline.name}): 0 errors, ${totalWarnings}/${baseline.total} warnings; no rule exceeded its ceiling.`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(scriptPath).toLowerCase()
) {
  await main();
}
