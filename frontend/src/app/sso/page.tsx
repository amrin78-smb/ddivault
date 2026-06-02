'use client';

import { Suspense, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams, useRouter } from 'next/navigation';

function SSOHandler() {
  const params  = useSearchParams();
  const router  = useRouter();
  const token   = params.get('token');
  const hub     = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
  const [status, setStatus] = useState('Verifying token...');
  const [error,  setError]  = useState('');

  useEffect(() => {
    if (!token) {
      setError('No token in URL');
      setTimeout(() => {
        window.location.href = `${hub}/login?callbackUrl=%2Fapi%2Fsso%2Fddivault`;
      }, 2000);
      return;
    }

    async function doSSO() {
      try {
        // Step 1 — verify token via our server-side proxy (avoids CORS)
        setStatus('Verifying token...');
        const verifyRes = await fetch('/api/sso', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ token }),
        });

        if (!verifyRes.ok) {
          const err = await verifyRes.json();
          throw new Error(err.error || `Verify failed: ${verifyRes.status}`);
        }

        const data = await verifyRes.json();
        if (!data.email) throw new Error('No email returned from sso-verify');

        // Step 2 — create NextAuth session
        setStatus('Creating session...');
        const result = await signIn('credentials', {
          email:    data.email,
          token:    token,
          redirect: false,
        });

        if (result?.ok) {
          setStatus('Success! Redirecting...');
          router.replace('/');
        } else {
          throw new Error(`Session creation failed: ${result?.error || 'unknown'}`);
        }

      } catch (err: any) {
        console.error('[SSO] Error:', err.message);
        setError(err.message);
        setTimeout(() => {
          window.location.href = `${hub}/login?callbackUrl=%2Fapi%2Fsso%2Fddivault`;
        }, 3000);
      }
    }

    doSSO();
  }, [token]);

  return (
    <div style={{
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      height:         '100vh',
      background:     '#0f172a',
      flexDirection:  'column',
      gap:            16,
    }}>
      {!error ? (
        <>
          <div style={{
            width:          40,
            height:         40,
            border:         '3px solid #C8102E',
            borderTopColor: 'transparent',
            borderRadius:   '50%',
            animation:      'spin 0.8s linear infinite',
          }} />
          <div style={{ color: '#94a3b8', fontSize: 14 }}>{status}</div>
        </>
      ) : (
        <>
          <div style={{ color: '#dc2626', fontSize: 14, fontWeight: 600 }}>SSO Error</div>
          <div style={{ color: '#94a3b8', fontSize: 12, maxWidth: 400, textAlign: 'center' }}>{error}</div>
          <div style={{ color: '#64748b', fontSize: 11 }}>Redirecting to login...</div>
        </>
      )}
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
