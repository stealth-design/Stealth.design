/**
 * Browser capture — capture levels 2 and 3 (§7, §8, §26).
 *
 * Runs Chromium through Playwright to render a page and photograph it. This is
 * the expensive path and the dangerous one: it executes arbitrary JavaScript
 * from an arbitrary website inside our infrastructure.
 *
 * The safety posture, in order of how much it matters:
 *
 *   1. THE SANDBOX STAYS ON. `--no-sandbox` appears nowhere in this file and
 *      must never be added. It is the single control that stands between a
 *      Chromium renderer exploit and the worker process. If Chromium will not
 *      start in a container, the fix is to give the container the privileges
 *      the sandbox needs (a seccomp profile, or `--cap-add SYS_ADMIN` with
 *      user namespaces), never to disable it.
 *   2. The worker holds no secrets to steal. See `loadWorkerEnv`, which refuses
 *      to start if a database URL or storage credential is present.
 *   3. A fresh, isolated browser context per item — no shared cookies, no
 *      storage, no service workers surviving between captures.
 *   4. Request interception: every navigation and subresource host is checked,
 *      so a page cannot use the browser as an SSRF proxy to somewhere the
 *      guard refused.
 *   5. Hard timeouts and a page-weight budget, so one page cannot occupy a
 *      worker indefinitely.
 */
import {
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Route,
  chromium,
  devices,
} from "playwright";
import {
  type Logger,
  type Result,
  ErrorCode,
  err,
  ok,
  sanitizeText,
  sleep,
} from "@uxd/shared";
import {
  DEVICE_PROFILES,
  type DeviceProfile,
  type DeviceProfileKey,
  type InteractionStep,
  type ScreenshotScope,
} from "@uxd/types";
import { extractFromHtml, type ExtractedPage } from "./extract.js";
import { classifyIp } from "./ip.js";
import {
  type GuardFailure,
  type GuardPolicy,
  type GuardedUrl,
  guardUrl,
  hostResolvesToPublicAddress,
} from "./url-guard.js";

/**
 * Let a freshly-navigated page reach a photographable state.
 *
 * Shared by every device profile: a mobile capture that skipped the font wait
 * or the animation freeze would differ from its desktop sibling for reasons
 * that have nothing to do with the device.
 */
async function settle(page: Page, options: BrowserCaptureOptions): Promise<void> {
  // Give client-rendered content a chance to paint, then wait for fonts so
  // text is not photographed mid-swap.
  await Promise.race([
    page.waitForLoadState("load", { timeout: Math.min(8_000, options.navigationTimeoutMs) }),
    sleep(Math.min(8_000, options.navigationTimeoutMs)),
  ]).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  if (options.settleMs && options.settleMs > 0) await sleep(Math.min(options.settleMs, 10_000));

  // Freeze animations so a full-page screenshot is not smeared, and so two
  // captures of an unchanged page produce comparable images.
  await page
    .addStyleTag({
      content: `*, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          scroll-behavior: auto !important;
          caret-color: transparent !important;
        }`,
    })
    .catch(() => {});
}

/**
 * A user agent for a device profile that still says who we are.
 *
 * A mobile capture needs a mobile UA or a site doing server-side device
 * detection serves the desktop page and the screenshot is a desktop
 * screenshot at a narrow width. But adopting an iPhone's UA wholesale would
 * hide a research crawler behind a consumer device, which is the opposite of
 * how this crawler behaves everywhere else — it publishes a contact URL and
 * obeys robots.txt precisely so operators can identify it.
 *
 * So the platform tokens a site needs are present and our own identity is
 * appended rather than replaced.
 */
function userAgentFor(profile: DeviceProfile, baseUserAgent: string): string {
  if (!profile.isMobile) return baseUserAgent;
  return (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 " +
    baseUserAgent
  );
}

/**
 * The SSRF request screen, as a reusable object.
 *
 * Without this the browser is an open SSRF proxy: the guard validated the
 * page's own URL, but the page can then `fetch("http://169.254.169.254/")` or
 * embed an image from an internal host, and the request goes out from inside
 * our network.
 *
 * Extracted from `captureWithBrowser` so the capture studio's long-lived
 * context gets the identical screen rather than a second implementation of it.
 * A screen that exists in two places is a screen that will eventually differ in
 * two places, and the half that drifts is the half nobody is testing.
 *
 * One instance per logical capture; `attach` may be called on several contexts
 * (one per device profile) and each gets its own page-weight budget.
 */
