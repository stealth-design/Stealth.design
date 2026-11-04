/**
 * Heuristic classifier — the default provider.
 *
 * Deterministic, offline, free, and instant. It reads *structural* signals from
 * the extracted page (form fields, tables, price hints, dialog roles) rather
 * than page copy, which matters for two reasons: structure is much harder for a
 * page to lie about than text, and the same page always produces the same
 * suggestion, so a reviewer's mental model of "what the machine thinks" stays
 * stable.
 *
 * It is deliberately modest. Rules fire only on strong signals and cap their
 * own confidence well below any auto-apply threshold, so every suggestion still
 * reaches a human. §27 asks for reliability over automation in V1, and a small
 * set of rules that are right most of the time — and visibly a guess when they
 * are not — is more useful to a curation team than a clever system they cannot
 * predict.
 *
 * The rules propose term *names*, which are then resolved against the
 * operator-owned taxonomy. If a team renames or removes a term, the matching
 * suggestion simply stops resolving; no code change is needed, and nothing here
 * branches on a specific term existing.
 */
import type {
  ClassificationInput,
  ClassificationProvider,
  ClassificationResult,
  RawSuggestion,
} from "./types.js";
import { resolveSuggestions } from "./types.js";

/**
 * A rule proposes a term name for a vocabulary when its predicate matches.
 *
 * `confidence` is the rule author's honest estimate of how often the rule is
 * right. None of them reach `DEFAULT_MIN_AUTO_APPLY_CONFIDENCE` (0.85), which
 * is the mechanical guarantee that heuristic output is always reviewed.
 */
interface HeuristicRule {
  readonly kind: string;
  readonly term: string;
  readonly confidence: number;
  readonly rationale: string;
  matches(input: ClassificationInput): boolean;
}

const text = (input: ClassificationInput): string =>
  [input.title, input.description, input.h1, ...input.headings]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();

const path = (input: ClassificationInput): string => {
  if (!input.url) return "";
  try {
    return new URL(input.url).pathname.toLowerCase();
  } catch {
    return "";
  }
};

