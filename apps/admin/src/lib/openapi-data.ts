// Spec-derived type helpers. `paths` comes from the generated (gitignored)
// openapi.generated.ts — run `npm run generate:types` if your editor can't find it.
import type { paths } from "./openapi.generated";

type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** The unwrapped `.data` payload type for a path+method (what getJSON<T> returns). */
export type ApiData<P extends keyof paths, M extends keyof paths[P]> = Ok<
  P,
  M
> extends { data?: infer D }
  ? D
  : never;

/** The request body type for a path+method. */
export type ApiBody<P extends keyof paths, M extends keyof paths[P]> =
  paths[P][M] extends {
    requestBody: { content: { "application/json": infer B } };
  }
    ? B
    : never;
