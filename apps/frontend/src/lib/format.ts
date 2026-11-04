/**
 * The frontend's small formatting helpers.
 *
 * Kept here rather than imported from `@uxd/shared`, because that package pulls
 * in nothing dangerous today but is a shared surface that could — and the
 * boundary check exists precisely so this app's dependency list stays short
 * enough to read. Four functions is a cheaper price than a dependency.
 */

/** A date as a plain, unambiguous string. Null-safe. */
export function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** A URL as a reader-friendly host and path, with the scheme dropped. */
export function displayUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.host}${path}`;
  } catch {
    return value;
  }
}

/** "12 pages" / "1 page". */
export function plural(count: number, singular: string, pluralForm?: string): string {
  const word = count === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${count.toLocaleString("en-US")} ${word}`;
}

/**
 * Acronyms that must not be sentence-cased.
 *
 * "Ui pattern" and "Ux pattern" are the two that actually show up, and both
 * look like a bug on a design site of all places.
 */
const ACRONYMS = new Map([
  ["ui", "UI"],
  ["ux", "UX"],
  ["api", "API"],
  ["url", "URL"],
  ["os", "OS"],
  ["cta", "CTA"],
  ["seo", "SEO"],
  ["ios", "iOS"],
]);

/** A vocabulary key like `ui_pattern` as a heading. */
/**
 * What a tag group is called on the site. Plain names for visitors, not the
 * internal kinds the CMS files tags under.
 */
const KIND_LABELS: Record<string, string> = {
  industry: "Industry",
  ui_pattern: "Type",
  ux_pattern: "Style",
  component: "Elements",
  page_type: "Page",
  screen_type: "Page",
  state: "State",
  function: "Category",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? humanise(kind);
}

export function humanise(value: string): string {
  const words = value.split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return value;

  return words
    .map((word, index) => {
      const acronym = ACRONYMS.get(word.toLowerCase());
      if (acronym) return acronym;
      // Only the first word is capitalised: these are labels, not titles.
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase();
    })
    .join(" ");
}
