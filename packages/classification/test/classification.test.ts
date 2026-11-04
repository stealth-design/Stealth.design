/**
 * Classification tests (§14).
 *
 * The most important assertions here are about what a provider *cannot* do:
 * invent a taxonomy term, exceed a confidence of 1, or produce a suggestion
 * that bypasses human review.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ClassificationInput,
  type VocabularyForKind,
  clampConfidence,
  createHeuristicProvider,
  createClassificationProvider,
  createNullProvider,
  describeHeuristicRules,
  resolveSuggestions,
} from "@uxd/classification";
import { DEFAULT_MIN_AUTO_APPLY_CONFIDENCE } from "@uxd/types";

const vocabulary: VocabularyForKind[] = [
  {
    kind: "page_type",
    singleValue: true,
    terms: [
      { id: "t-pricing", name: "Pricing", slug: "pricing", path: "marketing/pricing", aliases: ["plans", "price page"], description: null },
      { id: "t-login", name: "Log in", slug: "log-in", path: "auth/log-in", aliases: ["signin", "sign in"], description: null },
      { id: "t-home", name: "Home", slug: "home", path: "home", aliases: ["homepage", "landing page"], description: null },
    ],
  },
  {
    kind: "ui_pattern",
    singleValue: false,
    terms: [
      { id: "t-nav", name: "Navigation", slug: "navigation", path: "navigation", aliases: [], description: null },
      { id: "t-bottomnav", name: "Bottom navigation", slug: "bottom-navigation", path: "navigation/mobile/bottom-navigation", aliases: ["tab bar", "bottom nav"], description: null },
      { id: "t-table", name: "Data table", slug: "data-table", path: "data/data-table", aliases: ["table"], description: null },
      { id: "t-form", name: "Form", slug: "form", path: "input/form", aliases: [], description: null },
    ],
  },
];

const input = (overrides: Partial<ClassificationInput> = {}): ClassificationInput => ({
  contentKind: "page",
  url: "https://stripe.example.com/pricing",
  title: "Pricing — Example",
  description: "Simple pricing for every team.",
  h1: "Pricing",
  headings: ["Starter", "Pro", "Enterprise"],
  signals: { hasPriceHint: true, tableCount: 2, navCount: 1, formCount: 0, hasFooter: true },
  wordCount: 420,
  companyName: "Example Inc",
  domain: "stripe.example.com",
  vocabulary,
  ...overrides,
});

describe("resolveSuggestions — a model cannot invent taxonomy", () => {
  it("resolves a term by its exact name", () => {
    const { resolved } = resolveSuggestions(
      [{ kind: "page_type", term: "Pricing", confidence: 0.8, rationale: null }],
      vocabulary,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.termId, "t-pricing");
    assert.equal(resolved[0]!.origin, "ai_suggested", "suggestions are always marked as AI output");
  });

  it("resolves via alias, slug, path and path leaf", () => {
    const cases: [string, string][] = [
      ["plans", "t-pricing"], // alias
      ["price page", "t-pricing"], // multi-word alias
      ["log-in", "t-login"], // slug
      ["auth/log-in", "t-login"], // full path
      ["sign in", "t-login"], // alias
    ];
    for (const [term, expectedId] of cases) {
      const { resolved } = resolveSuggestions(
        [{ kind: "page_type", term, confidence: 0.7, rationale: null }],
        vocabulary,
      );
      assert.equal(resolved[0]?.termId, expectedId, `"${term}" should resolve to ${expectedId}`);
    }
  });

  it("resolves a hierarchical term by its leaf name", () => {
    // A model saying "Bottom navigation" should find
    // navigation/mobile/bottom-navigation without knowing the full path.
    const { resolved } = resolveSuggestions(
      [{ kind: "ui_pattern", term: "bottom nav", confidence: 0.7, rationale: null }],
      vocabulary,
    );
    assert.equal(resolved[0]?.termId, "t-bottomnav");
  });

  it("matches case- and punctuation-insensitively", () => {
    for (const term of ["PRICING", "  pricing  ", "Pricing!", "Pricing."]) {
      const { resolved } = resolveSuggestions(
        [{ kind: "page_type", term, confidence: 0.7, rationale: null }],
        vocabulary,
      );
      assert.equal(resolved[0]?.termId, "t-pricing", `"${term}" should resolve`);
    }
    // Separators are word boundaries, not noise: "log-in" and "log in" are
    // the same term, but "pri-cing" is a typo and must not silently match
    // "Pricing" — a wrong resolution is worse than an unresolved suggestion,
    // because the operator never sees that it happened.
    const { resolved, unresolved } = resolveSuggestions(
      [{ kind: "page_type", term: "pri-cing", confidence: 0.7, rationale: null }],
      vocabulary,
    );
    assert.equal(resolved.length, 0);
    assert.equal(unresolved.length, 1);
  });

  it("DROPS a term that does not exist, and says why", () => {
    // The guarantee: a model that hallucinates "Squeeze page" does not create
    // a taxonomy term, and does not silently vanish either.
    const { resolved, unresolved } = resolveSuggestions(
      [
        { kind: "page_type", term: "Squeeze page", confidence: 0.95, rationale: null },
        { kind: "page_type", term: "Pricing", confidence: 0.8, rationale: null },
      ],
      vocabulary,
    );
    assert.equal(resolved.length, 1, "only the real term survives");
    assert.equal(resolved[0]!.termId, "t-pricing");
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]!.term, "Squeeze page");
    assert.match(unresolved[0]!.reason, /No term named "Squeeze page"/);
    assert.match(unresolved[0]!.reason, /Add it in Taxonomy/, "tells the operator what to do");
  });

  it("drops a suggestion for a vocabulary that was not offered", () => {
    const { resolved, unresolved } = resolveSuggestions(
      [{ kind: "industry", term: "Finance", confidence: 0.9, rationale: null }],
      vocabulary,
    );
    assert.equal(resolved.length, 0);
    assert.equal(unresolved.length, 1);
    assert.match(unresolved[0]!.reason, /not a vocabulary/);
  });

  it("keeps only the most confident term for a single-value vocabulary", () => {
    // A page has one page type. Offering a reviewer three is noise.
    const { resolved } = resolveSuggestions(
      [
        { kind: "page_type", term: "Pricing", confidence: 0.6, rationale: null },
        { kind: "page_type", term: "Home", confidence: 0.9, rationale: null },
        { kind: "page_type", term: "Log in", confidence: 0.4, rationale: null },
      ],
      vocabulary,
    );
    const pageTypes = resolved.filter((r) => r.kind === "page_type");
    assert.equal(pageTypes.length, 1);
    assert.equal(pageTypes[0]!.termId, "t-home");
  });

  it("keeps several terms for a multi-value vocabulary", () => {
    const { resolved } = resolveSuggestions(
      [
        { kind: "ui_pattern", term: "Navigation", confidence: 0.8, rationale: null },
        { kind: "ui_pattern", term: "Data table", confidence: 0.7, rationale: null },
        { kind: "ui_pattern", term: "Form", confidence: 0.6, rationale: null },
      ],
      vocabulary,
    );
    assert.equal(resolved.filter((r) => r.kind === "ui_pattern").length, 3);
  });

  it("deduplicates the same term suggested twice", () => {
    const { resolved } = resolveSuggestions(
      [
        { kind: "ui_pattern", term: "Navigation", confidence: 0.8, rationale: null },
        { kind: "ui_pattern", term: "navigation", confidence: 0.5, rationale: null },
      ],
      vocabulary,
    );
    assert.equal(resolved.length, 1);
  });

  it("clamps confidence into 0..1", () => {
    const { resolved } = resolveSuggestions(
      [
        { kind: "ui_pattern", term: "Navigation", confidence: 4.2, rationale: null },
        { kind: "ui_pattern", term: "Form", confidence: -3, rationale: null },
      ],
      vocabulary,
    );
    for (const suggestion of resolved) {
      assert.ok(suggestion.confidence >= 0 && suggestion.confidence <= 1, `${suggestion.confidence}`);
    }
  });

  it("returns results ordered by confidence", () => {
    const { resolved } = resolveSuggestions(
      [
        { kind: "ui_pattern", term: "Form", confidence: 0.3, rationale: null },
        { kind: "ui_pattern", term: "Navigation", confidence: 0.9, rationale: null },
        { kind: "ui_pattern", term: "Data table", confidence: 0.6, rationale: null },
      ],
      vocabulary,
    );
    const confidences = resolved.map((r) => r.confidence);
    assert.deepEqual([...confidences].sort((a, b) => b - a), confidences);
  });
});

describe("clampConfidence", () => {
  it("handles non-numeric and out-of-range input", () => {
    assert.equal(clampConfidence(0.5), 0.5);
    assert.equal(clampConfidence(2), 1);
    assert.equal(clampConfidence(-1), 0);
    assert.equal(clampConfidence(Number.NaN), 0);
    // Infinity is not a meaningful confidence. It resolves to 0 ("no
    // confidence") rather than 1, so a provider that malfunctions produces a
    // suggestion a reviewer must look at, never one that could auto-apply.
    assert.equal(clampConfidence(Number.POSITIVE_INFINITY), 0);
    assert.equal(clampConfidence(Number.NEGATIVE_INFINITY), 0);
    assert.equal(clampConfidence("0.9"), 0);
    assert.equal(clampConfidence(null), 0);
    assert.equal(clampConfidence(undefined), 0);
  });
});

describe("heuristic provider", () => {
  it("classifies a pricing page from structural signals", async () => {
    const provider = createHeuristicProvider();
    const result = await provider.classify(input());

    assert.equal(result.provider, "heuristic");
    assert.equal(result.error, null);
    // `usesModel` was never a field on the result, so the old form of this
    // assertion (`result.usesModel ?? false`) compared `false` to `false` and
    // proved nothing. The heuristic provider's actual promise is that it never
    // calls a model, and that is visible in three fields.
    assert.equal(result.model, null, "the heuristic provider names no model");
    assert.equal(result.inputTokens, null, "no tokens were sent");
    assert.equal(result.outputTokens, null, "no tokens were received");

    const pageType = result.suggestions.find((s) => s.kind === "page_type");
    assert.equal(pageType?.termId, "t-pricing", "a /pricing URL with price hints and tables");
    assert.ok(pageType?.rationale, "every suggestion explains its evidence");

    const uiPatterns = result.suggestions.filter((s) => s.kind === "ui_pattern").map((s) => s.termId);
    assert.ok(uiPatterns.includes("t-nav"), "a nav landmark was observed");
    assert.ok(uiPatterns.includes("t-table"), "two tables were observed");
  });

  it("identifies a login page from a password field", async () => {
    const provider = createHeuristicProvider();
    const result = await provider.classify(
      input({
        url: "https://example.com/login",
        title: "Sign in",
        h1: "Sign in",
        headings: [],
        description: null,
        signals: { passwordInputCount: 1, formCount: 1, navCount: 0 },
      }),
    );
    assert.equal(result.suggestions.find((s) => s.kind === "page_type")?.termId, "t-login");
  });

  it("NEVER produces a suggestion confident enough to auto-apply", async () => {
    // The mechanical guarantee behind §14: heuristic output always reaches a
    // human, because no rule's confidence reaches the auto-apply floor.
    const provider = createHeuristicProvider();
    for (const testInput of [
      input(),
      input({ url: "https://example.com/login", signals: { passwordInputCount: 1 } }),
      input({ url: "https://example.com/", signals: { hasHeader: true, hasFooter: true } }),
    ]) {
      const result = await provider.classify(testInput);
      for (const suggestion of result.suggestions) {
        // `platform: Web` is a mechanical fact (it came from a URL), not a
        // judgement, so it is allowed to be certain.
        if (suggestion.kind === "platform") continue;
        assert.ok(
          suggestion.confidence < DEFAULT_MIN_AUTO_APPLY_CONFIDENCE,
          `${suggestion.kind}/${suggestion.termName} at ${suggestion.confidence} would auto-apply`,
        );
      }
    }
  });

  it("suggests nothing when there is no vocabulary to choose from", async () => {
    const provider = createHeuristicProvider();
    const result = await provider.classify(input({ vocabulary: [] }));
    assert.deepEqual(result.suggestions, []);
  });

  it("survives malformed input without throwing", async () => {
    const provider = createHeuristicProvider();
    const result = await provider.classify(
      input({ url: "not a url", title: null, description: null, h1: null, headings: [], signals: {} }),
    );
    assert.equal(result.error, null, "a rule that cannot evaluate is a non-match, not a failure");
  });

  it("does not flood a reviewer with suggestions", async () => {
    const provider = createHeuristicProvider({ maxPerKind: 2 });
    const result = await provider.classify(
      input({
        signals: {
          navCount: 1, tableCount: 1, formCount: 1, hasFooter: true, hasAside: true,
          videoCount: 1, hasDialog: true, hasCarouselHint: true, hasTabsHint: true,
        },
      }),
    );
    const uiCount = result.suggestions.filter((s) => s.kind === "ui_pattern").length;
    assert.ok(uiCount <= 2, `expected at most 2 ui_pattern suggestions, got ${uiCount}`);
  });

  it("documents its rules for the Settings screen", () => {
    const rules = describeHeuristicRules();
    assert.ok(rules.length > 20);
    for (const rule of rules) {
      assert.ok(rule.rationale.length > 10, `${rule.term} needs an explanation`);
      assert.ok(rule.confidence > 0 && rule.confidence <= 1);
    }
  });
});

describe("provider factory", () => {
  it("returns a no-op provider for 'none'", async () => {
    const provider = await createClassificationProvider({ provider: "none" });
    const result = await provider.classify(input());
    assert.equal(result.provider, "none");
    assert.deepEqual(result.suggestions, []);
  });

  it("returns the heuristic provider by default", async () => {
    const provider = await createClassificationProvider({ provider: "heuristic" });
    assert.equal(provider.name, "heuristic");
    assert.equal(provider.usesModel, false);
  });

  it("falls back to heuristic when anthropic is selected with no key", async () => {
    // Misconfiguration must degrade, not break the pipeline.
    const provider = await createClassificationProvider({ provider: "anthropic" });
    assert.equal(provider.name, "heuristic");
  });

  it("the null provider is usable and inert", async () => {
    const result = await createNullProvider().classify(input());
    assert.equal(result.error, null);
    assert.deepEqual(result.suggestions, []);
    assert.equal(result.model, null);
  });
});
