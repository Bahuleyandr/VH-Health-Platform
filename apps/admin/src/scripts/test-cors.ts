export {};
import { API_BASE_URL, API_KEY, ORIGIN } from "./config";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function check(method: "GET" | "OPTIONS", path: string) {
  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "x-api-key": API_KEY,
      origin: ORIGIN,
    },
  });
  console.log(`  ${method} ${path}: ${res.status} ${res.statusText}`);
}

async function testCORS() {
  console.log("🧪 Testing CORS Configuration\n");
  const paths = ["/admin/health", "/admin/settings"];
  for (const p of paths) {
    for (const m of ["GET", "OPTIONS"] as const) {
      try {
        await check(m, p);
      } catch (e: unknown) {
        console.log(`  ❌ Error: ${getErrorMessage(e)}\n`);
      }
    }
  }
}

testCORS().catch((e) => {
  console.error("Fatal:", getErrorMessage(e));
  process.exitCode = 1;
});
