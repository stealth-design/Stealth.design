/**
 * Synthetic screenshots for the demo seed.
 *
 * A design-reference library is images. With nothing captured yet the public
 * site has nothing to show, and "does the grid work" is not a question you can
 * answer against empty state — so this generates plausible interface
 * screenshots to develop and demo against.
 *
 * ## What these are and are not
 *
 * They are real PNGs, composed as SVG and rasterised by sharp, and they go
 * through the ordinary media pipeline: validated, sniffed, hashed, dHashed,
 * derivatives generated. So the media library, deduplication and thumbnailing
 * are exercised for real rather than stubbed.
 *
 * They depict **fictional products**. Nothing here reproduces, imitates or
 * claims to be any real company's interface, and every URL is under
 * `example.com`. A demo seed that shipped fabricated screenshots of real
 * products would be presenting invented material as a record of someone's
 * actual product, which is not a thing to do for the sake of a nicer-looking
 * grid.
 *
 * Rendering is deterministic: the same record name always produces the same
 * bytes. That means re-running the seed deduplicates against what is already
 * stored instead of accumulating copies, which is also a real test of the
 * sha256 path.
 */
import sharp from "sharp";

export type Layout =
  | "marketing"
  | "dashboard"
  | "table"
  | "form"
  | "detail"
  | "feed"
  | "empty"
  | "checkout";

export interface ScreenshotSpec {
  readonly title: string;
  readonly product: string;
  readonly layout: Layout;
  /** Base hue, 0-360. One per product, so a product reads as a set. */
  readonly hue: number;
  readonly device: "desktop" | "mobile";
  /** Light or dark interface, because a library of only one is a poor demo. */
  readonly scheme?: "light" | "dark";
}

const DIMENSIONS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

/** A tiny deterministic PRNG, so a name always yields the same layout jitter. */
function seeded(text: string): () => number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return () => {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    return ((hash >>> 0) % 10_000) / 10_000;
  };
}

interface Palette {
  page: string;
  surface: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
}

function palette(hue: number, scheme: "light" | "dark"): Palette {
  return scheme === "dark"
    ? {
        page: `hsl(${hue} 14% 9%)`,
        surface: `hsl(${hue} 13% 13%)`,
        line: `hsl(${hue} 12% 20%)`,
        text: `hsl(${hue} 8% 92%)`,
        muted: `hsl(${hue} 8% 55%)`,
        accent: `hsl(${hue} 78% 62%)`,
        accentSoft: `hsl(${hue} 60% 22%)`,
      }
    : {
        page: `hsl(${hue} 20% 99%)`,
        surface: `hsl(${hue} 22% 96%)`,
        line: `hsl(${hue} 16% 89%)`,
        text: `hsl(${hue} 18% 14%)`,
        muted: `hsl(${hue} 10% 48%)`,
        accent: `hsl(${hue} 72% 48%)`,
        accentSoft: `hsl(${hue} 68% 92%)`,
      };
}

const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A run of text-like bars, which reads as prose at thumbnail size. */
function textLines(
  x: number,
  y: number,
  width: number,
  count: number,
  colour: string,
  random: () => number,
  lineHeight = 11,
): string {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const w = width * (0.55 + random() * 0.45);
    lines.push(
      `<rect x="${x}" y="${y + index * lineHeight}" width="${w.toFixed(0)}" height="5" rx="2.5" fill="${colour}" opacity="0.55"/>`,
    );
  }
  return lines.join("");
}

function card(x: number, y: number, w: number, h: number, p: Palette): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${p.page}" stroke="${p.line}"/>`;
}

// --- Layouts --------------------------------------------------------------

function desktopChrome(spec: ScreenshotSpec, p: Palette): string {
  const { width } = DIMENSIONS.desktop;
  return `
    <rect width="${width}" height="${DIMENSIONS.desktop.height}" fill="${p.page}"/>
    <rect width="${width}" height="64" fill="${p.page}"/>
    <line x1="0" y1="64" x2="${width}" y2="64" stroke="${p.line}"/>
    <circle cx="40" cy="32" r="11" fill="${p.accent}"/>
    <text x="60" y="37" font-family="Inter, ui-sans-serif, system-ui, sans-serif"
      font-size="15" font-weight="600" fill="${p.text}">${escape(spec.product)}</text>
    ${[0, 1, 2].map((i) => `<rect x="${190 + i * 78}" y="27" width="${46 + i * 6}" height="7" rx="3.5" fill="${p.muted}" opacity="0.5"/>`).join("")}
    <rect x="${width - 210}" y="20" width="120" height="24" rx="12" fill="${p.surface}" stroke="${p.line}"/>
    <rect x="${width - 74}" y="20" width="34" height="24" rx="12" fill="${p.accent}"/>
  `;
}

