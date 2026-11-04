/**
 * Content kinds and the shape of the content graph (§2, §33).
 *
 * The model is not built around screenshots. A screenshot is one media asset
 * attached to a `page` or `screen`; the page exists whether or not we managed
 * to photograph it, can have many captures over time, and carries the
 * classification and relationships that make it useful.
 *
 * The hierarchy the brief asks for —
 *   Website -> Page -> Flow -> Pattern -> State -> Interaction
 *   App     -> Screen -> Flow -> Pattern -> State -> Interaction
 * — is expressed as three separate axes rather than one rigid tree, because
 * they genuinely behave differently:
 *
 *   1. Containment (`parentId`): a state belongs to a page; an interaction
 *      belongs to a page.
 *   2. Experience membership (`experienceId`): every page/screen/flow/state/
 *      interaction points at the `website` or `app` record it belongs to, so
 *      "show me everything from this product" is one indexed lookup.
 *   3. Sequence (`flow_steps`): a flow is an *ordered* path through pages or
 *      screens, and one page can appear in many flows. That is a join table,
 *      not a parent pointer.
 *
 * "Pattern" is not a content kind. Patterns are taxonomy terms applied to
 * content — the UX/UI classification layer, not a node in the tree.
 */

export const CONTENT_KINDS = [
  "website",
  "app",
  "page",
  "screen",
  "flow",
  "state",
  "interaction",
] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

export interface ContentKindMeta {
  readonly label: string;
  readonly plural: string;
  readonly description: string;
  /** Modules that can own this kind. */
  readonly modules: readonly string[];
  /**
   * Kinds that may be this record's `parentId`. An empty list means the kind
   * sits at the top of the containment tree.
   */
  readonly parentKinds: readonly ContentKind[];
  /** True for `website`/`app`: the experience root that others point at. */
  readonly isExperienceRoot: boolean;
  /** Has its own URL and can be captured directly by the crawler. */
  readonly isCapturable: boolean;
  /** Gets an entry in the `page_details`-style side table. */
  readonly detailTable: string | null;
}

export const CONTENT_KIND_META: Record<ContentKind, ContentKindMeta> = {
  website: {
    label: "Website",
    plural: "Websites",
    description:
      "A website as a whole, as presented publicly. The experience root that pages, flows and interactions belong to.",
    modules: ["web"],
    parentKinds: [],
    isExperienceRoot: true,
    isCapturable: true,
    detailTable: "experience_details",
  },
  app: {
    label: "App",
    plural: "Apps",
    description: "An application as a whole. The experience root that screens and flows belong to.",
    modules: ["app"],
    parentKinds: [],
    isExperienceRoot: true,
    isCapturable: false,
    detailTable: "experience_details",
  },
  page: {
    label: "Page",
    plural: "Pages",
    description: "A single web page at a specific URL.",
    modules: ["web"],
    parentKinds: ["website"],
    isExperienceRoot: false,
    isCapturable: true,
    detailTable: "page_details",
  },
  screen: {
    label: "Screen",
    plural: "Screens",
    description: "A single screen in an app.",
    modules: ["app"],
    parentKinds: ["app"],
    isExperienceRoot: false,
    isCapturable: false,
    detailTable: "screen_details",
  },
  flow: {
    label: "Flow",
    plural: "Flows",
    description:
      "An ordered path through pages or screens toward a goal, such as sign-up or checkout. Membership and order live in flow_steps.",
    modules: ["web", "app"],
    parentKinds: ["website", "app"],
    isExperienceRoot: false,
    isCapturable: false,
    detailTable: "flow_details",
  },
  state: {
    label: "State",
    plural: "States",
    description:
      "A distinct visual state of a page or screen: empty, loading, error, filled, success, logged-out.",
    modules: ["web", "app"],
    parentKinds: ["page", "screen"],
    isExperienceRoot: false,
    isCapturable: false,
    detailTable: "state_details",
  },
  interaction: {
    label: "Interaction",
    plural: "Interactions",
    description:
      "A behaviour on a page or screen, with its before and after states: a dropdown opening, a modal, a carousel advancing.",
    modules: ["web", "app"],
    parentKinds: ["page", "screen"],
    isExperienceRoot: false,
    isCapturable: false,
    detailTable: "interaction_details",
  },
};

export function isContentKind(value: unknown): value is ContentKind {
  return typeof value === "string" && (CONTENT_KINDS as readonly string[]).includes(value);
}

export function contentKindsForModule(module: string): ContentKind[] {
  return CONTENT_KINDS.filter((k) => CONTENT_KIND_META[k].modules.includes(module));
}

/** Is `child` allowed to sit under `parent` in the containment tree? */
export function canParent(parent: ContentKind, child: ContentKind): boolean {
  return CONTENT_KIND_META[child].parentKinds.includes(parent);
}

export const EXPERIENCE_ROOT_KINDS = CONTENT_KINDS.filter((k) => CONTENT_KIND_META[k].isExperienceRoot);
export const CAPTURABLE_KINDS = CONTENT_KINDS.filter((k) => CONTENT_KIND_META[k].isCapturable);

/**
 * Typed relationships between content records, for the graph that a rigid tree
 * cannot express: "these two pages are variants of each other", "this screen
 * is the mobile equivalent of that page".
 */
export const CONTENT_RELATION_TYPES = [
  "related",
  "variant_of",
  "responsive_equivalent",
  "precedes",
  "alternative_of",
  "supersedes",
  "references",
] as const;
export type ContentRelationType = (typeof CONTENT_RELATION_TYPES)[number];

export const CONTENT_RELATION_META: Record<
  ContentRelationType,
  { label: string; inverse: ContentRelationType | null; description: string }
> = {
  related: { label: "Related to", inverse: "related", description: "Loosely associated, no direction." },
  variant_of: {
    label: "Variant of",
    inverse: "variant_of",
    description: "A different treatment of the same thing — an A/B variant or a localised version.",
  },
  responsive_equivalent: {
    label: "Responsive equivalent of",
    inverse: "responsive_equivalent",
    description: "The same content at a different breakpoint or on a different device.",
  },
  precedes: {
    label: "Precedes",
    inverse: null,
    description: "Comes before the other record in a sequence. Directional.",
  },
  alternative_of: {
    label: "Alternative to",
    inverse: "alternative_of",
    description: "A different design solving the same problem, often from another product.",
  },
  supersedes: {
    label: "Supersedes",
    inverse: null,
    description: "Replaces an older record. Directional.",
  },
  references: {
    label: "References",
    inverse: null,
    description: "Cites or points at the other record. Directional.",
  },
};

/** Named states we recognise out of the box. Extended via `state` taxonomy. */
export const COMMON_STATE_NAMES = [
  "default",
  "empty",
  "loading",
  "skeleton",
  "error",
  "success",
  "filled",
  "partial",
  "disabled",
  "logged_out",
  "logged_in",
  "first_run",
  "offline",
  "paywalled",
  "cookie_consent",
] as const;
