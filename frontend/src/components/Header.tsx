'use client';
import Image from 'next/image';
import GlobalSearch from './GlobalSearch';
import { useState, useRef, useEffect } from 'react';
import { useTheme } from './ThemeContext';
import { signOut, useSession } from 'next-auth/react';
import { useRBAC } from '@/components/RBACContext';

interface HeaderProps {
  onNavigate?: (tab: any) => void;
  collectorOnline: boolean;
}

interface AlertItem {
  id: number;
  message: string;
  severity: string;
  scope_id: string;
  fired_at: string;
}

const SEVERITY_COLOR: Record<string, string> = { critical: '#dc2626', warning: '#ca8a04' };

const ROLE_META: Record<string, { label: string; color: string }> = {
  super_admin: { label: 'Super Admin', color: '#C8102E' },
  admin:       { label: 'Admin',       color: '#2563eb' },
  site_admin:  { label: 'Site Admin',  color: '#16a34a' },
  viewer:      { label: 'Viewer',      color: '#64748b' },
};

export function Header(props: HeaderProps) {
  const { collectorOnline, onNavigate } = props;
  const { theme, toggle } = useTheme();
  const { data: session } = useSession();
  const { role } = useRBAC();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [alertTotal, setAlertTotal] = useState(0);
  const dropRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const hubUrl = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

  const userName    = session?.user?.name  || session?.user?.email || 'User';
  const userEmail   = session?.user?.email || '';
  const userInitial = userName[0]?.toUpperCase() || 'U';

  // Poll unacknowledged alerts for the notifications bell
  useEffect(() => {
    const load = () => {
      fetch('/api/alerts?unacked=true&limit=5')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) { setAlerts(d.data || []); setAlertTotal(d.total || 0); } })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropdownOpen(false);
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setNotifOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <header style={{
      height: 'var(--header-height)',
      background: '#1a2744',
      display: 'flex',
      alignItems: 'center',
      padding: '0 24px',
      gap: 20,
      flexShrink: 0,
      boxShadow: '0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.2)',
      zIndex: 100,
      position: 'relative',
    }}>

      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '8px 0' }}>
        <Image
          src="/logo.png"
          alt="DDIVault"
          width={260}
          height={56}
          style={{ objectFit: 'contain', objectPosition: 'left center' }}
          priority
        />
      </div>

      {/* Divider */}
      <div style={{ width: 1, height: 28, background: 'rgba(255,255,255,0.12)', flexShrink: 0 }} />

      {/* App subtitle */}
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em', fontWeight: 500 }}>
        DNS · DHCP · IPAM
      </div>

      {/* Global Search */}
      <GlobalSearch onNavigate={onNavigate} />

      <div style={{ flex: 1 }} />

      {/* Collector status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '5px 12px',
        background: collectorOnline ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.15)',
        borderRadius: 20,
        border: `1px solid ${collectorOnline ? 'rgba(22,163,74,0.3)' : 'rgba(220,38,38,0.3)'}`,
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%',
          background: collectorOnline ? '#16a34a' : '#dc2626',
          boxShadow: collectorOnline ? '0 0 6px #16a34a' : 'none',
          animation: collectorOnline ? 'pulse 2s infinite' : 'none',
        }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: collectorOnline ? '#86efac' : '#fca5a5', letterSpacing: '0.03em' }}>
          {collectorOnline ? 'COLLECTOR' : 'OFFLINE'}
        </span>
      </div>

      {/* Notifications bell */}
      <div ref={bellRef} style={{ position: 'relative' }}>
        <button
          onClick={() => setNotifOpen(o => !o)}
          title="Alerts"
          style={{
            width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: notifOpen ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, cursor: 'pointer',
            color: 'rgba(255,255,255,0.7)', position: 'relative', transition: 'background 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
          onMouseLeave={e => { if (!notifOpen) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          {alertTotal > 0 && (
            <span style={{
              position: 'absolute', top: -4, right: -4, minWidth: 17, height: 17, padding: '0 4px',
              background: '#C8102E', color: '#fff', borderRadius: 9, fontSize: 10, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '2px solid #1a2744', boxShadow: '0 0 0 1px rgba(200,16,46,0.4)',
            }}>
              {alertTotal > 99 ? '99+' : alertTotal}
            </span>
          )}
        </button>

        {notifOpen && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 340,
            background: '#fff', border: '1px solid var(--border)', borderRadius: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.15)', overflow: 'hidden', zIndex: 999, animation: 'fadeIn 0.15s ease',
          }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>Alerts</div>
              <span style={{ fontSize: 11, color: '#64748b' }}>{alertTotal} unacknowledged</span>
            </div>
            {alerts.length === 0 ? (
              <div style={{ padding: '24px 16px', textAlign: 'center', fontSize: 13, color: '#16a34a', fontWeight: 500 }}>
                ✓ No active alerts
              </div>
            ) : (
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {alerts.map(a => (
                  <div key={a.id}
                    onClick={() => { setNotifOpen(false); onNavigate?.('events'); }}
                    style={{ padding: '10px 16px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', display: 'flex', gap: 10 }}
                    onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                    onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
                  >
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_COLOR[a.severity] || '#64748b', marginTop: 5, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, color: '#0f172a', lineHeight: 1.4 }}>{a.message}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                        {a.scope_id ? `${a.scope_id} · ` : ''}{new Date(a.fired_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => { setNotifOpen(false); onNavigate?.('events'); }}
              style={{ width: '100%', padding: '11px 16px', background: '#fff', border: 'none', borderTop: '1px solid #f1f5f9', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#C8102E', textAlign: 'center' }}
              onMouseEnter={e => (e.currentTarget.style.background = '#fef2f2')}
              onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
            >
              View all alerts →
            </button>
          </div>
        )}
      </div>

      {/* Dark mode toggle */}
      <button
        onClick={toggle}
        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        style={{
          width: 36, height: 36,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 8,
          cursor: 'pointer',
          fontSize: 16,
          transition: 'background 0.15s',
          color: 'rgba(255,255,255,0.7)',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>

      {/* User avatar dropdown */}
      <div ref={dropRef} style={{ position: 'relative' }}>
        <button
          onClick={() => setDropdownOpen(p => !p)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: dropdownOpen ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 10,
            padding: '6px 12px 6px 6px',
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
          onMouseLeave={e => { if (!dropdownOpen) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
        >
          {/* Avatar */}
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'linear-gradient(135deg, #C8102E, #a00d24)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontWeight: 700, fontSize: 13,
            flexShrink: 0,
            boxShadow: '0 2px 6px rgba(200,16,46,0.4)',
          }}>
            {userInitial}
          </div>
          <div style={{ textAlign: 'left' }}>
            <div style={{ color: '#fff', fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>
              {userName.split(' ')[0]}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, lineHeight: 1.2 }}>
              {(session?.user as any)?.role || 'admin'}
            </div>
          </div>
          {/* Chevron */}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{
            color: 'rgba(255,255,255,0.4)',
            transform: dropdownOpen ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
            marginLeft: 2,
          }}>
            <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        {/* Dropdown menu */}
        {dropdownOpen && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 8px)', right: 0,
            background: '#fff',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
            minWidth: 220,
            overflow: 'hidden',
            zIndex: 999,
            animation: 'fadeIn 0.15s ease',
          }}>
            {/* User info header */}
            <div style={{ padding: '14px 16px', borderBottom: '1px solid #f1f5f9' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>{userName}</div>
                {(() => {
                  const meta = ROLE_META[role] || ROLE_META.viewer;
                  return (
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 600,
                      color: meta.color,
                      background: meta.color + '1a',
                      whiteSpace: 'nowrap',
                    }}>
                      {meta.label}
                    </span>
                  );
                })()}
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{userEmail}</div>
            </div>

            {/* Menu items */}
            <div style={{ padding: '6px 0' }}>
              <a
                href={`${hubUrl}/launcher`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 16px',
                  color: '#334155', fontSize: 13, fontWeight: 500,
                  textDecoration: 'none',
                  transition: 'background 0.1s',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#64748b' }}>
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                  <polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
                NocVault Hub
              </a>

              <button
                onClick={toggle}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 16px', width: '100%',
                  color: '#334155', fontSize: 13, fontWeight: 500,
                  background: 'none', border: 'none', cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#64748b' }}>
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3"/>
                  <line x1="12" y1="21" x2="12" y2="23"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                  <line x1="1" y1="12" x2="3" y2="12"/>
                  <line x1="21" y1="12" x2="23" y2="12"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                </svg>
                {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
              </button>

              <div style={{ height: 1, background: '#f1f5f9', margin: '4px 0' }} />

              <button
                onClick={async () => {
                  // Get CSRF token first, then sign out, then redirect
                  try {
                    const csrf = await fetch('/api/auth/csrf').then(r => r.json());
                    await fetch('/api/auth/signout', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                      body: `csrfToken=${csrf.csrfToken}`,
                    });
                  } catch (_) {}
                  // Hard redirect — no callbackUrl, goes straight to launcher
                  window.location.replace(`${process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000'}/launcher`);
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 16px', width: '100%',
                  color: '#dc2626', fontSize: 13, fontWeight: 500,
                  background: 'none', border: 'none', cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#fef2f2')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
                Sign Out
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
