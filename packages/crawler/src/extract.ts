/**
 * Metadata extraction from crawled HTML.
 *
 * Everything this module returns is attacker-controlled. A page can put
 * anything in its `<title>`, its meta tags, its link labels — including
 * gigabytes of it, invisible Unicode, control characters, or text designed to
 * read as instructions to a model.
 *
 * So every string leaves here having passed through `sanitizeText` (which
 * normalises Unicode, strips control and zero-width characters, collapses
 * whitespace and enforces a length cap) and every list has a bounded size.
 * Nothing downstream needs to remember to sanitise, because nothing unsanitised
 * escapes this file.
 *
 * Parsing uses cheerio/htmlparser2 — a pure parser that builds a tree and
 * executes nothing. No `eval`, no script execution, no network fetches for
 * subresources.
 */
import * as cheerio from "cheerio";
import {
  type ParsedUrl,
  contentHash as computeContentHash,
  resolveDiscoveredHref,
  sanitizeText,
  sha256Hex,
} from "@uxd/shared";

/** Caps on what we will keep from one page. */
const LIMITS = {
  title: 500,
  description: 2000,
  heading: 300,
  headings: 50,
  links: 2000,
  linkText: 200,
  images: 200,
  textForHash: 200_000,
  jsonLdBytes: 100_000,
} as const;

export interface ExtractedLink {
  /** Absolute, resolved against the page URL. Not yet guarded. */
  readonly url: string;
  readonly text: string | null;
  readonly rel: string | null;
  /** Same registrable host as the page. */
  readonly internal: boolean;
}

export interface ExtractedPage {
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly ogTitle: string | null;
  readonly ogDescription: string | null;
  readonly ogImageUrl: string | null;
  readonly ogType: string | null;
  readonly ogSiteName: string | null;
  readonly twitterCard: string | null;
  readonly faviconUrl: string | null;
  /** The page's own rel=canonical claim, resolved. Untrusted: a page can claim
   * any canonical it likes, so this is recorded, not obeyed. */
  readonly canonicalUrl: string | null;
  readonly langAttr: string | null;
  readonly h1: string | null;
  readonly headings: readonly { level: number; text: string }[];
  readonly links: readonly ExtractedLink[];
  readonly imageUrls: readonly string[];
  readonly wordCount: number;
  readonly hasNoindex: boolean;
  /** Hash of the visible text. Equal hashes across captures mean no change. */
  readonly contentHash: string;
  /**
   * Hash of the structural skeleton — tag names and heading levels, without
   * text. Lets a capture distinguish "the copy changed" from "the layout
   * changed", which is the difference between a content edit and a redesign.
   */
  readonly layoutHash: string;
  /** Hash of the raw HTML, for exact-byte comparison. */
  readonly domHash: string;
  /** Signals for the heuristic classifier. Structural facts, not text. */
  readonly signals: PageSignals;
}

/**
 * Structural signals used by the heuristic classifier.
 *
 * Counts and booleans rather than text, deliberately: a heuristic that keys off
 * structure ("has a pricing table, three tiers, a form with an email field")
 * cannot be talked into a wrong answer by page copy, whereas one that keys off
 * words can.
 */
export interface PageSignals {
  readonly formCount: number;
  readonly emailInputCount: number;
  readonly passwordInputCount: number;
  readonly searchInputCount: number;
  readonly buttonCount: number;
  readonly linkCount: number;
  readonly imageCount: number;
  readonly videoCount: number;
  readonly iframeCount: number;
  readonly tableCount: number;
  readonly listCount: number;
  readonly headingCount: number;
  readonly navCount: number;
  readonly hasHeader: boolean;
  readonly hasFooter: boolean;
  readonly hasAside: boolean;
  readonly hasMain: boolean;
  readonly hasDialog: boolean;
  readonly hasCarouselHint: boolean;
  readonly hasTabsHint: boolean;
  readonly hasAccordionHint: boolean;
  readonly hasModalHint: boolean;
  readonly hasPriceHint: boolean;
  readonly hasCartHint: boolean;
  readonly hasAuthHint: boolean;
  readonly hasCookieBannerHint: boolean;
  readonly ariaRoles: readonly string[];
  readonly scriptCount: number;
  /** Known frameworks detectable from markup, useful context for a reviewer. */
  readonly frameworkHints: readonly string[];
}