export interface RequestScreenOptions {
  /** Per-context byte budget. */
  readonly maxPageBytes: number;
  readonly guardPolicy?: GuardPolicy;
  readonly logger?: Logger;
  /** Named in the debug line when a subresource is refused. */
  readonly pageUrl?: string;
}

export interface RequestScreen {
  readonly attach: (ctx: BrowserContext) => Promise<void>;
  readonly stats: () => {
    readonly resourceCount: number;
    readonly bytesTransferred: number;
    readonly blockedRequestCount: number;
  };
}

export function createRequestScreen(options: RequestScreenOptions): RequestScreen {
  const { logger } = options;
  let resourceCount = 0;
  let bytesTransferred = 0;
  let blockedRequestCount = 0;

  /**
   * One verdict per hostname per capture.
   *
   * The promise itself is cached, not the result, so N simultaneous requests
   * to the same new host share one lookup instead of starting N of them —
   * which is how a page with a hundred images from one CDN would otherwise
   * behave.
   */
  const hostVerdicts = new Map<string, Promise<{ allowed: boolean; reason: string | null }>>();
  const screenHost = (host: string) => {
    const cached = hostVerdicts.get(host);
    if (cached) return cached;
    const pending = hostResolvesToPublicAddress(host, { logger, ...(options.guardPolicy ?? {}) });
    hostVerdicts.set(host, pending);
    return pending;
  };

  const attach = async (ctx: BrowserContext): Promise<void> => {
    // The page-weight budget is per context, not per capture. It was briefly
    // shared, and the effect was immediate: the desktop pass spent the whole
    // allowance, so the mobile context's *first* request — the main document —
    // was already over budget and aborted. Two sites came back as
    // `ERR_BLOCKED_BY_CLIENT`, blocked by us.
    //
    // Per context is also the right meaning. The budget exists to stop one
    // page consuming the worker indefinitely, and each profile loads the page
    // once.
    let contextBytes = 0;

    // Counted here rather than on the primary page, so a secondary profile's
    // traffic is measured against its own budget and still contributes to the
    // total the capture reports.
    ctx.on("response", (response) => {
      resourceCount += 1;
      const length = Number(response.headers()["content-length"] ?? 0);
      if (!Number.isFinite(length)) return;
      contextBytes += length;
      bytesTransferred += length;
    });

    await ctx.route("**/*", async (route: Route) => {
      const requestUrl = route.request().url();
      try {
        const parsed = new URL(requestUrl);

        // Only http(s). data: and blob: are same-document and harmless;
        // everything else is refused.
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
            await route.continue();
            return;
          }
          blockedRequestCount += 1;
          await route.abort("blockedbyclient");
          return;
        }

        const host = parsed.hostname.replace(/\.$/, "");
        const isLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");

        // A literal address needs no lookup. A name does: a suffix check alone
        // would pass `evil.example.com` pointing at 10.0.0.5, and the browser
        // would then reach an internal host on behalf of a page we do not
        // control.
        const verdict = isLiteral
          ? classifyIp(host.startsWith("[") ? host.slice(1, -1) : host)
          : await screenHost(host);

        if (!verdict.allowed) {
          blockedRequestCount += 1;
          logger?.debug("Blocked a subresource request from a crawled page", {
            pageUrl: options.pageUrl,
            blocked: requestUrl.slice(0, 200),
          });
          await route.abort("blockedbyclient");
          return;
        }

        // Page-weight budget. A page that keeps loading past the budget gets
        // its remaining requests refused rather than being allowed to consume
        // the worker's bandwidth and memory indefinitely.
        if (contextBytes > options.maxPageBytes) {
          blockedRequestCount += 1;
          await route.abort("blockedbyclient");
          return;
        }

        await route.continue();
      } catch {
        blockedRequestCount += 1;
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
  };

  return {
    attach,
    stats: () => ({ resourceCount, bytesTransferred, blockedRequestCount }),
  };
}

/**
 * A browser context for one device profile, with the request screen attached.
 *
 * Every property that matters is set here because Playwright fixes them at
 * context creation: `deviceScaleFactor`, `isMobile` and `hasTouch` have no
 * setters, so a "mobile" capture taken by resizing a desktop context is a
 * desktop capture at a narrow width. That is exactly what this replaces.
 *
 * `screen` takes the context through the same SSRF request screen as the
 * primary one. It is a parameter rather than something this function could
 * forget to do.
 */
export async function newGuardedContext(
  browser: Browser,
  profile: DeviceProfile,
  options: BrowserCaptureOptions,
  screen: (ctx: BrowserContext) => Promise<void>,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    userAgent: userAgentFor(profile, options.userAgent),
    locale: "en-US",
    timezoneId: "UTC",
    permissions: [],
    storageState: undefined,
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    bypassCSP: false,
  });
  context.setDefaultNavigationTimeout(options.navigationTimeoutMs);
  context.setDefaultTimeout(options.navigationTimeoutMs);
  await screen(context);
  return context;
}

