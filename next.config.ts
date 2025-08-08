// next.config.ts
import type { NextConfig } from 'next';
import type { Configuration as WebpackConfig } from 'webpack';
import { withSentryConfig } from '@sentry/nextjs';
import withPWAInit from '@ducanh2912/next-pwa';

// Only enable PWA in production
const withPWA = withPWAInit({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
  // No deprecated GA runtime caching
  runtimeCaching: [],
  buildExcludes: [/middleware-manifest\.json$/],
});

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? '*'; // set to your site URL if you need credentials

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Adds crossorigin="anonymous" to preload links (ok to keep)
  crossOrigin: 'anonymous',

  webpack: (config: WebpackConfig, { isServer }: { isServer: boolean }) => {
    // Polyfill url for client if needed
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        url: require.resolve('url/'),
      };
    }
    return config;
  },

  // ❌ Remove the /api/proxy rewrite — your Route Handler handles proxying.
  // async rewrites() { return []; },

  async headers() {
    return [
      // Global CORS. If you need credentials (cookies), set FRONTEND_ORIGIN to your exact site.
      {
        source: '/:path*',
        headers:
          FRONTEND_ORIGIN === '*'
            ? [
                // Credentials OFF (valid with *)
                { key: 'Access-Control-Allow-Origin', value: '*' },
                { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT' },
                {
                  key: 'Access-Control-Allow-Headers',
                  value:
                    'X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-api-key',
                },
              ]
            : [
                // Credentials ON (requires explicit origin)
                { key: 'Access-Control-Allow-Origin', value: FRONTEND_ORIGIN },
                { key: 'Access-Control-Allow-Credentials', value: 'true' },
                { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT' },
                {
                  key: 'Access-Control-Allow-Headers',
                  value:
                    'X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-api-key',
                },
              ],
      },

      // ❌ Remove this — you cannot set request header "Origin" via response headers.
      // {
      //   source: '/api/proxy/:path*',
      //   headers: [{ key: 'Origin', value: 'https://vh-health-portal.vercel.app' }],
      // },
    ];
  },
};

const configWithPWA =
  process.env.NODE_ENV === 'production' ? withPWA(nextConfig) : nextConfig;

export default withSentryConfig(configWithPWA, {
  // Sentry upload options
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: '/monitoring',
  hideSourceMaps: true,
  disableLogger: true,
  automaticVercelMonitors: true,
});
