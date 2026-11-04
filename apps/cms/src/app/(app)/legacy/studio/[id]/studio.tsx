"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CAPTURE_SESSION_STATUS_META,
  type CaptureSessionStatus,
  type SessionCommandPayload,
} from "@uxd/types";
import { Badge, Button, Note, Thumbnail } from "@/components/ui/primitives";
import { closeSessionAction } from "@/lib/actions/discovery";

export interface StudioSession {
  readonly id: string;
  readonly status: CaptureSessionStatus;
  readonly targetUrl: string;
  readonly currentUrl: string | null;
  readonly currentTitle: string | null;
  readonly deviceProfile: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly deviceScaleFactor: number;
  readonly screensCaptured: number;
  readonly errorMessage: string | null;
  readonly flowId: string | null;
  readonly flowTitle: string | null;
  readonly flowStepCount: number;
  readonly dismissConsent: boolean;
}

export interface CapturedScreen {
  readonly id: string;
  readonly title: string | null;
  readonly stateLabel: string | null;
  readonly thumbnailUrl: string | null;
}

/**
 * The capture studio (§2, §3).
 *
 * A live browser the researcher drives, so they can reach the exact state
 * worth keeping — navigation open, search open, a modal up — and only then
 * press Capture.
 *
 * What this is, precisely
 * ----------------------
 * A stream. The worker runs Chromium's screencast, which paints a frame
 * whenever the page changes, and the CMS relays each one to this page as part
 * of a single `multipart/x-mixed-replace` response — the `<img>` below
 * replaces its picture with every part, decoded by the browser itself. Input
 * goes the other way through plain `fetch`es: commands (click, type,
 * navigate) are logged and wake the worker at once; the pointer and the wheel
 * are relayed without being recorded, which is what lets hover work just by
 * moving the mouse.
 *
 * Coordinates
 * -----------
 * Clicks are translated from the displayed image back to CSS pixels in the
 * page's own viewport before being sent. The frame is rendered at whatever
 * width the column happens to be, so a researcher on a laptop and one on a
 * large monitor produce identical clicks — which matters, because the captured
 * Screen must not depend on the reviewer's screen.
 */
