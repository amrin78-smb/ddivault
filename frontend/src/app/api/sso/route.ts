import { NextRequest, NextResponse } from 'next/server';

const HUB_URL = process.env.NETVAULT_HUB_URL || 'http://localhost:3000';

/**
 * SSO proxy — avoids CORS by making the sso-verify call server-side.
 * Browser calls /api/sso (same origin), this calls NetVault server-to-server.
 */
export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();
    if (!token) {
      return NextResponse.json({ error: 'No token provided' }, { status: 400 });
    }

    const res = await fetch(`${HUB_URL}/api/auth/sso-verify`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token }),
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `sso-verify failed: ${res.status} ${text}` },
        { status: 401 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);

  } catch (err: any) {
    console.error('[SSO Proxy] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
