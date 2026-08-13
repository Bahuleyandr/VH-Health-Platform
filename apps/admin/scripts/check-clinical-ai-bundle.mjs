import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const clinicalAiEntry =
  "[project]/src/app/(with-auth)/dashboard/clinical-ai/page";
const dashboardLayoutEntry = "[project]/src/app/(with-auth)/dashboard/layout";

function readRequired(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing ${label}: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

export function assertClinicalAiLazyLoading(root = defaultRoot) {
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
  const pageSource = readRequired(pagePath, "Clinical AI page source");
  const expansionSource = readRequired(
    expansionPath,
    "Clinical AI expansion source",
  );

  if (
    /from\s+["']\.\/components\/(?:coreModulePanels|deferredModulePanels)/.test(
      pageSource,
    )
  ) {
    throw new Error("clinical-ai/page.tsx statically imports heavy panels");
  }

  for (const marker of [
    "next/dynamic",
    "function deferredPanel",
    "IntersectionObserver",
    'rootMargin: "900px 0px"',
  ]) {
    if (!expansionSource.includes(marker)) {
      throw new Error(`ClinicalAiExpansionPanels.tsx is missing ${marker}`);
    }
  }

  if (
    /^import\s+.*from\s+["']\.\/(?:coreModulePanels|deferredModulePanels)/m.test(
      expansionSource,
    )
  ) {
    throw new Error("ClinicalAiExpansionPanels.tsx statically imports panels");
  }

  const deferredPanelCount = (
    expansionSource.match(/deferredPanel\(\(\) => import\(/g) ?? []
  ).length;
  if (deferredPanelCount < 20) {
    throw new Error(
      `expected at least 20 deferred Clinical AI panels; found ${deferredPanelCount}`,
    );
  }
  return deferredPanelCount;
}

function parseClientReferenceManifest(source, manifestPath) {
  const assignment = source.match(
    /globalThis\.__RSC_MANIFEST\[[^\]]+\]\s*=\s*(\{[\s\S]*\});?\s*$/,
  );
  if (!assignment) {
    throw new Error(
      `unsupported Next client-reference manifest shape: ${manifestPath}`,
    );
  }

  try {
    return JSON.parse(assignment[1]);
  } catch (error) {
    throw new Error(`invalid JSON payload in ${manifestPath}`, {
      cause: error,
    });
  }
}

function resolveChunk(nextDir, asset) {
  if (typeof asset !== "string" || !asset.endsWith(".js")) {
    throw new Error(`invalid JavaScript chunk entry: ${String(asset)}`);
  }
  const normalized = asset
    .replaceAll("\\", "/")
    .replace(/^\/?_next\//, "")
    .replace(/^\//, "");
  const nextRoot = path.resolve(nextDir);
  const chunkPath = path.resolve(nextRoot, normalized);
  if (!chunkPath.startsWith(`${nextRoot}${path.sep}`)) {
    throw new Error(`chunk path escapes .next: ${asset}`);
  }
  if (!fs.existsSync(chunkPath)) {
    throw new Error(`manifest chunk is missing: ${normalized}`);
  }
  return { normalized, chunkPath };
}

export function measureClinicalAiRoute({
  nextDir = path.join(defaultRoot, ".next"),
  budgetBytes,
}) {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    throw new Error(
      `bundle budget must be a positive byte count: ${budgetBytes}`,
    );
  }

  const manifestPath = path.join(
    nextDir,
    "server",
    "app",
    "(with-auth)",
    "dashboard",
    "clinical-ai",
    "page_client-reference-manifest.js",
  );
  const manifest = parseClientReferenceManifest(
    readRequired(manifestPath, "Next 16 client-reference manifest"),
    manifestPath,
  );
  const entryFiles = manifest.entryJSFiles;
  const routeAssets = entryFiles?.[clinicalAiEntry];
  const layoutAssets = entryFiles?.[dashboardLayoutEntry];
  if (!Array.isArray(routeAssets) || !Array.isArray(layoutAssets)) {
    throw new Error(
      "Next 16 manifest lacks the Clinical AI route or dashboard layout entry",
    );
  }

  const sharedAssets = new Set(layoutAssets);
  const routeOwnedAssets = [...new Set(routeAssets)].filter(
    (asset) => !sharedAssets.has(asset),
  );
  if (routeOwnedAssets.length === 0) {
    throw new Error(
      "Next 16 manifest contains no measurable route-owned chunks",
    );
  }

  const chunks = routeOwnedAssets.map((asset) => resolveChunk(nextDir, asset));
  const bytes = chunks.reduce(
    (total, { chunkPath }) => total + fs.statSync(chunkPath).size,
    0,
  );
  if (bytes > budgetBytes) {
    throw new Error(
      `route-owned JS is ${(bytes / 1024).toFixed(1)} KiB, above ${(budgetBytes / 1024).toFixed(1)} KiB budget`,
    );
  }

  return {
    bytes,
    budgetBytes,
    chunks: chunks.map(({ normalized }) => normalized),
  };
}

export function runClinicalAiBundleCheck({
  root = defaultRoot,
  nextDir = process.env.ADMIN_BUNDLE_NEXT_DIR ?? path.join(root, ".next"),
  budgetKb = Number(process.env.ADMIN_CLINICAL_AI_ROUTE_JS_BUDGET_KB ?? 180),
} = {}) {
  if (!Number.isFinite(budgetKb) || budgetKb <= 0) {
    throw new Error(
      `invalid ADMIN_CLINICAL_AI_ROUTE_JS_BUDGET_KB: ${budgetKb}`,
    );
  }
  const deferredPanelCount = assertClinicalAiLazyLoading(root);
  const result = measureClinicalAiRoute({
    nextDir,
    budgetBytes: budgetKb * 1024,
  });
  console.log(
    `Clinical AI route budget OK: ${(result.bytes / 1024).toFixed(1)} KiB <= ${budgetKb.toFixed(1)} KiB across ${result.chunks.length} route-owned chunks; ${deferredPanelCount} panels deferred.`,
  );
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    runClinicalAiBundleCheck();
  } catch (error) {
    console.error(
      `Clinical AI bundle guard failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
