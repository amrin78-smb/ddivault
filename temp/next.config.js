/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          // Proxy /api/* to Express on 3007
          // Exclude: /api/auth/* (NextAuth) and /api/sso (SSO proxy)
          source: '/api/:path((?!auth|sso).*)',
          destination: 'http://127.0.0.1:3007/api/:path*',
        },
      ],
      fallback: [],
    };
  },
};

module.exports = nextConfig;
