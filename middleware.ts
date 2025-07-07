// middleware.ts

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const token = request.cookies.get('auth_token');

  // If no token and user is trying to access a protected route, redirect to login
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

// See "Matching Paths" below to learn more
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - login (the login page itself)
     */
    '/((?!api|_next/static|_next/image|favicon.ico|login).*)',
    '/dashboard/:path*',
    '/users/:path*',
    '/appointments/:path*',
    '/logs/:path*',
  ],
}