'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { getHubUrl } from '@/lib/hubUrl';

const HUB_URL = getHubUrl();
const WARNING_MS = 60 * 1000; // show warning 60s before expiry

// Sub-component defined at module scope — never inside the main component (causes remount on every render)
interface WarningModalProps {
  onStay: () => void;
  onSignOut: () => void;
}

function WarningModal(props: WarningModalProps) {
  const { onStay, onSignOut } = props;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100000,
        animation: 'fadeIn 0.15s ease',
      }}
    >
      <div
        style={{
          background: 'var(--bg-card)',
          borderRadius: 8,
          boxShadow: 'var(--shadow-md)',
          padding: 28,
          maxWidth: 420,
          width: '90%',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: 'var(--tint-danger)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px',
          }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="6" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px' }}>
          Session expiring
        </h2>
        <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)', margin: '0 0 24px', lineHeight: 1.5 }}>
          You will be logged out in 60 seconds due to inactivity
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button
            onClick={onStay}
            style={{
              flex: 1,
              padding: '11px 16px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--primary)',
              color: '#fff',
              fontSize: 'var(--text-md)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Stay logged in
          </button>
          <button
            onClick={onSignOut}
            style={{
              flex: 1,
              padding: '11px 16px',
              borderRadius: 8,
              border: '1px solid var(--border, #e2e8f0)',
              background: 'var(--bg-card)',
              color: 'var(--text-secondary)',
              fontSize: 'var(--text-md)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Sign out now
          </button>
        </div>
      </div>
    </div>
  );
}

export function IdleTimeout() {
  const [timeoutMs, setTimeoutMs] = useState<number | null>(null);
  const [showWarning, setShowWarning] = useState(false);

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showWarningRef = useRef(false); // gate activity resets without re-running the timer effect
  const resetTimerRef = useRef<() => void>(() => {}); // exposed so the "Stay logged in" button can re-arm

  // Same sign-out pattern as Header.tsx — do NOT use next-auth signOut() (it appends callbackUrl → auto-SSO loop)
  const signOutNow = useCallback(async () => {
    try {
      const csrf = await fetch('/api/auth/csrf').then(r => r.json());
      await fetch('/api/auth/signout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `csrfToken=${csrf.csrfToken}`,
      });
    } catch (_) {}
    window.location.replace(`${HUB_URL}/login?reason=timeout`);
  }, []);

  // Fetch the configured timeout once on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/hub/settings');
        if (!res.ok) return;
        const settings = await res.json();
        const raw = settings?.['idle_timeout_minutes'];
        if (raw == null || raw === 'never') return;
        const minutes = parseInt(raw, 10);
        if (!minutes || isNaN(minutes) || minutes <= 0) return;
        if (!cancelled) setTimeoutMs(minutes * 60 * 1000);
      } catch (_) {
        // fetch failed — do nothing, no idle timeout enforced
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Arm the idle + warning timers once the timeout is resolved
  useEffect(() => {
    if (timeoutMs == null) return;

    const clearTimers = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    };

    const resetTimer = () => {
      clearTimers();
      showWarningRef.current = false;
      setShowWarning(false);
      warningTimerRef.current = setTimeout(() => {
        showWarningRef.current = true;
        setShowWarning(true);
      }, Math.max(0, timeoutMs - WARNING_MS));
      idleTimerRef.current = setTimeout(() => {
        signOutNow();
      }, timeoutMs);
    };
    resetTimerRef.current = resetTimer;

    const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'scroll'];
    const onActivity = () => {
      // Once the warning is up, only the explicit "Stay logged in" button should reset
      if (!showWarningRef.current) resetTimer();
    };

    events.forEach(ev => window.addEventListener(ev, onActivity, { passive: true }));
    resetTimer();

    return () => {
      clearTimers();
      events.forEach(ev => window.removeEventListener(ev, onActivity));
    };
  }, [timeoutMs, signOutNow]);

  const handleStay = useCallback(() => {
    resetTimerRef.current();
  }, []);

  if (!showWarning) return null;

  return <WarningModal onStay={handleStay} onSignOut={signOutNow} />;
}

export default IdleTimeout;
