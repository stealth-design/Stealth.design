/**
 * Phase 5 — interaction capture, proof of concept.
 *
 * ## Why this is a separate script
 *
 * `interaction_details` and `state_details` exist in the schema, are read by
 * the CMS detail query, and are written by nothing. The CMS renders a section
 * that can never populate. Before wiring anything into the capture pipeline the
 * question worth answering is whether interaction capture is *feasible* on the
 * open web at all — so this measures that, and stores nothing.
 *
 * ## What it measures
 *
 * For each page: how many interactive elements can be found using structure
 * alone (no per-site selectors), how many of those actually change the page
 * when operated, and what a before/after pair costs in time and bytes. Those
 * three numbers decide whether this is a feature or a research project.
 *
 * ## The honest difficulty
 *
 * Finding a button is easy. Knowing that clicking it produced *the* state a
 * designer wants to browse — rather than a navigation, a cookie dismissal or
 * nothing at all — is the hard part, and it is what this script tries to
 * quantify rather than assume.
 *
 * ## Bounds (Phase 2's rules apply here too)
 *
 * Explicit URL list, one page per run per URL, a cap on candidates per page, a
 * per-interaction timeout, a total runtime ceiling, and a hard refusal to
 * follow navigations. Chromium's sandbox stays enabled.
 *
 * ## Untrusted input
 *
 * Page-authored strings — labels, selectors, text — are read as *data*. The
 * only code that runs in the page is the static function literal below; no
 * value taken from the page is ever passed back into `evaluate`, a shell, SQL
 * or a template. Everything harvested is truncated and stripped before it is
 * printed.
 *
 *   node scripts/experiments/interaction-poc.mjs
 *   node scripts/experiments/interaction-poc.mjs --limit=4 --candidates=6
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const B = "[1m";
const D = "[90m";
const G = "[32m";
const Y = "[33m";
const R = "[31m";
const X = "[0m";

// --- Bounds ---------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const LIMITS = {
  /** Pages per run. */
  pages: Number(args.limit ?? 8),
  /** Interactive elements probed per page. The tail is long and low-value. */
  candidatesPerPage: Number(args.candidates ?? 8),
  /** One navigation. */
  navigationMs: 20_000,
  /** How long to let an interaction's animation settle before the after-shot. */
  settleMs: 700,
  /** One interaction, including both screenshots. */
  interactionMs: 8_000,
  /** Whole run. */
  totalMs: 10 * 60_000,
  viewport: { width: 1440, height: 900 },
};

/**
 * Pages chosen to span the interaction patterns the brief names, using sites
 * whose robots.txt permits automated access and which are stable enough that a
 * re-run is comparable. Each declares what it is *expected* to exercise, so a
 * miss is visible as a miss rather than averaged away.
 */
const PAGES = [
  { url: "https://developer.mozilla.org/en-US/docs/Web/HTML", expect: ["menu", "dropdown"] },
  { url: "https://getbootstrap.com/docs/5.3/components/accordion/", expect: ["accordion", "tabs"] },
  { url: "https://getbootstrap.com/docs/5.3/components/modal/", expect: ["modal", "click"] },
  { url: "https://getbootstrap.com/docs/5.3/components/dropdowns/", expect: ["dropdown"] },
  { url: "https://getbootstrap.com/docs/5.3/components/carousel/", expect: ["carousel"] },
  { url: "https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/examples/disclosure-navigation/", expect: ["menu", "accordion"] },
  { url: "https://tailwindcss.com/docs/installation/using-vite", expect: ["menu", "tabs"] },
  { url: "https://react.dev/learn", expect: ["menu", "dropdown"] },
].slice(0, LIMITS.pages);

// --- Candidate discovery --------------------------------------------------

/**
 * Runs in the page. A static function literal — nothing from the page is ever
 * compiled or re-entered as code.
 *
 * Candidates are found by *structure*: ARIA attributes and semantic elements,
 * which are the only signals that mean the same thing across sites. A
 * class-name heuristic ("looks like `.accordion`") would work on the sites that
 * happen to use that word and silently fail everywhere else, which is worse
 * than not trying, because the failure looks like a clean result.
 *
 * The returned `type` is a *hypothesis* about what the element is, derived from
 * the attribute that identified it. It is checked afterwards against what the
 * interaction actually did.
 */
