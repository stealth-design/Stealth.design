"use client";

import { ArrowLeft, ArrowRight, Info } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicMedia } from "@uxd/api/client";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { stageSrc, stageSrcSet, thumbSrc } from "@/lib/media";
import { cn } from "@/lib/utils";

/** One screen on the stage. */
export interface Slide {
  readonly id: string;
  readonly href: string;
  /** Lit: usually the product. */
  readonly title: string;
  /** Dim: the screen and its state. */
  readonly subtitle: string | null;
  readonly media: PublicMedia | null;
}

/**
 * The lightbox: one screen on the stage, the rest in a filmstrip below.
 *
 * Two modes. On a screen's own page (`route`), stepping moves to the next
 * screen's URL, so every position is shareable and the back button works.
 * Elsewhere (`local`), stepping only changes what is on the stage, and the
 * caption links through to the screen's page.
 *
 * ← and → step, `i` opens the details when there are any. Keys are ignored
 * while typing in a field, so search is never hijacked.
 */
export function Viewer({
  slides,
  initialIndex = 0,
  mode = "local",
  info,
  infoTitle = "Details",
}: {
  slides: readonly Slide[];
  initialIndex?: number;
  mode?: "local" | "route";
  info?: React.ReactNode;
  infoTitle?: string;
}) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(Math.min(Math.max(initialIndex, 0), Math.max(slides.length - 1, 0)));
  const [infoOpen, setInfoOpen] = useState(false);
  const frameRefs = useRef<(HTMLElement | null)[]>([]);

  const current = slides[index];

  const go = useCallback(
    (next: number) => {
      if (slides.length === 0) return;
      const wrapped = (next + slides.length) % slides.length;
      if (mode === "route") {
        const target = slides[wrapped];
        if (target) router.push(target.href, { scroll: false });
      }
      setIndex(wrapped);
    },
    [mode, router, slides],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        go(index + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(index - 1);
      } else if (event.key.toLowerCase() === "i" && info) {
        setInfoOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, info]);

  // Keep the active frame in view as the stage moves.
  useEffect(() => {
    frameRefs.current[index]?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", inline: "center", block: "nearest" });
  }, [index, reduce]);

  if (!current) return null;

  const counter = `${String(index + 1).padStart(3, "0")} / ${String(slides.length).padStart(3, "0")}`;

  return (
    <div className="mx-auto max-w-[1600px] px-5 md:px-8">
      {/* --- The stage ------------------------------------------------------ */}
      {/* A fixed stage height on desktop, so stepping never moves the
          caption; on a phone the image sets its own height. */}
      <div className="flex items-center justify-center md:h-[min(calc(100svh-15rem),56rem)] md:min-h-[18rem]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.id}
            className="flex w-full items-center justify-center md:h-full"
            initial={reduce ? false : { opacity: 0, scale: 0.995 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {current.media ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={stageSrc(current.media)}
                srcSet={stageSrcSet(current.media)}
                sizes="(max-width: 768px) 100vw, 1500px"
                alt={current.media.altText ?? `Screenshot: ${current.title}`}
                width={current.media.width ?? undefined}
                height={current.media.height ?? undefined}
                className="lit-from-behind h-auto w-full rounded-md object-contain md:max-h-full md:w-auto md:max-w-full"
                fetchPriority="high"
              />
            ) : (
              <div className="flex aspect-[16/10] w-full max-w-4xl items-center justify-center rounded-md bg-shot text-faint">
                No screenshot
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* --- The caption ---------------------------------------------------- */}
      <div className="mt-6 flex items-center gap-4">
        <div className="min-w-0 flex-1 truncate text-[13px]">
          {mode === "local" ? (
            <Link href={current.href} className="group">
              <span className="text-lit">{current.title}</span>
              {current.subtitle ? <span className="text-dim group-hover:text-lit"> — {current.subtitle}</span> : null}
              <span className="ml-2 text-faint group-hover:text-dim">Open ↗</span>
            </Link>
          ) : (
            <>
              <span className="text-lit">{current.title}</span>
              {current.subtitle ? <span className="text-dim"> — {current.subtitle}</span> : null}
            </>
          )}
        </div>
        <span className="num hidden text-[12px] text-faint sm:inline">{counter}</span>
        <div className="flex items-center gap-1">
          <StepButton label="Previous screen" onClick={() => go(index - 1)} disabled={slides.length < 2}>
            <ArrowLeft className="size-4" />
          </StepButton>
          <StepButton label="Next screen" onClick={() => go(index + 1)} disabled={slides.length < 2}>
            <ArrowRight className="size-4" />
          </StepButton>
          {info ? (
            <StepButton label="Details (i)" onClick={() => setInfoOpen(true)}>
              <Info className="size-4" />
            </StepButton>
          ) : null}
        </div>
      </div>

      {/* --- The filmstrip -------------------------------------------------- */}
      {slides.length > 1 ? (
        <div className="no-scrollbar -mx-5 mt-5 overflow-x-auto px-5 md:-mx-8 md:px-8">
          <ol className="flex w-max gap-2 pb-2">
            {slides.map((slide, position) => {
              const active = position === index;
              const frame = (
                <>
                  {slide.media ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbSrc(slide.media)}
                      alt=""
                      loading="lazy"
                      className="aspect-[16/10] h-14 w-auto rounded-[3px] object-cover object-top md:h-16"
                    />
                  ) : (
                    <span className="block aspect-[16/10] h-14 rounded-[3px] bg-shot md:h-16" />
                  )}
                  <span
                    aria-hidden
                    className={cn("mt-1.5 block h-px w-full transition-colors", active ? "bg-brand" : "bg-transparent")}
                  />
                </>
              );
              const className = cn(
                "block transition-opacity duration-200",
                active ? "opacity-100" : "opacity-35 hover:opacity-80",
              );
              return (
                <li key={slide.id} ref={(node) => { frameRefs.current[position] = node; }}>
                  {mode === "route" ? (
                    <Link href={slide.href} scroll={false} className={className} aria-current={active ? "true" : undefined} aria-label={slide.subtitle ?? slide.title} onClick={() => setIndex(position)}>
                      {frame}
                    </Link>
                  ) : (
                    <button type="button" className={className} aria-current={active ? "true" : undefined} aria-label={slide.subtitle ?? slide.title} onClick={() => setIndex(position)}>
                      {frame}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      {info ? (
        <Sheet open={infoOpen} onOpenChange={setInfoOpen}>
          <SheetContent side="right" className="w-full border-l-border bg-background sm:max-w-md">
            <SheetHeader>
              <SheetTitle className="text-[13px] font-normal text-dim">{infoTitle}</SheetTitle>
            </SheetHeader>
            <div className="overflow-y-auto px-4 pb-8">{info}</div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

function StepButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-8 items-center justify-center rounded-md text-dim transition-colors hover:bg-accent hover:text-lit disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
