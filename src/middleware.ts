// src/middleware.ts
import { NextResponse } from 'next/server';

export function middleware() {
  // Add logic here later if needed
  return NextResponse.next();
}

// Keep your matcher if you had one:
export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*'],
};
