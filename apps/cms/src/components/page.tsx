import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * The skeleton every rebuilt screen sits in: a header with the title, an
 * optional line saying what the screen is for and the screen's actions, then
 * the body. One width, one set of gutters, so moving between sections never
 * shifts the page under the eye.
 */
export function Page({
  title,
  description,
  actions,
  back,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** The screen one level up, for screens inside a section. */
  back?: { readonly label: string; readonly href: string };
  children?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 md:px-10">
      {back ? (
        <Link
          href={back.href}
          className="mt-6 inline-flex items-center gap-1.5 text-xs text-ink-500 transition-colors hover:text-ink-900 md:mt-8"
        >
          <ArrowLeft aria-hidden className="size-3" />
          {back.label}
        </Link>
      ) : null}
      <header className={`flex flex-wrap items-end justify-between gap-4 pb-6 ${back ? "pt-3" : "pt-8 md:pt-10"}`}>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-medium tracking-[-0.01em] text-ink-900">{title}</h1>
          {description ? <div className="mt-1 max-w-xl text-[13px] leading-relaxed text-ink-500">{description}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className="pb-16">{children}</div>
    </div>
  );
}

/** What an empty body says: one quiet line, and the action that would fill it. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-ink-200 text-center">
      <p className="text-[13px] text-ink-500">{children}</p>
      {action}
    </div>
  );
}
