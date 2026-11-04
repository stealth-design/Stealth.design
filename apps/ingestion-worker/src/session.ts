/**
 * The capture studio, worker side (§2, §3).
 *
 * Opens one browser context, holds it, and does what the operator asks until
 * they stop asking. Structurally the opposite of `captureItem`: that function
 * is a transaction — fetch, photograph, report, forget — and this one is a
 * conversation with a person on the other end.
 *
 * Three things run side by side while the session is open:
 *
 *   - **The command loop.** `sync(results) -> commands -> run them -> sync
 *     again`. The control plane holds the sync open until a command arrives
 *     and is woken the instant one is written, so a click reaches this page in
 *     one hop.
 *   - **The live view.** Chromium's screencast paints a JPEG whenever the page
 *     changes; `LiveView` pumps the newest one to the control plane, dropping
 *     any that are superseded while a post is in flight. An idle page sends
 *     nothing; an opening menu streams.
 *   - **The input loop.** Pointer and wheel movements, held in the control
 *     plane's live relay and collected by a long poll of their own, so moving
 *     the mouse never waits behind a slow navigation.
 *
 * Commands and input touch the same page, so both go through one serial queue
 * and can never interleave mid-gesture.
 *
 * Nothing about the isolation posture changes here. The context is built by
 * `newGuardedContext` with the same SSRF request screen the crawl path uses —
 * the same object, not a second implementation — the Chromium sandbox is on,
 * and the only commands that exist are input events. There is no command that
 * evaluates operator-supplied script inside this process.
 */
import type { BrowserContext, CDPSession, Page } from "playwright";
import {
  type BrowserPool,
  createRequestScreen,
  guardUrl,
  type ConsentTracker,
  installConsentHandling,
  newGuardedContext,
} from "@uxd/crawler";
import { type Logger, sanitizeText, sleep } from "@uxd/shared";
import {
  DEVICE_PROFILES,
  type DeviceProfile,
  type DeviceProfileKey,
  STUDIO_DISMISS_CONSENT_DEFAULT,
  STUDIO_FRAME,
  sessionCommandPayloadSchema,
} from "@uxd/types";
import type { ClaimedStudioSession, ControlPlaneClient, StudioCommand } from "./control-plane.js";
import type { WorkerRuntimeConfig } from "./config.js";

export interface SessionDeps {
  readonly client: ControlPlaneClient;
  readonly pool: BrowserPool;
  readonly runtime: WorkerRuntimeConfig;
  readonly logger: Logger;
}

/** What one command produced, reported back on the next sync. */
interface CommandResult {
  commandId: string;
  status: "done" | "failed";
  errorMessage: string | null;
  result: Record<string, unknown>;
}

/**
 * Run one live session to completion.
 *
 * Returns when the operator closes it, the control plane says it has ended, or
 * the browser dies. Never throws: a session that fails has to be *reported* as
 * failed, otherwise the studio shows a spinner until the reaper gets to it.
 */
