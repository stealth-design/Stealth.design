import type { MetadataRoute } from "next";

/**
 * Robots policy.
 *
 * Disallow everything for this build. The site is a placeholder proving the
 * ingestion-to-publication pipeline, and letting a crawler index a wall of
 * other people's screenshots is a decision for whoever deploys it — not a
 * default this repository should make on their behalf. Change this deliberately,
 * alongside a rights review.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
