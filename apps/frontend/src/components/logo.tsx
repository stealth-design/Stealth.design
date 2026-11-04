/**
 * The Stealth.design mark.
 *
 * Drawn for the old name (UX Disrupt), kept until the new mark is decided.
 *
 * ## What it is
 *
 * A 2×2 grid of tiles with the top-right one displaced and rotated out of
 * alignment.
 *
 * The concept is doing two jobs at once, which is why it was worth drawing
 * rather than setting the name in a typeface. The site *is* a grid of captured
 * screens, so a grid is a picture of the product. And the name is "disrupt", so
 * a cell breaking out of that grid is a picture of the word. Neither reading
 * needs explaining, and the mark means something at both.
 *
 * ## Why the displaced tile is the one coloured thing
 *
 * The site's whole visual argument is that the chrome should be near-monochrome
 * because the screenshots carry all the colour. So an accent in the header
 * needs to earn its place, and this one does: drawn in monochrome, the
 * displacement stops being legible at 16px — you have to look for it. The
 * colour is what makes the idea survive the favicon.
 *
 * ## Sizes
 *
 * Drawn on a 24-unit grid and tested at 48, 16 and 12px. `currentColor` for the
 * three settled tiles so it inherits the theme; the accent is explicit, because
 * it is a fixed part of the mark rather than a themed surface.
 */

export function LogoMark({
  size = 22,
  className,
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* The three tiles still in the grid. */}
      <rect x="2" y="2" width="9" height="9" rx="2" fill="currentColor" />
      <rect x="2" y="13" width="9" height="9" rx="2" fill="currentColor" />
      <rect x="13" y="13" width="9" height="9" rx="2" fill="currentColor" />
      {/* The one that left. Rotated about its own centre, then nudged up and
          right, so it reads as having escaped rather than as a drawing error. */}
      <g transform="translate(1.8 -1.6) rotate(20 17.5 6.5)">
        <rect x="13" y="2" width="9" height="9" rx="2" fill="var(--brand)" />
      </g>
    </svg>
  );
}

/** Mark plus wordmark. */
export function Logo({
  size = 22,
  showWordmark = true,
  className,
}: {
  size?: number;
  showWordmark?: boolean;
  className?: string;
}) {
  return (
    <span className={`flex shrink-0 items-center gap-2 ${className ?? ""}`}>
      <LogoMark size={size} />
      {showWordmark ? (
        <span className="text-[22px] leading-none font-semibold tracking-[-0.05em]">
          Stealth.design
        </span>
      ) : null}
    </span>
  );
}

/**
 * The stealth wordmark, the logo in the header.
 *
 * Drawn from `public/brand/stealth-wordmark.png` used as a mask, so the
 * letters take the current text colour: black in light mode, white in dark,
 * from one file. The proportions are the file's own (1030 × 221).
 */
export function Wordmark({
  height = 20,
  className,
}: {
  height?: number | string;
  className?: string;
}) {
  const mask =
    "url(/brand/stealth-wordmark.png) left center / contain no-repeat";
  return (
    <span
      aria-hidden
      className={`block shrink-0 bg-current ${className ?? ""}`}
      style={{ height, aspectRatio: "1030 / 221", mask, WebkitMask: mask }}
    />
  );
}
