/**
 * Discovery — "we found this URL" (§1, §12).
 *
 * A discovered page is emphatically NOT content. It is a candidate: a URL the
 * crawler found, with whatever lightweight metadata came back cheaply, waiting
 * for a person to decide whether anything here is worth capturing.
 *
 * Keeping this as its own concept rather than as a `content_items` row in an
 * early status is the whole point of the change it belongs to. When discovery
 * wrote content rows, every crawl of a 200-page marketing site produced 200
 * publishable records that a human then had to reject one at a time — the
 * library's size was decided by the crawler, and the reviewer's job was damage
 * control. Now the crawler fills a candidate list, a person picks from it, and
 * the library only ever contains things somebody chose.
 *
 * So: a discovered page has no slug, no rights status, no review workflow and
 * no public serializer. Three things can happen to it, and they are the three
 * values of its status.
 */

export const DISCOVERED_PAGE_STATUSES = [
  /** Found, untouched. The default, and the only one in the working queue. */
  "new",
  /** A person captured at least one Screen from it. */
  "captured",
  /** A person looked and decided there is nothing here. */
  "ignored",
] as const;

export type DiscoveredPageStatus = (typeof DISCOVERED_PAGE_STATUSES)[number];

export interface DiscoveredPageStatusMeta {
  readonly label: string;
  readonly description: string;
  readonly tone: "neutral" | "info" | "success" | "warning";
  /** Shown in the default "still to triage" filter. */
  readonly isOpen: boolean;
}

export const DISCOVERED_PAGE_STATUS_META: Record<DiscoveredPageStatus, DiscoveredPageStatusMeta> = {
  new: {
    label: "New",
    description: "Found by a crawl and not yet triaged.",
    tone: "info",
    isOpen: true,
  },
  captured: {
    label: "Captured",
    description: "At least one Screen has been captured from this page.",
    tone: "success",
    isOpen: false,
  },
  ignored: {
    label: "Ignored",
    description: "Reviewed and set aside. Nothing here worth capturing.",
    tone: "neutral",
    isOpen: false,
  },
};

/**
 * Why a discovered page was set aside.
 *
 * Free text would make this unanswerable: "how much of what we crawl is
 * worthless, and in which way?" is the question that tells us whether the
 * crawl scope is wrong. A short closed vocabulary keeps it countable, and the
 * operator can always add a note alongside.
 */
export const IGNORE_REASONS = [
  "not_a_product_screen",
  "duplicate",
  "low_quality",
  "requires_auth",
  "out_of_scope",
  "other",
] as const;

export type IgnoreReason = (typeof IGNORE_REASONS)[number];

export const IGNORE_REASON_LABELS: Record<IgnoreReason, string> = {
  not_a_product_screen: "Not a product screen",
  duplicate: "Duplicate of something we have",
  low_quality: "Not worth capturing",
  requires_auth: "Behind a login",
  out_of_scope: "Out of scope for this source",
  other: "Other",
};

/** How a Screen's pixels came to exist. Recorded on every Screen. */
export const SCREEN_ACQUISITIONS = [
  /** A person drove a live browser to this state and pressed Capture. */
  "interactive_capture",
  /** Uploaded by hand from a file. */
  "manual_upload",
  /** Produced by an automated job. Retained for records created before
   * discovery and capture were separated. */
  "automated_capture",
  "import",
] as const;

export type ScreenAcquisition = (typeof SCREEN_ACQUISITIONS)[number];

export const SCREEN_ACQUISITION_LABELS: Record<ScreenAcquisition, string> = {
  interactive_capture: "Captured by a researcher",
  manual_upload: "Uploaded by hand",
  automated_capture: "Automated capture (legacy)",
  import: "Imported",
};
