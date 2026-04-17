// ---------------------------------------------------------------------------
// jsdom 26 (bundled with jest-environment-jsdom 30) does NOT expose the
// fetch API constructors on its window — so `new Response(...)` in test
// code throws "Response is not defined". Polyfill from `undici` which
// ships the spec-compliant WHATWG fetch implementation Node itself uses
// internally.
//
// undici's module-top code touches TextDecoder/TextEncoder/ReadableStream/
// WritableStream/TransformStream/Blob/MessageChannel — all native Node
// features that jsdom's window doesn't always re-expose. We pull them
// from node: built-ins BEFORE loading undici so the require doesn't blow
// up at import time.
// ---------------------------------------------------------------------------
import { TextDecoder, TextEncoder } from "node:util";
import { ReadableStream, TransformStream, WritableStream } from "node:stream/web";
import { Blob } from "node:buffer";
import { MessageChannel, MessagePort } from "node:worker_threads";

type PolyGlobals = Record<string, unknown>;
const _g = globalThis as PolyGlobals;
function maybe(key: string, value: unknown) {
  if (typeof _g[key] === "undefined") _g[key] = value;
}
maybe("TextDecoder", TextDecoder);
maybe("TextEncoder", TextEncoder);
maybe("ReadableStream", ReadableStream);
maybe("WritableStream", WritableStream);
maybe("TransformStream", TransformStream);
maybe("Blob", Blob);
maybe("MessageChannel", MessageChannel);
maybe("MessagePort", MessagePort);

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const undici = require("undici") as {
  fetch: unknown;
  Headers: unknown;
  Request: unknown;
  Response: unknown;
  FormData: unknown;
};
maybe("Response", undici.Response);
maybe("Request", undici.Request);
maybe("Headers", undici.Headers);
maybe("fetch", undici.fetch);
maybe("FormData", undici.FormData);

import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// Mock localStorage (jsdom provides one, but we reset it between tests)
// ---------------------------------------------------------------------------
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => store[key] ?? null),
    setItem: jest.fn((key: string, value: string) => {
      store[key] = String(value);
    }),
    removeItem: jest.fn((key: string) => {
      delete store[key];
    }),
    clear: jest.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: jest.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

Object.defineProperty(window, "localStorage", { value: localStorageMock });

// Reset localStorage mock between tests
beforeEach(() => {
  localStorageMock.clear();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Suppress noisy console output during tests (optional — remove if you want
// to see warnings/errors in test output)
// ---------------------------------------------------------------------------
// jest.spyOn(console, "warn").mockImplementation(() => {});
// jest.spyOn(console, "error").mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Mock react-hot-toast to prevent side-effects in unit tests
// ---------------------------------------------------------------------------
jest.mock("react-hot-toast", () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
    loading: jest.fn(),
  },
}));
