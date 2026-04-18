// next.config.ts
import { withSentryConfig } from '@sentry/nextjs';
import type { NextConfig } from 'next';
import type { Configuration as WebpackConfig } from 'webpack';

const nextConfig: NextConfig = {
  // output: 'standalone' — DO NOT enable on Vercel; use only for self-hosted Docker/Node deployments
  // output: 'standalone',
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

  async headers() {
    const allowedOrigin = process.env.NEXT_PUBLIC_ALLOWED_ORIGIN || 'http://localhost:3000';
    // unsafe-eval is required in production by Sentry SDK and workbox (PWA service worker)
    // Removing it causes EvalError in prod. It was mistakenly blocked in prod only.
    const scriptSrc = "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
    return [
      {
        source: '/api/proxy/:path*',
        headers: [{ key: 'Origin', value: allowedOrigin }],
      },
      {
        source: '/:path*',
        headers: [
          // CORS: use specific origin, NOT wildcard (especially with credentials)
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: allowedOrigin },
          { key: 'Access-Control-Allow-Methods', value: 'GET,DELETE,PATCH,POST,PUT,OPTIONS' },
          {
            key: 'Access-Control-Allow-Headers',
            value:
              'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-api-key, Origin',
          },
          // Security headers
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              `connect-src 'self' ${process.env.NEXT_PUBLIC_API_URL || 'https://api.vhhealth.app'} ${(process.env.NEXT_PUBLIC_API_URL || 'https://api.vhhealth.app').replace('https://', 'wss://')} https://*.sentry.io`,
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "worker-src 'self' blob:",
              "child-src 'self' blob:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

// Wrap with Sentry. telemetry:false silences the “Sending telemetry…” build log.
// The sourcemaps block keeps uploads via the plugin and deletes local *.map after.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  telemetry: false, // <-- disable Sentry plugin telemetry (quiet builds)

  silent: !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: '/monitoring',
  disableLogger: true,
  automaticVercelMonitors: true,

  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
});
