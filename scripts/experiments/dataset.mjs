/**
 * The crawl experiment dataset.
 *
 * ## What this is for
 *
 * Phase 2 of the audit asks for 50–100 publicly accessible sites covering
 * specific technical scenarios, so that the capture pipeline is measured
 * against what the web actually is rather than against `example.com`.
 *
 * Each entry declares which scenarios it exercises. That is what makes the
 * results diagnostic instead of merely aggregate: a 78% success rate tells you
 * nothing, but "every failure was a `spa` and every `spa` failed" tells you
 * where to look.
 *
 * ## How these were chosen
 *
 * Documentation sites, open-source project pages, standards bodies, public
 * institutions and a handful of well-known product marketing pages. The
 * selection is biased towards sites that expect automated traffic and publish
 * permissive robots.txt — which is deliberate. This is a capability
 * measurement, not a content-acquisition run, and a research crawler's first
 * obligation is to be a well-behaved visitor.
 *
 * ## What this run does NOT do
 *
 * No discovery, no depth. `maxDepth: 0` and `crawlInternalLinks: false`, so
 * exactly the listed URLs are fetched and nothing else. One page per host in
 * the standard profile. robots.txt is respected — a site that disallows us is
 * recorded as `blocked`, which is a legitimate result rather than a failure to
 * work around.
 *
 * ## Adding a URL
 *
 * Only if it is publicly accessible without authentication, its robots.txt
 * permits automated access, and it exercises a scenario the set does not
 * already cover well. Quantity is not the goal.
 */

/**
 * The technical scenarios the audit brief names, plus a few the brief implies.
 *
 * Every one has a reason to be measured separately — a difference in how the
 * capture pipeline has to behave, not just a difference in subject matter.
 */
export const SCENARIOS = {
  "static-html": "Server-rendered HTML with little or no client-side JavaScript.",
  react: "React, client-rendered or hydrated.",
  nextjs: "Next.js, so streaming and hydration boundaries are in play.",
  vue: "Vue or Nuxt.",
  svelte: "Svelte or SvelteKit.",
  spa: "Content that does not exist in the initial HTML at all.",
  "heavy-js": "Large JavaScript payload; slow to reach a settled state.",
  animation: "Animation on load, which a screenshot can catch mid-motion.",
  "long-page": "Very tall documents, where a full-page screenshot is expensive.",
  "lazy-images": "Images that load only on scroll.",
  redirect: "Redirects on the way to the final URL.",
  "cookie-banner": "A consent overlay obscuring the page.",
  slow: "Slow to respond or slow to settle.",
  "many-links": "Large numbers of internal links, exercising discovery limits.",
  "expected-fail": "Expected not to load. Included to measure error handling.",
  "unusual-layout": "Layout that a naive viewport assumption gets wrong.",
  video: "Embedded video.",
  svg: "Significant inline SVG.",
  canvas: "Canvas or WebGL rendering.",
  webfonts: "Web fonts that arrive after first paint.",
  "sticky-nav": "Sticky or fixed navigation, which repeats in a full-page shot.",
  i18n: "Non-Latin script, to check text extraction and font fallback.",
  "no-js-fallback": "Works entirely without JavaScript.",
  "http-only": "Good candidate for level-1 HTTP capture rather than a browser.",
};

/**
 * @typedef {{ url: string, label: string, scenarios: string[], note?: string }} Entry
 * @type {Entry[]}
 */
