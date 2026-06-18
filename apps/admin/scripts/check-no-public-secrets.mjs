// Regression guard for ADM API-key footgun (PLATFORM_AUDIT_2026-06-18 §3 Admin).
//
// Next.js inlines every NEXT_PUBLIC_* env var into the client bundle for any
// module in the client graph that reads it. A secret-shaped NEXT_PUBLIC_* var
// (the backend master API key, a JWT/session secret, a bearer token, a
// password) therefore ships to every browser the moment one client module
// touches it. This guard fails the build if such a name reappears, either as
// an assignment in an .env* file or as a `process.env.NEXT_PUBLIC_*` read in
// src/. The backend key must live ONLY under a non-public name
// (BACKEND_API_KEY) consumed server-side by /api/proxy + /api/login.
//
// Run: node scripts/check-no-public-secrets.mjs  (npm run check:no-public-secrets)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Secret-shaped substrings. Any NEXT_PUBLIC_ var whose name contains one of
// these is treated as a leaked secret unless explicitly allowlisted below.
const SECRET_TOKENS = ["KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL"];

// Names that legitimately carry a "secret-shaped" word but are public client
// identifiers by design (Google's Firebase web API key is a public project
// identifier, not a credential — see PLATFORM_AUDIT §4 B#6, tracked separately).
// Keep this list TIGHT: only known-public client config belongs here.
const ALLOWLIST_PREFIXES = ["NEXT_PUBLIC_FIREBASE_"];

const NAME_RE = /NEXT_PUBLIC_[A-Z0-9_]+/g;

function isSecretShaped(name) {
  if (ALLOWLIST_PREFIXES.some((p) => name.startsWith(p))) return false;
  return SECRET_TOKENS.some((t) => name.includes(t));
}

const violations = [];

function record(file, line, name, kind) {
  violations.push({
    file: path.relative(root, file),
    line,
    name,
    kind,
  });
}

// ---- 1. Scan .env* files for secret-shaped NEXT_PUBLIC_* assignments --------
function scanEnvFiles() {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(".env")) continue;
    const filePath = path.join(root, entry.name);
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    lines.forEach((raw, idx) => {
      const text = raw.trim();
      if (!text || text.startsWith("#")) return; // skip blanks + comments
      const eq = text.indexOf("=");
      if (eq === -1) return;
      const name = text.slice(0, eq).trim();
      if (name.startsWith("NEXT_PUBLIC_") && isSecretShaped(name)) {
        record(filePath, idx + 1, name, "env-assignment");
      }
    });
  }
}

// ---- 2. Scan src/ for `process.env.NEXT_PUBLIC_*` secret reads --------------
const SRC_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
// Matches `process.env.NEXT_PUBLIC_FOO` and `process.env["NEXT_PUBLIC_FOO"]`.
const READ_RE =
  /process\.env(?:\.|\[\s*["'])\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*["']?\s*\]?/g;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (SRC_EXTS.has(path.extname(entry.name))) {
      scanSourceFile(full);
    }
  }
}

function scanSourceFile(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line, idx) => {
    let m;
    READ_RE.lastIndex = 0;
    while ((m = READ_RE.exec(line)) !== null) {
      const name = m[1];
      if (isSecretShaped(name)) {
        record(filePath, idx + 1, name, "src-read");
      }
    }
  });
}

scanEnvFiles();
const srcDir = path.join(root, "src");
if (fs.existsSync(srcDir)) walk(srcDir);

// ---- Report -----------------------------------------------------------------
if (violations.length > 0) {
  console.error(
    "check-no-public-secrets: secret-shaped NEXT_PUBLIC_* var(s) found.\n" +
      "Next.js inlines NEXT_PUBLIC_* into the client bundle — these would ship\n" +
      "to the browser. Move the value to a non-public name (e.g. BACKEND_API_KEY)\n" +
      "read only in server code (route handlers / tsx scripts).\n",
  );
  for (const v of violations) {
    const how =
      v.kind === "env-assignment"
        ? "assigned in env file"
        : "read via process.env in source";
    console.error(`  ${v.file}:${v.line}  ${v.name}  (${how})`);
  }
  console.error(
    `\n${violations.length} violation(s). If a name is a genuinely public ` +
      "client identifier, add its prefix to ALLOWLIST_PREFIXES in this script.",
  );
  process.exitCode = 1;
} else {
  console.log(
    "check-no-public-secrets OK: no secret-shaped NEXT_PUBLIC_* vars in .env* or src/.",
  );
}