function marketing(spec: ScreenshotSpec, p: Palette, random: () => number): string {
  const { width, height } = DIMENSIONS.desktop;
  return `
    ${desktopChrome(spec, p)}
    <rect x="0" y="64" width="${width}" height="330" fill="${p.accentSoft}"/>
    <rect x="120" y="150" width="330" height="18" rx="9" fill="${p.accent}" opacity="0.35"/>
    <rect x="120" y="186" width="540" height="34" rx="8" fill="${p.text}" opacity="0.88"/>
    <rect x="120" y="232" width="430" height="34" rx="8" fill="${p.text}" opacity="0.88"/>
    ${textLines(120, 292, 400, 2, p.text, random, 14)}
    <rect x="120" y="332" width="140" height="40" rx="20" fill="${p.accent}"/>
    <rect x="274" y="332" width="126" height="40" rx="20" fill="none" stroke="${p.line}"/>
    <rect x="760" y="120" width="560" height="250" rx="14" fill="${p.page}" stroke="${p.line}"/>
    <rect x="760" y="120" width="560" height="34" rx="14" fill="${p.surface}"/>
    ${[0, 1, 2].map((i) => `<rect x="${790 + i * 180}" y="180" width="140" height="80" rx="8" fill="${p.surface}"/>`).join("")}
    ${textLines(790, 280, 500, 4, p.text, random)}
    ${[0, 1, 2].map((i) => `${card(120 + i * 400, 450, 360, 190, p)}
      <circle cx="${152 + i * 400}" cy="486" r="14" fill="${p.accentSoft}"/>
      <rect x="${176 + i * 400}" y="480" width="${110 + i * 20}" height="9" rx="4.5" fill="${p.text}" opacity="0.8"/>
      ${textLines(152 + i * 400, 520, 290, 4, p.text, random)}`).join("")}
    <rect x="120" y="700" width="${width - 240}" height="1" fill="${p.line}"/>
    ${textLines(120, 730, 260, 3, p.muted, random)}
    <rect x="0" y="${height - 60}" width="${width}" height="60" fill="${p.surface}"/>
  `;
}