const RULES: readonly HeuristicRule[] = [
  // --- Page type ------------------------------------------------------
  {
    kind: "page_type",
    term: "Pricing",
    confidence: 0.72,
    rationale: "The URL or headings mention pricing and the page shows price-like content.",
    matches: (i) =>
      (/\/(pricing|plans|price)\b/.test(path(i)) || /\bpricing\b|\bplans?\b/.test(text(i))) &&
      (i.signals.hasPriceHint === true || (i.signals.tableCount ?? 0) > 0),
  },
  {
    kind: "page_type",
    term: "Sign up",
    confidence: 0.78,
    rationale: "The page has a password field and sign-up wording.",
    matches: (i) =>
      (i.signals.passwordInputCount ?? 0) > 0 &&
      (/\/(signup|sign-up|register|join|create-account)\b/.test(path(i)) ||
        /\bsign up\b|\bcreate account\b|\bget started free\b/.test(text(i))),
  },
  {
    kind: "page_type",
    term: "Log in",
    confidence: 0.8,
    rationale: "The page has a single password field and log-in wording.",
    matches: (i) =>
      (i.signals.passwordInputCount ?? 0) > 0 &&
      (/\/(login|log-in|signin|sign-in|auth)\b/.test(path(i)) || /\blog ?in\b|\bsign ?in\b/.test(text(i))),
  },
  {
    kind: "page_type",
    term: "Home",
    confidence: 0.68,
    rationale: "The URL is the site root and the page has full site navigation.",
    matches: (i) =>
      (path(i) === "/" || path(i) === "") && i.signals.hasHeader === true && i.signals.hasFooter === true,
  },
  {
    kind: "page_type",
    term: "Blog post",
    confidence: 0.66,
    rationale: "A long single-article URL pattern with substantial body text.",
    matches: (i) =>
      /\/(blog|news|article|post|insights)\//.test(path(i)) && i.wordCount > 400,
  },
  {
    kind: "page_type",
    term: "Blog index",
    confidence: 0.6,
    rationale: "A blog listing URL with many links and little body text.",
    matches: (i) =>
      /\/(blog|news|articles|posts|insights)\/?$/.test(path(i)) && (i.signals.linkCount ?? 0) > 20,
  },
  {
    kind: "page_type",
    term: "Documentation",
    confidence: 0.7,
    rationale: "A docs URL pattern with a sidebar and many in-page headings.",
    matches: (i) =>
      /\/(docs?|documentation|guide|reference|api)\b/.test(path(i)) &&
      ((i.signals.hasAside ?? false) || (i.signals.headingCount ?? 0) > 5),
  },
  {
    kind: "page_type",
    term: "Product",
    confidence: 0.6,
    rationale: "A product URL with add-to-cart wording.",
    matches: (i) => /\/(product|products|item|shop)\//.test(path(i)) && i.signals.hasCartHint === true,
  },
  {
    kind: "page_type",
    term: "Contact",
    confidence: 0.7,
    rationale: "A contact URL with a form containing an email field.",
    matches: (i) =>
      /\/(contact|contact-us|get-in-touch|support)\b/.test(path(i)) &&
      (i.signals.emailInputCount ?? 0) > 0,
  },
  {
    kind: "page_type",
    term: "About",
    confidence: 0.64,
    rationale: "An about URL with body text and no form.",
    matches: (i) => /\/(about|about-us|company|team|who-we-are)\b/.test(path(i)),
  },
  {
    kind: "page_type",
    term: "Careers",
    confidence: 0.7,
    rationale: "A careers URL with a list of roles.",
    matches: (i) => /\/(careers?|jobs|join-us|hiring)\b/.test(path(i)),
  },
  {
    kind: "page_type",
    term: "Search results",
    confidence: 0.66,
    rationale: "A search URL or a prominent search input with a results list.",
    matches: (i) =>
      /\/(search|results)\b/.test(path(i)) && (i.signals.searchInputCount ?? 0) > 0,
  },
  {
    kind: "page_type",
    term: "Checkout",
    confidence: 0.74,
    rationale: "A checkout URL with a form.",
    matches: (i) =>
      /\/(checkout|cart|basket|payment)\b/.test(path(i)) && (i.signals.formCount ?? 0) > 0,
  },
  {
    kind: "page_type",
    term: "Legal",
    confidence: 0.72,
    rationale: "A legal or policy URL with long body text and no interactive elements.",
    matches: (i) =>
      /\/(privacy|terms|legal|cookie-policy|dpa|gdpr|imprint)\b/.test(path(i)) && i.wordCount > 300,
  },

  // --- UI pattern -----------------------------------------------------
  {
    kind: "ui_pattern",
    term: "Navigation",
    confidence: 0.75,
    rationale: "The page has a navigation landmark.",
    matches: (i) => (i.signals.navCount ?? 0) > 0,
  },
  {
    kind: "ui_pattern",
    term: "Carousel",
    confidence: 0.55,
    rationale: "Class or id names suggest a carousel or slider component.",
    matches: (i) => i.signals.hasCarouselHint === true,
  },
  {
    kind: "ui_pattern",
    term: "Tabs",
    confidence: 0.7,
    rationale: "The page uses tab ARIA roles.",
    matches: (i) => i.signals.hasTabsHint === true || (i.signals.ariaRoles ?? []).includes("tablist"),
  },
  {
    kind: "ui_pattern",
    term: "Accordion",
    confidence: 0.6,
    rationale: "The page contains collapsible sections.",
    matches: (i) => i.signals.hasAccordionHint === true,
  },
  {
    kind: "ui_pattern",
    term: "Modal",
    confidence: 0.62,
    rationale: "The page contains a dialog element or dialog role.",
    matches: (i) => i.signals.hasDialog === true || i.signals.hasModalHint === true,
  },
  {
    kind: "ui_pattern",
    term: "Data table",
    confidence: 0.68,
    rationale: "The page contains one or more tables.",
    matches: (i) => (i.signals.tableCount ?? 0) > 0,
  },
  {
    kind: "ui_pattern",
    term: "Form",
    confidence: 0.72,
    rationale: "The page contains a form.",
    matches: (i) => (i.signals.formCount ?? 0) > 0,
  },
  {
    kind: "ui_pattern",
    term: "Footer",
    confidence: 0.7,
    rationale: "The page has a footer landmark.",
    matches: (i) => i.signals.hasFooter === true,
  },
  {
    kind: "ui_pattern",
    term: "Sidebar",
    confidence: 0.62,
    rationale: "The page has a complementary (sidebar) landmark.",
    matches: (i) => i.signals.hasAside === true,
  },
  {
    kind: "ui_pattern",
    term: "Video",
    confidence: 0.6,
    rationale: "The page embeds video.",
    matches: (i) => (i.signals.videoCount ?? 0) > 0,
  },

  // --- UX pattern -----------------------------------------------------
  {
    kind: "ux_pattern",
    term: "Onboarding",
    confidence: 0.58,
    rationale: "Sign-up or getting-started wording with a form.",
    matches: (i) =>
      (i.signals.formCount ?? 0) > 0 &&
      /\bget started\b|\bonboard/.test(text(i)),
  },
  {
    kind: "ux_pattern",
    term: "Authentication",
    confidence: 0.76,
    rationale: "The page has a password field.",
    matches: (i) => (i.signals.passwordInputCount ?? 0) > 0,
  },
  {
    kind: "ux_pattern",
    term: "Search",
    confidence: 0.66,
    rationale: "The page has a search input or search landmark.",
    matches: (i) =>
      (i.signals.searchInputCount ?? 0) > 0 || (i.signals.ariaRoles ?? []).includes("search"),
  },
  {
    kind: "ux_pattern",
    term: "Consent",
    confidence: 0.6,
    rationale: "A cookie or consent banner is present.",
    matches: (i) => i.signals.hasCookieBannerHint === true,
  },
  {
    kind: "ux_pattern",
    term: "Checkout",
    confidence: 0.66,
    rationale: "Cart or checkout wording with a form.",
    matches: (i) => i.signals.hasCartHint === true && (i.signals.formCount ?? 0) > 0,
  },

  // --- Component ------------------------------------------------------
  {
    kind: "component",
    term: "Button",
    confidence: 0.7,
    rationale: "The page contains buttons.",
    matches: (i) => (i.signals.buttonCount ?? 0) > 0,
  },
  {
    kind: "component",
    term: "Text input",
    confidence: 0.65,
    rationale: "The page contains form inputs.",
    matches: (i) => (i.signals.formCount ?? 0) > 0,
  },
  {
    kind: "component",
    term: "Dialog",
    confidence: 0.6,
    rationale: "A dialog element or dialog role is present.",
    matches: (i) => i.signals.hasDialog === true,
  },
  {
    kind: "component",
    term: "Table",
    confidence: 0.68,
    rationale: "The page contains a table.",
    matches: (i) => (i.signals.tableCount ?? 0) > 0,
  },

  // --- Platform and device --------------------------------------------
  {
    kind: "platform",
    term: "Web",
    confidence: 0.95,
    rationale: "Captured from a web URL.",
    matches: (i) => i.url !== null,
  },
];

