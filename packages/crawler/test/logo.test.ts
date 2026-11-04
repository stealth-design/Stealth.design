/**
 * Finding a website's published icons in its HTML: the cheap first pass at a
 * logo, done when a website is added. Raster only — SVG and ICO are skipped
 * on purpose — and best first.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findLogoCandidates, findManifestIcons } from "@uxd/crawler";

const page = "https://www.example-saas.com/pricing";

describe("findLogoCandidates", () => {
  it("prefers the largest raster icon, and resolves relative addresses", () => {
    const html = `
      <link rel="icon" href="/favicon-32.png" sizes="32x32">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
      <link rel="icon" type="image/png" href="https://cdn.example-saas.com/icon-512.png" sizes="512x512">`;
    const { candidates } = findLogoCandidates(html, page);
    assert.deepEqual(
      candidates.map((c) => c.url),
      [
        "https://cdn.example-saas.com/icon-512.png",
        "https://www.example-saas.com/apple-touch-icon.png",
        "https://www.example-saas.com/favicon-32.png",
      ],
    );
  });

  it("skips SVG and ICO icons — they are never processed here", () => {
    const html = `
      <link rel="icon" href="/favicon.ico">
      <link rel="icon" type="image/svg+xml" href="/logo.svg">
      <link rel="mask-icon" href="/safari.svg">`;
    assert.equal(findLogoCandidates(html, page).candidates.length, 0);
  });

  it("assumes Apple's usual 180px when a touch icon gives no size", () => {
    const { candidates } = findLogoCandidates(`<link rel="apple-touch-icon" href="/touch.png">`, page);
    assert.equal(candidates[0]?.size, 180);
  });

  it("finds the manifest so its icons can be read next", () => {
    const { manifestUrl } = findLogoCandidates(`<link rel="manifest" href="/site.webmanifest">`, page);
    assert.equal(manifestUrl, "https://www.example-saas.com/site.webmanifest");
  });

  it("ignores links that are not web addresses", () => {
    const html = `<link rel="icon" href="javascript:alert(1).png"><link rel="icon" href="data:image/png;base64,AAAA">`;
    assert.equal(findLogoCandidates(html, page).candidates.length, 0);
  });
});

describe("findManifestIcons", () => {
  it("lists raster icons largest first, relative to the manifest", () => {
    const manifest = JSON.stringify({
      icons: [
        { src: "icons/192.png", sizes: "192x192", type: "image/png" },
        { src: "icons/512.png", sizes: "512x512", type: "image/png" },
        { src: "icons/any.svg", sizes: "any", type: "image/svg+xml" },
      ],
    });
    const icons = findManifestIcons(manifest, "https://www.example-saas.com/static/site.webmanifest");
    assert.deepEqual(
      icons.map((icon) => icon.url),
      ["https://www.example-saas.com/static/icons/512.png", "https://www.example-saas.com/static/icons/192.png"],
    );
  });

  it("returns nothing for a manifest that is not JSON", () => {
    assert.deepEqual(findManifestIcons("<html>", "https://www.example-saas.com/m.json"), []);
  });
});
