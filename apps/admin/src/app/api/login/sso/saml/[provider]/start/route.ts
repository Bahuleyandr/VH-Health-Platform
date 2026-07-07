export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerBackendUrl } from "@/lib/api-config";

function getBrowserBackendUrl() {
  return process.env.NEXT_PUBLIC_API_URL || getServerBackendUrl();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  const host = request.headers.get("host") || "";
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") || "/dashboard";
  const target = new URL(
    `/api/v1/auth/admin/sso/saml/${encodeURIComponent(provider)}/start`,
    getBrowserBackendUrl(),
  );
  target.searchParams.set("admin_host", host);
  target.searchParams.set("returnTo", returnTo);
  target.searchParams.set("deviceType", "web");
  return NextResponse.redirect(target);
}
