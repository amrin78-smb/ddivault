'use client';

import { useState, useEffect, createContext, useContext, ReactNode } from 'react';

interface LicenseState {
  mode: 'active' | 'trial' | 'grace' | 'disabled' | 'unreachable' | 'unknown';
  canWrite: boolean;
  canRead: boolean;
  disabled: boolean;
}
interface LicenseInfo {
  status: string;
  daysRemaining: number;
  customer: string;
  expiry: string;
  trialDaysTotal?: number;
}
interface LicenseContextType {
  license: LicenseInfo | null;
  state: LicenseState;
  loading: boolean;
}

const LicenseContext = createContext<LicenseContextType>({
  license: null,
  state: { mode: 'unknown', canWrite: true, canRead: true, disabled: false },
  loading: true,
});

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [state, setState]     = useState<LicenseState>({ mode: 'unknown', canWrite: true, canRead: true, disabled: false });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const check = async () => {
      try {
        const res  = await fetch('/api/license-status');
        const data = await res.json();
        setLicense(data.license);
        setState(data.state);
      } catch {
        setState({ mode: 'unreachable', canWrite: true, canRead: true, disabled: false });
      } finally {
        setLoading(false);
      }
    };
    check();
    const interval = setInterval(check, 6 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <LicenseContext.Provider value={{ license, state, loading }}>
      {children}
    </LicenseContext.Provider>
  );
}

export function useLicense() {
  return useContext(LicenseContext);
}

export function LicenseBanner() {
  const { license, state } = useLicense();
  if (!license || state.mode === 'active') {
    // still allow the "expiring soon" warning for active licenses below
    if (!license || (state.mode === 'active' && license.daysRemaining > 30)) return null;
  }
  const hubUrl = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';

  const banners: Record<string, { bg: string; text: string; message: string }> = {
    trial: {
      bg: '#1d4ed8', text: '#fff',
      message: `Trial license — ${license.daysRemaining} day${license.daysRemaining !== 1 ? 's' : ''} remaining. Activate a full license to continue using DDIVault.`,
    },
    grace: {
      bg: '#b45309', text: '#fff',
      message: `License expired — ${Math.abs(license.daysRemaining)} day${Math.abs(license.daysRemaining) !== 1 ? 's' : ''} into grace period. Write operations disabled. Renew now to restore full access.`,
    },
    disabled: {
      bg: '#b91c1c', text: '#fff',
      message: 'DDIVault license has expired and the grace period has ended. Please renew your NocVault license to restore access.',
    },
    unreachable: {
      bg: '#374151', text: '#fff',
      message: 'License server unreachable — running in offline mode. Verify NetVault hub is accessible.',
    },
  };
  if (state.mode === 'active' && license.daysRemaining <= 30) {
    banners.expiring = {
      bg: '#92400e', text: '#fff',
      message: `License expires in ${license.daysRemaining} day${license.daysRemaining !== 1 ? 's' : ''}. Renew now to avoid service interruption.`,
    };
  }

  const banner = banners[state.mode] || (license.daysRemaining <= 30 ? banners.expiring : null);
  if (!banner) return null;

  return (
    <div style={{
      background: banner.bg, color: banner.text,
      padding: '10px 20px', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between', fontSize: 13, fontWeight: 500,
      flexShrink: 0, zIndex: 100,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>⚠️</span>
        <span>{banner.message}</span>
        {license.customer && (
          <span style={{ opacity: 0.7, marginLeft: 8 }}>· Licensed to: {license.customer}</span>
        )}
      </div>
      <a
        href={`${hubUrl}/settings/license`}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#fff', textDecoration: 'underline', fontSize: 12, whiteSpace: 'nowrap', marginLeft: 16 }}
      >
        Manage License →
      </a>
    </div>
  );
}

export function LicenseDisabledScreen() {
  const hubUrl = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100vh', background: '#f4f6f9',
      gap: 16, padding: 32, textAlign: 'center',
    }}>
      <div style={{ fontSize: 64 }}>🔒</div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: '#0f172a', margin: 0 }}>DDIVault License Expired</h1>
      <p style={{ fontSize: 15, color: '#64748b', maxWidth: 480, margin: 0 }}>
        Your NocVault license has expired and the 30-day grace period has ended.
        Please renew your license to restore access to DDIVault.
      </p>
      <a
        href={`${hubUrl}/settings/license`}
        style={{ background: '#C8102E', color: '#fff', padding: '12px 28px', borderRadius: 8, textDecoration: 'none', fontWeight: 600, fontSize: 15, marginTop: 8 }}
      >
        Renew License at NocVault Hub →
      </a>
      <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>Need help? Contact your NocVault administrator.</p>
    </div>
  );
}
