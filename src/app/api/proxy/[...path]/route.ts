// src/app/api/proxy/[...path]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { API_BASE_URL } from "@/lib/api-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Allowed API path prefixes — all other paths are rejected.
// This prevents the proxy from being used to reach arbitrary backend endpoints.
const ALLOWED_PATH_PREFIXES = [
  "api/v1/admin/",
  "api/v1/auth/",
  "api/v1/users",
  "api/v1/doctors",
  "api/v1/departments",
  "api/v1/appointments",
  "api/v1/pharmacy",
  "api/v1/notifications",
  "api/v1/records",
  "api/v1/staff",
  "api/v1/investigations",
  "api/v1/sos",
  "api/v1/analytics",
  "api/v1/devices",
  "api/v1/feedback",
  "api/v1/billing",
  "api/v1/emr/",
  "api/v1/logs/",
  "api/v1/rbac/",
  "api/v1/health-check",
  "api/v1/health-records",
  "api/v1/system/",
  "api/v1/config/",
];

// Headers that must not be forwarded by proxies
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function extractPathSegments(req: NextRequest): string[] {
  // e.g. /api/proxy/a/b -> ["a","b"]
  const pathname = req.nextUrl.pathname;
  const prefix = "/api/proxy/";
  const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
  return rest.split("/").filter(Boolean);
}

function buildTargetUrl(req: NextRequest): string {
  const base = API_BASE_URL.replace(/\/+$/, "");
  const path = extractPathSegments(req).join("/");
  const search = req.nextUrl.search; // includes leading '?' or ''
  return `${base}/${path}${search}`;
}

function forwardableHeaders(incoming: Headers): HeadersInit {
  const out: Record<string, string> = {};
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    if (k === "host") return;
    out[key] = value;
  });
  return out;
}

async function handleProxy(req: NextRequest) {
  // Validate auth from httpOnly cookie
  const token = req.cookies.get("auth_token")?.value;
  if (!token) {
    return NextResponse.json(
      { message: "Authentication required" },
      { status: 401 },
    );
  }

  const targetUrl = buildTargetUrl(req);

  // Validate the proxy path against allowlist to prevent open relay
  const path = extractPathSegments(req).join("/");
  const isAllowed = ALLOWED_PATH_PREFIXES.some((prefix) =>
    path.startsWith(prefix) || `api/v1/${path}`.startsWith(prefix),
  );
  if (!isAllowed) {
    return NextResponse.json(
      { message: "Proxy path not allowed" },
      { status: 403 },
    );
  }

  // Block path traversal attempts
  if (path.includes("..") || path.includes("//")) {
    return NextResponse.json(
      { message: "Invalid path" },
      { status: 400 },
    );
  }

  const method = req.method;

  const headers = forwardableHeaders(req.headers) as Record<string, string>;

  // Inject the validated token as Authorization header
  headers["Authorization"] = `Bearer ${token}`;

  // Inject API key server-side — never exposed to the client bundle.
  // Prefer BACKEND_API_KEY as the explicit production key name; keep API_KEY
  // as a fallback for older environments.
  const serverApiKey = process.env.BACKEND_API_KEY || process.env.API_KEY || "";
  if (serverApiKey) {
    headers["x-api-key"] = serverApiKey;
  }

  const init: RequestInit = { method, headers };

  // Bodies only for non-GET/HEAD
  if (!["GET", "HEAD"].includes(method)) {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const json = await req.json();
      init.body = JSON.stringify(json);
      if (!("Content-Type" in headers)) {
        headers["Content-Type"] = "application/json";
      }
    } else if (
      ct.includes("multipart/form-data") ||
      ct.includes("application/x-www-form-urlencoded")
    ) {
      init.body = await req.formData();
    } else {
      init.body = await req.arrayBuffer();
    }
  }

  const upstream = await fetch(targetUrl, init);

  const respHeaders = new Headers(upstream.headers);
  HOP_BY_HOP.forEach((h) => respHeaders.delete(h));

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export function GET(req: NextRequest) {
  return handleProxy(req);
}
export function POST(req: NextRequest) {
  return handleProxy(req);
}
export function PUT(req: NextRequest) {
  return handleProxy(req);
}
export function PATCH(req: NextRequest) {
  return handleProxy(req);
}
export function DELETE(req: NextRequest) {
  return handleProxy(req);
}
export function OPTIONS(req: NextRequest) {
  return handleProxy(req);
}