export async function runSession(deps: SessionDeps, session: ClaimedStudioSession): Promise<void> {
  const logger = deps.logger.child({ sessionId: session.id, url: session.targetUrl });
  const profileKey = session.deviceProfile as DeviceProfileKey;
  const profile: DeviceProfile | undefined = DEVICE_PROFILES[profileKey];

  if (!profile) {
    await fail(deps, session, "UNKNOWN_PROFILE", "That capture profile is not one this worker knows.");
    return;
  }

  // Validate before opening anything. The control plane checked too, but this
  // side is the one that actually dials out, so it is the side that must be
  // sure (§25).
  const guarded = await guardUrl(session.targetUrl, {
    blockedDomains: deps.runtime.blockedDomains,
    logger,
  });
  if (!guarded.ok) {
    await fail(deps, session, guarded.error.errorCode, guarded.error.message);
    return;
  }

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let dismissConsent = STUDIO_DISMISS_CONSENT_DEFAULT;
  let consent: ConsentTracker | null = null;
  let stopLiveView: () => Promise<void> = async () => {};

  try {
    const browser = await deps.pool.get();
    deps.pool.noteCapture();

    const screen = createRequestScreen({
      maxPageBytes: deps.runtime.maxPageBytes,
      guardPolicy: { blockedDomains: deps.runtime.blockedDomains, logger },
      logger,
      pageUrl: session.targetUrl,
    });

    const liveView = new LiveView(deps, session, logger);
    stopLiveView = () => liveView.stop();
    const serial = createSerialQueue();

    /**
     * A fresh browser profile with one page, at `url`.
     *
     * Called once to start, and again when the operator switches consent
     * handling — an init script cannot be removed from a context, and the
     * site's memory of the opt-out lives in that context's cookies.
     */
    const open = async (
      url: string,
    ): Promise<{ context: BrowserContext; page: Page; consent: ConsentTracker | null }> => {
      const ctx = await newGuardedContext(
        browser,
        profile,
        {
          userAgent: deps.runtime.userAgent,
          navigationTimeoutMs: deps.runtime.navTimeoutMs,
          // Unused by context creation, but the option type is shared with the
          // batch path. Named explicitly rather than cast, so a future field
          // added there is a compile error here rather than a silent default.
          pool: deps.pool,
          guarded: guarded.value,
          deviceProfiles: [profileKey],
          fullPage: false,
          viewport: true,
          totalTimeoutMs: deps.runtime.itemTimeoutMs,
          maxPageBytes: deps.runtime.maxPageBytes,
          interactionSteps: [],
          logger,
        },
        screen.attach,
      );

      try {
        const tracker = dismissConsent ? await installConsentHandling(ctx) : null;
        const openPage = await ctx.newPage();

        // A page that opens a popup would otherwise leave a second tab nobody
        // can see or close. Closing it keeps the session to exactly one
        // visible page.
        ctx.on("page", (opened) => {
          if (opened !== openPage) void opened.close().catch(() => {});
        });

        // Streaming before the first navigation, so the researcher watches the
        // page load instead of waiting on a blank box.
        await liveView.attach(openPage);
        // "commit": hand the session over as soon as the page starts arriving.
        // The researcher watches it fill in, can click while it does, and
        // Capture waits for the page to settle before photographing it —
        // so nothing is gained by holding every command until a heavy page
        // has finished parsing.
        try {
          await openPage.goto(url, {
            waitUntil: "commit",
            timeout: deps.runtime.navTimeoutMs,
          });
        } catch (error) {
          // A heavy page that has started arriving but not finished parsing is
          // still a page the researcher can work with — the live view shows it
          // filling in. Only a navigation that never got anywhere is a failure.
          const arrived = openPage.url() !== "about:blank";
          if (!arrived || !(error instanceof Error) || error.name !== "TimeoutError") throw error;
          logger.warn("The page is slow to load; carrying on with what has arrived", { url });
        }
        void liveView.refresh(openPage);
        return { context: ctx, page: openPage, consent: tracker };
      } catch (error) {
        await ctx.close().catch(() => {});
        throw error;
      }
    };

    ({ context, page, consent } = await open(guarded.value.parsed.fetchUrl));

    logger.info("Capture session is live", { dismissConsent });

    // Once, if the website still needs a proper logo: photograph the one in
    // its header. Queued like any command, so it never races a click.
    if (session.wantsLogo) {
      void serial(async () => {
        const target = page;
        if (!target || target.isClosed()) return;
        await settleForFrame(target);
        // Single-page sites draw their header after "load".
        await sleep(1_500);
        const shot = await photographHeaderLogo(target);
        if (!shot) {
          logger.info("No convincing logo in the page header; keeping what the website has");
          return;
        }
        const uploaded = await deps.client.uploadMedia({
          bytes: shot,
          filename: "logo.png",
          contentType: "image/png",
          sourceUrl: target.url(),
          deviceScaleFactor: session.deviceScaleFactor,
          screenshotScope: "element",
          altText: "Logo",
        });
        await deps.client.reportLogo(session.id, session.leaseToken, uploaded.mediaId);
        logger.info("Photographed the header logo");
      }).catch((error: unknown) => logger.warn("Could not photograph the header logo", { error }));
    }

    // --- The conversation -------------------------------------------------
    let results: CommandResult[] = [];
    let live = true;
    let closing = false;

    // Pointer and wheel, on their own loop. Ends when the control plane says
    // the session is over, or when this function's `finally` stops the view.
    void (async () => {
      while (live && !closing) {
        const input = await deps.client.takeInput(session.id, session.leaseToken).catch(() => null);
        if (!input) {
          await sleep(500);
          continue;
        }
        if (!input.accepted || input.ended) break;
        const { pointer, wheel } = input;
        if (!pointer && !wheel) continue;
        await serial(async () => {
          const target = page;
          if (!target || target.isClosed()) return;
          if (wheel) {
            await target.mouse.move(wheel.x, wheel.y);
            await target.mouse.wheel(wheel.deltaX, wheel.deltaY);
          }
          if (pointer) await target.mouse.move(pointer.x, pointer.y);
        }).catch(() => undefined);
      }
    })();

    while (live && !closing) {
      const sync = await deps.client
        .syncSession(
          session.id,
          {
            leaseToken: session.leaseToken,
            currentUrl: page.url().slice(0, 2048),
            currentTitle: sanitizeText(await page.title().catch(() => null), { maxLength: 500 }),
            live: true,
            results,
          },
          // Frames travel on their own channel now; see `LiveView`.
          null,
        )
        .catch((error: unknown) => {
          logger.warn("Session sync failed", { error });
          return null;
        });

      results = [];

      if (!sync) {
        // A single failed sync is usually the control plane restarting. Pause
        // and try once more rather than throwing away a browser the operator
        // is in the middle of using.
        await sleep(2_000);
        continue;
      }
      if (!sync.accepted || sync.status === "closed" || sync.status === "expired") {
        logger.info("Session ended by the control plane", { status: sync.status, reason: sync.reason });
        return;
      }

      for (const { command, merged } of mergeScrolls(sync.commands)) {
        const parsed = sessionCommandPayloadSchema.safeParse(command.payload);
        if (parsed.success && parsed.data.type === "consent") {
          // Handled here rather than in `runCommand`, because it replaces the
          // page every other command acts on.
          if (parsed.data.dismiss !== dismissConsent) {
            const dismiss = parsed.data.dismiss;
            await serial(async () => {
              const current = page!;
              const restart = await guardUrl(current.url(), {
                blockedDomains: deps.runtime.blockedDomains,
                logger,
              });
              const url = restart.ok ? restart.value.parsed.fetchUrl : guarded.value.parsed.fetchUrl;
              dismissConsent = dismiss;
              await current.close().catch(() => {});
              await context?.close().catch(() => {});
              ({ context, page, consent } = await open(url));
            });
            logger.info("Restarted the browser for consent handling", { dismissConsent });
          }
          results.push({
            commandId: command.id,
            status: "done",
            errorMessage: null,
            result: { dismissConsent, url: page.url().slice(0, 2048) },
          });
          continue;
        }

        const current = page!;
        const outcome = await serial(() => runCommand(deps, session, current, command, logger, consent, liveView));
        results.push(outcome.result);
        for (const id of merged) {
          results.push({ ...outcome.result, commandId: id, result: { mergedInto: command.id } });
        }
        if (outcome.closed) closing = true;
        if (outcome.closed) break;
      }

      // If the page did not repaint after what just ran — a click on nothing,
      // a key the page ignored — the viewer still gets a fresh picture.
      if (!closing && sync.commands.length > 0 && page) void liveView.refresh(page);
    }

    // Final turn, so the control plane learns the last command's result and
    // records the session as closed rather than waiting for the lease to lapse
    // and reporting it as idle.
    await deps.client
      .syncSession(
        session.id,
        {
          leaseToken: session.leaseToken,
          currentUrl: page.url().slice(0, 2048),
          currentTitle: null,
          live: false,
          closing,
          results,
        },
        null,
      )
      .catch(() => undefined);
  } catch (error) {
    logger.error("Capture session failed", { error });
    await fail(
      deps,
      session,
      "SESSION_FAILED",
      error instanceof Error ? error.message.slice(0, 500) : "The browser stopped responding.",
    );
  } finally {
    await stopLiveView().catch(() => {});
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    logger.info("Capture session closed");
  }
}