/**
 * Chromium launch flags.
 *
 * Note what is NOT here: `--no-sandbox` and `--disable-setuid-sandbox`. Every
 * flag below reduces attack surface or resource use; none of them weakens
 * process isolation.
 */
const CHROMIUM_ARGS: readonly string[] = [
  // Deny the page any ability to prompt, autoplay, or notify.
  "--disable-notifications",
  "--disable-popup-blocking=false",
  "--autoplay-policy=user-gesture-required",
  // Features we never want a crawled page to reach.
  "--disable-background-networking",
  "--disable-sync",
  "--disable-domain-reliability",
  "--disable-client-side-phishing-detection",
  "--disable-component-update",
  "--disable-breakpad",
  "--no-default-browser-check",
  "--no-first-run",
  "--disable-extensions",
  "--disable-plugins",
  // Deterministic rendering, so two captures of an unchanged page match.
  "--force-color-profile=srgb",
  "--disable-lcd-text",
  "--hide-scrollbars",
  "--font-render-hinting=none",
  // /dev/shm is small in most containers; without this Chromium crashes on
  // heavy pages. It trades shared memory for disk, not security.
  "--disable-dev-shm-usage",
  // Cap the renderer's memory so one enormous page cannot take down the host.
  "--js-flags=--max-old-space-size=512",
];

export interface BrowserPoolOptions {
  readonly logger?: Logger;
  /** Chromium executable, when supplying your own build. */
  readonly executablePath?: string;
  readonly headless?: boolean;
}

/**
 * A single long-lived browser with a fresh context per capture.
 *
 * Launching Chromium takes 300-800ms, so relaunching per URL would dominate a
 * 250-page job. Contexts are cheap and are fully isolated from one another,
 * which gives per-item cleanliness without per-item launch cost.
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private capturesSinceLaunch = 0;

  /**
   * Recycle the browser periodically. Chromium's memory grows slowly across
   * many navigations, and a scheduled restart is cheaper than diagnosing a slow
   * leak in a long-running worker.
   */
  private static readonly MAX_CAPTURES_PER_BROWSER = 200;

  private readonly options: BrowserPoolOptions;

  constructor(options: BrowserPoolOptions = {}) {
    this.options = options;
  }

  async get(): Promise<Browser> {
    if (this.browser?.isConnected() && this.capturesSinceLaunch < BrowserPool.MAX_CAPTURES_PER_BROWSER) {
      return this.browser;
    }
    if (this.browser) await this.close();
    if (this.launching) return this.launching;

    this.launching = chromium
      .launch({
        headless: this.options.headless ?? true,
        args: [...CHROMIUM_ARGS],
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
        // Kill a browser that will not shut down cleanly.
        timeout: 60_000,
      })
      .then((browser) => {
        this.browser = browser;
        this.capturesSinceLaunch = 0;
        this.launching = null;
        this.options.logger?.info("Chromium launched", { version: browser.version() });
        browser.on("disconnected", () => {
          this.browser = null;
        });
        return browser;
      })
      .catch((error: unknown) => {
        this.launching = null;
        throw error;
      });

    return this.launching;
  }

  noteCapture(): void {
    this.capturesSinceLaunch += 1;
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => {});
  }

  get version(): string | null {
    return this.browser?.isConnected() ? this.browser.version() : null;
  }
}

export interface CaptureScreenshot {
  readonly scope: ScreenshotScope;
  readonly deviceProfile: DeviceProfileKey;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly label: string;
}

export interface InteractionCapture {
  readonly step: InteractionStep;
  readonly beforeScreenshot: CaptureScreenshot | null;
  readonly afterScreenshot: CaptureScreenshot | null;
  readonly succeeded: boolean;
  readonly note: string;
}

