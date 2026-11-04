/**
 * The browser globals this package's `page.evaluate` callbacks use.
 *
 * ## Why not just add `"DOM"` to `lib`
 *
 * This package runs in Node. The only code here that touches `document` or
 * `window` is inside a `page.evaluate(...)` callback, which Playwright
 * serialises and runs *in the page* — so those globals are genuinely in scope
 * at runtime, and genuinely absent from the surrounding module.
 *
 * Enabling the full DOM lib would type those callbacks correctly and also make
 * every DOM global available to the Node code around them. That is exactly the
 * mistake worth avoiding here: a stray `localStorage.getItem(...)` or
 * `fetch(document.location)` in the worker would typecheck and then throw at
 * runtime, in the process that is hardest to debug and most exposed.
 *
 * Declaring only what is used keeps that error a compile error. If a callback
 * needs another global, add it here deliberately — the friction is the point.
 *
 * ## Why these members and no more
 *
 * Each entry corresponds to a real call site in `browser-capture.ts`:
 * waiting for fonts before photographing text, measuring the document to size
 * a full-page screenshot, and scrolling to trigger lazy-loaded images.
 */

interface BrowserDocumentElement {
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

interface BrowserFontFaceSet {
  /** Resolves once web fonts have loaded, so text is not captured mid-swap. */
  readonly ready: Promise<unknown>;
}

interface BrowserDocument {
  readonly documentElement: BrowserDocumentElement;
  /** Absent in older engines, hence the optional chain at the call site. */
  readonly fonts?: BrowserFontFaceSet;
}

interface BrowserWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  scrollTo(x: number, y: number): void;
  scrollBy(x: number, y: number): void;
}

declare const document: BrowserDocument;
declare const window: BrowserWindow;
