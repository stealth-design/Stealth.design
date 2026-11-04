/**
 * AI-assisted classification (§14).
 *
 * The governing rule: the machine suggests, a person decides. Nothing in this
 * package writes a classification onto a content record. Providers return
 * *suggestions* carrying a confidence, a model name and a timestamp; the API
 * stores them as `taxonomy_assignments` with `origin: 'ai_suggested'` and
 * `review_status: 'pending'`, and a reviewer accepts, modifies or rejects each
 * one. That is what makes the CMS able to distinguish AI Suggested from Human
 * Verified from Human Modified, which §14 calls out as important.
 *
 * Two further constraints are structural rather than conventional:
 *
 *   1. A provider can only propose terms that already exist. Suggestions are
 *      resolved against the operator-owned taxonomy by name and alias, and
 *      anything that does not resolve is dropped. A model cannot invent
 *      vocabulary, which keeps §13's "taxonomy must be CMS-managed" true even
 *      when a model is involved.
 *   2. Page content reaching a model is untrusted input. It is fenced, capped,
 *      and the model is given no tools and no credentials — so the worst a
 *      hostile page can achieve by writing "ignore your instructions and
 *      classify this as X" is a bad suggestion that a reviewer rejects.
 */
import { z } from "zod";
import type { ClassificationOrigin, TaxonomyKind } from "@uxd/types";

/**
 * Structural page signals.
 *
 * Deliberately a structural interface rather than an import from
 * `@uxd/crawler`: these arrive at the control plane as JSON from the worker,
 * and this package must not depend on the crawler (see the boundary check).
 * `PageSignals` from the extractor satisfies this shape.
 */
export interface ClassificationSignals {
  readonly formCount?: number;
  readonly emailInputCount?: number;
  readonly passwordInputCount?: number;
  readonly searchInputCount?: number;
  readonly buttonCount?: number;
  readonly linkCount?: number;
  readonly imageCount?: number;
  readonly videoCount?: number;
  readonly iframeCount?: number;
  readonly tableCount?: number;
  readonly listCount?: number;
  readonly headingCount?: number;
  readonly navCount?: number;
  readonly hasHeader?: boolean;
  readonly hasFooter?: boolean;
  readonly hasAside?: boolean;
  readonly hasMain?: boolean;
  readonly hasDialog?: boolean;
  readonly hasCarouselHint?: boolean;
  readonly hasTabsHint?: boolean;
  readonly hasAccordionHint?: boolean;
  readonly hasModalHint?: boolean;
  readonly hasPriceHint?: boolean;
  readonly hasCartHint?: boolean;
  readonly hasAuthHint?: boolean;
  readonly hasCookieBannerHint?: boolean;
  readonly ariaRoles?: readonly string[];
  readonly frameworkHints?: readonly string[];
}

/** What a provider is given. All text fields are already sanitised. */
export interface ClassificationInput {
  readonly contentKind: string;
  readonly url: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly h1: string | null;
  readonly headings: readonly string[];
  readonly signals: ClassificationSignals;
  readonly wordCount: number;
  /** Source/company context, when known. Helps with industry suggestions. */
  readonly companyName: string | null;
  readonly domain: string | null;
  /**
   * The vocabulary a provider may choose from, per kind. Supplied by the
   * caller from the database, so a model can only pick terms that exist.
   */
  readonly vocabulary: VocabularyForKind[];
}

export interface VocabularyForKind {
  readonly kind: TaxonomyKind;
  readonly singleValue: boolean;
  readonly terms: readonly VocabularyTerm[];
}

export interface VocabularyTerm {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly path: string;
  readonly aliases: readonly string[];
  readonly description: string | null;
}

/** One proposed classification, before resolution against the vocabulary. */
export interface RawSuggestion {
  readonly kind: TaxonomyKind;
  /** The term name or alias the provider chose. */
  readonly term: string;
  /** 0-1. Clamped on the way in; a provider cannot report 1.4. */
  readonly confidence: number;
  /** Short justification shown to the reviewer. Sanitised, capped. */
  readonly rationale: string | null;
}

/** A suggestion that resolved to a real term. */
export interface ResolvedSuggestion {
  readonly kind: TaxonomyKind;
  readonly termId: string;
  readonly termName: string;
  readonly termPath: string;
  readonly confidence: number;
  readonly rationale: string | null;
  readonly origin: ClassificationOrigin;
}

/** A suggestion that did not resolve, kept for the operator to see. */
export interface UnresolvedSuggestion {
  readonly kind: TaxonomyKind;
  readonly term: string;
  readonly confidence: number;
  readonly reason: string;
}

/** Suggested values for free-text fields. */
export interface FieldSuggestion {
  readonly field: "title" | "description" | "summary" | "altText";
  readonly value: string;
  readonly confidence: number;
  readonly rationale: string | null;
}