// --- Commands -------------------------------------------------------------

/**
 * Fold each run of consecutive scrolls into one.
 *
 * A trackpad gesture is dozens of wheel events, and each used to arrive here
 * as its own command costing a quarter of a second — one swipe could queue
 * minutes of scrolling ahead of the next click or capture. The studio now
 * coalesces on its side too; this is the backstop for any client that does
 * not. Merged commands are reported with the outcome of the one that ran.
 */
function mergeScrolls(
  commands: readonly StudioCommand[],
): { command: StudioCommand; merged: string[] }[] {
  const out: { command: StudioCommand; merged: string[] }[] = [];
  const sum = (a: unknown, b: unknown) =>
    Math.max(-20_000, Math.min(20_000, (typeof a === "number" ? a : 0) + (typeof b === "number" ? b : 0)));

  for (const command of commands) {
    const last = out.at(-1);
    if (command.type === "scroll" && last?.command.type === "scroll") {
      last.command = {
        ...last.command,
        payload: {
          ...last.command.payload,
          deltaX: sum(last.command.payload.deltaX, command.payload.deltaX),
          deltaY: sum(last.command.payload.deltaY, command.payload.deltaY),
        },
      };
      last.merged.push(command.id);
      continue;
    }
    out.push({ command, merged: [] });
  }
  return out;
}

