export const API_BASE_URL = "https://api.vhhealth.app" as const;
// These are tsx CLI probes run server-side only (never bundled for the browser),
// so the backend key is read from the NON-public BACKEND_API_KEY (with the
// legacy API_KEY name as a fallback). It must NEVER be a NEXT_PUBLIC_* var:
// Next.js inlines those into the client bundle, leaking the backend master key.
export const API_KEY = (process.env.BACKEND_API_KEY ||
  process.env.API_KEY ||
  "") as string;
export const ORIGIN: string =
  process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000";
