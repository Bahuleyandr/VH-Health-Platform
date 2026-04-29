import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagePath = path.join(
  root,
  "src",
  "app",
  "(with-auth)",
  "dashboard",
  "clinical-ai",
  "page.tsx",
);
const expansionPath = path.join(
  root,
  "src",
  "app",
  "(with-auth)",
  "dashboard",
  "clinical-ai",
  "components",
  "ClinicalAiExpansionPanels.tsx",
);
const budgetKb = Number.parseInt(
  process.env.ADMIN_CLINICAL_AI_ROUTE_JS_BUDGET_KB || "180",
  10,
);

function fail(message) {
  console.error(`Clinical AI bundle guard failed: ${message}`);
  process.exitCode = 1;
}

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`missing required file ${path.relative(root, filePath)}`);
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

const pageSource = readRequired(pagePath);
const expansionSource = readRequired(expansionPath);

if (
  /from\s+["']\.\/components\/(?:coreModulePanels|deferredModulePanels)/.test(
    pageSource,
  )
) {
  fail("clinical-ai/page.tsx must not statically import heavy module panels");
}

const requiredExpansionMarkers = [
  "next/dynamic",
  "function deferredPanel",
  "IntersectionObserver",
  'rootMargin: "900px 0px"',
];
for (const marker of requiredExpansionMarkers) {
  if (!expansionSource.includes(marker)) {
    fail(
      `ClinicalAiExpansionPanels.tsx is missing lazy-render marker: ${marker}`,
    );
  }
}

if (
  /^import\s+.*from\s+["']\.\/(?:coreModulePanels|deferredModulePanels)/m.test(
    expansionSource,
  )
) {
  fail(
    "ClinicalAiExpansionPanels.tsx must use dynamic imports for heavy module panels",
  );
}

const panelImportCount = (
  expansionSource.match(/deferredPanel\(\(\) => import\(/g) || []
).length;
if (panelImportCount < 20) {
  fail(
    `expected lazy dynamic imports for the Clinical AI panel set; found ${panelImportCount}`,
  );
}

const manifestPath = path.join(root, ".next", "app-build-manifest.json");
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const pages = manifest.pages || {};
  const clinicalRoute = Object.entries(pages).find(([route]) =>
    route.includes("/dashboard/clinical-ai/page"),
  );

  if (clinicalRoute) {
    const [, assets] = clinicalRoute;
    const jsAssets = assets.filter((asset) => asset.endsWith(".js"));
    const routeAssets = jsAssets.filter((asset) =>
      asset
        .replaceAll("\\", "/")
        .includes("static/chunks/app/(with-auth)/dashboard/clinical-ai/"),
    );
    const budgetedAssets = routeAssets.length > 0 ? routeAssets : jsAssets;
    const routeBytes = budgetedAssets.reduce((sum, asset) => {
      const assetPath = path.join(root, ".next", asset);
      return sum + (fs.existsSync(assetPath) ? fs.statSync(assetPath).size : 0);
    }, 0);
    const manifestBytes = jsAssets.reduce((sum, asset) => {
      const assetPath = path.join(root, ".next", asset);
      return sum + (fs.existsSync(assetPath) ? fs.statSync(assetPath).size : 0);
    }, 0);
    const routeKb = routeBytes / 1024;
    const manifestKb = manifestBytes / 1024;
    if (routeKb > budgetKb) {
      fail(
        `route-owned JS is ${routeKb.toFixed(1)} KiB, above ${budgetKb} KiB budget`,
      );
    } else {
      console.log(
        `Clinical AI route-owned JS budget OK: ${routeKb.toFixed(1)} KiB <= ${budgetKb} KiB ` +
          `(manifest total ${manifestKb.toFixed(1)} KiB includes shared chunks)`,
      );
    }
  } else {
    console.log(
      "Clinical AI static lazy-load guard OK; no route manifest entry found to budget.",
    );
  }
} else {
  console.log(
    "Clinical AI static lazy-load guard OK; build manifest not present.",
  );
}

if (!process.exitCode) {
  console.log(
    `Clinical AI lazy panel guard OK: ${panelImportCount} panels are deferred.`,
  );
}
