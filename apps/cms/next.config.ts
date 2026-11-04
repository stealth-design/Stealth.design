import type { NextConfig } from "next";

/**
 * CMS Next.js configuration.
 *
 * `transpilePackages` is not needed: the workspace packages are built to ESM
 * JavaScript with declarations before the app builds (`tsc -b`), so Next
 * consumes ordinary published-shaped packages.
 */
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Off: every corner is taken — the account menu bottom-left, Save bars and
  // Done buttons on the right — and the badge sat on top of them. Compile and
  // runtime errors still show without it.
  devIndicators: false,

  // `sharp` and `playwright` load native/binary assets that must not be
  // bundled into a server chunk.
  serverExternalPackages: ["sharp", "@aws-sdk/client-s3", "pg"],

  typedRoutes: false,
  // Type errors must fail the build: this app is the control plane, and a
  // type error here is a bug that reaches the database.
  typescript: { ignoreBuildErrors: false },

  /**
   * Security headers for the CMS itself.
   *
   * The CSP is strict but has to allow Next's inline runtime, hence
   * 'unsafe-inline' for style and a nonce-free script policy — tightening that
   * further is a known follow-up (see docs/known-limitations.md). The important
   * clauses here are `frame-ancestors 'none'` (the CMS is never embedded) and
   * `object-src 'none'`.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              // Captured screenshots may be served from object storage or a CDN.
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default config;
