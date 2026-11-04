import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import clsx from "clsx";

export interface WebsiteRow {
  readonly id: string;
  readonly href: string;
  readonly name: string;
  readonly domain: string | null;
  /** Up to four thumbnails, newest first. */
  readonly thumbnails: readonly (string | null)[];
  /** One quiet line under the name: "Last capture 2h ago". */
  readonly detail: string | null;
  /** The numbers on the right. */
  readonly counts: ReactNode;
}

/**
 * Websites as rows — the front page of the Inbox and of the Library. Every
 * capture belongs to exactly one website, so this is the whole of either,
 * grouped, with nothing counted twice.
 */
export function WebsiteList({ rows }: { rows: readonly WebsiteRow[] }) {
  return (
    <ul className="divide-y divide-ink-200 overflow-hidden rounded-xl border border-ink-200">
      {rows.map((row) => (
        <li key={row.id}>
          <Link
            href={row.href}
            className="group flex flex-col gap-4 p-4 transition-colors hover:bg-ink-100 sm:flex-row sm:items-center"
          >
            <div className="flex shrink-0 gap-1.5">
              {Array.from({ length: 4 }, (_, index) => {
                const url = row.thumbnails[index];
                return (
                  <span
                    key={index}
                    className="relative aspect-[16/10] w-16 overflow-hidden rounded-md border border-ink-200 bg-ink-100 sm:w-20"
                  >
                    {url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={url} alt="" loading="lazy" className="size-full object-cover object-top" />
                    ) : null}
                  </span>
                );
              })}
            </div>

            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2">
                <span className="truncate text-[15px] font-medium text-ink-900">{row.name}</span>
                {row.domain ? <span className="truncate font-mono text-xs text-ink-500">{row.domain}</span> : null}
              </p>
              {row.detail ? <p className="mt-1 text-xs text-ink-500">{row.detail}</p> : null}
            </div>

            <div className="flex items-center gap-4 text-xs">
              {row.counts}
              <ArrowRight
                aria-hidden
                className="hidden size-4 text-ink-400 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-900 sm:block"
              />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A number with a dot and a label: "● 4 to review". */
export function Count({ value, label, dot }: { value: number; label: string; dot: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={clsx("size-1.5 rounded-full", value === 0 ? "bg-ink-300" : dot)} />
      <span className={clsx("font-mono", value === 0 ? "text-ink-400" : "text-ink-900")}>{value}</span>
      <span className="text-ink-500">{label}</span>
    </span>
  );
}
