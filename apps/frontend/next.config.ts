import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { NextConfig } from "next";

/**
 * Load the repository-root `.env`.
 *
 * Next only looks for `.env` beside the app, and this is a monorepo with one
 * env file at the root — so without this the frontend would silently fall back
 * to its defaults and `PUBLIC_API_BASE_URL` would be inert configuration.
 *
 * Done here rather than through `@uxd/shared` on purpose: this app's runtime
 * dependency list is exactly one package (`@uxd/api/client`), which is what
 * makes "the frontend cannot reach the database" a checkable property rather
 * than a claim. A build-time env loader is not worth widening it for, and
 * `process.loadEnvFile` is built into Node.
 *
 * `next.config.ts` runs in the same process as the server, so the variables it
 * loads are visible to the app at request time too.
 */
function loadRootEnv(): void {
  let directory = resolve(process.cwd());
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // A malformed file is not worth failing the build over; the schema
        // reports bad values at startup.
      }
      return;
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

loadRootEnv();

/**
 * Public site configuration.
 *
 * Deliberately minimal. This app has no database driver, no object-storage
 * client and no native dependencies, so it needs no `serverExternalPackages` —
 * a fact the `frontend-has-no-database` boundary check enforces rather than
 * merely documents.
 */

/**
 * Origins this site may load images from, derived from configuration.
 *
 * Screenshots do not come from this origin. They come from wherever the CMS
 * serves media — its own public media route in development, an S3 bucket or a
 * CDN in production — and the CSP has to name that origin or every image on
 * the site is blocked with no visible error beyond a console entry.
 *
 * Derived rather than hardcoded, and derived from the *same* variables the
 * runtime uses, so a deployment that moves the API or the CDN does not also
 * need someone to remember this file. §37: no hardcoded URLs.
 */
function imageOrigins(): string[] {
  const origins = new Set<string>(["'self'", "data:"]);

  for (const value of [process.env.PUBLIC_API_BASE_URL, process.env.STORAGE_PUBLIC_BASE_URL]) {
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // A malformed URL is the env schema's problem to report, not this
      // file's. Skipping it here means a bad value costs images, not a build.
    }
  }

  // In production, media is served over HTTPS from a bucket or CDN whose
  // origin may not be known at build time (a preview deployment, a
  // multi-region CDN). `https:` covers those without opening the door to
  // plaintext. Development gets the explicit localhost origin above instead.
  if (process.env.NODE_ENV === "production") origins.add("https:");

  return [...origins];
}

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },

  /**
   * Security headers.
   *
   * Stricter than the CMS's in the clause that matters: `connect-src 'self'`
   * and no `unsafe-eval`.
   *
   * `frame-ancestors 'none'` is deliberate even for a public site. Nothing
   * here is designed to be embedded, and an embeddable page of other people's
   * screenshots is an invitation to present their work as your own.
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
              // Next's runtime is inline.
              //
              // `unsafe-eval` is added in development only, and only because
              // React's development build genuinely uses `eval()` for its
              // debugging features (reconstructing call stacks across
              // environments). Without it every page logs a CSP violation and
              // the error overlay degrades. Production ships React's
              // production build, which never calls `eval()`, so the
              // production policy stays strict — which is the whole reason to
              // make this conditional rather than just adding it.
              process.env.NODE_ENV === "production"
                ? "script-src 'self' 'unsafe-inline'"
                : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              `img-src ${imageOrigins().join(" ")}`,
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
