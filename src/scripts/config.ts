export const API_BASE_URL = "https://api.vhhealth.app" as const;
export const API_KEY = (process.env.NEXT_PUBLIC_API_KEY || "") as string;
export const ORIGIN: string =
  process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000";
