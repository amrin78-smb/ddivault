'use client';

import { Suspense, useEffect } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams, useRouter } from 'next/navigation';

function SSOHandler() {
  const params = useSearchParams();
  const router = useRouter();
  const token  = params.get('token');
  const hub    = process.env.NEXT_PUBLIC_NETVAULT_HUB_URL || 'http://192.168.6.111:3000';

  useEffect(() => {
    if (!token) {
      window.location.href = `${hub}/login`;
      return;
    }
    // Exchange SSO token for local session
    fetch(`${hub}/api/auth/sso-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(r => r.json())
      .then(async data => {
        if (data.email && data.ssoPassword) {
          const result = await signIn('credentials', {
            email:    data.email,
            password: data.ssoPassword,
            redirect: false,
          });
          if (result?.ok) router.replace('/');
          else window.location.href = `${hub}/login`;
        } else {
          window.location.href = `${hub}/login`;
        }
      })
      .catch(() => { window.location.href = `${hub}/login`; });
  }, [token]);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#0f172a', flexDirection: 'column', gap: 16,
    }}>
      <div style={{ width: 40, height: 40, border: '3px solid #C8102E', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <div style={{ color: '#94a3b8', fontSize: 14 }}>Signing you in to DDIVault...</div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function SSOPage() {
  return (
    <Suspense>
      <SSOHandler />
    </Suspense>
  );
}
