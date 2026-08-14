// next.config.ts
import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";
import type { Configuration as WebpackConfig } from "webpack";

const uploadSentrySourceMaps = process.env.SENTRY_UPLOAD_SOURCE_MAPS === "true";

const nextConfig: NextConfig = {
  // output: 'standalone' — DO NOT enable on Vercel; use only for self-hosted Docker/Node deployments
  // output: 'standalone',
  reactStrictMode: true,

  // Sets crossorigin="anonymous" on Next scripts
  crossOrigin: "anonymous",

  webpack: (config: WebpackConfig, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        url: require.resolve("url/"),
      };
    }
    return config;
  },

  async headers() {
    const allowedOrigin =
      process.env.NEXT_PUBLIC_ALLOWED_ORIGIN || "http://localhost:3001";
    // Audit finding M9: the Content-Security-Policy is now emitted by
    // src/middleware.ts with a per-request nonce + 'strict-dynamic' and NO
    // 'unsafe-inline'. Keeping a second static CSP here would make browsers
    // enforce the INTERSECTION of both policies and defeat the nonce, so
    // this file intentionally no longer sets one.
    return [
      {
        source: "/api/proxy/:path*",
        headers: [{ key: "Origin", value: allowedOrigin }],
      },
      {
        source: "/:path*",
        headers: [
          // CORS: use specific origin, NOT wildcard (especially with credentials)
          { key: "Access-Control-Allow-Credentials", value: "true" },
          { key: "Access-Control-Allow-Origin", value: allowedOrigin },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET,DELETE,PATCH,POST,PUT,OPTIONS",
          },
          {
            key: "Access-Control-Allow-Headers",
            value:
              "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-api-key, Origin",
          },
          // Security headers
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

// Wrap with Sentry. telemetry:false silences the “Sending telemetry…” build log.
// The sourcemaps block keeps uploads via the plugin and deletes local *.map after.
export default withSentryConfig(nextConfig, {
  org: uploadSentrySourceMaps ? process.env.SENTRY_ORG : undefined,
  project: uploadSentrySourceMaps ? process.env.SENTRY_PROJECT : undefined,
  authToken: uploadSentrySourceMaps ? process.env.SENTRY_AUTH_TOKEN : undefined,

  telemetry: false, // <-- disable Sentry plugin telemetry (quiet builds)

  silent: !process.env.CI,
  widenClientFileUpload: true,
  tunnelRoute: "/monitoring",
  webpack: {
    automaticVercelMonitors: true,
    treeshake: {
      removeDebugLogging: true,
    },
  },

  sourcemaps: {
    deleteSourcemapsAfterUpload: uploadSentrySourceMaps,
  },
});
