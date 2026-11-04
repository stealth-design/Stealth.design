"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Camera, Monitor, RotateCw, Smartphone, X } from "lucide-react";
import clsx from "clsx";
import { CAPTURE_SESSION_STATUS_META, type CaptureSessionStatus, type SessionCommandPayload } from "@uxd/types";
import { TagPicker, type TagOption } from "@/components/tag-picker";
import { closeSessionAction, setSessionTagsAction } from "@/lib/actions/discovery";
import { useScreenDraft } from "@/lib/use-screen-draft";
import { discardScreenAction } from "@/lib/actions/products";

export interface StudioSession {
  readonly id: string;
  readonly status: CaptureSessionStatus;
  readonly targetUrl: string;
  readonly currentUrl: string | null;
  readonly deviceLabel: string;
  readonly mobile: boolean;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly screensCaptured: number;
  readonly errorMessage: string | null;
  readonly productId: string | null;
  readonly productName: string | null;
  /** The product's website (`notion.com`), which decides where captures go. */
  readonly productSite: string | null;
  readonly flowTitle: string | null;
  readonly flowStepCount: number;
  readonly defaultTermIds: readonly string[];
  readonly dismissConsent: boolean;
}

export interface CapturedScreen {
  readonly id: string;
  readonly name: string;
  readonly stateLabel: string | null;
  /** The product it was filed under, when that is not this session's. */
  readonly filedUnder: string | null;
  readonly thumbnailUrl: string | null;
  readonly discardable: boolean;
  readonly tags: readonly { readonly assignmentId: string; readonly termId: string }[];
}

/**
 * The studio.
 *
 * Left, the live page: a real browser streamed from the worker (Chromium's
 * screencast, relayed by the CMS into the `<img>` below), driven with the
 * mouse and keyboard as any browser is. Right, the capture: what each capture
 * will be called and tagged, the Capture button, and everything captured so
 * far — each one retaggable, each one throwable away.
 *
 * Nothing here publishes. Captures go to the Inbox; Done closes the browser
 * and goes back to the product.
 *
 * Coordinates: points on the displayed frame are scaled back to CSS pixels of
 * the page's own viewport, so a click lands in the same place whatever size
 * the frame is drawn at.
 */
