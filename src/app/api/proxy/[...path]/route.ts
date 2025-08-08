// src/app/api/proxy/[...path]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { API_BASE_URL } from '@/lib/api-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// NOTE: params must be REQUIRED (not optional) for Next's type check
type RouteParams = { params: { path: string[] } };

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function buildTargetUrl(req: NextRequest, path: string[]) {
  const pathname = (path ?? []).join('/');
  const search = req.nextUrl.search;
  const base = API_BASE_URL.replace(/\/+$/, '');
  return `${base}/${pathname}${search}`;
}

function forwardableHeaders(incoming: Headers): HeadersInit {
  const out: Record<string, string> = {};
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k) || k === 'host') return;
    out[key] = value;
  });
  return out;
}

async function handleProxy(req: NextRequest, { params }: RouteParams) {
  const targetUrl = buildTargetUrl(req, params.path);
  const method = req.method;
  const headers = forwardableHeaders(req.headers);
  const init: RequestInit = { method, headers };

  if (!['GET', 'HEAD'].includes(method)) {
    const ct = req.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const json = await req.json();
      init.body = JSON.stringify(json);
      if (!('Content-Type' in (headers as Record<string, string>))) {
        (headers as Record<string, string>)['Content-Type'] = 'application/json';
      }
    } else if (
      ct.includes('multipart/form-data') ||
      ct.includes('application/x-www-form-urlencoded')
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

export function GET(req: NextRequest, ctx: RouteParams)   { return handleProxy(req, ctx); }
export function POST(req: NextRequest, ctx: RouteParams)  { return handleProxy(req, ctx); }
export function PUT(req: NextRequest, ctx: RouteParams)   { return handleProxy(req, ctx); }
export function PATCH(req: NextRequest, ctx: RouteParams) { return handleProxy(req, ctx); }
export function DELETE(req: NextRequest, ctx: RouteParams){ return handleProxy(req, ctx); }
export function OPTIONS(req: NextRequest, ctx: RouteParams){ return handleProxy(req, ctx); }