function dashboard(spec: ScreenshotSpec, p: Palette, random: () => number): string {
  const { height } = DIMENSIONS.desktop;
  const bars = Array.from({ length: 12 }, () => 30 + random() * 130);
  return `
    ${desktopChrome(spec, p)}
    <rect x="0" y="64" width="228" height="${height - 64}" fill="${p.surface}"/>
    <line x1="228" y1="64" x2="228" y2="${height}" stroke="${p.line}"/>
    ${Array.from({ length: 7 }, (_, i) => `
      ${i === 1 ? `<rect x="12" y="${92 + i * 40}" width="204" height="30" rx="8" fill="${p.accentSoft}"/>` : ""}
      <rect x="26" y="${103 + i * 40}" width="14" height="8" rx="3" fill="${p.muted}" opacity="0.7"/>
      <rect x="50" y="${103 + i * 40}" width="${70 + random() * 70}" height="8" rx="4" fill="${i === 1 ? p.accent : p.muted}" opacity="${i === 1 ? 1 : 0.6}"/>`).join("")}
    <rect x="264" y="100" width="240" height="20" rx="6" fill="${p.text}" opacity="0.85"/>
    ${[0, 1, 2, 3].map((i) => `${card(264 + i * 282, 148, 258, 104, p)}
      <rect x="288" y="172" width="${60 + i * 8}" height="7" rx="3.5" fill="${p.muted}" opacity="0.7" transform="translate(${i * 282} 0)"/>
      <rect x="288" y="192" width="${86 - i * 6}" height="20" rx="5" fill="${p.text}" opacity="0.85" transform="translate(${i * 282} 0)"/>
      <rect x="288" y="222" width="44" height="7" rx="3.5" fill="${p.accent}" transform="translate(${i * 282} 0)"/>`).join("")}
    ${card(264, 280, 780, 330, p)}
    <rect x="288" y="304" width="150" height="10" rx="5" fill="${p.text}" opacity="0.8"/>
    ${bars.map((h, i) => `<rect x="${300 + i * 60}" y="${570 - h}" width="34" height="${h}" rx="4" fill="${i % 4 === 1 ? p.accent : p.accentSoft}"/>`).join("")}
    <line x1="288" y1="572" x2="1020" y2="572" stroke="${p.line}"/>
    ${card(1068, 280, 300, 330, p)}
    <rect x="1092" y="304" width="120" height="10" rx="5" fill="${p.text}" opacity="0.8"/>
    <circle cx="1218" cy="420" r="72" fill="none" stroke="${p.accentSoft}" stroke-width="26"/>
    <circle cx="1218" cy="420" r="72" fill="none" stroke="${p.accent}" stroke-width="26"
      stroke-dasharray="${(0.62 * 452).toFixed(0)} 452" transform="rotate(-90 1218 420)"/>
    ${textLines(1092, 530, 250, 4, p.text, random)}
    ${card(264, 638, 1104, 200, p)}
    ${Array.from({ length: 4 }, (_, i) => `
      <rect x="288" y="${672 + i * 40}" width="24" height="24" rx="12" fill="${p.accentSoft}"/>
      <rect x="324" y="${680 + i * 40}" width="${160 + random() * 160}" height="8" rx="4" fill="${p.text}" opacity="0.7"/>
      <rect x="1240" y="${680 + i * 40}" width="104" height="8" rx="4" fill="${p.muted}" opacity="0.5"/>`).join("")}
  `;
}

function table(spec: ScreenshotSpec, p: Palette, random: () => number): string {
  const { width, height } = DIMENSIONS.desktop;
  return `
    ${desktopChrome(spec, p)}
    <rect x="56" y="104" width="220" height="20" rx="6" fill="${p.text}" opacity="0.85"/>
    <rect x="${width - 232}" y="100" width="176" height="34" rx="8" fill="${p.accent}"/>
    <rect x="56" y="152" width="300" height="32" rx="8" fill="${p.surface}" stroke="${p.line}"/>
    ${[0, 1, 2].map((i) => `<rect x="${372 + i * 92}" y="152" width="80" height="32" rx="16" fill="${i === 0 ? p.accentSoft : p.page}" stroke="${p.line}"/>`).join("")}
    ${card(56, 204, width - 112, height - 260, p)}
    <rect x="56" y="204" width="${width - 112}" height="44" rx="10" fill="${p.surface}"/>
    ${[0, 1, 2, 3, 4].map((i) => `<rect x="${88 + i * 260}" y="222" width="${58 + i * 9}" height="8" rx="4" fill="${p.muted}" opacity="0.8"/>`).join("")}
    ${Array.from({ length: 12 }, (_, row) => `
      <line x1="56" y1="${248 + row * 44}" x2="${width - 56}" y2="${248 + row * 44}" stroke="${p.line}"/>
      <rect x="88" y="${266 + row * 44}" width="18" height="18" rx="5" fill="${p.accentSoft}"/>
      <rect x="116" y="${271 + row * 44}" width="${110 + random() * 90}" height="8" rx="4" fill="${p.text}" opacity="0.72"/>
      <rect x="348" y="${271 + row * 44}" width="${70 + random() * 60}" height="8" rx="4" fill="${p.muted}" opacity="0.6"/>
      <rect x="608" y="${268 + row * 44}" width="72" height="16" rx="8" fill="${row % 3 === 0 ? p.accentSoft : p.surface}"/>
      <rect x="868" y="${271 + row * 44}" width="${64 + random() * 50}" height="8" rx="4" fill="${p.muted}" opacity="0.6"/>
      <rect x="1128" y="${271 + row * 44}" width="88" height="8" rx="4" fill="${p.muted}" opacity="0.6"/>`).join("")}
  `;
}

