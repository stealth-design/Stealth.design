/**
 * Taxonomy (§13).
 *
 * Taxonomy *terms* are rows in the database, created and edited by operators in
 * the CMS. Nothing in this file is a term. What is declared here is the set of
 * taxonomy *kinds* — the vocabularies themselves — plus which entity types
 * each kind can be attached to and whether it is hierarchical.
 *
 * This is the distinction §13 asks for ("do not hardcode taxonomy into
 * application logic"). Application logic knows that `ux_pattern` is a
 * hierarchical vocabulary attachable to content; it does not know that
 * "Progressive onboarding" exists. Seed data proposes a starting tree for
 * local development, and operators own it from there.
 *
 * The UX/UI classification layer lives here rather than in `modules.ts` or
 * `content.ts`, which is the structural expression of "UX/UI is not a content
 * source".
 */

export const TAXONOMY_KINDS = [
  "industry",
  "page_type",
  "screen_type",
  "ux_pattern",
  "ui_pattern",
  "component",
  "interaction_type",
  "design_style",
  "platform",
  "device",
  "state",
  "function",
  "tag",
] as const;

export type TaxonomyKind = (typeof TAXONOMY_KINDS)[number];

/** Entity types a taxonomy term can be attached to. */
export const TAXONOMY_TARGETS = ["content", "source", "media"] as const;
export type TaxonomyTarget = (typeof TAXONOMY_TARGETS)[number];

export interface TaxonomyKindMeta {
  readonly label: string;
  readonly plural: string;
  readonly description: string;
  /** Supports parent/child nesting. */
  readonly hierarchical: boolean;
  /** Which entities this vocabulary can classify. */
  readonly targets: readonly TaxonomyTarget[];
  /** At most one term of this kind per record (e.g. a page has one page type). */
  readonly singleValue: boolean;
  /** Offered as a facet on the public API and public frontend. */
  readonly publicFacet: boolean;
  /** Content kinds this vocabulary is relevant to. Empty means all. */
  readonly relevantKinds: readonly string[];
  /** Example tree, shown as placeholder help in the CMS create form. */
  readonly example?: string;
}

export const TAXONOMY_KIND_META: Record<TaxonomyKind, TaxonomyKindMeta> = {
  industry: {
    label: "Industry",
    plural: "Industries",
    description: "The sector the product operates in.",
    hierarchical: true,
    targets: ["content", "source"],
    singleValue: false,
    publicFacet: true,
    relevantKinds: [],
    example: "Finance > Consumer banking",
  },
  page_type: {
    label: "Page type",
    plural: "Page types",
    description: "What kind of page this is, structurally.",
    hierarchical: true,
    targets: ["content"],
    singleValue: true,
    publicFacet: true,
    relevantKinds: ["page", "website"],
    example: "Marketing > Pricing",
  },
  screen_type: {
    label: "Screen type",
    plural: "Screen types",
    description: "What kind of app screen this is.",
    hierarchical: true,
    targets: ["content"],
    singleValue: true,
    publicFacet: true,
    relevantKinds: ["screen", "app"],
    example: "Onboarding > Permission request",
  },
  ux_pattern: {
    label: "UX pattern",
    plural: "UX patterns",
    description: "The experience-level pattern: how the design solves a user problem.",
    hierarchical: true,
    targets: ["content"],
    singleValue: false,
    publicFacet: true,
    relevantKinds: [],
    example: "Onboarding > Progressive onboarding",
  },
  ui_pattern: {
    label: "UI pattern",
    plural: "UI patterns",
    description: "The interface-level pattern: how it is arranged on screen.",
    hierarchical: true,
    targets: ["content"],
    singleValue: false,
    publicFacet: true,
    relevantKinds: [],
    example: "Navigation > Bottom navigation",
  },
  component: {
    label: "Component",
    plural: "Components",
    description: "Discrete interface elements present in the capture.",
    hierarchical: true,
    targets: ["content"],
    singleValue: false,
    publicFacet: true,
    relevantKinds: [],
    example: "Input > Combobox",
  },
  interaction_type: {
    label: "Interaction type",
    plural: "Interaction types",
    description: "The kind of behaviour captured.",
    hierarchical: false,
    targets: ["content"],
    singleValue: true,
    publicFacet: true,
    relevantKinds: ["interaction"],
    example: "Modal",
  },
  design_style: {
    label: "Design style",
    plural: "Design styles",
    description: "Visual language and aesthetic treatment.",
    hierarchical: true,
    targets: ["content", "source"],
    singleValue: false,
    publicFacet: true,
    relevantKinds: [],
    example: "Minimal > Swiss",
  },
  platform: {
    label: "Platform",
    plural: "Platforms",
    description: "The platform the experience runs on.",
    hierarchical: false,
    targets: ["content", "source"],
    singleValue: false,
    publicFacet: true,
    relevantKinds: [],
    example: "iOS",
  },
  device: {
    label: "Device",
    plural: "Devices",
    description: "The device class the capture represents.",
    hierarchical: false,
    targets: ["content", "media"],
    singleValue: false,
    publicFacet: true,
    relevantKinds: [],
    example: "Mobile",
  },
  state: {
    label: "State",
    plural: "States",
    description: "The condition being shown: empty, loading, error, success.",
    hierarchical: false,
    targets: ["content"],
    singleValue: false,
    publicFacet: true,
    relevantKinds: ["state", "page", "screen"],
    example: "Empty state",
  },
  function: {
    label: "Function",
    plural: "Functions",
    description: "What the user is trying to accomplish here.",
    hierarchical: true,
    targets: ["content"],
    singleValue: false,
    publicFacet: true,
    relevantKinds: [],
    example: "Purchase > Checkout",
  },
  tag: {
    label: "Tag",
    plural: "Tags",
    description: "Free-form internal label. Flat, unrestricted, for the team's own use.",
    hierarchical: false,
    targets: ["content", "source", "media"],
    singleValue: false,
    publicFacet: false,
    relevantKinds: [],
    example: "worth-revisiting",
  },
};

