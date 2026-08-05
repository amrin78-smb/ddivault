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
import { CORNERS_INIT_SCRIPT } from '@/lib/corners';

export const metadata: Metadata = {
  title: 'DDIVault — DNS · DHCP · IPAM',
  description: 'DNS, DHCP, and IP Address Management monitoring for NocVault',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* No-flash corner style: sets data-corners on <html> synchronously, before
            first paint, so a square-corner user never sees a rounded frame flash.
            Must stay a blocking inline <script> in <head> — moving it into a
            useEffect (as the theme currently does) reintroduces the flash. */}
        <script dangerouslySetInnerHTML={{ __html: CORNERS_INIT_SCRIPT }} />
      </head>
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