function checkout(spec: ScreenshotSpec, p: Palette, random: () => number): string {
  const { width, height } = DIMENSIONS.desktop;
  return `
    ${desktopChrome(spec, p)}
    <rect x="0" y="64" width="${width}" height="${height - 64}" fill="${p.surface}"/>
    ${[0, 1, 2].map((i) => `
      <circle cx="${520 + i * 200}" cy="118" r="14" fill="${i === 0 ? p.accent : p.page}" stroke="${p.line}"/>
      ${i < 2 ? `<line x1="${534 + i * 200}" y1="118" x2="${706 + i * 200}" y2="118" stroke="${i === 0 ? p.accent : p.line}" stroke-width="2"/>` : ""}
      <rect x="${492 + i * 200}" y="144" width="70" height="7" rx="3.5" fill="${i === 0 ? p.text : p.muted}" opacity="0.7"/>`).join("")}
    ${card(280, 190, 640, 560, p)}
    <rect x="320" y="226" width="200" height="16" rx="6" fill="${p.text}" opacity="0.85"/>
    ${Array.from({ length: 5 }, (_, i) => `
      <rect x="320" y="${272 + i * 84}" width="${72 + random() * 50}" height="7" rx="3.5" fill="${p.muted}" opacity="0.8"/>
      <rect x="320" y="${290 + i * 84}" width="560" height="42" rx="8" fill="${p.page}" stroke="${i === 1 ? p.accent : p.line}" stroke-width="${i === 1 ? 2 : 1}"/>
      <rect x="338" y="${306 + i * 84}" width="${140 + random() * 180}" height="8" rx="4" fill="${p.text}" opacity="0.45"/>`).join("")}
    <rect x="320" y="694" width="560" height="44" rx="10" fill="${p.accent}"/>
    ${card(960, 190, 400, 330, p)}
    <rect x="992" y="222" width="150" height="12" rx="6" fill="${p.text}" opacity="0.8"/>
    ${Array.from({ length: 3 }, (_, i) => `
      <rect x="992" y="${262 + i * 56}" width="44" height="44" rx="8" fill="${p.surface}"/>
      <rect x="1050" y="${272 + i * 56}" width="${130 + random() * 90}" height="8" rx="4" fill="${p.text}" opacity="0.7"/>
      <rect x="1050" y="${290 + i * 56}" width="70" height="7" rx="3.5" fill="${p.muted}" opacity="0.6"/>
      <rect x="1292" y="${278 + i * 56}" width="42" height="8" rx="4" fill="${p.text}" opacity="0.7"/>`).join("")}
    <line x1="992" y1="440" x2="1328" y2="440" stroke="${p.line}"/>
    <rect x="992" y="462" width="80" height="10" rx="5" fill="${p.text}" opacity="0.8"/>
    <rect x="1258" y="460" width="70" height="14" rx="7" fill="${p.accent}"/>
  `;
}

/** Status bar, tab bar and home indicator. The layouts draw their own headers. */
function mobileChrome(p: Palette): string {
  const { width, height } = DIMENSIONS.mobile;
  return `
    <rect width="${width}" height="${height}" fill="${p.page}"/>
    <rect width="${width}" height="54" fill="${p.page}"/>
    <rect x="24" y="20" width="40" height="7" rx="3.5" fill="${p.text}" opacity="0.75"/>
    <rect x="${width - 92}" y="20" width="68" height="7" rx="3.5" fill="${p.text}" opacity="0.75"/>
    <rect x="${width / 2 - 56}" y="14" width="112" height="22" rx="11" fill="${p.text}" opacity="0.9"/>
    <rect x="0" y="${height - 78}" width="${width}" height="78" fill="${p.page}"/>
    <line x1="0" y1="${height - 78}" x2="${width}" y2="${height - 78}" stroke="${p.line}"/>
    ${[0, 1, 2, 3, 4].map((i) => `
      <rect x="${30 + i * 68}" y="${height - 58}" width="22" height="22" rx="7" fill="${i === 0 ? p.accent : p.muted}" opacity="${i === 0 ? 1 : 0.45}"/>
      <rect x="${28 + i * 68}" y="${height - 30}" width="26" height="5" rx="2.5" fill="${i === 0 ? p.accent : p.muted}" opacity="${i === 0 ? 1 : 0.4}"/>`).join("")}
    <rect x="${width / 2 - 67}" y="${height - 12}" width="134" height="5" rx="2.5" fill="${p.text}" opacity="0.35"/>
  `;
}

