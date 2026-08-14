import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { measureClinicalAiRoute } from "./check-clinical-ai-bundle.mjs";

const routeEntry = "[project]/src/app/(with-auth)/dashboard/clinical-ai/page";
const layoutEntry = "[project]/src/app/(with-auth)/dashboard/layout";

function createNext16Fixture({ routeBytes = 256 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-admin-bundle-"));
  const nextDir = path.join(root, ".next");
  const manifestPath = path.join(
    nextDir,
    "server",
    "app",
    "(with-auth)",
    "dashboard",
    "clinical-ai",
    "page_client-reference-manifest.js",
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.mkdirSync(path.join(nextDir, "static", "chunks"), { recursive: true });
  fs.writeFileSync(path.join(nextDir, "static", "chunks", "shared.js"), "s");
  fs.writeFileSync(
    path.join(nextDir, "static", "chunks", "clinical-ai.js"),
    "x".repeat(routeBytes),
  );
  const payload = {
    entryJSFiles: {
      [layoutEntry]: ["static/chunks/shared.js"],
      [routeEntry]: ["static/chunks/shared.js", "static/chunks/clinical-ai.js"],
    },
  };
  fs.writeFileSync(
    manifestPath,
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n` +
      `globalThis.__RSC_MANIFEST["/(with-auth)/dashboard/clinical-ai/page"] = ${JSON.stringify(payload)};\n`,
  );
  return { root, nextDir };
}

test("measures route-owned Next 16 Turbopack chunks", (t) => {
  const fixture = createNext16Fixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = measureClinicalAiRoute({
    nextDir: fixture.nextDir,
    budgetBytes: 512,
  });
  assert.equal(result.bytes, 256);
  assert.deepEqual(result.chunks, ["static/chunks/clinical-ai.js"]);
});

test("fails on an oversized emitted-chunk fixture", (t) => {
  const fixture = createNext16Fixture({ routeBytes: 2048 });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(
    () =>
      measureClinicalAiRoute({
        nextDir: fixture.nextDir,
        budgetBytes: 1024,
      }),
    /above 1\.0 KiB budget/,
  );
});

test("fails closed when Next build evidence is absent", () => {
  assert.throws(
    () =>
      measureClinicalAiRoute({
        nextDir: "missing-next-output",
        budgetBytes: 1,
      }),
    /missing Next 16 client-reference manifest/,
  );
});
