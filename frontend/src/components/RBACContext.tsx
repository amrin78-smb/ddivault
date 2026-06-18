'use client';

import { createContext, useContext, ReactNode } from 'react';
import { useSession } from 'next-auth/react';

type Role = 'super_admin' | 'admin' | 'site_admin' | 'viewer';

interface RBACContextType {
  role: Role;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isSiteAdmin: boolean;
  isViewer: boolean;
  canWrite: boolean;        // admin or super_admin
  canManageSystem: boolean; // super_admin only
  hasRole: (minRole: Role) => boolean;
}

const ROLE_LEVELS: Record<Role, number> = {
  super_admin: 4,
  admin:       3,
  site_admin:  2,
  viewer:      1,
};

const RBACContext = createContext<RBACContextType>({
  role: 'viewer',
  isSuperAdmin: false,
  isAdmin: false,
  isSiteAdmin: false,
  isViewer: true,
  canWrite: false,
  canManageSystem: false,
  hasRole: () => false,
});

/** Normalize any incoming role string to a known Role (legacy 'user' → viewer). */
function normalizeRole(raw: unknown): Role {
  const r = String(raw || '').toLowerCase();
  if (r === 'super_admin' || r === 'admin' || r === 'site_admin' || r === 'viewer') return r as Role;
  return 'viewer';
}

export function RBACProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const role = normalizeRole((session?.user as any)?.role);

  const hasRole = (minRole: Role) =>
    (ROLE_LEVELS[role] || 0) >= (ROLE_LEVELS[minRole] || 0);

  const value: RBACContextType = {
    role,
    isSuperAdmin:    role === 'super_admin',
    isAdmin:         role === 'admin' || role === 'super_admin',
    isSiteAdmin:     role === 'site_admin',
    isViewer:        role === 'viewer',
    canWrite:        hasRole('admin'),
    canManageSystem: role === 'super_admin',
    hasRole,
  };

  return (
    <RBACContext.Provider value={value}>
      {children}
    </RBACContext.Provider>
  );
}

export function useRBAC() {
  return useContext(RBACContext);
}

/**
 * Subtle yellow info banner shown on tabs where the current user has read-only
 * access. By default it renders whenever the user cannot write; pass `show` to
 * override (e.g. only when a tab actually has hidden write controls).
 */
export function ReadOnlyBanner({ show, label }: { show?: boolean; label?: string }) {
  const { canWrite } = useRBAC();
  const visible = show !== undefined ? show : !canWrite;
  if (!visible) return null;
  return (
    <div style={{
      background: '#fefce8', border: '1px solid #fde047', color: '#854d0e',
      padding: '8px 14px', borderRadius: 8, fontSize: 'var(--text-base)', fontWeight: 500,
      display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
    }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      {label || 'You have read-only access to this section'}
    </div>
  );
}

/**
 * Conditionally render children based on role.
 * Usage: <RequireRole role="admin"><DeleteButton /></RequireRole>
 */
export function RequireRole({
  role,
  children,
  fallback = null,
}: {
  role: Role;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const rbac = useRBAC();
  return rbac.hasRole(role) ? <>{children}</> : <>{fallback}</>;
}