export function Studio({
  session,
  tags,
  screens,
}: {
  session: StudioSession;
  tags: readonly TagOption[];
  screens: readonly CapturedScreen[];
}) {
  const router = useRouter();
  const [status, setStatus] = useState<CaptureSessionStatus>(session.status);
  const [currentUrl, setCurrentUrl] = useState(session.currentUrl ?? session.targetUrl);
  const [urlDraft, setUrlDraft] = useState(session.currentUrl ?? session.targetUrl);
  const [hasFrame, setHasFrame] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [name, setName] = useState("");
  const [stateLabel, setStateLabel] = useState("");
  const [sessionTags, setSessionTags] = useState<string[]>([...session.defaultTermIds]);
  // What the server holds. The chips above can differ until the next Capture,
  // which saves them first — so nothing changes without a button press.
  const savedSessionTags = useRef<string[]>([...session.defaultTermIds]);
  const [dismissConsent, setDismissConsent] = useState(session.dismissConsent);
  const [closing, startClosing] = useTransition();
  const imageRef = useRef<HTMLImageElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const capturedRef = useRef(session.screensCaptured);
  // The capture command in flight, so a failure can be told apart from a
  // capture that is simply still being taken.
  const captureCommandRef = useRef<string | null>(null);
  const pointerRef = useRef({ x: 0, y: 0, inFlight: false, sentAt: 0, queued: false });
  const wheelRef = useRef({ x: 0, y: 0, deltaX: 0, deltaY: 0, inFlight: false });

  const isActive = CAPTURE_SESSION_STATUS_META[status].isActive;
  const pageName = pageNameOf(currentUrl);
  const productHref = session.productId ? `/products/${session.productId}` : "/products";
  // A capture belongs to the website it was taken on. Say so before it
  // happens when the researcher has wandered off this product's site.
  const currentHost = hostOf(currentUrl);
  const elsewhere =
    !session.flowTitle &&
    session.productSite !== null &&
    currentHost !== null &&
    currentHost !== session.productSite &&
    !currentHost.endsWith(`.${session.productSite}`);

  // --- Status: alive?, where is it?, did a capture land? ------------------
  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetch(`/api/studio/${session.id}/status`, { cache: "no-store" });
        if (cancelled || !response.ok) return;
        const next = (await response.json()) as {
          status: CaptureSessionStatus;
          currentUrl: string | null;
          screensCaptured: number;
          recent: { id: string; type: string; status: string; errorMessage: string | null }[];
        };
        setStatus(next.status);
        const pendingCapture = captureCommandRef.current
          ? next.recent.find((command) => command.id === captureCommandRef.current)
          : undefined;
        if (pendingCapture?.status === "failed") {
          captureCommandRef.current = null;
          setCapturing(false);
          setMessage({ text: pendingCapture.errorMessage ?? "That capture didn't save.", tone: "danger" });
        }
        if (next.currentUrl) {
          setCurrentUrl(next.currentUrl);
          if (document.activeElement !== addressRef.current) setUrlDraft(next.currentUrl);
        }
        if (next.screensCaptured > capturedRef.current) {
          capturedRef.current = next.screensCaptured;
          captureCommandRef.current = null;
          setCapturing(false);
          setMessage({ text: "Captured. It's in the Inbox.", tone: "info" });
          router.refresh();
        }
      } catch {
        // A missed status check is replaced a moment later.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session.id, isActive, router]);

  // --- Input ---------------------------------------------------------------
  const postInput = useCallback(
    async (body: unknown): Promise<string | null> => {
      try {
        const response = await fetch(`/api/studio/${session.id}/input`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (response.ok) return null;
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        return payload.error ?? "That didn't reach the browser.";
      } catch {
        return "That didn't reach the browser.";
      }
    },
    [session.id],
  );

  const send = useCallback(
    (payload: SessionCommandPayload) => {
      void postInput({ kind: "command", payload }).then((error) => {
        if (error) setMessage({ text: error, tone: "danger" });
      });
    },
    [postInput],
  );

  const toPage = useCallback(
    (clientX: number, clientY: number) => {
      const image = imageRef.current;
      if (!image) return null;
      const rect = image.getBoundingClientRect();
      if (rect.width === 0) return null;
      const scale = session.viewportWidth / rect.width;
      return {
        x: Math.max(0, Math.min(session.viewportWidth, Math.round((clientX - rect.left) * scale))),
        y: Math.max(0, Math.min(session.viewportHeight, Math.round((clientY - rect.top) * scale))),
      };
    },
    [session.viewportWidth, session.viewportHeight],
  );

  // The pointer as the hand moves: one request in flight, at most every 40ms,
  // and only the latest position — so hover works without a gesture to learn.
  const flushPointer = useCallback(async () => {
    const pointer = pointerRef.current;
    if (pointer.inFlight || !pointer.queued) return;
    const wait = pointer.sentAt + 40 - Date.now();
    if (wait > 0) {
      setTimeout(() => void flushPointer(), wait);
      return;
    }
    pointer.queued = false;
    pointer.inFlight = true;
    pointer.sentAt = Date.now();
    await postInput({ kind: "pointer", x: pointer.x, y: pointer.y });
    pointer.inFlight = false;
    void flushPointer();
  }, [postInput]);

  // Scrolling, summed while a request is in flight.
  const flushWheel = useCallback(async () => {
    const wheel = wheelRef.current;
    if (wheel.inFlight || (wheel.deltaX === 0 && wheel.deltaY === 0)) return;
    const clamp = (value: number) => Math.max(-20_000, Math.min(20_000, Math.round(value)));
    const body = { kind: "wheel", x: wheel.x, y: wheel.y, deltaX: clamp(wheel.deltaX), deltaY: clamp(wheel.deltaY) };
    wheel.deltaX = 0;
    wheel.deltaY = 0;
    wheel.inFlight = true;
    await postInput(body);
    wheel.inFlight = false;
    void flushWheel();
  }, [postInput]);

  // Non-passive, so scrolling over the page scrolls the page and not the CMS.
  useEffect(() => {
    const image = imageRef.current;
    if (!image || !isActive) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toPage(event.clientX, event.clientY);
      if (!point) return;
      const wheel = wheelRef.current;
      wheel.x = point.x;
      wheel.y = point.y;
      wheel.deltaX += event.deltaX;
      wheel.deltaY += event.deltaY;
      void flushWheel();
    };
    image.addEventListener("wheel", onWheel, { passive: false });
    return () => image.removeEventListener("wheel", onWheel);
  }, [isActive, toPage, flushWheel, streamAttempt]);

  const capture = async () => {
    setMessage(null);
    setCapturing(true);
    const saved = savedSessionTags.current;
    const changed = sessionTags.length !== saved.length || sessionTags.some((id) => !saved.includes(id));
    if (changed) {
      const result = await setSessionTagsAction(session.id, sessionTags);
      if (!result.ok) {
        setCapturing(false);
        setMessage({ text: result.error ?? "Those tags could not be saved.", tone: "danger" });
        return;
      }
      savedSessionTags.current = [...sessionTags];
    }
    try {
      const response = await fetch(`/api/studio/${session.id}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "command",
          payload: {
            type: "capture",
            screenName: name.trim() || pageName,
            ...(stateLabel.trim() ? { stateLabel: stateLabel.trim() } : {}),
          },
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { commandId?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "That didn't reach the browser.");
      captureCommandRef.current = body.commandId ?? null;
      setStateLabel("");
    } catch (error) {
      setCapturing(false);
      setMessage({ text: error instanceof Error ? error.message : "That didn't reach the browser.", tone: "danger" });
    }
  };

  const done = () =>
    startClosing(async () => {
      if (isActive) await closeSessionAction(session.id);
      router.push(productHref);
    });

  const changeSessionTags = (next: string[]) => setSessionTags(next);

  const meta = CAPTURE_SESSION_STATUS_META[status];
  const frameRatio = session.viewportWidth / session.viewportHeight;

  return (
    <div className="flex min-h-dvh flex-col">
      {/* --- Header ---------------------------------------------------------- */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ink-200 px-4 py-3 md:px-6">
        <Link
          href={productHref}
          className="flex items-center gap-1.5 text-xs text-ink-500 transition-colors hover:text-ink-900"
        >
          <ArrowLeft aria-hidden className="size-3" />
          {session.productName ?? "Products"}
        </Link>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <h1 className="truncate text-[15px] font-medium text-ink-900">{pageName}</h1>
          <span className="hidden truncate font-mono text-xs text-ink-500 sm:inline">{shortUrl(currentUrl)}</span>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-ink-500">
          {session.mobile ? <Smartphone aria-hidden className="size-3.5" /> : <Monitor aria-hidden className="size-3.5" />}
          {session.deviceLabel}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-ink-600" title={meta.description}>
          <span
            aria-hidden
            className={clsx(
              "size-1.5 rounded-full",
              status === "live" ? "bg-[var(--color-tone-success)]" : isActive ? "bg-[var(--color-tone-warning)]" : "bg-ink-400",
            )}
          />
          {meta.label}
        </span>
        <button
          type="button"
          onClick={done}
          disabled={closing}
          className="h-8 rounded-md bg-ink-900 px-4 text-xs font-medium text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-60"
        >
          {closing ? "Closing…" : "Done"}
        </button>
      </header>

      <div className="grid flex-1 gap-4 p-4 md:p-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* --- The live page -------------------------------------------------- */}
        <section aria-label="Live page" className="flex min-w-0 flex-col gap-3">
          <div className="overflow-hidden rounded-xl border border-ink-200 bg-surface">
            <div className="flex items-center gap-1 border-b border-ink-200 p-1.5">
              <ToolButton label="Back" disabled={!isActive} onClick={() => send({ type: "back" })}>
                <ArrowLeft aria-hidden className="size-3.5" />
              </ToolButton>
              <ToolButton label="Forward" disabled={!isActive} onClick={() => send({ type: "forward" })}>
                <ArrowRight aria-hidden className="size-3.5" />
              </ToolButton>
              <ToolButton label="Reload" disabled={!isActive} onClick={() => send({ type: "reload" })}>
                <RotateCw aria-hidden className="size-3.5" />
              </ToolButton>
              <input
                ref={addressRef}
                type="url"
                value={urlDraft}
                disabled={!isActive}
                onChange={(event) => setUrlDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  send({ type: "navigate", url: urlDraft.trim() });
                  event.currentTarget.blur();
                }}
                aria-label="Address"
                spellCheck={false}
                className="ml-1 h-8 min-w-0 flex-1 rounded-md bg-ink-100 px-3 font-mono text-xs text-ink-800 outline-none focus:bg-ink-200 focus-visible:outline-none disabled:opacity-60"
              />
            </div>

            <div className="bg-ink-50">
              <div
                className="relative mx-auto"
                style={{
                  aspectRatio: `${session.viewportWidth} / ${session.viewportHeight}`,
                  width: `min(100%, calc((100dvh - 190px) * ${frameRatio}))`,
                }}
              >
                {isActive ? (
                  // A plain <img>: the stream is a multipart response the
                  // browser decodes itself, and an optimiser in front of it
                  // would only get in the way. The attempt counter reconnects
                  // after a dropped stream.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={streamAttempt}
                    ref={imageRef}
                    src={`/api/studio/${session.id}/stream?attempt=${streamAttempt}`}
                    alt="The page as the capture browser sees it"
                    onLoad={() => setHasFrame(true)}
                    onError={() => {
                      setHasFrame(false);
                      setTimeout(() => setStreamAttempt((attempt) => attempt + 1), 1_000);
                    }}
                    onClick={(event) => {
                      const point = toPage(event.clientX, event.clientY);
                      if (point) {
                        send({ type: "click", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: [] });
                      }
                    }}
                    onMouseMove={(event) => {
                      const point = toPage(event.clientX, event.clientY);
                      if (!point) return;
                      Object.assign(pointerRef.current, { x: point.x, y: point.y, queued: true });
                      void flushPointer();
                    }}
                    draggable={false}
                    className="block size-full select-none object-contain"
                  />
                ) : null}
                {!hasFrame || !isActive ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-[13px] text-ink-500">
                    {isActive ? (
                      "Opening the page…"
                    ) : (
                      <>
                        <span>
                          {status === "failed"
                            ? (session.errorMessage ?? "The browser couldn't open that page.")
                            : "This browser has closed."}
                        </span>
                        <Link href={productHref} className="text-xs text-ink-700 underline hover:text-ink-900">
                          Back to {session.productName ?? "the product"}
                        </Link>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <TypeBar disabled={!isActive} onSend={send} />
        </section>

        {/* --- Capture -------------------------------------------------------- */}
        <aside className="flex flex-col gap-4">
          <section className="rounded-xl border border-ink-200 bg-surface p-4">
            <p className="text-xs text-ink-500">
              {session.flowTitle ? (
                <>
                  Capturing the flow <span className="text-ink-900">{session.flowTitle}</span> — each capture is the
                  next step.
                </>
              ) : (
                "Capturing screens"
              )}
            </p>

            <div className="mt-4 grid grid-cols-[1fr_auto] items-end gap-2">
              <label className="block min-w-0">
                <span className="text-xs text-ink-600">Name</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={pageName}
                  className="mt-1.5 h-9 w-full rounded-lg border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none placeholder:text-ink-500 focus:border-ink-400 focus-visible:outline-none"
                />
              </label>
              <label className="block w-32">
                <span className="text-xs text-ink-600">
                  State <span className="text-ink-400">optional</span>
                </span>
                <input
                  value={stateLabel}
                  onChange={(event) => setStateLabel(event.target.value)}
                  placeholder="Menu open"
                  className="mt-1.5 h-9 w-full rounded-lg border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900 outline-none placeholder:text-ink-400 focus:border-ink-400 focus-visible:outline-none"
                />
              </label>
            </div>

            <div className="mt-4">
              <p className="text-xs text-ink-600">
                Tags on each capture <span className="text-ink-400">— saved when you press Capture</span>
              </p>
              <div className="mt-2">
                <TagPicker options={tags} selected={sessionTags} onChange={changeSessionTags} align="right" />
              </div>
            </div>

            <button
              type="button"
              onClick={() => void capture()}
              disabled={!isActive || !hasFrame || capturing}
              className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-ink-900 text-[13px] font-medium text-ink-50 transition-colors hover:bg-ink-950 disabled:opacity-50"
            >
              <Camera aria-hidden className="size-4" />
              {capturing ? "Capturing…" : "Capture"}
            </button>
            <p
              className={clsx(
                "mt-2 text-xs",
                message?.tone === "danger" ? "text-[var(--color-tone-danger)]" : "text-ink-500",
              )}
            >
              {message?.text ??
                (elsewhere
                  ? `You're on ${currentHost}, not ${session.productSite}. This capture will be filed under the ${currentHost} profile, not ${session.productName ?? "this product"}.`
                  : "Captures exactly what you see. It goes to the Inbox — nothing is published from here.")}
            </p>
          </section>

          <section aria-labelledby="captured-heading">
            <h2 id="captured-heading" className="flex items-baseline gap-2 text-[13px] text-ink-900">
              Captured <span className="font-mono text-xs text-ink-400">{screens.length}</span>
            </h2>
            {screens.length === 0 ? (
              <p className="mt-2 text-xs text-ink-500">Nothing yet. Each capture appears here.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-3">
                {screens.map((screen) => (
                  <CapturedItem key={screen.id} screen={screen} tags={tags} />
                ))}
              </ul>
            )}
          </section>

          <label className="mt-auto flex items-start gap-2.5 rounded-xl border border-ink-200 p-3">
            <input
              type="checkbox"
              checked={dismissConsent}
              disabled={!isActive}
              onChange={(event) => {
                const dismiss = event.target.checked;
                setDismissConsent(dismiss);
                send({ type: "consent", dismiss });
              }}
              className="mt-0.5 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block text-xs text-ink-800">Hide cookie banners</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-500">
                Switching restarts the browser on this page, signed out.
              </span>
            </span>
          </label>
        </aside>
      </div>
    </div>
  );
}

