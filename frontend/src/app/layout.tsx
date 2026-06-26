import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/AuthProvider';
import { RBACProvider } from '@/components/RBACContext';
import { ThemeProvider } from '@/components/ThemeContext';
import { ToastProvider } from '@/components/Toast';
import { FetchInterceptor } from '@/components/FetchInterceptor';
import { IdleTimeout } from '@/components/IdleTimeout';
import { AuditActor } from '@/components/AuditActor';
import { LicenseProvider, LicenseGate } from '@/components/LicenseGuard';

export const metadata: Metadata = {
  title: 'DDIVault — DNS · DHCP · IPAM',
  description: 'DNS, DHCP, and IP Address Management monitoring for NocVault',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AuthProvider>
          <RBACProvider>
            <AuditActor />
            <IdleTimeout />
            <ThemeProvider>
              <ToastProvider>
                <FetchInterceptor />
                <LicenseProvider>
                  {/* LicenseGate hard-blocks EVERY route (incl. /sso) with the
                      full-screen lock when the license is disabled/unlicensed —
                      not just a banner with the app usable behind it. */}
                  <LicenseGate>
                    {children}
                  </LicenseGate>
                </LicenseProvider>
              </ToastProvider>
            </ThemeProvider>
          </RBACProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
