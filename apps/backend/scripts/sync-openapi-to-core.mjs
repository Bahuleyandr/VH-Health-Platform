#!/usr/bin/env node
// apps/backend/scripts/sync-openapi-to-core.mjs
// Copies the canonical backend OpenAPI spec into the shared Dart package so the
// vhhealth_core Dart client generator (Phase 4) reads ONE source of truth.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendSpec = resolve(__dirname, '..', 'src', 'docs', 'openapi.json');
const coreSpec = resolve(__dirname, '..', '..', '..', 'packages', 'vhhealth_core', 'swagger', 'openapi.json');

if (!existsSync(backendSpec)) {
  console.error(`Source spec missing: ${backendSpec}`);
  console.error('Generate it first: npm --prefix apps/backend run openapi:generate');
  process.exit(2);
}
mkdirSync(dirname(coreSpec), { recursive: true });
writeFileSync(coreSpec, readFileSync(backendSpec));
console.log(`openapi: synced ${backendSpec} -> ${coreSpec}`);
