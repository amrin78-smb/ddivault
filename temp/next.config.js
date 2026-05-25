/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          // Proxy /api/* (except /api/auth/*) to Express on port 3007
          source: '/api/:path((?!auth).*)',
          destination: 'http://127.0.0.1:3007/api/:path*',
        },
      ],
      fallback: [],
    };
  },
};

module.exports = nextConfig;
