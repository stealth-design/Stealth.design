/**
 * Verify the whole image path end to end.
 *
 *   Playwright master -> storage -> derivative -> public API -> frontend
 *
 * The question this answers is the only one that matters for quality: for each
 * image the site actually renders, is the rendition the browser chose at least
 * as wide as the space it has to fill, at that display's pixel density?
 *
 * Everything is measured from the running system — the database for what was
 * generated, the public API for what is offered, and a real browser for what
 * was chosen and how big it is on screen. Nothing here is inferred from config.
 *
 *   node scripts/verify-image-pipeline.mjs
 *   node scripts/verify-image-pipeline.mjs --dpr=1
 */
import sharp from "sharp";
import { chromium } from "playwright";

const B = "[1m";
const D = "[90m";
const G = "[32m";
const Y = "[33m";
const R = "[31m";
const X = "[0m";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);

const API = process.env.PUBLIC_API_BASE_URL ?? "http://localhost:3000/api/public";
const SITE = process.env.FRONTEND_BASE_URL ?? "http://localhost:3001";
const DPR = Number(args.dpr ?? 2);
const VIEWPORT = Number(args.viewport ?? 1440);

const listing = await (await fetch(`${API}/content?limit=24`)).json();
const entries = listing.items ?? [];

console.log(`${B}Image pipeline verification${X}`);
console.log(`${D}viewport ${VIEWPORT} at dpr ${DPR} · ${entries.length} published entries${X}\n`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: VIEWPORT, height: 1000 },
  deviceScaleFactor: DPR,
});
const page = await context.newPage();

const rows = [];

for (const entry of entries) {
  const detail = await (await fetch(`${API}/content/${entry.slug}`)).json();
  await page.goto(`${SITE}/entry/${entry.slug}`, {
    waitUntil: "domcontentloaded",
    timeout: 40_000,
  });

  // Every image on this page is lazy below the fold, so a rendition is only
  // *selected* once it is scrolled to. Reading before that reports an empty
  // `currentSrc`, which looks exactly like a fallback to the original.
  const measured = await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll("img.tile-img")];
    const out = [];
    for (const img of imgs) {
      img.scrollIntoView({ block: "center" });
      await new Promise((r) => setTimeout(r, 350));
      out.push({
        css: Math.round(img.getBoundingClientRect().width),
        currentSrc: img.currentSrc,
        srcset: img.srcset,
        natural: img.naturalWidth,
      });
    }
    return out;
  });

  // The first tile is the primary image — the one that carries the page.
  const first = measured[0];
  const media = detail.media?.[0];
  if (!first || !media) continue;

  const kindOf = (url) =>
    (url.match(/-(thumbnail|preview|large)\.webp/) ?? [, url ? "original" : "none"])[1];

  const needed = first.css * DPR;

  // `naturalWidth` cannot answer this. For an image with `w` descriptors the
  // spec defines the intrinsic size as the resource's *density-corrected* size,
  // so the browser reports the `sizes` value back at us no matter which file it
  // chose — every row read 1056. The only honest measurement is the file the
  // browser actually fetched, so fetch it and read its header.
  let got = 0;
  try {
    const bytes = Buffer.from(await (await fetch(first.currentSrc)).arrayBuffer());
    got = (await sharp(bytes).metadata()).width ?? 0;
  } catch {
    got = 0;
  }
  const ok = got >= needed * 0.98;

  rows.push({
    title: (detail.title ?? entry.slug).slice(0, 22),
    original: `${media.width}x${media.height}`,
    preview: media.previewUrl ? "yes" : "-",
    large: media.largeUrl ? "yes" : "-",
    css: first.css,
    needed,
    got,
    picked: kindOf(first.currentSrc),
    hasSrcset: Boolean(first.srcset),
    ok,
  });
}

await browser.close();

const w = { t: 24, o: 13, p: 8, c: 6, n: 7, g: 7, k: 10 };
console.log(
  `  ${"entry".padEnd(w.t)}${"original".padEnd(w.o)}${"prev/lrg".padEnd(w.p + 2)}` +
    `${"css".padStart(w.c)}${"needs".padStart(w.n)}${"served".padStart(w.g)}  ${"selected".padEnd(w.k)}verdict`,
);
for (const r of rows) {
  const verdict = r.ok ? `${G}crisp${X}` : `${Y}soft ${(r.needed / r.got).toFixed(2)}x${X}`;
  console.log(
    `  ${r.title.padEnd(w.t)}${r.original.padEnd(w.o)}${(r.preview + "/" + r.large).padEnd(w.p + 2)}` +
      `${String(r.css).padStart(w.c)}${String(r.needed).padStart(w.n)}${String(r.got).padStart(w.g)}  ` +
      `${r.picked.padEnd(w.k)}${verdict}`,
  );
}

const crisp = rows.filter((r) => r.ok).length;
const withSrcset = rows.filter((r) => r.hasSrcset).length;
console.log(
  `\n  ${crisp}/${rows.length} crisp at dpr ${DPR} · ${withSrcset}/${rows.length} offered a choice of renditions`,
);
if (crisp < rows.length) {
  console.log(
    `  ${D}A "soft" row means the widest rendition is narrower than the space it fills.${X}`,
  );
  console.log(
    `  ${D}At 1054css and dpr 2 the ceiling is 2048px, so 2108 needed is a 2% shortfall.${X}`,
  );
}
console.log("");
