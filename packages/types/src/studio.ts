/**
 * The capture studio — a live browser a researcher drives (§2, §3, §13).
 *
 * The product requirement is that a person opens the target page, navigates to
 * the exact state they want — nav open, search open, a modal up — and only then
 * presses Capture. That means a browser that stays open and takes instructions,
 * which is a different shape of work from the queue: a crawl item is one
 * request the worker answers and forgets, a studio session is a conversation.
 *
 * How the conversation travels
 * ----------------------------
 * The worker still holds no credentials and still cannot be reached from
 * anywhere (§25) — it dials out to the control plane and nothing dials in. So
 * the session is a pair of durable queues in Postgres rather than a socket:
 *
 *   CMS  --> capture_session_commands  --> worker   (what to do next)
 *   CMS  <-- capture_sessions.frame    <-- worker   (what the page looks like)
 *
 * The worker long-polls for commands and posts back a JPEG of the viewport.
 * That is not a video stream and is not trying to be: a frame after every
 * action, and roughly one a second while a viewer is watching, is enough to
 * steer a page to a state, and it costs one HTTP round trip instead of a
 * bidirectional transport the isolation boundary would have to grow a hole for.
 *
 * Putting both queues in the database rather than in the CMS process's memory
 * is what makes the session survive a Next.js hot reload, a CMS restart, and
 * the operator closing the tab and coming back.
 */

import { z } from "zod";

export const CAPTURE_SESSION_STATUSES = [
  /** Created by an operator. No worker has picked it up yet. */
  "pending",
  /** A worker claimed it and is opening the browser. */
  "starting",
  /** The page is open and taking commands. */
  "live",
  /** Finished normally — the operator closed it. */
  "closed",
  /** The browser or the target URL failed. `errorMessage` says how. */
  "failed",
  /** Nobody drove it for long enough that the worker reclaimed the browser. */
  "expired",
] as const;

export type CaptureSessionStatus = (typeof CAPTURE_SESSION_STATUSES)[number];

export interface CaptureSessionStatusMeta {
  readonly label: string;
  readonly description: string;
  readonly tone: "neutral" | "info" | "progress" | "success" | "danger";
  /** The browser is (or should be) alive: the studio keeps polling. */
  readonly isActive: boolean;
}

export const CAPTURE_SESSION_STATUS_META: Record<CaptureSessionStatus, CaptureSessionStatusMeta> = {
  pending: {
    label: "Waiting for a worker",
    description: "Queued. A capture worker will open the browser shortly.",
    tone: "info",
    isActive: true,
  },
  starting: {
    label: "Opening",
    description: "A worker is loading the page.",
    tone: "progress",
    isActive: true,
  },
  live: {
    label: "Live",
    description: "The browser is open and following your input.",
    tone: "success",
    isActive: true,
  },
  closed: {
    label: "Closed",
    description: "The session ended normally.",
    tone: "neutral",
    isActive: false,
  },
  failed: {
    label: "Failed",
    description: "The browser could not open the page.",
    tone: "danger",
    isActive: false,
  },
  expired: {
    label: "Expired",
    description: "Idle too long, so the browser was released.",
    tone: "neutral",
    isActive: false,
  },
};

export const SESSION_COMMAND_STATUSES = ["pending", "running", "done", "failed"] as const;
export type SessionCommandStatus = (typeof SESSION_COMMAND_STATUSES)[number];

/**
 * What the operator can ask the live page to do.
 *
 * Deliberately a small, closed set of *input events*, not a scripting surface.
 * Every one maps to a Playwright input call on a page the worker already
 * owns — there is no command that evaluates operator-supplied JavaScript,
 * because the studio is a way to reach a visual state, not a way to run code
 * inside the capture sandbox.
 */
export const SESSION_COMMAND_TYPES = [
  "navigate",
  "back",
  "forward",
  "reload",
  "move",
  "click",
  "scroll",
  "key",
  "type",
  /** Take the Screen. The only command that creates a record. */
  "capture",
  /** Send a fresh frame; changes nothing on the page. */
  "refresh",
  "close",
  /**
   * Turn automatic cookie-banner dismissal on or off. Not an input event, but
   * not script either: it chooses between two fixed behaviours the worker
   * already has. Changing it restarts the browser at the same URL, because a
   * site remembers the opt-out in cookies — keeping them would hide the banner
   * the operator turned dismissal off to see.
   */
  "consent",
] as const;

export type SessionCommandType = (typeof SESSION_COMMAND_TYPES)[number];

/**
 * Coordinates are CSS pixels inside the page viewport, with the origin at the
 * top left — the same space Playwright's mouse API uses. The studio scales
 * them from the displayed frame before sending, so a researcher on a small
 * laptop and one on a large monitor produce identical clicks.
 */
const coordinate = z.number().min(0).max(20_000);