export function isTaxonomyKind(value: unknown): value is TaxonomyKind {
  return typeof value === "string" && (TAXONOMY_KINDS as readonly string[]).includes(value);
}

export function taxonomyKindsFor(target: TaxonomyTarget): TaxonomyKind[] {
  return TAXONOMY_KINDS.filter((k) => TAXONOMY_KIND_META[k].targets.includes(target));
}

export function publicFacetKinds(): TaxonomyKind[] {
  return TAXONOMY_KINDS.filter((k) => TAXONOMY_KIND_META[k].publicFacet);
}

/** Kinds relevant to a given content kind, for the classification panel. */
export function taxonomyKindsForContentKind(contentKind: string): TaxonomyKind[] {
  return TAXONOMY_KINDS.filter((k) => {
    const meta = TAXONOMY_KIND_META[k];
    if (!meta.targets.includes("content")) return false;
    return meta.relevantKinds.length === 0 || meta.relevantKinds.includes(contentKind);
  });
}

export const TAXONOMY_TERM_STATUSES = ["draft", "active", "archived"] as const;
export type TaxonomyTermStatus = (typeof TAXONOMY_TERM_STATUSES)[number];

/**
 * Where a classification came from, and how far it has got with a human (§14).
 *
 * The distinction the brief calls important is carried by this single column:
 * `ai_suggested` has not been seen by a person; `human_verified` means a person
 * accepted the machine's suggestion unchanged; `human_modified` means a person
 * changed it; `human_added` means a person added it with no machine involvement.
 * The CMS shows these differently and the public API exposes only the
 * human-confirmed ones by default.
 */
export const CLASSIFICATION_ORIGINS = [
  "ai_suggested",
  "human_verified",
  "human_modified",
  "human_added",
  "imported",
  "rule_based",
] as const;
export type ClassificationOrigin = (typeof CLASSIFICATION_ORIGINS)[number];

export interface ClassificationOriginMeta {
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly tone: "neutral" | "info" | "warning" | "success";
  /** A person has confirmed this value. */
  readonly humanConfirmed: boolean;
}

export const CLASSIFICATION_ORIGIN_META: Record<ClassificationOrigin, ClassificationOriginMeta> = {
  ai_suggested: {
    label: "AI suggested",
    shortLabel: "AI",
    description: "Proposed by a model and not yet reviewed by a person.",
    tone: "warning",
    humanConfirmed: false,
  },
  human_verified: {
    label: "Human verified",
    shortLabel: "Verified",
    description: "A person reviewed the model's suggestion and accepted it as-is.",
    tone: "success",
    humanConfirmed: true,
  },
  human_modified: {
    label: "Human modified",
    shortLabel: "Modified",
    description: "A person reviewed the model's suggestion and changed it.",
    tone: "success",
    humanConfirmed: true,
  },
  human_added: {
    label: "Human added",
    shortLabel: "Manual",
    description: "Added by a person. No model involved.",
    tone: "success",
    humanConfirmed: true,
  },
  imported: {
    label: "Imported",
    shortLabel: "Import",
    description: "Came in through a bulk import and has not been reviewed.",
    tone: "neutral",
    humanConfirmed: false,
  },
  rule_based: {
    label: "Rule based",
    shortLabel: "Rule",
    description: "Derived deterministically from page signals, not from a model.",
    tone: "info",
    humanConfirmed: false,
  },
};

export const HUMAN_CONFIRMED_ORIGINS = CLASSIFICATION_ORIGINS.filter(
  (o) => CLASSIFICATION_ORIGIN_META[o].humanConfirmed,
);

/** Review state of an individual suggested assignment. */
export const SUGGESTION_REVIEW_STATUSES = ["pending", "accepted", "modified", "rejected"] as const;
export type SuggestionReviewStatus = (typeof SUGGESTION_REVIEW_STATUSES)[number];

/**
 * Confidence floor below which a suggestion is never auto-applied (§14: "do
 * not automatically publish low-confidence classifications"). Operators can
 * raise this in Settings; it cannot be lowered to zero.
 */
export const DEFAULT_MIN_AUTO_APPLY_CONFIDENCE = 0.85;
export const ABSOLUTE_MIN_AUTO_APPLY_CONFIDENCE = 0.6;
