// Client-side hub URL resolver — derives the NocVault hub origin from the
// browser's own address bar (same server, same ports — just whatever hostname
// the user is currently using, IP or local-DNS name), instead of a static
// build-time env var baked in at install time. Falls back to the env var only
// when there is no `window` (SSR render pass), matching the pre-existing
// fallback behavior.
export function getHubUrl(): string {
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3000`
  }
  return process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000'
}
