// src/app/api/act-as/route.ts
//
// W5 S3 — SUPER_ADMIN "act as tenant" control. A SUPER_ADMIN selects a tenant to
// operate within; this route records it in an httpOnly `acting_tenant` cookie
// that the proxy (W5 S4) translates into the backend's audited x-tenant-id
// override. The cookie is SERVER-SET only after a signature-verified SUPER_ADMIN
// check — a regular ADMIN can never set it, and the browser can't forge it
// (httpOnly). Clearing exits the acting context.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { assertSameOriginOrAllowed } from "@/lib/csrfOrigin";
import { getVerifiedTokenRole, isSuperAdminRole } from "@/lib/serverTokenRole";

const COOKIE = "acting_tenant";
const MIN_REASON_LEN = 8; // matches backend MIN_OVERRIDE_REASON_LEN
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ActingTenant {
  id: string;
  slug: string | null;
  reason: string;
}

function readActing(req: NextRequest): ActingTenant | null {
  const raw = req.cookies.get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ActingTenant>;
    if (parsed && typeof parsed.id === "string" && UUID_RE.test(parsed.id)) {
      return { id: parsed.id, slug: typeof parsed.slug === "string" ? parsed.slug : null, reason: String(parsed.reason ?? "") };
    }
  } catch {
    /* malformed cookie → treat as absent */
  }
  return null;
}

// GET — current acting tenant (or null). Safe method, no CSRF needed.
export function GET(req: NextRequest) {
  return NextResponse.json({ actingTenant: readActing(req) });
}

// POST { tenantId, slug?, reason } — begin acting as a tenant. SUPER_ADMIN only.
export async function POST(req: NextRequest) {
  const csrfError = assertSameOriginOrAllowed(req);
  if (csrfError) return csrfError;

  const role = await getVerifiedTokenRole(req.cookies.get("auth_token")?.value);
  if (!isSuperAdminRole(role)) {
    return NextResponse.json({ message: "Forbidden: SUPER_ADMIN only" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "Invalid JSON body" }, { status: 400 });
  }

  const tenantId = String(body.tenantId ?? "").trim().toLowerCase();
  const slug = body.slug == null ? null : String(body.slug);
  const reason = String(body.reason ?? "").trim();

  if (!UUID_RE.test(tenantId)) {
    return NextResponse.json({ message: "tenantId must be a valid UUID" }, { status: 400 });
  }
  if (reason.length < MIN_REASON_LEN) {
    return NextResponse.json(
      { message: `reason must be at least ${MIN_REASON_LEN} characters` },
      { status: 400 },
    );
  }

  const actingTenant: ActingTenant = { id: tenantId, slug, reason: reason.slice(0, 500) };
  const res = NextResponse.json({ actingTenant });
  res.cookies.set(COOKIE, JSON.stringify(actingTenant), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 4, // 4h — bounded by the admin JWT lifetime
  });
  return res;
}

// DELETE — exit the acting context. Gate on SUPER_ADMIN too (clearing is benign,
// but keep the surface consistent); always clears the cookie regardless.
export async function DELETE(req: NextRequest) {
  const csrfError = assertSameOriginOrAllowed(req);
  if (csrfError) return csrfError;

  const res = NextResponse.json({ actingTenant: null });
  res.cookies.set(COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
