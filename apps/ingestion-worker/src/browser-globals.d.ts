/**
 * The browser globals this app's `page.evaluate` callbacks use.
 *
 * Same reasoning as `packages/crawler/src/browser-globals.d.ts`, and worth
 * repeating because this is the process where it matters most. The only code
 * here that touches `document` or `navigator` is inside a `page.evaluate(...)`
 * callback, which Playwright serialises and runs *in the page* — those globals
 * are genuinely in scope at runtime and genuinely absent from the module
 * around them.
 *
 * Turning on the full DOM lib would type those callbacks and simultaneously
 * make every DOM global available to the Node code beside them, so a stray
 * `localStorage` or `fetch(document.location)` would typecheck and then throw
 * at runtime — in the one process that runs hostile page scripts and is
 * hardest to debug. Declaring only what is used keeps that a compile error.
 *
 * Each member below corresponds to a real call site in `session.ts`: counting
 * structural elements for the classifier's signals, reading the user agent
 * the page actually saw, and finding the logo in the page header.
 */

interface BrowserRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface BrowserElement {
  readonly id: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): BrowserRect;
  closest(selector: string): BrowserElement | null;
}

interface BrowserNodeList {
  readonly length: number;
  item(index: number): BrowserElement | null;
}

interface BrowserStyle {
  readonly visibility: string;
  readonly display: string;
  readonly opacity: string;
}

interface BrowserLocation {
  readonly href: string;
  readonly host: string;
}

interface BrowserWindow {
  readonly innerWidth: number;
  scrollTo(x: number, y: number): void;
}

interface BrowserFontFaceSet {
  /** Resolves once web fonts have loaded, so text is not photographed
   * mid-swap. Optional because older engines lack it, hence the optional
   * chain at the call site. */
  readonly ready: Promise<unknown>;
}

interface BrowserDocument {
  querySelectorAll(selector: string): BrowserNodeList;
  readonly fonts?: BrowserFontFaceSet;
}

interface BrowserNavigator {
  readonly userAgent: string;
}

declare const document: BrowserDocument;
declare const navigator: BrowserNavigator;
declare const window: BrowserWindow;
declare const location: BrowserLocation;
declare function getComputedStyle(element: BrowserElement): BrowserStyle;