export function Studio({
  session,
  screens,
}: {
  session: StudioSession;
  screens: readonly CapturedScreen[];
}) {
  const [status, setStatus] = useState<CaptureSessionStatus>(session.status);
  const [hasFrame, setHasFrame] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "danger" } | null>(null);
  const [urlDraft, setUrlDraft] = useState(session.currentUrl ?? session.targetUrl);
  const [screenName, setScreenName] = useState("");
  const [stateLabel, setStateLabel] = useState("");
  const [dismissConsent, setDismissConsent] = useState(session.dismissConsent);
  const [pending, startTransition] = useTransition();
  const imageRef = useRef<HTMLImageElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const capturedRef = useRef(session.screensCaptured);
  const pointerRef = useRef<{ x: number; y: number; inFlight: boolean; sentAt: number; queued: boolean }>({
    x: 0,
    y: 0,
    inFlight: false,
    sentAt: 0,
    queued: false,
  });
  const wheelRef = useRef({ x: 0, y: 0, deltaX: 0, deltaY: 0, inFlight: false });

  const isActive = CAPTURE_SESSION_STATUS_META[status].isActive;

  // --- Status ------------------------------------------------------------
  //
  // The stream carries pixels only. Whether the browser is alive, where it
  // has navigated and whether a capture landed come from this small poll.
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
        };
        setStatus(next.status);

        // Follow the page's own navigation in the address bar, unless the
        // researcher is in the middle of typing a new address.
        if (next.currentUrl && document.activeElement !== addressRef.current) setUrlDraft(next.currentUrl);

        // A capture is queued work; this is how the page learns it landed.
        // Refreshing re-reads the session's screens from the server.
        if (next.screensCaptured > capturedRef.current) {
          capturedRef.current = next.screensCaptured;
          setMessage({ text: "Captured. It is waiting in Reviews.", tone: "info" });
          router.refresh();
        }
      } catch {
        // A missed status check is replaced a moment later.
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 1_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session.id, isActive, router]);

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
        return payload.error ?? "That did not reach the browser.";
      } catch {
        return "That did not reach the browser.";
      }
    },
    [session.id],
  );

  const send = useCallback(
    (payload: SessionCommandPayload, note?: string) => {
      setBusy(true);
      void postInput({ kind: "command", payload }).then((error) => {
        setBusy(false);
        if (error) setMessage({ text: error, tone: "danger" });
        else if (note) setMessage({ text: note, tone: "info" });
      });
    },
    [postInput],
  );

  /**
   * Translate a point on the rendered frame into the page's own coordinates.
   *
   * `getBoundingClientRect` gives the displayed box, and the session's
   * viewport is the page's real size in CSS pixels. The ratio between them is
   * the scale the browser applied to fit the column, and dividing it out is
   * what makes the click land where the researcher aimed.
   */
  const toPageCoordinates = useCallback(
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

  const onFrameClick = (event: React.MouseEvent<HTMLImageElement>) => {
    const point = toPageCoordinates(event.clientX, event.clientY);
    if (!point) return;
    send({ type: "click", x: point.x, y: point.y, button: "left", clickCount: 1, modifiers: [] });
  };

  /**
   * The pointer, as the hand moves.
   *
   * At most one request in flight and one every ~40ms; positions that arrive
   * meanwhile replace each other, so the worker always moves to where the
   * pointer is now rather than replaying where it was.
   */
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

  const onFrameMove = (event: React.MouseEvent<HTMLImageElement>) => {
    const point = toPageCoordinates(event.clientX, event.clientY);
    if (!point) return;
    const pointer = pointerRef.current;
    pointer.x = point.x;
    pointer.y = point.y;
    pointer.queued = true;
    void flushPointer();
  };

  /**
   * Scrolling, coalesced: deltas accumulate while a request is in flight and
   * go out summed when it returns, so a trackpad swipe is a handful of
   * requests rather than dozens.
   */
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

  // A non-passive listener, so scrolling over the live page scrolls the page
  // and not the CMS around it. React's own onWheel is passive and cannot.
  useEffect(() => {
    const image = imageRef.current;
    if (!image || !isActive) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toPageCoordinates(event.clientX, event.clientY);
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
  }, [isActive, toPageCoordinates, flushWheel]);

  const capture = () => {
    const name = screenName.trim();
    if (!name) {
      setMessage({ text: "Give the screen a name before capturing it.", tone: "danger" });
      return;
    }
    send(
      {
        type: "capture",
        screenName: name,
        ...(stateLabel.trim() ? { stateLabel: stateLabel.trim() } : {}),
      },
      "Capturing…",
    );
    setStateLabel("");
  };

  const meta = CAPTURE_SESSION_STATUS_META[status];

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      {/* --- The live page ------------------------------------------------ */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button disabled={!isActive || pending} onClick={() => send({ type: "back" })}>
            ← Back
          </Button>
          <Button disabled={!isActive || pending} onClick={() => send({ type: "forward" })}>
            Forward →
          </Button>
          <Button disabled={!isActive || pending} onClick={() => send({ type: "reload" })}>
            Reload
          </Button>
          <input
            ref={addressRef}
            type="url"
            value={urlDraft}
            onChange={(event) => setUrlDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              send({ type: "navigate", url: urlDraft.trim() });
            }}
            className="h-7 min-w-0 flex-1 rounded-[4px] border border-ink-300 px-2 font-mono text-2xs outline-none focus:border-[var(--color-accent)]"
            aria-label="Address"
          />
          <Badge tone={meta.tone} title={meta.description} dot>
            {meta.label}
          </Badge>
        </div>

        {message ? <Note tone={message.tone}>{message.text}</Note> : null}

        {status === "failed" ? (
          <Note tone="danger">{session.errorMessage ?? "The browser could not open that page."}</Note>
        ) : null}

        <div
          className="relative overflow-hidden rounded-md border border-ink-200 bg-ink-100"
          style={{ aspectRatio: `${session.viewportWidth} / ${session.viewportHeight}` }}
        >
          {isActive ? (
            // A plain <img> for the same reason the thumbnails are: this is a
            // stream from our own route, and next/image would put an optimiser
            // in front of a picture that never stops changing. The attempt
            // counter reconnects after a dropped stream.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={streamAttempt}
              ref={imageRef}
              src={`/api/studio/${session.id}/stream?attempt=${streamAttempt}`}
              alt="The page as the capture browser currently sees it"
              onLoad={() => setHasFrame(true)}
              onError={() => {
                setHasFrame(false);
                setTimeout(() => setStreamAttempt((attempt) => attempt + 1), 1_000);
              }}
              onClick={onFrameClick}
              onMouseMove={onFrameMove}
              draggable={false}
              className="block size-full cursor-default select-none object-contain"
            />
          ) : null}
          {!hasFrame || !isActive ? (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-ink-500">
              {isActive ? "Waiting for the browser…" : "This session has ended."}
            </div>
          ) : null}
          {busy ? (
            <div className="pointer-events-none absolute right-2 top-2 rounded-[3px] bg-black/80 px-2 py-0.5 text-2xs text-white">
              working…
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-500">
          <span>Click, hover and scroll the page as you would in a normal browser.</span>
          <span>
            {session.viewportWidth}×{session.viewportHeight} CSS at ×{session.deviceScaleFactor} —
            captures at {session.viewportWidth * session.deviceScaleFactor}×
            {session.viewportHeight * session.deviceScaleFactor}
          </span>
        </div>

        {/* Typing is a separate control rather than a keydown handler on the
            frame: a researcher needs to be able to type into the page without
            every keystroke in the CMS being forwarded to it. */}
        <TypeBar disabled={!isActive || pending} onSend={send} />
      </div>

      {/* --- Capture panel ------------------------------------------------- */}
      <div className="flex flex-col gap-3">
        <section className="rounded-md border border-ink-200 bg-surface p-3">
          <h2 className="text-xs font-semibold text-ink-800">Capture this state</h2>
          <p className="mt-0.5 text-2xs leading-relaxed text-ink-500">
            The viewport only, as a lossless PNG at full device density. The same URL can produce
            several screens — name the state that makes this one worth keeping.
          </p>

          <label className="mt-2.5 block text-2xs font-medium text-ink-600">
            Screen name
            <input
              type="text"
              value={screenName}
              placeholder="Pricing"
              onChange={(event) => setScreenName(event.target.value)}
              className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
            />
          </label>

          <label className="mt-2 block text-2xs font-medium text-ink-600">
            State <span className="font-normal text-ink-400">optional</span>
            <input
              type="text"
              value={stateLabel}
              placeholder="Navigation open"
              onChange={(event) => setStateLabel(event.target.value)}
              className="mt-1 h-7 w-full rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
            />
          </label>

          <Button
            variant="primary"
            className="mt-3 w-full"
            disabled={!isActive || pending}
            onClick={capture}
          >
            Capture screen
          </Button>

          <p className="mt-2 text-2xs text-ink-500">
            Every capture enters review. Nothing is published from here.
          </p>
        </section>

        <section className="rounded-md border border-ink-200 bg-surface p-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={dismissConsent}
              disabled={!isActive || pending}
              onChange={(event) => {
                const dismiss = event.target.checked;
                setDismissConsent(dismiss);
                send(
                  { type: "consent", dismiss },
                  dismiss
                    ? "Restarting the browser with cookie banners dismissed…"
                    : "Restarting the browser with cookie banners shown…",
                );
              }}
              className="mt-0.5"
            />
            <span>
              <span className="block text-xs font-semibold text-ink-800">Dismiss cookie banners</span>
              <span className="mt-0.5 block text-2xs leading-relaxed text-ink-500">
                Opts out of consent pop-ups on every page. Turn it off to capture the banner itself.
                Switching restarts the browser at this URL with a fresh profile, so anything you
                signed in to is signed out.
              </span>
            </span>
          </label>
        </section>

        {session.flowId ? (
          <section className="rounded-md border border-ink-200 bg-surface p-3">
            <h2 className="text-xs font-semibold text-ink-800">Capturing into a flow</h2>
            <p className="mt-1 text-2xs text-ink-500">
              Each screen becomes the next step of{" "}
              <Link href={`/flows/${session.flowId}`} className="underline hover:text-ink-800">
                {session.flowTitle ?? "this flow"}
              </Link>
              . It currently has {session.flowStepCount} step
              {session.flowStepCount === 1 ? "" : "s"}.
            </p>
          </section>
        ) : null}

        <section className="rounded-md border border-ink-200 bg-surface p-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xs font-semibold text-ink-800">Captured in this session</h2>
            <span className="text-2xs text-ink-500">{screens.length}</span>
          </div>
          {screens.length === 0 ? (
            <p className="mt-1.5 text-2xs text-ink-500">Nothing yet.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {screens.map((screen) => (
                <li key={screen.id} className="flex items-center gap-2">
                  <Thumbnail url={screen.thumbnailUrl} alt="" width={48} height={32} />
                  <Link
                    href={`/screens/${screen.id}`}
                    className="min-w-0 flex-1 truncate text-2xs hover:underline"
                  >
                    {screen.title ?? "Untitled"}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <Button
          variant="danger"
          disabled={!isActive || pending}
          onClick={() => {
            startTransition(async () => {
              await closeSessionAction(session.id);
              setStatus("closed");
            });
          }}
        >
          Close session
        </Button>
      </div>
    </div>
  );
}

/** Text entry and the keys a page actually responds to. */
function TypeBar({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (payload: SessionCommandPayload, note?: string) => void;
}) {
  const [text, setText] = useState("");

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        type="text"
        value={text}
        placeholder="Type into the page…"
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || text.length === 0) return;
          onSend({ type: "type", text });
          setText("");
        }}
        className="h-7 w-64 rounded-[4px] border border-ink-300 px-2 text-xs outline-none focus:border-[var(--color-accent)]"
      />
      {(["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp"] as const).map((key) => (
        <Button key={key} size="sm" disabled={disabled} onClick={() => onSend({ type: "key", key })}>
          {key}
        </Button>
      ))}
    </div>
  );
}