/**
 * Run one instruction.
 *
 * The payload is re-parsed against the shared schema rather than trusted from
 * the wire. The control plane validated it on the way in and it is the same
 * schema — but this process is the one holding a browser pointed at a hostile
 * page, and "the other side already checked" is the assumption that makes a
 * boundary decorative.
 */
async function runCommand(
  deps: SessionDeps,
  session: ClaimedStudioSession,
  page: Page,
  command: StudioCommand,
  logger: Logger,
  consent: ConsentTracker | null,
  liveView: LiveView,
): Promise<{ result: CommandResult; closed: boolean }> {
  const base: CommandResult = {
    commandId: command.id,
    status: "done",
    errorMessage: null,
    result: {},
  };

  try {
    const payload = sessionCommandPayloadSchema.parse(command.payload);

    switch (payload.type) {
      case "navigate": {
        // A navigation inside the studio is a fresh dial-out and gets the full
        // guard, exactly like the session's first URL. Without this, "type a
        // URL in the studio" would be an SSRF hole with a text box on it.
        const guarded = await guardUrl(payload.url, {
          blockedDomains: deps.runtime.blockedDomains,
          logger,
        });
        if (!guarded.ok) {
          return {
            result: { ...base, status: "failed", errorMessage: guarded.error.message },
            closed: false,
          };
        }
        // No settling afterwards, here or below: the live view streams the
        // page as it changes, so there is no single "next frame" that has to
        // show the finished result. Waiting would only hold up the next
        // instruction.
        await page.goto(guarded.value.parsed.fetchUrl, {
          waitUntil: "commit",
          timeout: deps.runtime.navTimeoutMs,
        });
        break;
      }

      case "back":
        await page.goBack({ waitUntil: "domcontentloaded", timeout: deps.runtime.navTimeoutMs });
        break;

      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded", timeout: deps.runtime.navTimeoutMs });
        break;

      case "reload":
        await page.reload({ waitUntil: "domcontentloaded", timeout: deps.runtime.navTimeoutMs });
        break;

      case "move":
        await page.mouse.move(payload.x, payload.y);
        break;

      case "click":
        await page.mouse.move(payload.x, payload.y);
        await page.mouse.click(payload.x, payload.y, {
          button: payload.button,
          clickCount: payload.clickCount,
        });
        break;

      case "scroll":
        await page.mouse.move(payload.x, payload.y);
        await page.mouse.wheel(payload.deltaX, payload.deltaY);
        break;

      case "key":
        await page.keyboard.press(payload.key, { delay: 20 });
        break;

      case "type":
        await page.keyboard.type(payload.text, { delay: 15 });
        break;

      case "capture": {
        const captured = await captureScreen(deps, session, page, command.id, payload, logger, consent);
        return { result: { ...base, result: captured }, closed: false };
      }

      case "refresh":
        await liveView.snapshot(page);
        break;

      case "close":
        return { result: base, closed: true };

      case "consent":
        // Handled by `runSession`, which owns the page this would replace.
        break;
    }

    return { result: { ...base, result: { url: page.url().slice(0, 2048) } }, closed: false };
  } catch (error) {
    logger.warn("A studio command failed", { type: command.type, error });
    return {
      result: {
        ...base,
        status: "failed",
        errorMessage: error instanceof Error ? error.message.slice(0, 500) : "The command failed.",
      },
      closed: false,
    };
  }
}

/**
 * Photograph the viewport and hand it to the control plane as a Screen (§3).
 *
 * Two properties this must not get wrong:
 *
 *   - **Viewport only.** `fullPage: false`, always. A Screen is a state a
 *     person chose; a 20,000-pixel strip of an entire marketing page is not a
 *     state anyone can look at.
 *   - **Lossless, at the profile's real density.** PNG, no `scale: "css"`, so
 *     a desktop capture is 2880×1800 and a mobile one is 1170×2532. The
 *     preview frames are JPEG because they are for aiming; this is the
 *     artefact, and it is the file a researcher will zoom into.
 */