function feed(p: Palette, random: () => number): string {
  const { width } = DIMENSIONS.mobile;
  return `
    ${mobileChrome(p)}
    <rect x="24" y="76" width="150" height="20" rx="6" fill="${p.text}" opacity="0.88"/>
    <circle cx="${width - 42}" cy="86" r="17" fill="${p.surface}"/>
    <rect x="24" y="116" width="${width - 48}" height="38" rx="19" fill="${p.surface}" stroke="${p.line}"/>
    <circle cx="46" cy="135" r="6" fill="${p.muted}" opacity="0.6"/>
    <rect x="62" y="131" width="120" height="7" rx="3.5" fill="${p.muted}" opacity="0.55"/>
    ${[0, 1, 2, 3].map((i) => `<rect x="${24 + i * 82}" y="170" width="${i === 0 ? 66 : 72}" height="30" rx="15" fill="${i === 0 ? p.accent : p.page}" stroke="${i === 0 ? p.accent : p.line}"/>`).join("")}
    ${[0, 1, 2].map((i) => `
      ${card(24, 220 + i * 178, width - 48, 162, p)}
      <rect x="24" y="${220 + i * 178}" width="${width - 48}" height="90" rx="10" fill="${i % 2 === 0 ? p.accentSoft : p.surface}"/>
      <rect x="44" y="${326 + i * 178}" width="${150 + random() * 90}" height="10" rx="5" fill="${p.text}" opacity="0.82"/>
      ${textLines(44, 348 + i * 178, 250, 2, p.muted, random, 14)}`).join("")}
  `;
}

function detail(p: Palette, random: () => number): string {
  const { width } = DIMENSIONS.mobile;
  return `
    ${mobileChrome(p)}
    <rect x="0" y="54" width="${width}" height="300" fill="${p.accentSoft}"/>
    <circle cx="42" cy="86" r="17" fill="${p.page}" opacity="0.9"/>
    <circle cx="${width - 42}" cy="86" r="17" fill="${p.page}" opacity="0.9"/>
    <rect x="24" y="374" width="${210 + random() * 80}" height="20" rx="6" fill="${p.text}" opacity="0.88"/>
    <rect x="24" y="404" width="120" height="9" rx="4.5" fill="${p.muted}" opacity="0.7"/>
    ${[0, 1, 2].map((i) => `<rect x="${24 + i * 78}" y="430" width="70" height="26" rx="13" fill="${p.surface}"/>`).join("")}
    <line x1="24" y1="476" x2="${width - 24}" y2="476" stroke="${p.line}"/>
    ${textLines(24, 500, width - 60, 6, p.text, random, 13)}
    <rect x="24" y="596" width="130" height="10" rx="5" fill="${p.text}" opacity="0.8"/>
    ${[0, 1, 2].map((i) => `
      <rect x="24" y="${622 + i * 40}" width="22" height="22" rx="11" fill="${p.accentSoft}"/>
      <rect x="58" y="${629 + i * 40}" width="${140 + random() * 120}" height="7" rx="3.5" fill="${p.text}" opacity="0.65"/>`).join("")}
    <rect x="24" y="${DIMENSIONS.mobile.height - 148}" width="${width - 48}" height="48" rx="24" fill="${p.accent}"/>
  `;
}

