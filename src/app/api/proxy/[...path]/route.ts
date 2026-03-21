// src/app/api/proxy/[...path]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { API_BASE_URL } from "@/lib/api-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  const method = req.method;

  const headers = forwardableHeaders(req.headers) as Record<string, string>;

  // Inject the validated token as Authorization header
  headers["Authorization"] = `Bearer ${token}`;

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