/** One capture: its picture, its name, its tags, and a way to throw it away. */
function CapturedItem({ screen, tags }: { screen: CapturedScreen; tags: readonly TagOption[] }) {
  const draft = useScreenDraft(screen);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <li className="rounded-xl border border-ink-200 bg-surface p-2.5">
      <div className="flex gap-3">
        <div className="relative aspect-[16/10] w-28 shrink-0 overflow-hidden rounded-md border border-ink-200 bg-ink-100">
          {screen.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={screen.thumbnailUrl} alt="" className="size-full object-cover object-top" />
          ) : (
            <span className="flex size-full items-center justify-center text-[10px] text-ink-400">Processing</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] text-ink-900" title={screen.name}>
              {screen.name}
              {screen.stateLabel ? <span className="text-ink-500"> — {screen.stateLabel}</span> : null}
              {screen.filedUnder ? (
                <span className="block truncate text-[11px] text-ink-500">Filed under {screen.filedUnder}</span>
              ) : null}
            </p>
            {screen.discardable && !confirming ? (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                aria-label={`Discard ${screen.name}`}
                title="Discard this capture"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            ) : null}
          </div>
          {confirming ? (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-ink-600">Discard?</span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const result = await discardScreenAction(screen.id);
                    if (!result.ok) {
                      setError(result.error);
                      setConfirming(false);
                    }
                  })
                }
                className="h-6 rounded-md bg-[var(--color-tone-danger)] px-2.5 text-[11px] font-medium text-ink-50 disabled:opacity-60"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="h-6 rounded-md border border-ink-300 px-2.5 text-[11px] text-ink-800 hover:bg-ink-100"
              >
                Keep
              </button>
            </div>
          ) : (
            <div className="mt-2">
              <TagPicker
                options={tags}
                selected={draft.values.tagIds}
                onChange={(next) => draft.set("tagIds", next)}
                size="sm"
                align="right"
              />
              {draft.dirty || draft.error ? (
                <div className="mt-2 flex items-center gap-2">
                  <span className="flex-1 text-[11px] text-[var(--color-tone-warning)]">{draft.error ?? "Unsaved"}</span>
                  <button
                    type="button"
                    onClick={draft.discard}
                    className="h-6 rounded-md px-2 text-[11px] text-ink-600 hover:bg-ink-100 hover:text-ink-900"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    disabled={draft.saving}
                    onClick={() => void draft.save()}
                    className="h-6 rounded-md bg-ink-900 px-2.5 text-[11px] font-medium text-ink-50 disabled:opacity-50"
                  >
                    {draft.saving ? "Saving…" : "Save"}
                  </button>
                </div>
              ) : null}
            </div>
          )}
          {error ? <p className="mt-1.5 text-[11px] text-[var(--color-tone-danger)]">{error}</p> : null}
        </div>
      </div>
    </li>
  );
}

