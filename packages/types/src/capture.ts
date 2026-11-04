/**
 * Capture vocabulary: platforms, devices, capture levels and interactions.
 */

export const PLATFORMS = ["web", "ios", "android", "macos", "windows", "linux", "tvos", "watchos", "other"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  web: "Web",
  ios: "iOS",
  android: "Android",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  tvos: "tvOS",
  watchos: "watchOS",
  other: "Other",
};

export const DEVICE_CLASSES = ["desktop", "laptop", "tablet", "mobile", "tv", "watch", "other"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const DEVICE_CLASS_LABELS: Record<DeviceClass, string> = {
  desktop: "Desktop",
  laptop: "Laptop",
  tablet: "Tablet",
  mobile: "Mobile",
  tv: "TV",
  watch: "Watch",
  other: "Other",
};

/**
 * Device profiles used for capture.
 *
 * Kept as data so a job's "capture desktop + mobile" toggle resolves to
 * concrete, reproducible viewports that get recorded on the capture row. That
 * is what makes a recapture comparable to the capture before it (§12) — a
 * screenshot at an unrecorded viewport cannot be diffed against anything.
 */
export interface DeviceProfile {
  readonly key: string;
  readonly label: string;
  readonly deviceClass: DeviceClass;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
  /** Playwright device descriptor name, when one matches. */
  readonly playwrightDevice?: string;
}

export const DEVICE_PROFILES = {
  desktop_1440: {
    key: "desktop_1440",
    label: "Desktop — 1440×900",
    deviceClass: "desktop",
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
  desktop_1920: {
    key: "desktop_1920",
    label: "Desktop — 1920×1080",
    deviceClass: "desktop",
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  laptop_1280: {
    key: "laptop_1280",
    label: "Laptop — 1280×800",
    deviceClass: "laptop",
    width: 1280,
    height: 800,
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
  tablet_820: {
    key: "tablet_820",
    label: "Tablet — 820×1180",
    deviceClass: "tablet",
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: "iPad (gen 7)",
  },
  mobile_390: {
    key: "mobile_390",
    label: "Mobile — 390×844",
    deviceClass: "mobile",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: "iPhone 13",
  },
  mobile_360: {
    key: "mobile_360",
    label: "Mobile — 360×800 (Android)",
    deviceClass: "mobile",
    width: 360,
    height: 800,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    playwrightDevice: "Pixel 5",
  },
} as const satisfies Record<string, DeviceProfile>;

export type DeviceProfileKey = keyof typeof DEVICE_PROFILES;
export const DEVICE_PROFILE_KEYS = Object.keys(DEVICE_PROFILES) as [DeviceProfileKey, ...DeviceProfileKey[]];

export const DEFAULT_DESKTOP_PROFILE: DeviceProfileKey = "desktop_1440";
export const DEFAULT_MOBILE_PROFILE: DeviceProfileKey = "mobile_390";

/**
 * Capture levels — the layered strategy from §26.
 *
 * A job declares the *highest* level it is allowed to use. The worker starts at
 * level 1 and escalates only when the cheaper level cannot answer, so a
 * metadata-only refresh never pays for a browser.
 */
export const CAPTURE_LEVELS = {
  1: {
    key: "http_fetch",
    label: "Metadata only (HTTP)",
    description:
      "Plain HTTP fetch and HTML parse. No browser. Enough for title, description, OG image, favicon, canonical URL and a content hash. Milliseconds and almost no memory.",
    usesBrowser: false,
  },
  2: {
    key: "browser_render",
    label: "Browser render",
    description:
      "Full page load in Chromium with screenshots. Needed when the page renders client side, and for anything visual.",
    usesBrowser: true,
  },
  3: {
    key: "browser_interaction",
    label: "Browser interaction",
    description:
      "Browser render plus scripted interactions (hover, click, open) captured as before/after states.",
    usesBrowser: true,
  },
} as const;

export type CaptureLevel = keyof typeof CAPTURE_LEVELS;
export const CAPTURE_LEVEL_VALUES = [1, 2, 3] as const;

/** How a stored capture or media asset came to exist. Recorded as provenance. */
export const CAPTURE_METHODS = [
  "http_fetch",
  "browser_render",
  "browser_interaction",
  "manual_upload",
  "import",
] as const;
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];

export const CAPTURE_METHOD_LABELS: Record<CaptureMethod, string> = {
  http_fetch: "HTTP fetch",
  browser_render: "Browser render",
  browser_interaction: "Browser interaction",
  manual_upload: "Manual upload",
  import: "Import",
};

export const CAPTURE_STATUSES = ["succeeded", "partial", "failed"] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/**
 * Interaction types (§8).
 *
 * `deterministic: true` marks the handful the V1 worker can actually attempt on
 * its own, from an operator-supplied CSS selector: it can hover an element,
 * click it, or scroll the page, and photograph before and after. Everything
 * else is modelled so the data structure and the CMS are ready, and is captured
 * by a person defining the steps.
 *
 * This is on purpose. §8 asks for a framework plus a few deterministic types,
 * explicitly not a system that guesses at every interaction on every site.
 */
export const INTERACTION_TYPES = [
  "hover",
  "click",
  "focus",
  "scroll",
  "dropdown",
  "modal",
  "accordion",
  "tabs",
  "carousel",
  "menu",
  "tooltip",
  "drawer",
  "form_fill",
  "form_submit",
  "drag",
  "keyboard",
  "video_play",
  "other",
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

export interface InteractionTypeMeta {
  readonly label: string;
  readonly description: string;
  /** The V1 worker can perform this unattended, given a selector. */
  readonly deterministic: boolean;
  /** Needs a target element selector. */
  readonly needsSelector: boolean;
}

export const INTERACTION_TYPE_META: Record<InteractionType, InteractionTypeMeta> = {
  hover: { label: "Hover", description: "Pointer over an element.", deterministic: true, needsSelector: true },
  click: { label: "Click", description: "Click an element.", deterministic: true, needsSelector: true },
  focus: { label: "Focus", description: "Focus an element via keyboard.", deterministic: true, needsSelector: true },
  scroll: { label: "Scroll", description: "Scroll to a position or element.", deterministic: true, needsSelector: false },
  dropdown: { label: "Dropdown", description: "Open a select or dropdown.", deterministic: false, needsSelector: true },
  modal: { label: "Modal", description: "Open a dialog or modal.", deterministic: false, needsSelector: true },
  accordion: { label: "Accordion", description: "Expand a collapsible section.", deterministic: false, needsSelector: true },
  tabs: { label: "Tabs", description: "Switch tab panels.", deterministic: false, needsSelector: true },
  carousel: { label: "Carousel", description: "Advance a carousel or slider.", deterministic: false, needsSelector: true },
  menu: { label: "Menu", description: "Open a navigation menu.", deterministic: false, needsSelector: true },
  tooltip: { label: "Tooltip", description: "Reveal a tooltip.", deterministic: false, needsSelector: true },
  drawer: { label: "Drawer", description: "Open a side drawer or sheet.", deterministic: false, needsSelector: true },
  form_fill: { label: "Form fill", description: "Enter values into a form.", deterministic: false, needsSelector: true },
  form_submit: { label: "Form submit", description: "Submit a form. Not attempted automatically.", deterministic: false, needsSelector: true },
  drag: { label: "Drag", description: "Drag an element.", deterministic: false, needsSelector: true },
  keyboard: { label: "Keyboard", description: "Send a key sequence.", deterministic: false, needsSelector: false },
  video_play: { label: "Video play", description: "Start media playback.", deterministic: false, needsSelector: true },
  other: { label: "Other", description: "Anything else, described by hand.", deterministic: false, needsSelector: false },
};

export const DETERMINISTIC_INTERACTION_TYPES = INTERACTION_TYPES.filter(
  (t) => INTERACTION_TYPE_META[t].deterministic,
);

/** Screenshot framing. */
export const SCREENSHOT_SCOPES = ["viewport", "full_page", "element"] as const;
export type ScreenshotScope = (typeof SCREENSHOT_SCOPES)[number];
