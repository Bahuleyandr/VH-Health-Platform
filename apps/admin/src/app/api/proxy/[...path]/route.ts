// src/app/api/proxy/[...path]/route.ts
import { API_BASE_URL } from "@/lib/api-config";
import {
  requiredProxyPermission,
  checkProxyPermission,
} from "@/lib/proxyPermissions";
import { getVerifiedTokenRole, isSuperAdminRole } from "@/lib/serverTokenRole";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// W5 S4: a tenant override may only ever come from the server-set acting_tenant
// cookie of a verified SUPER_ADMIN — never a raw client header.
const TENANT_OVERRIDE_HEADERS = new Set(["x-tenant-id", "x-tenant-override-reason"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_OVERRIDE_REASON_LEN = 8;

// Allowed API path prefixes — all other paths are rejected.
// This prevents the proxy from being used to reach arbitrary backend endpoints.
const ALLOWED_PATH_PREFIXES = [
  "api/v1/admin/",
  "api/v1/auth/",
  "api/v1/users",
  "api/v1/patients",
  "api/v1/doctors",
  "api/v1/departments",
  "api/v1/appointments",
  "api/v1/pharmacy",
  "api/v1/notifications",
  "api/v1/records",
  "api/v1/staff",
  "api/v1/credentials",
  "api/v1/investigations",
  "api/v1/diagnostic-results",
  "api/v1/sos",
  "api/v1/analytics",
  "api/v1/beds",
  "api/v1/wards",
  "api/v1/devices",
  "api/v1/feedback",
  "api/v1/billing",
  "api/v1/emr/",
  "api/v1/logs/",
  "api/v1/rbac/",
  "api/v1/health-check",
  "api/v1/health/",
  "api/v1/health-records",
  "api/v1/system/",
  "api/v1/config/",
  "api/v1/prescriptions",
  "api/v1/linen-laundry",
  "api/v1/theatre",
  "api/v1/transplant",
  "api/v1/cssd",
  "api/v1/blood-bank",
  "api/v1/cold-chain",
  "api/v1/compliance",
  "api/v1/referrals",
  "api/v1/consent",
  "api/v1/dietary",
  "api/v1/abdm",
  "api/v1/resuscitation",
  "api/v1/radiology",
  "api/v1/radiation-oncology",
  "api/v1/pathology",
  "api/v1/quality",
  "api/v1/dashboards",
  "api/v1/death-certification",
  "api/v1/anesthesia",
  "api/v1/clinical",
  "api/v1/clinical-alerts",
  "api/v1/dialysis",
  "api/v1/icu",
  "api/v1/infection-control",
  "api/v1/oncology",
  "api/v1/lab",
  "api/v1/microbiology",
  "api/v1/nursing-assessments",
  "api/v1/pmjay",
  "api/v1/discharge-summaries",
  "api/v1/insurance",
  "api/v1/maternity",
  "api/v1/pcpndt",
  "api/v1/pharmacy-orders",
  "api/v1/physio",
  "api/v1/productivity",
  "api/v1/staff-messaging",
  "api/v1/stemi-pathway",
  "api/v1/stroke-pathway",
  "api/v1/downtime/reconciliation/",
  "api/v1/debug/",
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
    // The proxy may normalize or omit the body, so let fetch compute this.
    if (k === "content-length") return;
    // W5 S4: never forward a client-supplied tenant override. These are
    // re-attached server-side (below) ONLY for a verified SUPER_ADMIN acting-as.
    if (TENANT_OVERRIDE_HEADERS.has(k)) return;
    out[key] = value;
  });
  return out;
}

// SEC-8: resolve the CSRF origin allowlist at module load. In production we
// REFUSE to fall back to "http://localhost:3000" — a localhost default paired
// with credentialed cookies silently disables CSRF protection on a deployed
// instance. NEXT_PUBLIC_* vars are inlined at build time, so an unset value
// here fails the production build / hard-errors at import rather than shipping
// a wide-open proxy. Dev/test keep the localhost default for convenience.
function resolveAllowedOrigins(): string[] {
  const configured = process.env.NEXT_PUBLIC_ALLOWED_ORIGIN;
  if (!configured || !configured.trim()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NEXT_PUBLIC_ALLOWED_ORIGIN must be set in production — refusing to " +
          "default to localhost (would disable CSRF protection on the proxy).",
      );
    }
    return ["http://localhost:3000"];
  }
  return configured.split(",").map((s) => s.trim()).filter(Boolean);
}

const ALLOWED_ORIGINS = resolveAllowedOrigins();

/**
 * CSRF Origin validation for mutation requests (POST/PUT/PATCH/DELETE).
 *
 * SEC-8: unsafe methods now REQUIRE a valid Origin (or, failing that, a
 * Referer) that matches the allowlist. A missing Origin/Referer is rejected
 * rather than waved through — a forged cross-site form/fetch that omits Origin
 * must not be able to ride the user's auth cookie. GET/HEAD/OPTIONS are exempt
 * (safe methods per RFC 7231).
 */
