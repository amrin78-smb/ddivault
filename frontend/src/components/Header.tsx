'use client';
import Image from 'next/image';
import { useTheme } from './ThemeContext';
import { signOut, useSession } from 'next-auth/react';

interface HeaderProps {
  collectorOnline: boolean;
}

export function Header({ collectorOnline }: HeaderProps) {
  const { theme, toggle } = useTheme();
  const { data: session } = useSession();
  const hubUrl = process.env.NEXT_PUBLIC_NETVAULT_HUB_URL || 'http://192.168.6.111:3000';
  const userInitial = session?.user?.name?.[0]?.toUpperCase() || session?.user?.email?.[0]?.toUpperCase() || 'U';

  return (
    <header style={{
      height: 68,
      background: '#1a2744',
      display: 'flex',
      alignItems: 'center',
      padding: '0 20px',
      gap: 16,
      flexShrink: 0,
      boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      zIndex: 100,
    }}>
      {/* Home button */}
      <a
        href={`${hubUrl}/launcher`}
        title="Back to NexVault Hub"
        style={{
          color: 'rgba(255,255,255,0.45)',
          textDecoration: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '4px 6px',
          borderRadius: 6,
          flexShrink: 0,
        }}
        onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
        onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.45)')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          <polyline points="9 22 9 12 15 12 15 22"/>
        </svg>
      </a>

      {/* Logo — bigger, full height */}
      <div style={{ display: 'flex', alignItems: 'center', height: '100%', padding: '8px 0' }}>
        <Image
          src="/logo.png"
          alt="DDIVault"
          width={220}
          height={52}
          style={{ objectFit: 'contain', objectPosition: 'left center' }}
          priority
        />
      </div>

      <div style={{ flex: 1 }} />

      {/* Collector status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={collectorOnline ? 'Collector online' : 'Collector offline'}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: collectorOnline ? '#16a34a' : '#dc2626',
          animation: collectorOnline ? 'pulse 2s infinite' : 'none',
          boxShadow: collectorOnline ? '0 0 6px #16a34a' : 'none',
        }} />
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
          {collectorOnline ? 'Collector' : 'Offline'}
        </span>
      </div>

      {/* Dark mode toggle */}
      <button
        onClick={toggle}
        title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: 'rgba(255,255,255,0.6)', padding: '4px 8px',
          borderRadius: 6, fontSize: 16, display: 'flex', alignItems: 'center',
        }}
      >
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>

      {/* User + sign out */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {session?.user && (
          <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
            {session.user.name || session.user.email}
          </span>
        )}
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: '#C8102E',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontWeight: 700, fontSize: 13, flexShrink: 0,
        }}>
          {userInitial}
        </div>
        <button
          onClick={() => signOut({ callbackUrl: `${hubUrl}/login` })}
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6, color: 'rgba(255,255,255,0.7)',
            padding: '4px 10px', cursor: 'pointer', fontSize: 12,
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
