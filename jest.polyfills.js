/* eslint-disable @typescript-eslint/no-require-imports */
// Jest polyfills that MUST run before test-framework modules (including
// @testing-library/jest-dom and undici) are imported. Configured via
// `setupFiles` (not `setupFilesAfterEach`) so it executes before the
// test framework installs its module cache.
//
// Loaded order:
//   1. jest.polyfills.js (this file) — no static imports so nothing hoists.
//   2. jest.setup.ts     — imports from undici, which by now sees the
//                          TextDecoder/TextEncoder/Blob globals it needs.

const { TextDecoder, TextEncoder } = require('node:util');
const { Blob } = require('node:buffer');
const { ReadableStream, WritableStream, TransformStream } = require('node:stream/web');
const { MessageChannel, MessagePort } = require('node:worker_threads');

if (typeof globalThis.TextEncoder === 'undefined') {
  Object.defineProperty(globalThis, 'TextEncoder', {
    value: TextEncoder, writable: true, configurable: true,
  });
}
if (typeof globalThis.TextDecoder === 'undefined') {
  Object.defineProperty(globalThis, 'TextDecoder', {
    value: TextDecoder, writable: true, configurable: true,
  });
}
// jsdom ships a minimal Blob that lacks `.arrayBuffer()` / `.text()`.
// Prefer Node's Buffer.Blob if anything richer isn't already installed.
const existingBlob = globalThis.Blob;
const needsBlob =
  typeof existingBlob === 'undefined' ||
  typeof existingBlob.prototype?.arrayBuffer !== 'function';
if (needsBlob) {
  Object.defineProperty(globalThis, 'Blob', {
    value: Blob, writable: true, configurable: true,
  });
}
for (const [name, impl] of Object.entries({
  ReadableStream, WritableStream, TransformStream, MessageChannel, MessagePort,
})) {
  if (typeof globalThis[name] === 'undefined') {
    Object.defineProperty(globalThis, name, { value: impl, writable: true, configurable: true });
  }
}