async function captureScreen(
  deps: SessionDeps,
  session: ClaimedStudioSession,
  page: Page,
  commandId: string,
  payload: Extract<ReturnType<typeof sessionCommandPayloadSchema.parse>, { type: "capture" }>,
  logger: Logger,
  consent: ConsentTracker | null,
): Promise<Record<string, unknown>> {
  // Settle first: a capture taken mid-transition photographs a menu halfway
  // open, which is neither of the two states anyone wanted.
  await settleForFrame(page);

  const bytes = await page.screenshot({ type: "png", fullPage: false, scale: "device" });
  const url = page.url();

  const uploaded = await deps.client.uploadMedia({
    bytes,
    filename: `${payload.screenName.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60)}.png`,
    contentType: "image/png",
    sourceUrl: url,
    viewportWidth: session.viewportWidth,
    viewportHeight: session.viewportHeight,
    deviceScaleFactor: session.deviceScaleFactor,
    deviceProfile: session.deviceProfile,
    screenshotScope: "viewport",
    altText: payload.stateLabel
      ? `${payload.screenName} — ${payload.stateLabel}`
      : payload.screenName,
  });

  const reported = await deps.client.reportScreen(session.id, {
    leaseToken: session.leaseToken,
    commandId,
    mediaId: uploaded.mediaId,
    screenName: payload.screenName,
    description: payload.description ?? null,
    stateLabel: payload.stateLabel ?? null,
    url,
    pageTitle: sanitizeText(await page.title().catch(() => null), { maxLength: 500 }),
    viewportWidth: session.viewportWidth,
    viewportHeight: session.viewportHeight,
    deviceScaleFactor: session.deviceScaleFactor,
    imageWidth: uploaded.width,
    imageHeight: uploaded.height,
    browserName: "chromium",
    browserVersion: deps.pool.version,
    userAgent: await page.evaluate(() => navigator.userAgent).catch(() => null),
    signals: await pageSignals(page),
  });

  logger.info("Captured a screen", {
    screenName: payload.screenName,
    contentItemId: reported.contentItemId,
  });

  return {
    contentItemId: reported.contentItemId ?? null,
    slug: reported.slug ?? null,
    flowStepPosition: reported.flowStepPosition ?? null,
    mediaId: uploaded.mediaId,
    width: uploaded.width,
    height: uploaded.height,
    // Kept on the capture command, so "was a banner removed from this
    // screenshot, and whose?" stays answerable after the session ends.
    consent: consent?.outcome() ?? { outcome: "off", cmps: [] },
  };
}

/**
 * Structural signals for the classifier.
 *
 * Counts and booleans only — never page text. The classifier receives these
 * alongside the title and URL, and a string lifted verbatim out of a hostile
 * page is exactly the input a prompt injection would arrive on (§25).
 */
async function pageSignals(page: Page): Promise<Record<string, unknown>> {
  return page
    .evaluate(() => {
      const count = (selector: string) => document.querySelectorAll(selector).length;
      return {
        forms: count("form"),
        inputs: count("input, textarea, select"),
        buttons: count("button, [role=button]"),
        images: count("img"),
        headings: count("h1, h2, h3"),
        links: count("a[href]"),
        tables: count("table"),
        videos: count("video"),
        navs: count("nav, [role=navigation]"),
        dialogs: count("dialog, [role=dialog], [aria-modal=true]"),
        hasPricingTable: count("[class*=pric], [id*=pric]") > 0,
        hasCarousel: count("[class*=carousel], [class*=slider]") > 0,
      };
    })
    .catch(() => ({}));
}

// --- Frames ---------------------------------------------------------------

/**
 * The live picture: Chromium's screencast, pumped to the control plane.
 *
 * Chromium paints a frame whenever the page changes and will not paint the
 * next until this one is acknowledged, so acknowledging at once and keeping
 * only the newest frame gives natural back-pressure: a slow link drops
 * intermediate frames rather than queueing them, and the viewer is never
 * watching the past. Posts are capped at `STUDIO_FRAME.maxFps`.
 *
 * If the screencast cannot start (it is a Chromium DevTools feature, and a
 * future browser swap might not have it), the view falls back to a screenshot
 * a second — the old behaviour, slower but never blank.
 */
