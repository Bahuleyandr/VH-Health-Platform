export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerBackendUrl } from "@/lib/api-config";

const SERVER_API_KEY = process.env.BACKEND_API_KEY || process.env.API_KEY || "";

export async function GET(request: Request) {
  try {
    const host = request.headers.get("host") || "";
    const upstream = await fetch(
      `${getServerBackendUrl()}/api/v1/auth/admin/sso/oidc/providers?admin_host=${encodeURIComponent(host)}`,
      {
        headers: {
          "x-forwarded-proto": "https",
          "x-admin-host": host,
          ...(SERVER_API_KEY ? { "x-api-key": SERVER_API_KEY } : {}),
        },
        cache: "no-store",
      },
    );
    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch {
    return NextResponse.json(
      { success: false, message: "SSO discovery unavailable" },
      { status: 502 },
    );
  }
}
