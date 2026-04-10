import { NextResponse } from "next/server";

export async function POST(request: Request) {
  // CSRF Origin validation
  const origin = request.headers.get('origin');
  const allowed = process.env.NEXT_PUBLIC_ALLOWED_ORIGIN || 'http://localhost:3000';
  if (origin) {
    const allowedHosts = allowed.split(',').map((s: string) => s.trim());
    const originHost = new URL(origin).origin;
    const isAllowed = allowedHosts.some((h: string) => {
      if (h === origin) return true;
      if (h.startsWith('https://') && h.endsWith('.vhhealth.app')) {
        return originHost === h;
      }
      return false;
    });
    if (!isAllowed) {
      return NextResponse.json(
        { message: 'Forbidden: Origin not allowed', success: false },
        { status: 403 },
      );
    }
  }

  const response = NextResponse.json({ success: true });

  // Clear the auth cookie
  response.cookies.set("auth_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0, // Expire immediately
  });

  return response;
}