class LiveView {
  private cdp: CDPSession | null = null;
  private page: Page | null = null;
  private pending: Uint8Array | null = null;
  private inFlight = false;
  private lastSentAt = 0;
  private lastFrameAt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fallback: ReturnType<typeof setInterval> | null = null;

  private readonly deps: SessionDeps;
  private readonly session: ClaimedStudioSession;
  private readonly logger: Logger;

  constructor(deps: SessionDeps, session: ClaimedStudioSession, logger: Logger) {
    this.deps = deps;
    this.session = session;
    this.logger = logger;
  }

  async attach(page: Page): Promise<void> {
    await this.detach();
    this.page = page;
    try {
      const cdp = await page.context().newCDPSession(page);
      cdp.on("Page.screencastFrame", (event) => {
        void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
        this.offer(Buffer.from(event.data, "base64"));
      });
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: STUDIO_FRAME.quality,
        // CSS-sized frames: the studio maps clicks through the viewport size,
        // and a device-scale frame would be four times the bytes for a picture
        // whose job is aiming.
        maxWidth: this.session.viewportWidth,
        maxHeight: this.session.viewportHeight,
        everyNthFrame: 1,
      });
      this.cdp = cdp;
    } catch (error) {
      this.logger.warn("Live screencast unavailable; falling back to a screenshot a second", { error });
      this.fallback = setInterval(() => {
        if (this.page) void this.snapshot(this.page);
      }, 1_000);
    }
  }

  /** Take a screenshot now and send it, whatever the screencast is doing. */
  async snapshot(page: Page): Promise<void> {
    const frame = await grabFrame(page, this.logger);
    if (frame) this.offer(frame.bytes);
  }

  /**
   * Make sure the viewer sees the effect of what just ran. Chromium only paints
   * when something changed; if nothing did within a moment, send a picture
   * anyway so the studio is not left wondering.
   */
  async refresh(page: Page): Promise<void> {
    const since = Date.now();
    await sleep(600);
    if (this.stopped || this.lastFrameAt >= since) return;
    await this.snapshot(page);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.detach();
  }

  private async detach(): Promise<void> {
    if (this.fallback) clearInterval(this.fallback);
    this.fallback = null;
    const cdp = this.cdp;
    this.cdp = null;
    this.page = null;
    if (!cdp) return;
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }

  private offer(bytes: Uint8Array): void {
    if (this.stopped) return;
    if (bytes.byteLength > STUDIO_FRAME.maxBytes) {
      this.logger.warn("Dropped an oversized preview frame", { bytes: bytes.byteLength });
      return;
    }
    this.lastFrameAt = Date.now();
    this.pending = bytes;
    this.pump();
  }

  private pump(): void {
    if (this.inFlight || !this.pending || this.stopped) return;
    const wait = this.lastSentAt + 1_000 / STUDIO_FRAME.maxFps - Date.now();
    if (wait > 0) {
      this.timer ??= setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }

    const bytes = this.pending;
    this.pending = null;
    this.inFlight = true;
    this.lastSentAt = Date.now();
    this.deps.client
      .postFrame(this.session.id, this.session.leaseToken, {
        bytes,
        width: this.session.viewportWidth,
        height: this.session.viewportHeight,
      })
      .then((accepted) => {
        if (!accepted) this.stopped = true;
      })
      .catch((error: unknown) => {
        // A dropped frame is replaced by the next paint. Never worth more
        // than a debug line.
        this.logger.debug("Dropped a live frame", { error });
      })
      .finally(() => {
        this.inFlight = false;
        this.pump();
      });
  }
}

/**
 * Find the logo in the page header and photograph exactly it.
 *
 * Scored, not guessed: an element earns points for calling itself a logo or
 * brand, for linking to the home page, for sitting in the header or nav, and
 * for being near the top left where logos live. Only a convincing winner is
 * photographed — a wrong logo is worse than the app icon it would replace.
 * Whatever the page reports back is treated as untrusted numbers and clamped.
 */