export interface BrowserCaptureResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly httpStatus: number | null;
  readonly redirectChain: readonly { status: number; url: string }[];
  readonly html: string;
  readonly extracted: ExtractedPage;
  readonly screenshots: readonly CaptureScreenshot[];
  readonly interactions: readonly InteractionCapture[];
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly loadTimeMs: number;
  readonly durationMs: number;
  readonly resourceCount: number;
  readonly bytesTransferred: number;
  readonly browserName: string;
  readonly browserVersion: string;
  readonly userAgent: string;
  /** Console errors and failed subresources, sanitised and capped. */
  readonly browserErrors: readonly string[];
  readonly warnings: readonly { code: string; message: string }[];
  readonly blockedRequestCount: number;
}

export interface BrowserCaptureOptions {
  readonly pool: BrowserPool;
  readonly guarded: GuardedUrl;
  readonly deviceProfiles: readonly DeviceProfileKey[];
  readonly fullPage: boolean;
  readonly viewport: boolean;
  readonly userAgent: string;
  readonly navigationTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxPageBytes: number;
  readonly guardPolicy?: GuardPolicy;
  readonly interactionSteps?: readonly InteractionStep[];
  readonly logger?: Logger;
  /** Wait this long after load for late-rendering content to settle. */
  readonly settleMs?: number;
}

const MAX_BROWSER_ERRORS = 25;
const MAX_FULL_PAGE_HEIGHT = 20_000;