export const DATASET = [
  // --- Static HTML, minimal or no JavaScript ---------------------------
  { url: "https://example.com/", label: "Example Domain", scenarios: ["static-html", "http-only", "no-js-fallback"] },
  { url: "https://www.rfc-editor.org/rfc/rfc9562.html", label: "RFC 9562 (UUID)", scenarios: ["static-html", "long-page", "http-only", "no-js-fallback"] },
  { url: "https://www.ietf.org/", label: "IETF", scenarios: ["static-html", "webfonts"] },
  { url: "https://www.w3.org/", label: "W3C", scenarios: ["static-html", "many-links"] },
  { url: "https://www.gnu.org/", label: "GNU", scenarios: ["static-html", "no-js-fallback", "http-only"] },
  { url: "https://www.kernel.org/", label: "kernel.org", scenarios: ["static-html", "http-only"] },
  { url: "https://curl.se/", label: "curl", scenarios: ["static-html", "many-links"] },
  { url: "https://www.sqlite.org/index.html", label: "SQLite", scenarios: ["static-html", "no-js-fallback", "many-links"] },
  { url: "https://nginx.org/", label: "nginx", scenarios: ["static-html", "http-only"] },
  { url: "https://httpd.apache.org/", label: "Apache httpd", scenarios: ["static-html", "many-links"] },
  { url: "https://www.postgresql.org/", label: "PostgreSQL", scenarios: ["static-html", "webfonts"] },
  { url: "https://man7.org/linux/man-pages/man2/open.2.html", label: "man open(2)", scenarios: ["static-html", "long-page", "unusual-layout"] },

  // --- Documentation platforms ----------------------------------------
  { url: "https://developer.mozilla.org/en-US/docs/Web/HTML", label: "MDN HTML", scenarios: ["react", "long-page", "many-links", "webfonts", "sticky-nav"] },
  { url: "https://docs.python.org/3/", label: "Python docs", scenarios: ["static-html", "many-links", "http-only"] },
  { url: "https://nodejs.org/en", label: "Node.js", scenarios: ["nextjs", "react", "webfonts"] },
  { url: "https://go.dev/", label: "Go", scenarios: ["static-html", "animation", "svg"] },
  { url: "https://www.rust-lang.org/", label: "Rust", scenarios: ["static-html", "svg", "webfonts"] },
  { url: "https://docs.rs/", label: "docs.rs", scenarios: ["static-html", "unusual-layout"] },
  { url: "https://kotlinlang.org/", label: "Kotlin", scenarios: ["react", "animation", "heavy-js"] },
  { url: "https://www.typescriptlang.org/", label: "TypeScript", scenarios: ["static-html", "webfonts", "many-links"] },
  { url: "https://react.dev/", label: "React", scenarios: ["react", "spa", "heavy-js", "animation", "sticky-nav"] },
  { url: "https://vuejs.org/", label: "Vue", scenarios: ["vue", "spa", "heavy-js"] },
  { url: "https://svelte.dev/", label: "Svelte", scenarios: ["svelte", "spa", "animation"] },
  { url: "https://nextjs.org/", label: "Next.js", scenarios: ["nextjs", "react", "heavy-js", "animation", "webfonts"] },
  { url: "https://nuxt.com/", label: "Nuxt", scenarios: ["vue", "spa", "heavy-js"] },
  { url: "https://astro.build/", label: "Astro", scenarios: ["static-html", "animation", "svg"] },
  { url: "https://vite.dev/", label: "Vite", scenarios: ["vue", "spa"] },
  { url: "https://tailwindcss.com/", label: "Tailwind CSS", scenarios: ["nextjs", "react", "long-page", "lazy-images", "sticky-nav"] },
  { url: "https://www.solidjs.com/", label: "SolidJS", scenarios: ["spa", "animation"] },
  { url: "https://htmx.org/", label: "htmx", scenarios: ["static-html", "no-js-fallback", "long-page"] },
  { url: "https://deno.com/", label: "Deno", scenarios: ["nextjs", "react", "animation"] },
  { url: "https://bun.sh/", label: "Bun", scenarios: ["nextjs", "react", "animation", "svg"] },
  { url: "https://fastapi.tiangolo.com/", label: "FastAPI", scenarios: ["static-html", "long-page", "many-links"] },
  { url: "https://laravel.com/", label: "Laravel", scenarios: ["heavy-js", "animation", "webfonts"] },
  { url: "https://rubyonrails.org/", label: "Rails", scenarios: ["static-html", "unusual-layout", "webfonts"] },
  { url: "https://spring.io/", label: "Spring", scenarios: ["react", "heavy-js"] },
  { url: "https://www.djangoproject.com/", label: "Django", scenarios: ["static-html", "many-links"] },
  { url: "https://flask.palletsprojects.com/", label: "Flask", scenarios: ["static-html", "long-page"] },
  { url: "https://redis.io/", label: "Redis", scenarios: ["nextjs", "react", "cookie-banner"] },
  { url: "https://www.mongodb.com/", label: "MongoDB", scenarios: ["heavy-js", "cookie-banner", "lazy-images"] },
  { url: "https://grafana.com/", label: "Grafana", scenarios: ["nextjs", "heavy-js", "cookie-banner"] },
  { url: "https://prometheus.io/", label: "Prometheus", scenarios: ["static-html", "svg"] },
  { url: "https://kubernetes.io/", label: "Kubernetes", scenarios: ["static-html", "many-links", "long-page", "sticky-nav"] },
  { url: "https://www.docker.com/", label: "Docker", scenarios: ["heavy-js", "cookie-banner", "lazy-images"] },
  { url: "https://about.gitlab.com/", label: "GitLab", scenarios: ["heavy-js", "long-page", "lazy-images"] },
  { url: "https://obsidian.md/", label: "Obsidian", scenarios: ["static-html", "video", "animation"] },
  { url: "https://zed.dev/", label: "Zed", scenarios: ["spa", "animation", "canvas", "video"] },
  { url: "https://neovim.io/", label: "Neovim", scenarios: ["static-html", "svg"] },
  { url: "https://code.visualstudio.com/", label: "VS Code", scenarios: ["heavy-js", "video", "lazy-images"] },

  // --- Design and typography ------------------------------------------
  { url: "https://fonts.google.com/", label: "Google Fonts", scenarios: ["spa", "heavy-js", "webfonts", "lazy-images"] },
  { url: "https://www.figma.com/", label: "Figma", scenarios: ["heavy-js", "animation", "cookie-banner", "video"] },
  { url: "https://practicaltypography.com/", label: "Practical Typography", scenarios: ["static-html", "long-page", "unusual-layout", "webfonts"] },
  { url: "https://www.smashingmagazine.com/", label: "Smashing Magazine", scenarios: ["static-html", "long-page", "lazy-images", "many-links"] },
  { url: "https://alistapart.com/", label: "A List Apart", scenarios: ["static-html", "webfonts", "long-page"] },
  { url: "https://css-tricks.com/", label: "CSS-Tricks", scenarios: ["static-html", "lazy-images", "many-links"] },
  { url: "https://developer.chrome.com/", label: "Chrome for Developers", scenarios: ["heavy-js", "lazy-images", "many-links", "sticky-nav"] },
  { url: "https://web.dev/", label: "web.dev", scenarios: ["heavy-js", "lazy-images"] },
  { url: "https://caniuse.com/", label: "Can I Use", scenarios: ["spa", "heavy-js", "unusual-layout"] },
  { url: "https://svgwg.org/svg2-draft/", label: "SVG 2 draft", scenarios: ["static-html", "long-page", "svg"] },

  // --- Institutions and reference -------------------------------------
  { url: "https://www.wikipedia.org/", label: "Wikipedia portal", scenarios: ["static-html", "i18n", "svg"] },
  { url: "https://en.wikipedia.org/wiki/Design", label: "Wikipedia article", scenarios: ["static-html", "long-page", "many-links", "lazy-images"] },
  { url: "https://ja.wikipedia.org/wiki/%E3%83%87%E3%82%B6%E3%82%A4%E3%83%B3", label: "Wikipedia (Japanese)", scenarios: ["static-html", "i18n", "long-page"] },
  { url: "https://www.gov.uk/", label: "GOV.UK", scenarios: ["static-html", "no-js-fallback", "http-only"] },
  { url: "https://design-system.service.gov.uk/", label: "GOV.UK Design System", scenarios: ["static-html", "many-links", "no-js-fallback"] },
  { url: "https://designsystem.digital.gov/", label: "US Web Design System", scenarios: ["static-html", "many-links"] },
  { url: "https://www.nasa.gov/", label: "NASA", scenarios: ["heavy-js", "lazy-images", "video", "long-page"] },
  { url: "https://www.esa.int/", label: "ESA", scenarios: ["heavy-js", "lazy-images", "cookie-banner"] },
  { url: "https://archive.org/", label: "Internet Archive", scenarios: ["static-html", "unusual-layout", "many-links"] },
  { url: "https://creativecommons.org/", label: "Creative Commons", scenarios: ["static-html", "svg"] },
  { url: "https://www.unicode.org/", label: "Unicode", scenarios: ["static-html", "unusual-layout", "http-only"] },
  { url: "https://openlibrary.org/", label: "Open Library", scenarios: ["static-html", "lazy-images", "many-links"] },

  // --- Redirects -------------------------------------------------------
  { url: "http://example.com/", label: "example.com over HTTP", scenarios: ["redirect", "http-only"], note: "http → https upgrade" },
  { url: "https://w3.org/", label: "w3.org (no www)", scenarios: ["redirect"], note: "apex → www" },
  { url: "https://bit.ly/3xyzabc", label: "shortlink", scenarios: ["redirect", "expected-fail"], note: "a shortener; may 404" },
  { url: "https://httpbin.org/redirect/3", label: "3 redirects", scenarios: ["redirect"], note: "chained redirects" },
  { url: "https://httpbin.org/redirect/12", label: "12 redirects", scenarios: ["redirect", "expected-fail"], note: "exceeds the 5-hop limit" },
  { url: "https://httpbin.org/absolute-redirect/2", label: "absolute redirects", scenarios: ["redirect"] },

  // --- Slow, large, and error responses --------------------------------
  { url: "https://httpbin.org/delay/3", label: "3s delay", scenarios: ["slow"] },
  // 10s is slow but inside the 20s navigation timeout, so this is expected to
  // succeed. It was labelled `expected-fail` on the first pass, which made the
  // run look worse than it was — a reminder that the dataset's own labels are
  // a hypothesis to be checked against measured behaviour, not ground truth.
  { url: "https://httpbin.org/delay/10", label: "10s delay", scenarios: ["slow"], note: "slow but within the 20s navigation timeout" },
  { url: "https://httpbin.org/status/404", label: "404", scenarios: ["expected-fail"] },
  { url: "https://httpbin.org/status/500", label: "500", scenarios: ["expected-fail"] },
  { url: "https://httpbin.org/status/403", label: "403", scenarios: ["expected-fail"] },
  { url: "https://httpbin.org/html", label: "minimal HTML", scenarios: ["static-html", "http-only"] },
  // Does NOT test the response-size cap, despite the URL. httpbin caps its own
  // `/bytes/` endpoint at 102,400 bytes — a HEAD returns
  // `content-length: 102400` — so the body arrives complete and well under the
  // limit. It is kept because it exercises a real non-HTML binary response
  // (which yields no extractable text and therefore no content hash), but the
  // size bound itself is covered by `packages/crawler/test/http-bounds.test.ts`
  // against a synthetic stream, which is where a limit like this belongs: no
  // public endpoint can be relied on to keep sending until we say stop.
  { url: "https://httpbin.org/bytes/20000000", label: "binary response (100KB, not 20MB)", scenarios: ["expected-fail"], note: "non-HTML body; httpbin caps this endpoint at 100KB" },

  // --- Expected to fail ------------------------------------------------
  { url: "https://this-domain-should-not-exist-uxd-audit.example", label: "NXDOMAIN", scenarios: ["expected-fail"], note: "DNS failure" },
  { url: "https://expired.badssl.com/", label: "expired certificate", scenarios: ["expected-fail"], note: "TLS failure" },
  { url: "https://self-signed.badssl.com/", label: "self-signed certificate", scenarios: ["expected-fail"] },
  { url: "https://untrusted-root.badssl.com/", label: "untrusted root", scenarios: ["expected-fail"] },

  // --- Must be refused by our own guard --------------------------------
  //
  // These are not expected to fail at the network — they must never reach it.
  // Included so the experiment measures the SSRF guard on the same path as
  // everything else rather than only in a unit test.
  { url: "http://localhost:3000/", label: "localhost", scenarios: ["expected-fail"], note: "must be BLOCKED" },
  { url: "http://127.0.0.1:5432/", label: "loopback + database port", scenarios: ["expected-fail"], note: "must be BLOCKED" },
  { url: "http://169.254.169.254/latest/meta-data/", label: "cloud metadata", scenarios: ["expected-fail"], note: "must be BLOCKED" },
  { url: "http://[::1]/", label: "IPv6 loopback", scenarios: ["expected-fail"], note: "must be BLOCKED" },
  { url: "http://2130706433/", label: "decimal-encoded loopback", scenarios: ["expected-fail"], note: "must be BLOCKED" },
  { url: "http://10.0.0.1/", label: "RFC 1918", scenarios: ["expected-fail"], note: "must be BLOCKED" },
  { url: "file:///etc/passwd", label: "file://", scenarios: ["expected-fail"], note: "must be INVALID" },
  { url: "ftp://ftp.example.com/", label: "ftp://", scenarios: ["expected-fail"], note: "must be INVALID" },
  { url: "gopher://example.com/", label: "gopher://", scenarios: ["expected-fail"], note: "must be INVALID" },
  { url: "not-a-url-at-all", label: "malformed", scenarios: ["expected-fail"], note: "must be INVALID" },
];

/** URLs whose refusal is the correct outcome, keyed for the report. */
export const MUST_BE_REFUSED = new Set(
  DATASET.filter((e) => e.note?.startsWith("must be")).map((e) => e.url),
);

/** Everything expected to reach the network and succeed. */
export const EXPECTED_SUCCESS = DATASET.filter(
  (e) => !e.scenarios.includes("expected-fail"),
);

export function scenarioCoverage() {
  const counts = Object.fromEntries(Object.keys(SCENARIOS).map((s) => [s, 0]));
  for (const entry of DATASET) {
    for (const scenario of entry.scenarios) {
      if (scenario in counts) counts[scenario] += 1;
      else throw new Error(`Unknown scenario "${scenario}" on ${entry.url}`);
    }
  }
  return counts;
}
