/**
 * Handling for text that came from a crawled page.
 *
 * Every title, meta description, heading and link label we extract is attacker
 * controlled. Before such a string is stored, logged, rendered, or shown to a
 * model, it goes through `sanitizeText`. The rules here are deliberately
 * conservative: we are storing short human-readable labels, not documents.
 */

// C0/C1 control characters, minus tab/newline which we normalise separately.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// Zero-width and bidi-override characters. These are how a hostile page smuggles
// invisible content into a CMS table or a model prompt.
const INVISIBLE_CHARS =
  /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// Unicode line/paragraph separators, folded to \n.
const LINE_SEPARATORS = /[\u0085\u2028\u2029]/g;

export interface SanitizeTextOptions {
  /** Hard cap on the result, applied after normalisation. */
  readonly maxLength?: number;
  /** Collapse all whitespace (including newlines) into single spaces. */
  readonly singleLine?: boolean;
  /** Append an ellipsis when truncated. */
  readonly ellipsis?: boolean;
}

/**
 * Normalise and defang untrusted text. Returns `null` for input that is empty
 * once cleaned, so callers can store a real NULL rather than "".
 */
export function sanitizeText(
  input: unknown,
  options: SanitizeTextOptions = {},
): string | null {
  if (typeof input !== "string") return null;
  const maxLength = options.maxLength ?? 2000;
  const singleLine = options.singleLine ?? true;

  let out = input
    .normalize("NFC")
    .replace(LINE_SEPARATORS, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(INVISIBLE_CHARS, "");

  out = singleLine
    ? out.replace(/\s+/g, " ")
    : out.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");

  out = out.trim();
  if (out.length === 0) return null;

  if (out.length > maxLength) {
    out = out.slice(0, maxLength).trimEnd();
    if (options.ellipsis ?? true) out += "…";
  }
  return out;
}

/** Sanitize an array of untrusted strings, dropping empties and duplicates. */
export function sanitizeTextList(
  input: unknown,
  options: SanitizeTextOptions & { maxItems?: number } = {},
): string[] {
  if (!Array.isArray(input)) return [];
  const maxItems = options.maxItems ?? 50;
  const seen = new Set<string>();
  for (const raw of input) {
    if (seen.size >= maxItems) break;
    const clean = sanitizeText(raw, options);
    if (clean) seen.add(clean);
  }
  return [...seen];
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * HTML entity escaping.
 *
 * React escapes interpolated text already, so this exists for the places React
 * does not cover: generated feeds, emails, and any string that ends up inside
 * an attribute we build by hand.
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Wrap untrusted text for inclusion in a model prompt.
 *
 * Two things are happening here. The delimiter makes the boundary between our
 * instructions and page content explicit. The escaping of the delimiter itself
 * stops a page from closing the block early and continuing as if it were the
 * system author. This is a mitigation, not a guarantee — the real protection is
 * that classification output is a *suggestion* that a human must accept (§14),
 * and that the model is never given tools or credentials.
 */
export function fenceUntrusted(label: string, content: string): string {
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_").toUpperCase();
  const open = `<<<UNTRUSTED_${safeLabel}>>>`;
  const close = `<<<END_UNTRUSTED_${safeLabel}>>>`;
  const body = content
    .replaceAll(open, "[removed]")
    .replaceAll(close, "[removed]")
    .replace(/<<</g, "(((")
    .replace(/>>>/g, ")))");
  return `${open}\n${body}\n${close}`;
}

/** Compact whitespace-collapsed excerpt for table cells and search snippets. */
export function excerpt(input: string | null | undefined, length = 140): string {
  if (!input) return "";
  const clean = sanitizeText(input, { maxLength: length, singleLine: true, ellipsis: true });
  return clean ?? "";
}

/**
 * Split pasted bulk input into candidate URLs.
 *
 * Accepts newline-, comma-, semicolon- and whitespace-separated input, which is
 * what actually arrives when someone pastes from a spreadsheet, a Slack
 * message, or a text file. Order is preserved and blank lines are dropped.
 * No validation happens here — that is `validateUrl`'s job.
 */
export function splitPastedUrls(input: string, maxItems = 10_000): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    if (out.length >= maxItems) break;
    // Strip markdown/quote wrappers and trailing sentence punctuation that
    // survives a copy-paste.
    const trimmed = raw
      .trim()
      .replace(/^[<("'[]+/, "")
      .replace(/[>)"'\].,]+$/, "");
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** Pluralise a count for CMS copy: `pluralize(1, "page")` -> "1 page". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}