function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-md text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * Typing into the page, as its own field: a researcher has to be able to type
 * in the CMS without every keystroke going to the page.
 */
function TypeBar({ disabled, onSend }: { disabled: boolean; onSend: (payload: SessionCommandPayload) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="text"
        value={text}
        placeholder="Type into the page, then press Enter"
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || text.length === 0) return;
          onSend({ type: "type", text });
          setText("");
        }}
        className="h-8 min-w-0 flex-1 rounded-md border border-ink-200 bg-surface px-3 text-xs text-ink-900 outline-none placeholder:text-ink-400 focus:border-ink-400 focus-visible:outline-none sm:max-w-xs"
      />
      {(["Enter", "Escape", "Tab"] as const).map((key) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          onClick={() => onSend({ type: "key", key })}
          className="h-8 rounded-md border border-ink-200 px-2.5 font-mono text-[11px] text-ink-600 transition-colors hover:border-ink-300 hover:text-ink-900 disabled:opacity-40"
        >
          {key}
        </button>
      ))}
      <span className="ml-auto hidden text-[11px] text-ink-500 md:inline">
        Click, hover and scroll the page as you normally would.
      </span>
    </div>
  );
}

/** "/" is Home; anything else is its last path segment, in words. */
function pageNameOf(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    if (!path) return "Home";
    const last = decodeURIComponent(path.split("/").pop() ?? "");
    const words = last.replace(/[-_]+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Home";
  } catch {
    return "Home";
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "/" : parsed.pathname}`;
  } catch {
    return url;
  }
}