export async function captureWithBrowser(
  options: BrowserCaptureOptions,
): Promise<Result<BrowserCaptureResult, GuardFailure>> {
  const startedAt = performance.now();
  // The URL to navigate to, which is not the dedupe identity: the
  // normalised form drops a trailing slash and a great many sites 301 the
  // slashless path to the slashed one. See `ParsedUrl.fetchUrl`.
  const url = options.guarded.parsed.fetchUrl;
  const logger = options.logger;

  const browser = await options.pool.get();
  options.pool.noteCapture();

  const browserErrors: string[] = [];
  const warnings: { code: string; message: string }[] = [];
  const redirectChain: { status: number; url: string }[] = [];
  // One screen for the whole capture: shared host verdicts and shared totals
  // across every device profile, with a separate byte budget per context.
  const screen = createRequestScreen({
    maxPageBytes: options.maxPageBytes,
    guardPolicy: options.guardPolicy,
    logger,
    pageUrl: url,
  });

  const primaryProfileKey = options.deviceProfiles[0] ?? "desktop_1440";
  const primaryProfile = DEVICE_PROFILES[primaryProfileKey];

  let context: BrowserContext | null = null;
  try {
    context = await browser.newContext({
      viewport: { width: primaryProfile.width, height: primaryProfile.height },
      deviceScaleFactor: primaryProfile.deviceScaleFactor,
      isMobile: primaryProfile.isMobile,
      hasTouch: primaryProfile.hasTouch,
      // Via the same helper as a secondary profile, so a job that makes mobile
      // the *primary* profile does not quietly get a desktop user agent.
      userAgent: userAgentFor(primaryProfile, options.userAgent),
      locale: "en-US",
      timezoneId: "UTC",
      // A page must not be able to ask for anything, and must not be granted
      // anything it does ask for.
      permissions: [],
      // No credentials, no storage carried in or out.
      storageState: undefined,
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      // Reduce fingerprint-driven behaviour differences between captures.
      colorScheme: "light",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      bypassCSP: false,
    });

    context.setDefaultNavigationTimeout(options.navigationTimeoutMs);
    context.setDefaultTimeout(options.navigationTimeoutMs);

    await screen.attach(context);

    const page = await context.newPage();

    page.on("console", (message: ConsoleMessage) => {
      if (message.type() !== "error" || browserErrors.length >= MAX_BROWSER_ERRORS) return;
      const text = sanitizeText(message.text(), { maxLength: 500 });
      if (text) browserErrors.push(`console: ${text}`);
    });
    page.on("pageerror", (error) => {
      if (browserErrors.length >= MAX_BROWSER_ERRORS) return;
      const text = sanitizeText(error.message, { maxLength: 500 });
      if (text) browserErrors.push(`page: ${text}`);
    });
    page.on("requestfailed", (req) => {
      if (browserErrors.length >= MAX_BROWSER_ERRORS) return;
      const failure = req.failure()?.errorText ?? "unknown";
      // Our own blocks are expected, not page errors.
      if (failure.includes("BLOCKED_BY_CLIENT")) return;
      const text = sanitizeText(`${failure} ${req.url()}`, { maxLength: 300 });
      if (text) browserErrors.push(`request: ${text}`);
    });
    page.on("response", (response) => {
      // Bytes and resource counts are tallied per context in `screenRequest`.
      // Only the redirect chain is page-specific: it describes how the primary
      // navigation reached the document being extracted.
      const status = response.status();
      if (status >= 300 && status < 400 && response.request().isNavigationRequest()) {
        const location = response.headers().location;
        if (location) redirectChain.push({ status, url: location.slice(0, 2048) });
      }
    });

    // --- Navigate ---------------------------------------------------------
    const loadStart = performance.now();
    const response = await page.goto(url, {
      // `domcontentloaded` rather than `networkidle`: a page with analytics
      // beacons, chat widgets or polling never reaches network idle, and
      // waiting for it turns every such capture into a timeout. The explicit
      // settle below covers late rendering.
      waitUntil: "domcontentloaded",
      timeout: options.navigationTimeoutMs,
    });
    const loadTimeMs = Math.round(performance.now() - loadStart);

    if (!response) {
      return err({
        kind: "DNS_FAILED",
        errorCode: ErrorCode.NAVIGATION_FAILED,
        message: "The browser could not load the page at all.",
        rule: "no-response",
        url,
      });
    }

    await settle(page, options);

    const finalUrl = page.url();
    const html = (await page.content().catch(() => "")).slice(0, options.maxPageBytes);

    const dimensions = await page
      .evaluate(() => ({
        width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
        height: Math.max(document.documentElement.scrollHeight, window.innerHeight),
      }))
      .catch(() => ({ width: primaryProfile.width, height: primaryProfile.height }));

    // --- Screenshots ------------------------------------------------------
    //
    // A secondary profile gets its own browser context, not a resize of this
    // one. `page.setViewportSize` changes width and height and nothing else:
    // `deviceScaleFactor`, `isMobile` and `hasTouch` are fixed when a context
    // is created and there is no setter for them.
    //
    // Resizing therefore produced a "mobile" screenshot rendered by a desktop
    // context — 780px wide where the 390x844 profile at 3x asks for 1170, with
    // `isMobile` false, no touch, and a desktop user agent. Responsive CSS
    // still keyed off the viewport width so the *layout* looked right, which
    // is what made it survive review; what was wrong was everything a site
    // learns about the device by other means, and the recorded
    // `device_scale_factor` of 3, which was never true.
    const screenshots: CaptureScreenshot[] = [];
    for (const profileKey of options.deviceProfiles) {
      const profile = DEVICE_PROFILES[profileKey];
      let profilePage = page;
      let profileContext: BrowserContext | null = null;

      if (profileKey !== primaryProfileKey) {
        profileContext = await newGuardedContext(browser, profile, options, screen.attach);
        profilePage = await profileContext.newPage();
        // The final URL, so a redirect is not followed a second time and the
        // two profiles are guaranteed to be looking at the same document.
        await profilePage.goto(finalUrl, {
          waitUntil: "domcontentloaded",
          timeout: options.navigationTimeoutMs,
        });
        await settle(profilePage, options);
      }

      try {

        if (options.viewport) {
          const shot = await takeScreenshot(profilePage, "viewport", profileKey, options.logger);
          if (shot) screenshots.push(shot);
          else warnings.push({ code: "SCREENSHOT_FAILED", message: `Viewport screenshot failed for ${profile.label}.` });
        }

        if (options.fullPage) {
          const pageHeight = await profilePage
            .evaluate(() => document.documentElement.scrollHeight)
            .catch(() => 0);
          if (pageHeight > MAX_FULL_PAGE_HEIGHT) {
            // An infinite-scroll page reports an ever-growing height; a
            // full-page shot of it would be enormous and useless.
            warnings.push({
              code: "PAGE_TOO_TALL",
              message: `The page is ${pageHeight}px tall (over ${MAX_FULL_PAGE_HEIGHT}px), so only the top was captured full-page.`,
            });
          }
          // Scroll through the page first, so lazy-loaded images below the fold
          // are actually loaded before the screenshot is taken. Without this a
          // full-page capture of a modern site is mostly empty placeholders.
          await autoScroll(profilePage, Math.min(pageHeight, MAX_FULL_PAGE_HEIGHT)).catch(() => {});
          const shot = await takeScreenshot(profilePage, "full_page", profileKey, options.logger);
          if (shot) screenshots.push(shot);
          else warnings.push({ code: "SCREENSHOT_FAILED", message: `Full-page screenshot failed for ${profile.label}.` });
        }
      } finally {
        // The primary context belongs to the caller and outlives this loop.
        if (profileContext) await profileContext.close().catch(() => {});
      }
    }

    // --- Interactions (level 3) ------------------------------------------
    const interactions: InteractionCapture[] = [];
    if (options.interactionSteps && options.interactionSteps.length > 0) {
      for (const step of options.interactionSteps) {
        interactions.push(await runInteraction(page, step, primaryProfileKey, options.logger));
      }
    }

    const extracted = extractFromHtml(html, { pageUrl: finalUrl });

    return ok({
      requestedUrl: url,
      finalUrl,
      httpStatus: response.status(),
      redirectChain,
      html,
      extracted,
      screenshots,
      interactions,
      pageWidth: dimensions.width,
      pageHeight: dimensions.height,
      loadTimeMs,
      durationMs: Math.round(performance.now() - startedAt),
      resourceCount: screen.stats().resourceCount,
      bytesTransferred: screen.stats().bytesTransferred,
      browserName: "chromium",
      browserVersion: browser.version(),
      userAgent: options.userAgent,
      browserErrors,
      warnings,
      blockedRequestCount: screen.stats().blockedRequestCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "capture failed";
    const isTimeout = /timeout|Timeout/i.test(message);
    logger?.warn("Browser capture failed", { url, error });
    return err({
      kind: "DNS_FAILED",
      errorCode: isTimeout ? ErrorCode.CAPTURE_TIMEOUT : ErrorCode.CAPTURE_FAILED,
      message: isTimeout
        ? `The page did not finish loading within ${Math.round(options.navigationTimeoutMs / 1000)}s.`
        : `The browser could not capture this page: ${message.slice(0, 200)}`,
      rule: isTimeout ? "navigation-timeout" : "browser-error",
      url,
    });
  } finally {
    // Always tear the context down. A leaked context keeps its renderer
    // process — and whatever the page was doing in it — alive.
    if (context) await context.close().catch(() => {});
  }
}

async function takeScreenshot(
  page: Page,
  scope: ScreenshotScope,
  deviceProfile: DeviceProfileKey,
  logger?: Logger,
): Promise<CaptureScreenshot | null> {
  const profile = DEVICE_PROFILES[deviceProfile];
  try {
    const bytes = await page.screenshot({
      type: "png",
      fullPage: scope === "full_page",
      // Playwright's own cap; the page-height warning above is the operator
      // facing version of the same limit.
      timeout: 30_000,
      animations: "disabled",
      caret: "hide",
      scale: "device",
    });
    const height =
      scope === "full_page"
        ? await page.evaluate(() => document.documentElement.scrollHeight).catch(() => profile.height)
        : profile.height;
    return {
      scope,
      deviceProfile,
      bytes: new Uint8Array(bytes),
      width: profile.width,
      height,
      label: `${profile.label} — ${scope === "full_page" ? "full page" : "viewport"}`,
    };
  } catch (error) {
    logger?.warn("Screenshot failed", { scope, deviceProfile, error });
    return null;
  }
}

/**
 * Scroll the page to trigger lazy loading, then return to the top.
 *
 * Modern sites load most images on scroll, so a full-page screenshot taken
 * without this is a column of grey placeholders. Bounded by both height and
 * iteration count, because an infinite-scroll page will keep growing for as
 * long as it is scrolled.
 */
async function autoScroll(page: Page, maxHeight: number): Promise<void> {
  await page.evaluate(async (limit: number) => {
    const step = window.innerHeight * 0.8;
    let position = 0;
    let iterations = 0;
    while (position < limit && iterations < 40) {
      window.scrollTo(0, position);
      position += step;
      iterations += 1;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    window.scrollTo(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }, maxHeight);
}

/**
 * Perform one operator-defined interaction and photograph before and after.
 *
 * The deliberately narrow scope from §8: this executes a step a *person* wrote,
 * using a selector they supplied. It does not go looking for things to click.
 * A system that autonomously interacts with arbitrary websites would submit
 * forms, trigger purchases and send messages, which is not something to build
 * speculatively.
 *
 * The selector is untrusted input and is only ever passed to Playwright's
 * locator API — never interpolated into `page.evaluate`, where it would become
 * code running in the page.
 */
async function runInteraction(
  page: Page,
  step: InteractionStep,
  deviceProfile: DeviceProfileKey,
  logger?: Logger,
): Promise<InteractionCapture> {
  const before = await takeScreenshot(page, "viewport", deviceProfile, logger);

  try {
    if (step.type === "scroll") {
      if (step.selector) {
        await page.locator(step.selector).first().scrollIntoViewIfNeeded({ timeout: 5_000 });
      } else {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      }
    } else {
      if (!step.selector) {
        return {
          step,
          beforeScreenshot: before,
          afterScreenshot: null,
          succeeded: false,
          note: `A ${step.type} interaction needs a selector.`,
        };
      }
      const locator = page.locator(step.selector).first();
      await locator.waitFor({ state: "visible", timeout: 5_000 });

      switch (step.type) {
        case "hover":
          await locator.hover({ timeout: 5_000 });
          break;
        case "focus":
          await locator.focus({ timeout: 5_000 });
          break;
        case "click":
        case "dropdown":
        case "modal":
        case "accordion":
        case "tabs":
        case "carousel":
        case "menu":
        case "drawer":
          // A click with no navigation expected. `noWaitAfter` keeps a click
          // that does navigate from hanging the step.
          await locator.click({ timeout: 5_000, noWaitAfter: true });
          break;
        case "tooltip":
          await locator.hover({ timeout: 5_000 });
          break;
        default:
          return {
            step,
            beforeScreenshot: before,
            afterScreenshot: null,
            succeeded: false,
            note: `The ${step.type} interaction is modelled but not automated in V1. Capture it by hand.`,
          };
      }
    }

    await sleep(Math.min(step.settleMs ?? 500, 10_000));
    const after = await takeScreenshot(page, "viewport", deviceProfile, logger);

    return {
      step,
      beforeScreenshot: before,
      afterScreenshot: after,
      succeeded: after !== null,
      note: after ? `Captured a ${step.type} interaction.` : "The after-state screenshot failed.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "interaction failed";
    logger?.debug("Interaction step failed", { type: step.type, error });
    return {
      step,
      beforeScreenshot: before,
      afterScreenshot: null,
      succeeded: false,
      // A missing element is the common case and is not an error worth
      // failing the whole capture over — the page changed, or the selector
      // was wrong, and the operator needs to know which.
      note: /waiting for|not visible|Timeout/i.test(message)
        ? `Could not find "${step.selector}" on the page. The selector may be out of date.`
        : `The interaction failed: ${message.slice(0, 160)}`,
    };
  }
}

/**
 * Verify the browser can start at all, with the sandbox on.
 *
 * Exposed as a worker health check, because "Chromium will not launch" is the
 * failure most likely to strand an ingestion job at Queued, and it should be
 * diagnosable from the CMS rather than from a container log.
 */
export async function verifyBrowser(
  pool: BrowserPool,
): Promise<{ ok: boolean; version: string | null; error: string | null }> {
  try {
    const browser = await pool.get();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<html><body>ok</body></html>");
    const text = await page.textContent("body");
    await context.close();
    return { ok: text === "ok", version: browser.version(), error: null };
  } catch (error) {
    return {
      ok: false,
      version: null,
      error:
        error instanceof Error
          ? `${error.message.slice(0, 300)}. If this is a container, the sandbox needs a seccomp profile or user namespaces — do not disable it.`
          : "Chromium could not be started.",
    };
  }
}

/** Playwright's device descriptors, for the profiles that map to one. */
export function playwrightDeviceFor(profileKey: DeviceProfileKey) {
  // `DEVICE_PROFILES` is declared with `satisfies`, which preserves each
  // entry's literal type — so `playwrightDevice` is absent from the type of
  // the desktop profiles that do not set it. Widening to the interface is the
  // correct read here.
  const profile: DeviceProfile = DEVICE_PROFILES[profileKey];
  return profile.playwrightDevice ? devices[profile.playwrightDevice] : undefined;
}

/** Guard a URL and capture it, in one call. */
export async function guardAndCapture(
  url: string,
  options: Omit<BrowserCaptureOptions, "guarded">,
): Promise<Result<BrowserCaptureResult, GuardFailure>> {
  const guarded = await guardUrl(url, options.guardPolicy ?? {});
  if (!guarded.ok) return err(guarded.error);
  return captureWithBrowser({ ...options, guarded: guarded.value });
}
