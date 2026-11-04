/**
 * CMS UI primitives.
 *
 * A small, deliberately plain component set, built for consistency and
 * density: one badge, one table, one empty state, used identically on every
 * screen, so an operator learns the interface once. Labels are sentence case
 * and quiet; the values are what an operator came to read.
 *
 * Status colour comes from the `tone` recorded in `@uxd/types` metadata rather
 * than being chosen per screen. That is what keeps "needs review" the same
 * amber everywhere it appears.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import clsx from "clsx";

// --- Tone -----------------------------------------------------------------

export type Tone = "neutral" | "info" | "progress" | "warning" | "success" | "danger";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-[var(--color-tone-neutral-bg)] text-[var(--color-tone-neutral)]",
  info: "bg-[var(--color-tone-info-bg)] text-[var(--color-tone-info)]",
  progress: "bg-[var(--color-tone-progress-bg)] text-[var(--color-tone-progress)]",
  warning: "bg-[var(--color-tone-warning-bg)] text-[var(--color-tone-warning)]",
  success: "bg-[var(--color-tone-success-bg)] text-[var(--color-tone-success)]",
  danger: "bg-[var(--color-tone-danger-bg)] text-[var(--color-tone-danger)]",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-[var(--color-tone-neutral)]",
  info: "bg-[var(--color-tone-info)]",
  progress: "bg-[var(--color-tone-progress)]",
  warning: "bg-[var(--color-tone-warning)]",
  success: "bg-[var(--color-tone-success)]",
  danger: "bg-[var(--color-tone-danger)]",
};

/**
 * A status badge.
 *
 * `title` carries the status's own description from the type metadata, so an
 * operator can hover any status anywhere and get the explanation rather than
 * having to learn the vocabulary from documentation.
 */
