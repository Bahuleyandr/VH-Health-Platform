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

class TestMessagePort {
  constructor() {
    this.onmessage = null;
    this._listeners = new Set();
    this._peer = null;
  }

  postMessage(data) {
    const peer = this._peer;
    if (!peer) return;
    setTimeout(() => {
      const event = { data, target: peer, currentTarget: peer };
      peer.onmessage?.(event);
      for (const listener of peer._listeners) {
        listener.call(peer, event);
      }
    }, 0);
  }

  addEventListener(type, listener) {
    if (type === 'message') this._listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === 'message') this._listeners.delete(listener);
  }

  start() {}

  close() {
    this.onmessage = null;
    this._listeners.clear();
    this._peer = null;
  }
}

class TestMessageChannel {
  constructor() {
    this.port1 = new TestMessagePort();
    this.port2 = new TestMessagePort();
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
  }
}

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
  ReadableStream, WritableStream, TransformStream, MessageChannel: TestMessageChannel, MessagePort: TestMessagePort,
})) {
  if (typeof globalThis[name] === 'undefined') {
    Object.defineProperty(globalThis, name, { value: impl, writable: true, configurable: true });
  }
}
