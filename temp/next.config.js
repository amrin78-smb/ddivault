/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  async rewrites() {
    return [
      { source: '/api/health',             destination: 'http://127.0.0.1:3007/api/health' },
      { source: '/api/dashboard/:path*',   destination: 'http://127.0.0.1:3007/api/dashboard/:path*' },
      { source: '/api/scopes/:path*',      destination: 'http://127.0.0.1:3007/api/scopes/:path*' },
      { source: '/api/leases/:path*',      destination: 'http://127.0.0.1:3007/api/leases/:path*' },
      { source: '/api/events/:path*',      destination: 'http://127.0.0.1:3007/api/events/:path*' },
      { source: '/api/alerts/:path*',      destination: 'http://127.0.0.1:3007/api/alerts/:path*' },
      { source: '/api/alert-rules/:path*', destination: 'http://127.0.0.1:3007/api/alert-rules/:path*' },
      { source: '/api/servers/:path*',     destination: 'http://127.0.0.1:3007/api/servers/:path*' },
      { source: '/api/servers',            destination: 'http://127.0.0.1:3007/api/servers' },
      { source: '/api/settings/:path*',    destination: 'http://127.0.0.1:3007/api/settings/:path*' },
      { source: '/api/settings',           destination: 'http://127.0.0.1:3007/api/settings' },
      { source: '/api/subnets/:path*',     destination: 'http://127.0.0.1:3007/api/subnets/:path*' },
      { source: '/api/subnets',            destination: 'http://127.0.0.1:3007/api/subnets' },
      { source: '/api/dns/:path*',         destination: 'http://127.0.0.1:3007/api/dns/:path*' },
      { source: '/api/dhcp/:path*',        destination: 'http://127.0.0.1:3007/api/dhcp/:path*' },
      { source: '/api/ipam/:path*',        destination: 'http://127.0.0.1:3007/api/ipam/:path*' },
      { source: '/api/sites',              destination: 'http://127.0.0.1:3007/api/sites' },
    ];
  },
};

module.exports = nextConfig;