const FIND_CANDIDATES = () => {
  /** @type {{selector: string, type: string, label: string, evidence: string}[]} */
  const found = [];
  const seen = new Set();

  // A stable-ish path for one element. Prefers an id, then a scoped
  // nth-of-type chain. Not universally unique, which is why every use is
  // re-validated before the interaction.
  const pathTo = (el) => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      if (tag === "html" || tag === "body") break;
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
      node = parent;
    }
    return parts.join(" > ");
  };

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };

  const add = (el, type, evidence) => {
    if (!visible(el)) return;
    const selector = pathTo(el);
    if (!selector || seen.has(selector)) return;
    seen.add(selector);
    found.push({
      selector,
      type,
      // Labels are page-authored text. Truncated here and sanitised again on
      // the Node side before anything is printed.
      label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 80),
      evidence,
    });
  };

  // The structural signals, most specific first. `aria-expanded` is the single
  // most useful one on the real web: it means "this thing toggles something",
  // and it is machine-checkable afterwards because the attribute flips.
  for (const el of document.querySelectorAll("[aria-expanded]")) {
    const controls = el.getAttribute("aria-controls");
    const hasPopup = el.getAttribute("aria-haspopup");
    const type = hasPopup === "menu" ? "menu" : hasPopup ? "dropdown" : controls ? "accordion" : "click";
    add(el, type, "aria-expanded");
  }
  for (const el of document.querySelectorAll('[role="tab"]')) add(el, "tabs", 'role="tab"');
  for (const el of document.querySelectorAll("details > summary")) add(el, "accordion", "details/summary");
  for (const el of document.querySelectorAll('[data-bs-toggle="modal"], [aria-haspopup="dialog"]')) {
    add(el, "modal", "dialog trigger");
  }
  for (const el of document.querySelectorAll('[role="menuitem"]')) add(el, "menu", 'role="menuitem"');
  for (const el of document.querySelectorAll("select")) add(el, "dropdown", "select element");

  return found;
};

/** A page-content fingerprint, used to tell whether an interaction did anything. */
const SNAPSHOT = () => ({
  // Structure rather than full HTML: cheap to compare, and insensitive to the
  // text churn of a live site while still catching a panel opening.
  nodes: document.querySelectorAll("*").length,
  visibleText: document.body.innerText.length,
  expanded: [...document.querySelectorAll('[aria-expanded="true"]')].length,
  openDialogs: document.querySelectorAll("dialog[open], [role=dialog]:not([hidden])").length,
  url: location.href,
  scrollHeight: document.documentElement.scrollHeight,
});

// --- Helpers --------------------------------------------------------------

/** Page-authored text is control-stripped and truncated before display. */
const clean = (text, max = 60) =>
  String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** How different are two snapshots? Returns the signals that moved. */
function diff(before, after) {
  const changes = [];
  if (before.url !== after.url) changes.push("navigated");
  if (before.expanded !== after.expanded) changes.push(`expanded ${before.expanded}->${after.expanded}`);
  if (before.openDialogs !== after.openDialogs) changes.push(`dialogs ${before.openDialogs}->${after.openDialogs}`);
  const nodeDelta = after.nodes - before.nodes;
  if (Math.abs(nodeDelta) > 2) changes.push(`nodes ${nodeDelta > 0 ? "+" : ""}${nodeDelta}`);
  const textDelta = after.visibleText - before.visibleText;
  if (Math.abs(textDelta) > 20) changes.push(`text ${textDelta > 0 ? "+" : ""}${textDelta}`);
  const heightDelta = after.scrollHeight - before.scrollHeight;
  if (Math.abs(heightDelta) > 24) changes.push(`height ${heightDelta > 0 ? "+" : ""}${heightDelta}`);
  return changes;
}

// --- Run ------------------------------------------------------------------

const startedAt = Date.now();
const outDir = join(".data/experiments/interaction-poc", new Date(startedAt).toISOString().replace(/[:.]/g, "-"));
await mkdir(outDir, { recursive: true });

