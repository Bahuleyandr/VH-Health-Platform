// src/lib/normalize-response.ts

/**
 * Shared utility for normalizing API responses into arrays.
 *
 * Many API endpoints return data in different shapes:
 *   - Direct array: [item1, item2, ...]
 *   - Wrapped in envelope: { doctors: [...] }
 *   - Wrapped in data: { data: [...] }
 *   - Wrapped in results: { results: [...] }
 *
 * This utility extracts the array regardless of shape.
 */

function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Create a normalizer function that extracts an array from an API response.
 *
 * @param primaryKey - The primary key to look for in the response object (e.g., "doctors", "users")
 *
 * @example
 * const normalize = normalizeList<Doctor>("doctors");
 * const doctors = normalize(apiResponse); // always returns Doctor[]
 */
export function normalizeList<T>(primaryKey: string) {
  return (resp: unknown): T[] => {
    if (Array.isArray(resp)) return resp as T[];

    if (isObj(resp)) {
      const candidate =
        resp[primaryKey] ?? resp["data"] ?? resp["results"] ?? resp["items"];
      if (Array.isArray(candidate)) return candidate as T[];
    }

    return [];
  };
}