/** Elements whose text is not part of the visible content. */
const NON_CONTENT_SELECTORS = "script, style, noscript, template, svg, iframe, object, embed";

export interface ExtractOptions {
  readonly pageUrl: string;
  readonly parsedUrl?: ParsedUrl;
  /** Treat subdomains as internal when classifying discovered links. */
  readonly includeSubdomains?: boolean;
}

export function extractFromHtml(html: string, options: ExtractOptions): ExtractedPage {
  const $ = cheerio.load(html, {
    // No script execution, no network. htmlparser2 builds a tree and stops.
    xml: false,
  });

  const meta = (names: readonly string[], attr: "name" | "property" = "name"): string | null => {
    for (const name of names) {
      const value = $(`meta[${attr}="${name}"]`).first().attr("content");
      const clean = sanitizeText(value, { maxLength: LIMITS.description });
      if (clean) return clean;
    }
    return null;
  };

  const resolve = (href: string | undefined): string | null =>
    href ? resolveDiscoveredHref(href, options.pageUrl) : null;

  // --- Identity ---------------------------------------------------------
  const title = sanitizeText($("title").first().text(), { maxLength: LIMITS.title });
  const ogTitle = meta(["og:title"], "property");
  const ogDescription = meta(["og:description"], "property");
  const metaDescription = meta(["description"]);
  const ogType = meta(["og:type"], "property");
  const ogSiteName = meta(["og:site_name"], "property");
  const twitterCard = meta(["twitter:card"]);

  const ogImageRaw =
    $('meta[property="og:image"]').first().attr("content") ??
    $('meta[property="og:image:url"]').first().attr("content") ??
    $('meta[name="twitter:image"]').first().attr("content");
  const ogImageUrl = resolve(ogImageRaw);

  const faviconRaw =
    $('link[rel="icon"]').first().attr("href") ??
    $('link[rel="shortcut icon"]').first().attr("href") ??
    $('link[rel="apple-touch-icon"]').first().attr("href");
  // Fall back to the conventional location rather than leaving it null: /favicon.ico
  // is served by most sites without declaring it.
  const faviconUrl = resolve(faviconRaw) ?? resolve("/favicon.ico");

  const canonicalUrl = resolve($('link[rel="canonical"]').first().attr("href"));
  const langAttr = sanitizeText($("html").attr("lang"), { maxLength: 20 });

  const robotsMeta = `${$('meta[name="robots"]').attr("content") ?? ""} ${
    $('meta[name="googlebot"]').attr("content") ?? ""
  }`.toLowerCase();
  const hasNoindex = robotsMeta.includes("noindex") || robotsMeta.includes("none");

  // --- Headings ---------------------------------------------------------
  const headings: { level: number; text: string }[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    if (headings.length >= LIMITS.headings) return false;
    const tag = (el as { tagName?: string }).tagName ?? "h6";
    const text = sanitizeText($(el).text(), { maxLength: LIMITS.heading });
    if (text) headings.push({ level: Number(tag.slice(1)) || 6, text });
    return undefined;
  });
  const h1 = headings.find((h) => h.level === 1)?.text ?? null;

  // --- Links ------------------------------------------------------------
  const pageHost = (() => {
    try {
      return new URL(options.pageUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  const isInternal = (url: string): boolean => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host === pageHost) return true;
      if (!options.includeSubdomains) return false;
      return host.endsWith(`.${pageHost}`) || pageHost.endsWith(`.${host}`);
    } catch {
      return false;
    }
  };

  const seenLinks = new Set<string>();
  const links: ExtractedLink[] = [];
  $("a[href]").each((_, el) => {
    if (links.length >= LIMITS.links) return false;
    const url = resolve($(el).attr("href"));
    if (!url || seenLinks.has(url)) return undefined;
    seenLinks.add(url);
    links.push({
      url,
      text: sanitizeText($(el).text(), { maxLength: LIMITS.linkText }),
      rel: sanitizeText($(el).attr("rel"), { maxLength: 100 }),
      internal: isInternal(url),
    });
    return undefined;
  });

  // --- Images -----------------------------------------------------------
  const seenImages = new Set<string>();
  $("img[src], img[data-src], source[srcset]").each((_, el) => {
    if (seenImages.size >= LIMITS.images) return false;
    const raw =
      $(el).attr("src") ??
      $(el).attr("data-src") ??
      $(el).attr("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
    const url = resolve(raw);
    if (url) seenImages.add(url);
    return undefined;
  });

  // --- Visible text, for hashing and word count -------------------------
  const $text = cheerio.load(html);
  $text(NON_CONTENT_SELECTORS).remove();
  const visibleText = ($text("body").text() || $text.root().text())
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.textForHash);
  const wordCount = visibleText.length === 0 ? 0 : visibleText.split(/\s+/).length;

  // --- Hashes -----------------------------------------------------------
  const contentHash = computeContentHash([title, h1, visibleText]);

  // The layout hash walks the tag skeleton with no text at all, so a copy edit
  // leaves it unchanged while a template change moves it.
  const skeleton: string[] = [];
  $("body")
    .find("*")
    .each((_, el) => {
      if (skeleton.length >= 4000) return false;
      const tag = (el as { tagName?: string }).tagName;
      if (tag && !NON_CONTENT_SELECTORS.includes(tag)) skeleton.push(tag);
      return undefined;
    });
  const layoutHash = sha256Hex(skeleton.join(">"));
  const domHash = sha256Hex(html);

  return {
    title,
    metaDescription,
    ogTitle,
    ogDescription,
    ogImageUrl,
    ogType,
    ogSiteName,
    twitterCard,
    faviconUrl,
    canonicalUrl,
    langAttr,
    h1,
    headings,
    links,
    imageUrls: [...seenImages],
    wordCount,
    hasNoindex,
    contentHash,
    layoutHash,
    domHash,
    signals: extractSignals($, visibleText),
  };
}