console.log(`${B}Interaction capture — proof of concept${X}`);
console.log(`${D}${PAGES.length} pages · up to ${LIMITS.candidatesPerPage} candidates each · sandbox enabled${X}`);
console.log(`${D}output: ${outDir}${X}\n`);

// Sandbox stays on. The brief forbids disabling it and this script has no
// reason to be the exception.
const browser = await chromium.launch({ headless: true });
const results = [];
let totalBytes = 0;

for (const page_ of PAGES) {
  if (Date.now() - startedAt > LIMITS.totalMs) {
    console.log(`${Y}Total runtime ceiling reached; stopping.${X}`);
    break;
  }

  const host = new URL(page_.url).host;
  const record = {
    url: page_.url,
    expected: page_.expect,
    candidates: 0,
    probed: 0,
    effective: 0,
    navigations: 0,
    inert: 0,
    errors: 0,
    interactions: [],
    ms: 0,
  };
  const pageStart = Date.now();

  const context = await browser.newContext({
    viewport: LIMITS.viewport,
    userAgent: "uxdisrupt-research (+interaction capture proof of concept)",
  });
  const page = await context.newPage();

  try {
    console.log(`${B}${host}${X} ${D}${page_.url.slice(0, 78)}${X}`);
    await page.goto(page_.url, { waitUntil: "domcontentloaded", timeout: LIMITS.navigationMs });
    await page.waitForTimeout(800);

    const candidates = await page.evaluate(FIND_CANDIDATES);
    record.candidates = candidates.length;

    const byType = candidates.reduce((acc, c) => ({ ...acc, [c.type]: (acc[c.type] ?? 0) + 1 }), {});
    console.log(
      `  found ${B}${candidates.length}${X} candidates ${D}${Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(" ")}${X}`,
    );

    for (const candidate of candidates.slice(0, LIMITS.candidatesPerPage)) {
      if (Date.now() - startedAt > LIMITS.totalMs) break;
      record.probed += 1;

      const entry = { type: candidate.type, label: clean(candidate.label), evidence: candidate.evidence };
      try {
        // `candidate.selector` is page-derived and untrusted. Playwright's
        // locator API parses it as a selector and cannot execute it, which is
        // exactly why the selector never goes anywhere else.
        const locator = page.locator(candidate.selector).first();
        if ((await locator.count()) === 0) {
          entry.outcome = "vanished";
          record.errors += 1;
          record.interactions.push(entry);
          continue;
        }

        const before = await page.evaluate(SNAPSHOT);
        const beforeShot = await locator
          .screenshot({ timeout: LIMITS.interactionMs })
          .catch(() => null);

        // Hover for pointer-driven patterns, click for the rest. `select` is
        // left alone: choosing an option is a value change, not a state to
        // browse, and firing it can submit a form.
        if (candidate.type === "dropdown" && candidate.evidence === "select element") {
          entry.outcome = "skipped-select";
          record.interactions.push(entry);
          continue;
        }

        await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
        if (candidate.type === "menu" || candidate.type === "dropdown") {
          await locator.hover({ timeout: LIMITS.interactionMs, trial: false });
          await page.waitForTimeout(LIMITS.settleMs);
          const hoverState = await page.evaluate(SNAPSHOT);
          // Many menus are click-driven even when they look hover-driven, so
          // fall through to a click when hovering changed nothing.
          if (diff(before, hoverState).length === 0) {
            await locator.click({ timeout: LIMITS.interactionMs, noWaitAfter: true });
            entry.method = "hover-then-click";
          } else {
            entry.method = "hover";
          }
        } else {
          await locator.click({ timeout: LIMITS.interactionMs, noWaitAfter: true });
          entry.method = "click";
        }

        await page.waitForTimeout(LIMITS.settleMs);
        const after = await page.evaluate(SNAPSHOT);
        const changes = diff(before, after);
        entry.changes = changes;

        const afterShot = await page.screenshot({ timeout: LIMITS.interactionMs }).catch(() => null);
        if (beforeShot) totalBytes += beforeShot.byteLength;
        if (afterShot) totalBytes += afterShot.byteLength;

        if (changes.includes("navigated")) {
          entry.outcome = "navigated";
          record.navigations += 1;
          // A navigation is not an interaction state. Go back, or the rest of
          // this page's candidates are probed against a different document.
          await page.goBack({ waitUntil: "domcontentloaded", timeout: LIMITS.navigationMs }).catch(() => {});
          await page.waitForTimeout(500);
        } else if (changes.length > 0) {
          entry.outcome = "changed";
          record.effective += 1;
        } else {
          entry.outcome = "inert";
          record.inert += 1;
        }

        const mark =
          entry.outcome === "changed" ? `${G}+${X}` : entry.outcome === "navigated" ? `${Y}>${X}` : `${R}.${X}`;
        console.log(
          `    ${mark} ${entry.type.padEnd(10)} ${D}${(entry.method ?? "").padEnd(17)}${X}` +
            `${clean(candidate.label, 28).padEnd(30)} ${D}${changes.join(", ") || "no change"}${X}`,
        );
      } catch (error) {
        entry.outcome = "error";
        entry.error = clean(error?.message, 90);
        record.errors += 1;
        console.log(`    ${R}!${X} ${entry.type.padEnd(10)} ${D}${entry.error}${X}`);
      }
      record.interactions.push(entry);
    }
  } catch (error) {
    record.loadError = clean(error?.message, 120);
    console.log(`  ${R}could not load: ${record.loadError}${X}`);
  } finally {
    record.ms = Date.now() - pageStart;
    await context.close().catch(() => {});
  }

  const hit = record.probed > 0 ? Math.round((record.effective / record.probed) * 100) : 0;
  console.log(
    `  ${D}${record.effective}/${record.probed} produced a state change (${hit}%) · ${Math.round(record.ms / 100) / 10}s${X}\n`,
  );
  results.push(record);
}