export function Badge({
  children,
  tone = "neutral",
  title,
  dot = false,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-[4px] px-1.5 py-0.5 text-2xs font-medium whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      {dot ? <span className={clsx("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} /> : null}
      {children}
    </span>
  );
}

// --- Buttons --------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-ink-900 text-ink-50 hover:bg-ink-950 disabled:bg-ink-300 disabled:text-ink-500",
  secondary:
    "bg-surface text-ink-800 border border-ink-200 hover:border-ink-300 hover:bg-ink-100 disabled:text-ink-400",
  ghost: "text-ink-600 hover:bg-ink-100 hover:text-ink-900 disabled:text-ink-300",
  danger:
    "bg-surface text-[var(--color-tone-danger)] border border-ink-200 hover:border-[var(--color-tone-danger)]/40 hover:bg-[var(--color-tone-danger-bg)]",
};

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors",
        "disabled:cursor-not-allowed",
        size === "sm" ? "h-6 px-2 text-2xs" : "h-8 px-3 text-xs",
        BUTTON_VARIANT[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function LinkButton({
  children,
  href,
  variant = "secondary",
  size = "md",
  className,
}: {
  children: ReactNode;
  href: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors",
        size === "sm" ? "h-6 px-2 text-2xs" : "h-8 px-3 text-xs",
        BUTTON_VARIANT[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}

// --- Page structure -------------------------------------------------------

/**
 * A page header.
 *
 * `description` is not decoration: on an operations tool, saying what a screen
 * is for and what the numbers mean is the difference between a team using it
 * correctly and inventing their own interpretation.
 */
export function PageHeader({
  title,
  description,
  count,
  actions,
  breadcrumb,
}: {
  title: string;
  description?: string;
  count?: string;
  actions?: ReactNode;
  breadcrumb?: { label: string; href: string }[];
}) {
  return (
    <header className="border-b border-ink-200 px-6 pb-5 pt-6">
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-xs text-ink-500">
          {breadcrumb.map((crumb, index) => (
            <span key={crumb.href} className="flex items-center gap-1">
              {index > 0 ? <span aria-hidden className="text-ink-400">/</span> : null}
              <Link href={crumb.href} className="hover:text-ink-900">
                {crumb.label}
              </Link>
            </span>
          ))}
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="truncate text-lg font-medium tracking-[-0.01em] text-ink-900">{title}</h1>
            {count ? <span className="font-mono text-xs text-ink-400">{count}</span> : null}
          </div>
          {description ? (
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-500">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={clsx("overflow-hidden rounded-lg border border-ink-200 bg-surface", className)}>
      {title ? (
        <div className="flex items-center justify-between gap-2 border-b border-ink-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-medium text-ink-900">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-ink-500">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </div>
      ) : null}
      <div className={bodyClassName ?? ""}>{children}</div>
    </section>
  );
}

/**
 * A summary card for the dashboard.
 *
 * `hint` explains what the number means and `href` makes it a way in — a
 * dashboard number that cannot be clicked through to the list it counts is a
 * dead end (§1: a control center, not a showcase).
 */
export function StatCard({
  label,
  value,
  hint,
  tone,
  href,
  secondary,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: Tone;
  href?: string;
  secondary?: string;
}) {
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-ink-500">{label}</span>
        {tone ? <span className={clsx("size-1.5 rounded-full", TONE_DOT[tone])} /> : null}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-2xl tracking-tight text-ink-900">
          {typeof value === "number" ? value.toLocaleString("en-US") : value}
        </span>
        {secondary ? <span className="text-xs text-ink-500">{secondary}</span> : null}
      </div>
      {hint ? <p className="mt-1 text-2xs leading-snug text-ink-500">{hint}</p> : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="block rounded-lg border border-ink-200 bg-surface p-4 transition-colors hover:border-ink-300 hover:bg-ink-100"
      >
        {body}
      </Link>
    );
  }
  return <div className="rounded-lg border border-ink-200 bg-surface p-4">{body}</div>;
}

/**
 * An empty state that says what to do next.
 *
 * "No results" alone is a dead end. Every empty state in this CMS names the
 * action that would fill it, because an operator arriving at an empty screen is
 * usually at the start of a task rather than the end of one.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? <div className="mb-3 text-ink-300">{icon}</div> : null}
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-xs leading-relaxed text-ink-500">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

// --- Data display ---------------------------------------------------------

/** A label/value pair, for detail pages. */
export function Field({
  label,
  children,
  mono = false,
  hint,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="border-b border-ink-200 px-4 py-2.5 last:border-b-0">
      <dt className="text-xs text-ink-500" title={hint}>
        {label}
      </dt>
      <dd className={clsx("mt-0.5 break-words text-[13px] text-ink-900", mono && "mono")}>
        {children ?? <span className="text-ink-400">—</span>}
      </dd>
    </div>
  );
}

export function FieldList({ children }: { children: ReactNode }) {
  return <dl className="divide-y divide-ink-200">{children}</dl>;
}

/** A monospace value with a copy affordance, for IDs, hashes and URLs. */
export function MonoValue({
  value,
  truncate = false,
  title,
}: {
  value: string | null | undefined;
  truncate?: boolean;
  title?: string;
}) {
  if (!value) return <span className="text-ink-400">—</span>;
  return (
    <span
      className={clsx("mono text-ink-700", truncate && "block max-w-full truncate")}
      title={title ?? value}
    >
      {value}
    </span>
  );
}

/**
 * A timestamp.
 *
 * Rendered as an ISO string in the `title` and a short local form as the label,
 * so a scannable "2 Mar" is visible while the exact instant — which matters
 * when comparing two captures — is one hover away.
 */
export function Timestamp({
  value,
  relative = false,
}: {
  value: Date | string | null | undefined;
  relative?: boolean;
}) {
  if (!value) return <span className="text-ink-400">—</span>;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="text-ink-400">—</span>;

  const iso = date.toISOString();
  const label = relative
    ? formatRelative(date)
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });

  return (
    <time dateTime={iso} title={iso} className="whitespace-nowrap text-ink-700">
      {label}
    </time>
  );
}

function formatRelative(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const seconds = Math.round(deltaMs / 1000);
  if (Math.abs(seconds) < 60) return seconds <= 0 ? "just now" : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${days}d ago`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
}

/** Byte size in the largest sensible unit. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value < 10 && exponent > 0 ? value.toFixed(1) : Math.round(value)} ${units[exponent]}`;
}

/**
 * A progress bar built from a job's counters.
 *
 * Segmented by outcome rather than a single percentage, because "80% done" and
 * "80% done, half of it failed" are completely different situations and an
 * operator needs to see which one they have at a glance.
 */
export function ProgressBar({
  total,
  segments,
}: {
  total: number;
  segments: readonly { value: number; tone: Tone; label: string }[];
}) {
  if (total <= 0) {
    return <div className="h-1.5 w-full rounded-full bg-ink-200" />;
  }
  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-ink-200"
      role="img"
      aria-label={segments.map((s) => `${s.label}: ${s.value}`).join(", ")}
    >
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => (
          <div
            key={segment.label}
            className={TONE_DOT[segment.tone]}
            style={{ width: `${(segment.value / total) * 100}%` }}
            title={`${segment.label}: ${segment.value.toLocaleString("en-US")}`}
          />
        ))}
    </div>
  );
}

/** A dense definition row for inline metadata: "12 pages · 4 flows · 2 failed". */
export function InlineMeta({ items }: { items: readonly (string | null | undefined)[] }) {
  const present = items.filter((item): item is string => Boolean(item));
  if (present.length === 0) return null;
  return (
    <span className="text-2xs text-ink-500">
      {present.map((item, index) => (
        <span key={`${item}-${index}`}>
          {index > 0 ? <span aria-hidden className="mx-1 text-ink-300">·</span> : null}
          {item}
        </span>
      ))}
    </span>
  );
}

/** A thumbnail with a stable aspect box, so a grid does not reflow as it loads. */
export function Thumbnail({
  url,
  alt,
  width = 96,
  height = 64,
  fallbackColor,
  className,
}: {
  url: string | null | undefined;
  alt: string;
  width?: number;
  height?: number;
  fallbackColor?: string | null;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-[4px] border border-ink-200 bg-ink-100",
        className,
      )}
      style={{ width, height, backgroundColor: fallbackColor ?? undefined }}
    >
      {url ? (
        // Plain <img>: these are screenshots of arbitrary dimensions served from
        // object storage, and next/image's optimiser would add a proxy hop and a
        // remote-pattern allowlist for no benefit inside an internal tool.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="size-full object-cover object-top"
        />
      ) : (
        <span className="text-2xs text-ink-400">no image</span>
      )}
    </div>
  );
}

/** Section separator inside a scrolling detail column. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="px-4 pb-1 pt-4 text-xs text-ink-500">
      {children}
    </h3>
  );
}

/** A keyboard key, for the shortcut help and inline hints. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-4 items-center justify-center rounded-[4px] border border-ink-300 bg-ink-100 px-1 font-mono text-2xs text-ink-600">
      {children}
    </kbd>
  );
}

/** An inline explanatory note. Used to explain a rule, not to decorate. */
export function Note({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <div
      className={clsx(
        "rounded-[4px] border-l-2 px-2.5 py-1.5 text-xs leading-relaxed",
        TONE_CLASS[tone],
      )}
      style={{ borderLeftColor: `var(--color-tone-${tone})` }}
    >
      {children}
    </div>
  );
}
