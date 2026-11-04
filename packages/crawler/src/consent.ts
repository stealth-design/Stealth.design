/**
 * Cookie-consent banners.
 *
 * Every capture context is a brand-new browser profile, so every site treats
 * it as a first visit and puts its consent banner over the page — on some
 * sites, half the viewport. That is not the state a researcher is trying to
 * record, so the studio dismisses banners by default.
 *
 * The work is done by DuckDuckGo's autoconsent, the library their browsers use
 * for the same job: rules for the common consent platforms (OneTrust,
 * Cookiebot, Didomi, Usercentrics, TrustArc, Sourcepoint, IAB TCF) plus a
 * heuristic fallback. It *clicks the site's own opt-out*, rather than hiding
 * the banner with CSS, so the page underneath behaves as it would for a
 * visitor who declined — scrolling unlocked, no dimmed backdrop — and fewer
 * third-party trackers load into the sandbox.
 *
 * Isolation is unchanged. The script is the library's standalone build, read
 * from the pinned package on disk: it carries its rules inline and makes no
 * network requests, so nothing is fetched at runtime and the SSRF request
 * screen sees no new traffic. It is not operator-supplied, which is the line
 * the studio's command set draws.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";

let script: Promise<string> | null = null;

/**
 * The standalone build's source, read once per process.
 *
 * Located next to the package's main entry because its `exports` map does not
 * expose `dist/` subpaths — resolving the entry and taking its sibling is the
 * supported way to reach a file the map does not name.
 */
function standaloneScript(): Promise<string> {
  script ??= readFile(
    join(dirname(fileURLToPath(import.meta.resolve("@duckduckgo/autoconsent"))), "autoconsent.standalone.js"),
    "utf8",
  );
  return script;
}

export interface ConsentOutcome {
  /** `dismissed`: at least one banner was opted out of. `failed`: a banner
   * was found but every opt-out failed. `none`: no banner was handled. */
  readonly outcome: "dismissed" | "failed" | "none";
  /** Consent platforms opted out of, by rule name, e.g. `Onetrust`. */
  readonly cmps: readonly string[];
}

export interface ConsentTracker {
  /** What has been dismissed in this context so far. */
  outcome(): ConsentOutcome;
}

/** The standalone build's result line, e.g. `autoconsent opt-out result: Onetrust true`. */
const OPT_OUT_LINE = /^autoconsent opt-out result: ([\w .-]{1,60}) (true|false)$/;

/**
 * Dismiss consent banners on every page and frame this context opens.
 *
 * An init script, so it runs before the site's own code on every navigation
 * and in every iframe — several platforms render the banner inside one.
 * Must be called before the first page is created.
 *
 * The outcome is tracked here, from the console, rather than read back out of
 * the page: many sites reload once consent is recorded, which discards any
 * state the script kept on `window`. A hostile page can print the same line,
 * so what it yields is treated as untrusted — an enum and short identifiers,
 * kept as provenance, never acted on.
 */
export async function installConsentHandling(context: BrowserContext): Promise<ConsentTracker> {
  await context.addInitScript({ content: await standaloneScript() });

  const dismissed = new Set<string>();
  let failed = false;

  const watch = (page: Page) => {
    page.on("console", (message) => {
      const match = OPT_OUT_LINE.exec(message.text());
      if (!match) return;
      if (match[2] === "true" && dismissed.size < 20) dismissed.add(match[1]!.trim());
      else failed = true;
    });
  };
  context.pages().forEach(watch);
  context.on("page", watch);

  return {
    outcome: () => ({
      outcome: dismissed.size > 0 ? "dismissed" : failed ? "failed" : "none",
      cmps: [...dismissed],
    }),
  };
}