await browser.close();

// --- Findings -------------------------------------------------------------

const probed = results.reduce((n, r) => n + r.probed, 0);
const effective = results.reduce((n, r) => n + r.effective, 0);
const navigations = results.reduce((n, r) => n + r.navigations, 0);
const inert = results.reduce((n, r) => n + r.inert, 0);
const errors = results.reduce((n, r) => n + r.errors, 0);
const found = results.reduce((n, r) => n + r.candidates, 0);

console.log(`${B}Findings${X}`);
console.log(`  ${found} candidates found by structure across ${results.length} pages`);
console.log(`  ${probed} probed · ${G}${effective} changed state${X} · ${Y}${navigations} navigated away${X} · ${R}${inert} inert${X} · ${errors} errored`);
if (probed > 0) {
  console.log(`  ${B}${Math.round((effective / probed) * 100)}%${X} of structurally-identified elements produced a browsable state change`);
}
console.log(`  ${(totalBytes / 1024 / 1024).toFixed(1)} MB of before/after PNGs, unoptimised`);
if (effective > 0) {
  console.log(`  ${D}~${Math.round(totalBytes / effective / 1024)} KB per usable before/after pair${X}`);
}

// Did the hypothesised type survive contact with the page?
const byExpectation = results.map((r) => {
  const seenTypes = new Set(r.interactions.filter((i) => i.outcome === "changed").map((i) => i.type));
  const met = r.expected.filter((e) => seenTypes.has(e));
  return { url: r.url, expected: r.expected, met };
});
const fullyMet = byExpectation.filter((r) => r.met.length === r.expected.length).length;
console.log(`  ${fullyMet}/${byExpectation.length} pages yielded every interaction type they were chosen for`);

const elapsed = Math.round((Date.now() - startedAt) / 1000);
const file = join(outDir, "results.json");
await writeFile(
  file,
  `${JSON.stringify({ startedAt: new Date(startedAt).toISOString(), limits: LIMITS, elapsedSeconds: elapsed, totals: { found, probed, effective, navigations, inert, errors, totalBytes }, byExpectation, results }, null, 2)}\n`,
);
console.log(`\n${D}${elapsed}s · ${file}${X}`);
