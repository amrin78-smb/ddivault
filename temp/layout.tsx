import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/AuthProvider';
import { ThemeProvider } from '@/components/ThemeContext';
import { ToastProvider } from '@/components/Toast';

export const metadata: Metadata = {
  title: 'DDIVault — DNS · DHCP · IPAM',
  description: 'DNS, DHCP, and IP Address Management monitoring for NocVault',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AuthProvider>
          <ThemeProvider>
            <ToastProvider>
              {children}
            </ToastProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