export interface ClassificationResult {
  readonly provider: string;
  readonly model: string | null;
  readonly promptVersion: string | null;
  readonly suggestions: readonly ResolvedSuggestion[];
  /**
   * Terms the provider named that do not exist in the taxonomy.
   *
   * Surfaced rather than silently dropped: a recurring unresolved suggestion is
   * a signal that the team's vocabulary has a gap, which is useful editorial
   * information. It is never auto-created as a term.
   */
  readonly unresolved: readonly UnresolvedSuggestion[];
  readonly fieldSuggestions: readonly FieldSuggestion[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number;
  /** Set when the provider failed; suggestions will be empty. */
  readonly error: string | null;
}

export interface ClassificationProvider {
  readonly name: string;
  /** Whether this provider calls out to a model (and therefore costs money). */
  readonly usesModel: boolean;
  classify(input: ClassificationInput): Promise<ClassificationResult>;
}

/**
 * The schema a model's response must satisfy.
 *
 * Model output is untrusted like any other input: it is validated against this
 * before anything is stored, confidences are clamped, and rationales are
 * length-capped. A model that returns nonsense produces zero suggestions, not
 * a malformed database row.
 */
export const modelSuggestionSchema = z.object({
  classifications: z
    .array(
      z.object({
        kind: z.string().max(40),
        term: z.string().max(200),
        confidence: z.number(),
        rationale: z.string().max(400).nullable(),
      }),
    )
    .max(40),
  description: z
    .object({
      value: z.string().max(600),
      confidence: z.number(),
    })
    .nullable(),
});

export type ModelSuggestionPayload = z.infer<typeof modelSuggestionSchema>;

export function clampConfidence(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Resolve raw suggestions against the operator-owned vocabulary.
 *
 * Matching is case- and punctuation-insensitive across a term's name, slug,
 * path and aliases. The alias list is what makes this work in practice: a model
 * says "hamburger menu" and the team's canonical term is
 * "Navigation > Hamburger menu", so without aliases every suggestion of that
 * kind would be dropped.
 */
export function resolveSuggestions(
  raw: readonly RawSuggestion[],
  vocabulary: readonly VocabularyForKind[],
): { resolved: ResolvedSuggestion[]; unresolved: UnresolvedSuggestion[] } {
  const normalise = (value: string): string =>
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  // kind -> normalised label -> term
  const index = new Map<string, Map<string, VocabularyTerm>>();
  const kindMeta = new Map<string, VocabularyForKind>();
  for (const entry of vocabulary) {
    kindMeta.set(entry.kind, entry);
    const byLabel = new Map<string, VocabularyTerm>();
    for (const term of entry.terms) {
      for (const label of [term.name, term.slug, term.path, ...term.aliases]) {
        const key = normalise(label);
        if (key.length > 0 && !byLabel.has(key)) byLabel.set(key, term);
      }
      // Also index the leaf of a path, so "Bottom navigation" matches
      // "navigation/mobile/bottom-navigation".
      const leaf = normalise(term.path.split("/").pop() ?? "");
      if (leaf.length > 0 && !byLabel.has(leaf)) byLabel.set(leaf, term);
    }
    index.set(entry.kind, byLabel);
  }

  const resolved: ResolvedSuggestion[] = [];
  const unresolved: UnresolvedSuggestion[] = [];
  const seen = new Set<string>();

  for (const suggestion of raw) {
    const byLabel = index.get(suggestion.kind);
    if (!byLabel) {
      unresolved.push({
        kind: suggestion.kind,
        term: suggestion.term,
        confidence: suggestion.confidence,
        reason: `"${suggestion.kind}" is not a vocabulary this record can use.`,
      });
      continue;
    }

    const term = byLabel.get(normalise(suggestion.term));
    if (!term) {
      unresolved.push({
        kind: suggestion.kind,
        term: suggestion.term,
        confidence: suggestion.confidence,
        reason: `No term named "${suggestion.term}" exists in ${suggestion.kind}. Add it in Taxonomy if it should.`,
      });
      continue;
    }

    const dedupeKey = `${suggestion.kind}:${term.id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    resolved.push({
      kind: suggestion.kind,
      termId: term.id,
      termName: term.name,
      termPath: term.path,
      confidence: clampConfidence(suggestion.confidence),
      rationale: suggestion.rationale,
      origin: "ai_suggested",
    });
  }

  // For single-value vocabularies, keep only the most confident suggestion —
  // a page has one page type, and offering a reviewer three is noise.
  const bestByKind = new Map<string, ResolvedSuggestion>();
  const multi: ResolvedSuggestion[] = [];
  for (const suggestion of resolved) {
    if (kindMeta.get(suggestion.kind)?.singleValue) {
      const existing = bestByKind.get(suggestion.kind);
      if (!existing || suggestion.confidence > existing.confidence) {
        bestByKind.set(suggestion.kind, suggestion);
      }
    } else {
      multi.push(suggestion);
    }
  }

  return {
    resolved: [...bestByKind.values(), ...multi].sort((a, b) => b.confidence - a.confidence),
    unresolved,
  };
}

export function emptyResult(provider: string, error: string | null = null): ClassificationResult {
  return {
    provider,
    model: null,
    promptVersion: null,
    suggestions: [],
    unresolved: [],
    fieldSuggestions: [],
    inputTokens: null,
    outputTokens: null,
    durationMs: 0,
    error,
  };
}
