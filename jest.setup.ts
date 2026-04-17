import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// TextDecoder / TextEncoder polyfills. jsdom does not expose these; undici
// (which powers the fetch polyfill below) tries to use them at module-load
// time, so they must be wired BEFORE undici is imported.
// ---------------------------------------------------------------------------
import { TextDecoder, TextEncoder } from "node:util";
if (typeof (globalThis as Record<string, unknown>).TextEncoder === "undefined") {
  Object.defineProperty(globalThis, "TextEncoder", { value: TextEncoder, writable: true, configurable: true });
}
if (typeof (globalThis as Record<string, unknown>).TextDecoder === "undefined") {
  Object.defineProperty(globalThis, "TextDecoder", { value: TextDecoder, writable: true, configurable: true });
}

// eslint-disable-next-line import/first
import { fetch, FormData, Headers, Request, Response } from "undici";

// ---------------------------------------------------------------------------
// Fetch API polyfills. jsdom does not expose `Response` / `Request` /
// `Headers` / `fetch` / `FormData`, and the runtime code under test (api-fetch,
// auth-client, etc.) reaches for these globals directly. Node 22 *does* have
// them natively, but jsdom shadows `globalThis` — so we forward undici's
// implementations explicitly. Harmless no-ops if they're already present.
// ---------------------------------------------------------------------------
const fetchGlobals = { fetch, FormData, Headers, Request, Response } as const;
for (const [name, impl] of Object.entries(fetchGlobals)) {
  if (typeof (globalThis as Record<string, unknown>)[name] === "undefined") {
    Object.defineProperty(globalThis, name, {
      value: impl,
      writable: true,
      configurable: true,
    });
  }
}

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
