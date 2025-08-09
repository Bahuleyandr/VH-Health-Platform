// next.config.ts
import withPWAInit from '@ducanh2912/next-pwa';
import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';
import type { Configuration as WebpackConfig } from 'webpack';

const withPWA = withPWAInit({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  // move skipWaiting into Workbox options
  workboxOptions: {
    skipWaiting: true,
    clientsClaim: true,
    // exclude files from precache (replace old buildExcludes)
    exclude: [/middleware-manifest\.json$/],
    // if you use runtime caching, keep it here:
    // runtimeCaching: [],
  },
});

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Sets crossorigin="anonymous" on Next scripts
  crossOrigin: 'anonymous',

  webpack: (config: WebpackConfig, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        url: require.resolve('url/'),
      };
    }
    return config;
  },

  async rewrites() {
    return [
      {
        source: '/api/proxy/:path*',
        destination: 'https://vh-health-backend.onrender.com/api/v1/:path*',
      },
    ];
  },

  async headers() {
    return [
      {
        source: '/api/proxy/:path*',
        headers: [{ key: 'Origin', value: 'https://vh-health-portal.vercel.app' }],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT' },
          {
            key: 'Access-Control-Allow-Headers',
            value:
              'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-api-key, Origin',
          },
        ],
      },
    ];
  },
};

// Only wrap with PWA in production
const configWithPWA = process.env.NODE_ENV === 'production' ? withPWA(nextConfig) : nextConfig;

// Wrap with Sentry and use the modern sourcemaps options
export default withSentryConfig(configWithPWA, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  silent: !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: '/monitoring',
  disableLogger: true,
  automaticVercelMonitors: true,

  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
});