export const sessionCommandPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().min(1).max(2_048) }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("forward") }),
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("move"), x: coordinate, y: coordinate }),
  z.object({
    type: z.literal("click"),
    x: coordinate,
    y: coordinate,
    button: z.enum(["left", "middle", "right"]).default("left"),
    clickCount: z.number().int().min(1).max(3).default(1),
    modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4).default([]),
  }),
  z.object({
    type: z.literal("scroll"),
    x: coordinate,
    y: coordinate,
    deltaX: z.number().min(-20_000).max(20_000).default(0),
    deltaY: z.number().min(-20_000).max(20_000).default(0),
  }),
  z.object({
    type: z.literal("key"),
    /** A Playwright key name: "Enter", "Escape", "Tab", "ArrowDown", "a". */
    key: z.string().min(1).max(40),
  }),
  z.object({ type: z.literal("type"), text: z.string().min(1).max(2_000) }),
  z.object({
    type: z.literal("capture"),
    screenName: z.string().min(1).max(200),
    description: z.string().max(2_000).optional(),
    /** "Navigation open", "Search open" — the thing that makes this state
     * worth having as its own Screen. */
    stateLabel: z.string().max(120).optional(),
  }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("close") }),
  z.object({ type: z.literal("consent"), dismiss: z.boolean() }),
]);

/**
 * Pointer and wheel input from the studio.
 *
 * Not commands: nothing is recorded, only the latest pointer position counts,
 * and wheel deltas are summed. That is what lets the studio send the pointer
 * as the hand moves — real hover, no gesture to learn — without writing a
 * database row per mouse event.
 */
export const studioLiveInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pointer"), x: coordinate, y: coordinate }),
  z.object({
    kind: z.literal("wheel"),
    x: coordinate,
    y: coordinate,
    deltaX: z.number().min(-20_000).max(20_000).default(0),
    deltaY: z.number().min(-20_000).max(20_000).default(0),
  }),
]);

export type StudioLiveInput = z.infer<typeof studioLiveInputSchema>;

/** Cookie-banner dismissal is on unless the operator turns it off. */
export const STUDIO_DISMISS_CONSENT_DEFAULT = true;

export type SessionCommandPayload = z.infer<typeof sessionCommandPayloadSchema>;

/**
 * Live-view frames.
 *
 * The frame is a preview for steering, never the research image: the Screen
 * itself is re-photographed as a lossless PNG at the profile's full device
 * scale factor at the moment Capture is pressed (§3, §15).
 *
 * Frames come from Chromium's own screencast, which paints a new one whenever
 * the page changes rather than on a timer — so an idle page costs nothing and
 * an opening menu streams smoothly. They travel worker -> CMS relay -> studio
 * without touching the database; only one every `persistEveryMs` is written
 * there, as the picture a viewer sees if they arrive after a restart.
 */
export const STUDIO_FRAME = {
  format: "jpeg",
  quality: 70,
  /** CSS-pixel scale: one frame pixel per CSS pixel, whatever the profile's
   * device scale factor is. */
  scale: "css",
  /** Never accept a frame larger than this. A frame that exceeds it is
   * evidence of a bug, not a page worth previewing. */
  maxBytes: 4 * 1024 * 1024,
  /** At most this many frames a second leave the worker. Chromium can paint
   * at 60 on an animated page; the eye steering a click does not need it. */
  maxFps: 24,
  /** How often a frame is also written to the database. */
  persistEveryMs: 2_000,
  /** A viewer's stream re-sends the latest frame this often when the page is
   * still, so the connection never looks dead to a proxy. */
  keepAliveMs: 5_000,
} as const;

/** Session lifetime bounds. */
export const STUDIO_LIMITS = {
  /** A session with no viewer and no command for this long is released. */
  idleTimeoutMs: 5 * 60_000,
  /** Hard ceiling regardless of activity, so a forgotten tab cannot hold a
   * browser for a day. */
  maxSessionMs: 60 * 60_000,
  /** How long the worker holds a claim before another worker may take over. */
  leaseSeconds: 90,
  /** How long the worker's command poll is held open. A new command wakes it
   * at once, so this only bounds how often an idle session checks in. */
  commandPollMs: 10_000,
  /** Same, for pointer and wheel input. */
  inputPollMs: 10_000,
  /** How long a lease confirmed by the database is trusted by the live relay
   * before it is checked again. */
  leaseCacheMs: 15_000,
  /** An open session is reused only if its worker checked in this recently. */
  reuseHeartbeatMs: 20_000,
  /** A viewer seen more recently than this counts as active. */
  viewerActiveMs: 6_000,
  /** Most Screens one session may produce, so a runaway client cannot fill the
   * library from a single browser. */
  maxScreensPerSession: 200,
} as const;

/**
 * The device profiles the studio offers.
 *
 * Only two, and both are fixed at context creation — Playwright cannot change
 * `deviceScaleFactor`, `isMobile` or `hasTouch` on a live context, so "switch
 * to mobile" means a new session, not a resize. Naming them here rather than
 * accepting any profile key keeps that promise visible at the type level.
 */
export const STUDIO_PROFILES = ["desktop_1440", "mobile_390"] as const;
export type StudioProfile = (typeof STUDIO_PROFILES)[number];
