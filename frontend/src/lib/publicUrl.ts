import { NextRequest } from 'next/server'

// Derives the origin (scheme + host) DDIVault should use to build a redirect/
// fetch URL to the NocVault hub, from the CURRENT REQUEST instead of a static
// env var baked in at install time. This means hub links keep working if a
// customer starts reaching the suite via a different hostname (e.g. local DNS
// `nocvault.thaiunion.com` instead of the install-time IP) — same server, same
// ports, just a friendlier name. `legacyFallback` (the old env-var chain) is
// used ONLY when the incoming request doesn't carry a usable Host, so behavior
// is never worse than before this change.
//
// Local copy of the identical helper in the netvault repo's lib/publicUrl.ts
// (this repo doesn't share code with netvault).
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

export function resolveOrigin(req: NextRequest, port: number | null, legacyFallback: string): string {
  const rawHost = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const hostname = rawHost.split(':')[0].trim()
  const proto = (req.headers.get('x-forwarded-proto') || req.nextUrl.protocol.replace(':', '') || 'http')
    .split(',')[0]
    .trim()

  if (hostname && hostname.length <= 253 && HOSTNAME_RE.test(hostname) && (proto === 'http' || proto === 'https')) {
    return `${proto}://${hostname}${port ? ':' + port : ''}`
  }
  return legacyFallback
}
