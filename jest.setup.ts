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