export interface HeuristicProviderOptions {
  /** Suggestions below this are dropped entirely as too weak to be useful. */
  readonly minConfidence?: number;
  /** Cap on suggestions per vocabulary, so a reviewer is not flooded. */
  readonly maxPerKind?: number;
}

export function createHeuristicProvider(
  options: HeuristicProviderOptions = {},
): ClassificationProvider {
  const minConfidence = options.minConfidence ?? 0.5;
  const maxPerKind = options.maxPerKind ?? 6;

  return {
    name: "heuristic",
    usesModel: false,

    async classify(input: ClassificationInput): Promise<ClassificationResult> {
      const startedAt = performance.now();

      // Only consider vocabularies the caller actually offered for this record.
      const availableKinds = new Set(input.vocabulary.map((v) => v.kind));

      const raw: RawSuggestion[] = [];
      const perKind = new Map<string, number>();

      for (const rule of RULES) {
        if (!availableKinds.has(rule.kind as never)) continue;
        if (rule.confidence < minConfidence) continue;
        if ((perKind.get(rule.kind) ?? 0) >= maxPerKind) continue;

        let matched = false;
        try {
          matched = rule.matches(input);
        } catch {
          // A rule must never be able to fail a capture. A malformed URL or a
          // missing signal is a non-match, not an exception.
          matched = false;
        }
        if (!matched) continue;

        perKind.set(rule.kind, (perKind.get(rule.kind) ?? 0) + 1);
        raw.push({
          kind: rule.kind as RawSuggestion["kind"],
          term: rule.term,
          confidence: rule.confidence,
          rationale: rule.rationale,
        });
      }

      const { resolved, unresolved } = resolveSuggestions(raw, input.vocabulary);

      return {
        provider: "heuristic",
        model: null,
        promptVersion: "heuristic-v1",
        suggestions: resolved,
        unresolved,
        fieldSuggestions: [],
        inputTokens: null,
        outputTokens: null,
        durationMs: Math.round(performance.now() - startedAt),
        error: null,
      };
    },
  };
}

/** How many rules exist, for the Settings screen's explanation of the provider. */
export const HEURISTIC_RULE_COUNT = RULES.length;

/** The rules, for documentation and the Settings screen. */
export function describeHeuristicRules(): { kind: string; term: string; confidence: number; rationale: string }[] {
  return RULES.map((r) => ({
    kind: r.kind,
    term: r.term,
    confidence: r.confidence,
    rationale: r.rationale,
  }));
}