function form(p: Palette, random: () => number): string {
  const { width, height } = DIMENSIONS.mobile;
  return `
    ${mobileChrome(p)}
    <circle cx="42" cy="86" r="17" fill="${p.surface}"/>
    <rect x="24" y="126" width="${190 + random() * 70}" height="22" rx="7" fill="${p.text}" opacity="0.88"/>
    <rect x="24" y="160" width="${width - 90}" height="8" rx="4" fill="${p.muted}" opacity="0.6"/>
    <rect x="24" y="176" width="${width - 150}" height="8" rx="4" fill="${p.muted}" opacity="0.6"/>
    ${Array.from({ length: 4 }, (_, i) => `
      <rect x="24" y="${222 + i * 92}" width="${70 + random() * 50}" height="7" rx="3.5" fill="${p.muted}" opacity="0.8"/>
      <rect x="24" y="${240 + i * 92}" width="${width - 48}" height="52" rx="12" fill="${p.page}" stroke="${i === 0 ? p.accent : p.line}" stroke-width="${i === 0 ? 2 : 1}"/>
      <rect x="42" y="${260 + i * 92}" width="${120 + random() * 120}" height="9" rx="4.5" fill="${p.text}" opacity="${i === 0 ? 0.8 : 0.35}"/>`).join("")}
    <rect x="24" y="${height - 172}" width="18" height="18" rx="5" fill="${p.accent}"/>
    <rect x="52" y="${height - 168}" width="230" height="7" rx="3.5" fill="${p.muted}" opacity="0.7"/>
    <rect x="24" y="${height - 136}" width="${width - 48}" height="50" rx="25" fill="${p.accent}"/>
  `;
}

function empty(spec: ScreenshotSpec, p: Palette, random: () => number): string {
  const desktopLayout = spec.device === "desktop";
  const { width, height } = desktopLayout ? DIMENSIONS.desktop : DIMENSIONS.mobile;
  const cx = width / 2;
  const cy = height / 2 - (desktopLayout ? 20 : 60);
  return `
    ${desktopLayout ? desktopChrome(spec, p) : mobileChrome(p)}
    <circle cx="${cx}" cy="${cy - 40}" r="${desktopLayout ? 58 : 44}" fill="${p.accentSoft}"/>
    <rect x="${cx - (desktopLayout ? 26 : 20)}" y="${cy - (desktopLayout ? 62 : 54)}" width="${desktopLayout ? 52 : 40}" height="${desktopLayout ? 44 : 34}" rx="6" fill="${p.accent}" opacity="0.65"/>
    <rect x="${cx - (desktopLayout ? 140 : 110)}" y="${cy + 42}" width="${desktopLayout ? 280 : 220}" height="16" rx="8" fill="${p.text}" opacity="0.8"/>
    <rect x="${cx - (desktopLayout ? 190 : 130)}" y="${cy + 74}" width="${desktopLayout ? 380 : 260}" height="8" rx="4" fill="${p.muted}" opacity="0.6"/>
    <rect x="${cx - (desktopLayout ? 130 : 96)}" y="${cy + 90}" width="${desktopLayout ? 260 : 192}" height="8" rx="4" fill="${p.muted}" opacity="0.6"/>
    <rect x="${cx - 78}" y="${cy + 124}" width="156" height="42" rx="21" fill="${p.accent}"/>
    ${random() > 0.5 ? `<rect x="${cx - 60}" y="${cy + 182}" width="120" height="7" rx="3.5" fill="${p.muted}" opacity="0.45"/>` : ""}
  `;
}

// --- Composition ----------------------------------------------------------

function svgFor(spec: ScreenshotSpec): string {
  const scheme = spec.scheme ?? "light";
  const p = palette(spec.hue, scheme);
  const random = seeded(`${spec.product}:${spec.title}`);
  const { width, height } = DIMENSIONS[spec.device];

  const body =
    spec.layout === "marketing"
      ? marketing(spec, p, random)
      : spec.layout === "dashboard"
        ? dashboard(spec, p, random)
        : spec.layout === "table"
          ? table(spec, p, random)
          : spec.layout === "checkout"
            ? checkout(spec, p, random)
            : spec.layout === "feed"
              ? feed(p, random)
              : spec.layout === "detail"
                ? detail(p, random)
                : spec.layout === "form"
                  ? form(p, random)
                  : empty(spec, p, random);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${p.page}"/>
    ${body}
  </svg>`;
}

/**
 * Render one synthetic screenshot to PNG bytes.
 *
 * Deterministic for a given spec, so re-seeding deduplicates rather than
 * accumulating copies.
 */
export async function renderScreenshot(spec: ScreenshotSpec): Promise<{
  bytes: Uint8Array;
  width: number;
  height: number;
}> {
  const { width, height } = DIMENSIONS[spec.device];
  const buffer = await sharp(Buffer.from(svgFor(spec)))
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  return { bytes: new Uint8Array(buffer), width, height };
}

export const SCREENSHOT_DIMENSIONS = DIMENSIONS;
