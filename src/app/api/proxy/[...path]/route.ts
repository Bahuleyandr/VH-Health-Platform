// src/app/api/proxy/[...path]/route.ts
import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = 'https://vh-health-backend.onrender.com/api/v1';
const API_KEY = 'vhhealth123';

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join('/');
  const url = `${API_BASE_URL}/${path}${request.nextUrl.search}`;
  
  const headers = new Headers(request.headers);
  headers.set('x-api-key', API_KEY);
  headers.set('Origin', 'https://vh-health-portal.vercel.app');
  
  const response = await fetch(url, {
    method: 'GET',
    headers: headers,
  });

  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join('/');
  const url = `${API_BASE_URL}/${path}`;
  
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('x-api-key', API_KEY);
  headers.set('Origin', 'https://vh-health-portal.vercel.app');
  headers.set('Referer', 'https://vh-health-portal.vercel.app');
  
  // Add auth token if present
  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    headers.set('Authorization', authHeader);
  }

  const body = await request.json();
  
  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
  });

  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

// Add similar handlers for PUT, DELETE, PATCH
export async function PUT(request: NextRequest, { params }: { params: { path: string[] } }) {
  // Similar implementation
}

export async function DELETE(request: NextRequest, { params }: { params: { path: string[] } }) {
  // Similar implementation
}