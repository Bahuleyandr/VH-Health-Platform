// src/middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Client-side authentication check will handle protection
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/login'],
};