function extractSignals($: cheerio.CheerioAPI, visibleText: string): PageSignals {
  const count = (selector: string): number => {
    try {
      return $(selector).length;
    } catch {
      return 0;
    }
  };
  const has = (selector: string): boolean => count(selector) > 0;
  const lowerText = visibleText.toLowerCase().slice(0, 20_000);

  const classAndId = $("[class], [id]")
    .slice(0, 500)
    .map((_, el) => `${$(el).attr("class") ?? ""} ${$(el).attr("id") ?? ""}`)
    .get()
    .join(" ")
    .toLowerCase();

  const roles = new Set<string>();
  $("[role]")
    .slice(0, 200)
    .each((_, el) => {
      const role = $(el).attr("role")?.trim().toLowerCase();
      if (role && /^[a-z-]{1,30}$/.test(role)) roles.add(role);
    });

  const frameworkHints: string[] = [];
  if (has("#__next") || has("script#__NEXT_DATA__")) frameworkHints.push("next.js");
  if (has("[data-reactroot]") || has("#root")) frameworkHints.push("react");
  if (has("[data-v-app]") || has("#__nuxt")) frameworkHints.push("vue/nuxt");
  if (has("[ng-version]")) frameworkHints.push("angular");
  if (has("#svelte") || has("[data-svelte-h]")) frameworkHints.push("svelte");
  if (has('meta[name="generator"][content*="WordPress" i]')) frameworkHints.push("wordpress");
  if (has('script[src*="shopify" i]') || has("[data-shopify]")) frameworkHints.push("shopify");
  if (has('script[src*="webflow" i]') || has("html[data-wf-page]")) frameworkHints.push("webflow");

  return {
    formCount: count("form"),
    emailInputCount: count('input[type="email"], input[name*="email" i]'),
    passwordInputCount: count('input[type="password"]'),
    searchInputCount: count('input[type="search"], [role="search"] input, input[name*="search" i], input[name="q"]'),
    buttonCount: count('button, [role="button"], input[type="submit"]'),
    linkCount: count("a[href]"),
    imageCount: count("img"),
    videoCount: count("video, [class*='video' i]"),
    iframeCount: count("iframe"),
    tableCount: count("table"),
    listCount: count("ul, ol"),
    headingCount: count("h1, h2, h3, h4, h5, h6"),
    navCount: count('nav, [role="navigation"]'),
    hasHeader: has('header, [role="banner"]'),
    hasFooter: has('footer, [role="contentinfo"]'),
    hasAside: has('aside, [role="complementary"]'),
    hasMain: has('main, [role="main"]'),
    hasDialog: has('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'),
    hasCarouselHint: /carousel|slider|swiper|slick|glide|splide/.test(classAndId),
    hasTabsHint: has('[role="tab"], [role="tablist"]') || /\btabs?\b/.test(classAndId),
    hasAccordionHint: has("details") || /accordion|collaps/.test(classAndId),
    hasModalHint: has("dialog") || /modal|overlay|lightbox|drawer/.test(classAndId),
    hasPriceHint:
      /pricing|per month|\/mo\b|\$\d|£\d|€\d/.test(lowerText) || /\bpric(e|ing)\b/.test(classAndId),
    hasCartHint: /add to cart|add to bag|basket|checkout/.test(lowerText) || /\bcart\b/.test(classAndId),
    hasAuthHint:
      count('input[type="password"]') > 0 ||
      /sign in|log in|sign up|create account|register/.test(lowerText.slice(0, 5_000)),
    hasCookieBannerHint:
      /cookie|consent|gdpr/.test(classAndId) ||
      /we use cookies|accept all cookies|manage preferences/.test(lowerText.slice(0, 8_000)),
    ariaRoles: [...roles].slice(0, 40),
    scriptCount: count("script"),
    frameworkHints,
  };
}