function validateMutationOrigin(req: NextRequest): NextResponse | null {
  const method = req.method;
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return null;

  const reject = () =>
    NextResponse.json(
      { message: "Forbidden: cross-origin mutation blocked" },
      { status: 403 },
    );

  // Prefer the Origin header; fall back to the Referer's origin for clients
  // that omit Origin on same-origin requests but still send a Referer.
  let candidate = req.headers.get("origin");
  if (!candidate) {
    const referer = req.headers.get("referer");
    if (referer) {
      try {
        candidate = new URL(referer).origin;
      } catch {
        return reject();
      }
    }
  }

  // No Origin and no usable Referer → cannot prove same-origin → reject.
  if (!candidate) return reject();

  if (!ALLOWED_ORIGINS.includes(candidate)) return reject();
  return null;
}

async function handleProxy(req: NextRequest) {
  // CSRF: validate origin on mutation requests
  const csrfError = validateMutationOrigin(req);
  if (csrfError) return csrfError;

  // Validate auth from httpOnly cookie
  const token = req.cookies.get("auth_token")?.value;
  if (!token) {
    return NextResponse.json(
      { message: "Authentication required" },
      { status: 401 },
    );
  }

  const targetUrl = buildTargetUrl(req);

  // Validate the proxy path against allowlist to prevent open relay.
  // Match on segment boundaries, not raw string prefixes, so an entry like
  // "api/v1/users" cannot also authorize a sibling route such as
  // "api/v1/users-internal".
  const path = extractPathSegments(req).join("/");
  const candidate = path.startsWith("api/v1/") ? path : `api/v1/${path}`;
  const isAllowed = ALLOWED_PATH_PREFIXES.some((prefix) => {
    const boundary = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return candidate === prefix || candidate.startsWith(boundary);
  });
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

  // ADM-1: per-admin permission flags are enforced HERE, not just in the nav.
  // A scoped-down ADMIN (admins.permissions) must not retain full role-rank
  // API access through the proxy. See src/lib/proxyPermissions.ts.
  const requiredPermission = requiredProxyPermission(candidate, req.method);
  if (requiredPermission) {
    const verifiedRole = await getVerifiedTokenRole(token);
    const verdict = await checkProxyPermission(
      token,
      verifiedRole,
      requiredPermission,
    );
    if (!verdict.allowed) {
      return NextResponse.json(
        { message: verdict.message ?? "Forbidden" },
        { status: 403 },
      );
    }
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

  // Backend's HTTPS-redirect middleware trips when NODE_ENV=production
  // and this header isn't 'https'. We're always behind TLS one way or
  // another (Cloudflare Tunnel in prod, Tailscale serve in dev), so it's
  // safe + correct to assert this for all server-to-server calls.
  headers["x-forwarded-proto"] = "https";

  // W5 S4: SUPER_ADMIN acting-as-tenant. If the server-set acting_tenant cookie
  // is present AND the bearer is a signature-verified SUPER_ADMIN, translate it
  // into the backend's audited x-tenant-id override. The role check is the trust
  // boundary: a non-super (or forged) token never gets a tenant header attached,
  // and the client could not have set one itself (stripped above). The backend
  // independently re-gates the override on SUPER_ADMIN + reason and audits it.
  const actingRaw = req.cookies.get("acting_tenant")?.value;
  if (actingRaw) {
    const role = await getVerifiedTokenRole(token);
    if (isSuperAdminRole(role)) {
      try {
        const acting = JSON.parse(actingRaw) as { id?: string; reason?: string };
        const reason = typeof acting.reason === "string" ? acting.reason : "";
        if (acting.id && UUID_RE.test(acting.id) && reason.length >= MIN_OVERRIDE_REASON_LEN) {
          headers["x-tenant-id"] = acting.id;
          headers["x-tenant-override-reason"] = reason;
        }
      } catch {
        /* malformed acting_tenant cookie → no override */
      }
    }
  }

  const init: RequestInit = { method, headers };

  // Bodies only for non-GET/HEAD
  if (!["GET", "HEAD"].includes(method)) {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const text = await req.text();
      if (text.length > 0) {
        init.body = text;
      }
      // Ensure content-type is set (normalize to lowercase, no duplicates)
      delete (headers as Record<string,string>)["content-type"];
      (headers as Record<string,string>)["content-type"] = "application/json";
    } else if (
      ct.includes("multipart/form-data") ||
      ct.includes("application/x-www-form-urlencoded")
    ) {
      init.body = await req.formData();
    } else {
      const body = await req.arrayBuffer();
      if (body.byteLength > 0) {
        init.body = body;
      }
    }
  }

  const upstream = await fetch(targetUrl, init);
  const body = await upstream.arrayBuffer();

  const respHeaders = new Headers(upstream.headers);
  HOP_BY_HOP.forEach((h) => respHeaders.delete(h));
  // Upstream bodies may already be decompressed by the runtime fetch layer.
  // Drop encoding/length headers so the browser does not try to decode again.
  respHeaders.delete("content-encoding");
  respHeaders.delete("content-length");

  // ADM-7 (small): prevent the browser and any intermediate cache from storing
  // PHI-bearing API responses. Upstream Cache-Control is overridden here
  // because we cannot guarantee the backend always sends no-store.
  respHeaders.set("Cache-Control", "no-store");

  return new NextResponse(body, {
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