async function photographHeaderLogo(page: Page): Promise<Uint8Array | null> {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
  const box = await page
    .evaluate(() => {
      let best: { x: number; y: number; width: number; height: number } | null = null;
      let bestScore = 0;
      // Only things that draw: the logo is an image or a vector, and the
      // words that say so are usually on what wraps it ("header__logoLink").
      const nodes = document.querySelectorAll("img, svg, picture");
      for (let index = 0; index < Math.min(nodes.length, 400); index += 1) {
        const element = nodes.item(index);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 12 || rect.width > 420 || rect.height > 160) continue;
        if (rect.top < 0 || rect.top > 220 || rect.left > window.innerWidth * 0.6) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        const link = element.closest("a");
        const named = element.closest("[class*='logo' i], [id*='logo' i], [class*='brand' i], [aria-label*='logo' i]");
        const words = [
          element.getAttribute("class"),
          element.id,
          element.getAttribute("alt"),
          element.getAttribute("aria-label"),
          element.getAttribute("src"),
          link?.getAttribute("aria-label"),
          link?.getAttribute("title"),
        ]
          .join(" ")
          .toLowerCase();
        let score = 0;
        if (named || /logo|brand|wordmark/.test(words)) score += 5;
        if (link) {
          // Home is not always "/": Linear's logo goes to /homepage, Notion's
          // to /product. Any same-site link a step from the root counts.
          try {
            const href = new URL(link.getAttribute("href") ?? "", location.href);
            const depth = href.pathname.split("/").filter(Boolean).length;
            if (href.host === location.host && depth <= 1) score += 3;
          } catch {
            // Not a link we can read; no points.
          }
          if (/home/.test(words)) score += 2;
        }
        if (element.closest("header, nav, [role=banner]")) score += 3;
        score += Math.max(0, 3 - rect.left / 150);
        if (rect.top < 80) score += 1;
        if (score > bestScore) {
          bestScore = score;
          best = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
        }
      }
      return bestScore >= 7 ? best : null;
    })
    .catch(() => null);
  if (!box) return null;

  const viewport = page.viewportSize();
  const pad = 6;
  const x = Math.max(0, Math.floor(Number(box.x) - pad));
  const y = Math.max(0, Math.floor(Number(box.y) - pad));
  const width = Math.min((viewport?.width ?? 1440) - x, Math.ceil(Number(box.width) + pad * 2));
  const height = Math.min((viewport?.height ?? 900) - y, Math.ceil(Number(box.height) + pad * 2));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 20 || height < 10) return null;

  return page
    .screenshot({ type: "png", clip: { x, y, width, height }, scale: "device", animations: "disabled" })
    .catch(() => null);
}

/**
 * Run tasks one at a time, in the order they were queued. Commands and
 * pointer input share one page, and a pointer move landing between a click's
 * move and its press would click somewhere else.
 */
function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * A preview of what the page looks like right now.
 *
 * JPEG at CSS scale, not the device's. A desktop profile renders at scale
 * factor 2, so a device-scale frame would be 2880 pixels wide and several
 * hundred kilobytes — through the database, once a second, for a picture whose
 * only job is to let someone aim a click. The capture itself is lossless and
 * full density; this is not that.
 */
async function grabFrame(
  page: Page,
  logger: Logger,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  try {
    const bytes = await page.screenshot({
      type: "jpeg",
      quality: STUDIO_FRAME.quality,
      fullPage: false,
      scale: "css",
      timeout: 8_000,
    });
    if (bytes.byteLength > STUDIO_FRAME.maxBytes) {
      logger.warn("Dropped an oversized preview frame", { bytes: bytes.byteLength });
      return null;
    }
    const size = page.viewportSize();
    return { bytes, width: size?.width ?? 0, height: size?.height ?? 0 };
  } catch (error) {
    // A frame is a convenience. Losing one must never end a session — pages
    // navigate mid-screenshot all the time, and that is not a failure.
    logger.debug("Could not grab a preview frame", { error });
    return null;
  }
}

/**
 * Let the page reach a photographable state.
 *
 * Deliberately lighter than the crawl path's `settle`: that one freezes every
 * animation so two captures of an unchanged page are byte-comparable, which is
 * right for change detection and wrong here. A researcher capturing a hover
 * state or an opening modal needs the transition to *finish*, not to be
 * abolished — and a frozen page makes it impossible to tell whether a menu is
 * open or simply stuck.
 */
async function settleForFrame(page: Page): Promise<void> {
  await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
  await sleep(250);
}

async function fail(
  deps: SessionDeps,
  session: ClaimedStudioSession,
  code: string,
  message: string,
): Promise<void> {
  await deps.client
    .syncSession(
      session.id,
      {
        leaseToken: session.leaseToken,
        currentUrl: null,
        currentTitle: null,
        live: false,
        results: [],
        failure: { code: code.slice(0, 80), message: message.slice(0, 1_000) },
      },
      null,
    )
    .catch(() => undefined);
}