/**
 * Parse a sitemap.
 *
 * Handles both a `<urlset>` of pages and a `<sitemapindex>` of nested
 * sitemaps, and returns them separately so the caller decides whether to
 * follow the index. Bounded, because a sitemap index can legitimately point at
 * fifty thousand URLs and an operator pasting one should not accidentally queue
 * all of them.
 */
export interface ParsedSitemap {
  readonly urls: readonly { url: string; lastModified: string | null }[];
  readonly nestedSitemaps: readonly string[];
  readonly truncated: boolean;
}

export function parseSitemap(xml: string, maxUrls = 5_000): ParsedSitemap {
  const $ = cheerio.load(xml, { xml: true });
  const urls: { url: string; lastModified: string | null }[] = [];
  let truncated = false;

  $("url").each((_, el) => {
    if (urls.length >= maxUrls) {
      truncated = true;
      return false;
    }
    const loc = sanitizeText($(el).find("loc").first().text(), { maxLength: 2048 });
    if (loc) {
      urls.push({
        url: loc,
        lastModified: sanitizeText($(el).find("lastmod").first().text(), { maxLength: 40 }),
      });
    }
    return undefined;
  });

  const nestedSitemaps: string[] = [];
  $("sitemap > loc").each((_, el) => {
    if (nestedSitemaps.length >= 200) return false;
    const loc = sanitizeText($(el).text(), { maxLength: 2048 });
    if (loc) nestedSitemaps.push(loc);
    return undefined;
  });

  return { urls, nestedSitemaps, truncated };
}

/**
 * Compare two captures and describe what moved.
 *
 * Returns a summary a person can read on the capture-history panel, which is
 * the V1 answer to §12's versioning question. A pixel-level visual diff is
 * deliberately not built — §12 says not to unless it is simple, and comparing
 * three hashes tells a reviewer which *kind* of change happened, which is the
 * part that decides whether they need to look.
 */
export interface ChangeSummary {
  readonly changed: boolean;
  readonly contentChanged: boolean;
  readonly layoutChanged: boolean;
  readonly titleChanged: boolean;
  /** Sentence for the CMS. */
  readonly description: string;
}

export function summariseChange(
  previous: { contentHash: string | null; layoutHash: string | null; pageTitle: string | null } | null,
  current: { contentHash: string | null; layoutHash: string | null; pageTitle: string | null },
): ChangeSummary {
  if (!previous) {
    return {
      changed: false,
      contentChanged: false,
      layoutChanged: false,
      titleChanged: false,
      description: "First capture — nothing to compare against yet.",
    };
  }

  const contentChanged =
    previous.contentHash !== null &&
    current.contentHash !== null &&
    previous.contentHash !== current.contentHash;
  const layoutChanged =
    previous.layoutHash !== null &&
    current.layoutHash !== null &&
    previous.layoutHash !== current.layoutHash;
  const titleChanged = (previous.pageTitle ?? null) !== (current.pageTitle ?? null);

  const parts: string[] = [];
  if (layoutChanged) parts.push("the page structure changed");
  if (contentChanged) parts.push("the text changed");
  if (titleChanged) parts.push("the title changed");

  return {
    changed: contentChanged || layoutChanged || titleChanged,
    contentChanged,
    layoutChanged,
    titleChanged,
    description:
      parts.length === 0
        ? "No change since the last capture."
        : `Since the last capture, ${parts.join(" and ")}.`,
  };
}
