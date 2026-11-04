/**
 * The UX Disrupt mark, for the CMS.
 *
 * Duplicated from the public site rather than shared through a package, and
 * that is deliberate. Putting it in `@uxd/shared` would give the CMS a UI
 * dependency in a package the *worker* also imports, and the worker having a
 * transitive React dependency is exactly the kind of creep the boundary checks
 * exist to prevent. A twenty-line SVG in two places is the cheaper price.
 *
 * Same geometry as `apps/frontend/src/components/logo.tsx` — see there for
 * what the mark means.
 */

export function LogoMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect x="2" y="2" width="9" height="9" rx="2" fill="currentColor" />
      <rect x="2" y="13" width="9" height="9" rx="2" fill="currentColor" />
      <rect x="13" y="13" width="9" height="9" rx="2" fill="currentColor" />
      <g transform="translate(1.8 -1.6) rotate(20 17.5 6.5)">
        <rect x="13" y="2" width="9" height="9" rx="2" fill="var(--color-accent)" />
      </g>
    </svg>
  );
}

/** Mark plus wordmark, matching the public site's header. */
export function Logo({ size = 17 }: { size?: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-ink-900">
      <LogoMark size={size} />
      <span className="text-[13px] leading-none font-medium tracking-[-0.01em]">UX Disrupt</span>
    </span>
  );
}
