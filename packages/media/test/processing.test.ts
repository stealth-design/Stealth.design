/**
 * Media validation and processing tests (§9 upload safety, §11 dedupe).
 *
 * Images are generated with sharp rather than checked in as fixtures, so the
 * suite has no binary assets and the inputs are described by the code that
 * makes them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import {
  NEAR_DUPLICATE_THRESHOLD,
  assertSafeKey,
  buildStorageKey,
  dispositionFor,
  generateDerivatives,
  hammingDistance,
  isNearDuplicate,
  perceptualHash,
  readStreamWithLimit,
  validateMedia,
} from "@uxd/media";
import { Readable } from "node:stream";

const png = async (width: number, height: number, rgb: [number, number, number] = [40, 90, 200]) =>
  new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
    })
      .png()
      .toBuffer(),
  );

const jpeg = async (width: number, height: number) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
      .jpeg()
      .toBuffer(),
  );

/** A gradient, so a perceptual hash has real structure to encode. */
const gradient = async (width: number, height: number, shift = 0) => {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      data[i] = (x * 255) / width + shift;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = 128;
    }
  }
  return new Uint8Array(await sharp(data, { raw: { width, height, channels } }).png().toBuffer());
};

describe("validateMedia — type is sniffed, never trusted", () => {
  it("accepts a real PNG and reports its dimensions", async () => {
    const result = await validateMedia(await png(120, 80), { filename: "shot.png" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.media.mimeType, "image/png");
      assert.equal(result.media.kind, "image");
      assert.equal(result.media.width, 120);
      assert.equal(result.media.height, 80);
      assert.match(result.media.sha256, /^[0-9a-f]{64}$/);
    }
  });

  it("uses the sniffed type even when the filename lies", async () => {
    // A PNG named .jpg is accepted as a PNG, with the discrepancy recorded.
    const result = await validateMedia(await png(20, 20), { filename: "actually-a-png.jpg" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.media.mimeType, "image/png");
      assert.equal(result.media.metadata.extensionMismatch, true);
    }
  });

  it("refuses a file whose extension is allowed but whose content is not", async () => {
    // The classic upload bypass: name a script .png and hope the filename is
    // what gets checked.
    const script = new TextEncoder().encode("#!/bin/sh\nrm -rf /\n");
    const result = await validateMedia(script, { filename: "innocent.png" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.reason, "MIME_NOT_ALLOWED");
  });

  it("refuses executables, archives and other disallowed types", async () => {
    const cases: [string, Uint8Array][] = [
      ["ELF binary", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0])],
      ["Windows PE", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
      ["ZIP", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])],
      ["Mach-O", new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])],
    ];
    for (const [label, bytes] of cases) {
      const result = await validateMedia(bytes, { filename: "x.png" });
      assert.equal(result.ok, false, `${label} must be refused`);
    }
  });

  it("refuses an empty file", async () => {
    const result = await validateMedia(new Uint8Array(0));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.reason, "EMPTY");
  });

  it("enforces the caller's byte ceiling before decoding", async () => {
    const result = await validateMedia(await png(500, 500), { maxBytes: 10 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.reason, "TOO_LARGE");
  });

  it("refuses a truncated image rather than best-effort decoding it", async () => {
    const full = await png(100, 100);
    const truncated = full.subarray(0, Math.floor(full.byteLength / 2));
    const result = await validateMedia(truncated, { filename: "broken.png" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.reason, "UNREADABLE");
  });

  it("accepts JPEG and WebP", async () => {
    assert.equal((await validateMedia(await jpeg(60, 40))).ok, true);
    const webp = new Uint8Array(
      await sharp({ create: { width: 30, height: 30, channels: 3, background: "#123456" } })
        .webp()
        .toBuffer(),
    );
    const result = await validateMedia(webp);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.media.mimeType, "image/webp");
  });

  it("produces a stable sha256 for identical bytes", async () => {
    const bytes = await png(50, 50);
    const a = await validateMedia(bytes);
    const b = await validateMedia(bytes);
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.equal(a.media.sha256, b.media.sha256);
  });
});

describe("validateMedia — SVG screening", () => {
  const svg = (inner: string) =>
    new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${inner}</svg>`);

  it("accepts a plain, static SVG", async () => {
    const result = await validateMedia(svg('<rect width="10" height="10" fill="#333"/>'), {
      filename: "logo.svg",
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.media.mimeType, "image/svg+xml");
      assert.equal(result.media.metadata.screened, true);
    }
  });

  it("refuses every scriptable or externally-referencing construct", async () => {
    const hostile: [string, Uint8Array][] = [
      ["inline script", svg("<script>alert(1)</script>")],
      ["event handler", svg('<rect onload="alert(1)" width="10" height="10"/>')],
      ["onclick handler", svg('<circle onclick="fetch(`/x`)" r="5"/>')],
      ["javascript: url", svg('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>')],
      ["foreignObject", svg("<foreignObject><body>hi</body></foreignObject>")],
      ["iframe", svg('<iframe src="https://evil.test"></iframe>')],
      ["external xlink", svg('<use xlink:href="https://evil.test/x.svg#a"/>')],
      ["html data url", svg('<image href="data:text/html,<script>1</script>"/>')],
      [
        "XXE entity",
        new TextEncoder().encode(
          `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>`,
        ),
      ],
    ];
    for (const [label, bytes] of hostile) {
      const result = await validateMedia(bytes, { filename: "x.svg" });
      assert.equal(result.ok, false, `${label} must be refused`);
      if (!result.ok) {
        assert.equal(result.rejection.reason, "SVG_UNSAFE", label);
        // The reason names what was found, so an operator can tell a
        // mislabelled file from an attack.
        assert.ok(result.rejection.detail, `${label} should say what it found`);
      }
    }
  });
});

describe("perceptualHash — near-duplicate detection", () => {
  it("produces a 16-character hex hash", async () => {
    const hash = await perceptualHash(await gradient(200, 150));
    assert.ok(hash);
    assert.match(hash!, /^[0-9a-f]{16}$/);
  });

  it("is stable for the same image re-encoded", async () => {
    // The case exact hashing misses: same picture, different bytes.
    const source = await gradient(300, 200);
    const asJpeg = new Uint8Array(await sharp(source).jpeg({ quality: 80 }).toBuffer());
    const asWebp = new Uint8Array(await sharp(source).webp({ quality: 75 }).toBuffer());

    const a = await perceptualHash(source);
    const b = await perceptualHash(asJpeg);
    const c = await perceptualHash(asWebp);
    assert.ok(a && b && c);

    assert.ok(
      hammingDistance(a!, b!) <= NEAR_DUPLICATE_THRESHOLD,
      `re-encoded to JPEG should stay near-identical (distance ${hammingDistance(a!, b!)})`,
    );
    assert.ok(
      hammingDistance(a!, c!) <= NEAR_DUPLICATE_THRESHOLD,
      `re-encoded to WebP should stay near-identical (distance ${hammingDistance(a!, c!)})`,
    );
    assert.ok(isNearDuplicate(a, b));
  });

  it("survives a small resize, as a rescaled screenshot would", async () => {
    const source = await gradient(400, 300);
    const resized = new Uint8Array(await sharp(source).resize(380, 285).png().toBuffer());
    const a = await perceptualHash(source);
    const b = await perceptualHash(resized);
    assert.ok(a && b);
    assert.ok(
      hammingDistance(a!, b!) <= NEAR_DUPLICATE_THRESHOLD,
      `distance was ${hammingDistance(a!, b!)}`,
    );
  });

  it("separates genuinely different images", async () => {
    const a = await perceptualHash(await gradient(200, 200));
    const b = await perceptualHash(
      new Uint8Array(
        await sharp({ create: { width: 200, height: 200, channels: 3, background: "#ffffff" } })
          .composite([
            {
              input: Buffer.from(
                `<svg width="200" height="200"><circle cx="60" cy="140" r="50" fill="#000"/><rect x="120" y="20" width="70" height="70" fill="#888"/></svg>`,
              ),
              top: 0,
              left: 0,
            },
          ])
          .png()
          .toBuffer(),
      ),
    );
    assert.ok(a && b);
    assert.ok(
      hammingDistance(a!, b!) > NEAR_DUPLICATE_THRESHOLD,
      `different images should not collide (distance ${hammingDistance(a!, b!)})`,
    );
    assert.equal(isNearDuplicate(a, b), false);
  });

  it("returns null rather than throwing for something undecodable", async () => {
    assert.equal(await perceptualHash(new TextEncoder().encode("not an image")), null);
  });

  it("treats a missing hash as not-a-duplicate", () => {
    assert.equal(isNearDuplicate(null, "0000000000000000"), false);
    assert.equal(isNearDuplicate("0000000000000000", null), false);
  });
});

describe("hammingDistance", () => {
  it("counts differing bits", () => {
    assert.equal(hammingDistance("0000000000000000", "0000000000000000"), 0);
    assert.equal(hammingDistance("0000000000000000", "0000000000000001"), 1);
    assert.equal(hammingDistance("0000000000000000", "000000000000000f"), 4);
    assert.equal(hammingDistance("ffffffffffffffff", "0000000000000000"), 64);
  });

  it("refuses to compare hashes of different lengths", () => {
    assert.equal(hammingDistance("abcd", "abcdef"), Number.MAX_SAFE_INTEGER);
  });
});

describe("generateDerivatives", () => {
  it("produces renditions that fit within their bounds", async () => {
    const derivatives = await generateDerivatives(await gradient(2400, 1600), {
      mimeType: "image/png",
      width: 2400,
      height: 1600,
    });
    assert.ok(derivatives.length >= 2);
    for (const d of derivatives) {
      assert.equal(d.mimeType, "image/webp");
      assert.ok(d.byteSize > 0);
      assert.ok(d.width <= 2048 && d.height <= 16384, `${d.kind} exceeded its bounds`);
    }
    const thumb = derivatives.find((d) => d.kind === "thumbnail");
    assert.ok(thumb);
    assert.ok(thumb!.width <= 480 && thumb!.height <= 480);
  });

  /**
   * The geometry of a tall full-page screenshot.
   *
   * These exist because the original strategy — fit inside a width *and* a
   * height, for every rendition — cannot serve the two jobs these renditions
   * have. `fit: "inside"` honours whichever bound binds first, and on a
   * full-page capture that is always the height, so a real 780x31,182 capture
   * came out as a **102px-wide** preview. Every screenshot on the site was
   * being served from it.
   *
   * What each assertion protects is a *purpose*, not a number: a card has to be
   * a recognisable picture of the page's top, and a research image has to be
   * wide enough to read.
   */
  describe("a very tall full-page screenshot", () => {
    it("gives the card a fixed 16:10 crop of the top, not a sliver", async () => {
      const derivatives = await generateDerivatives(await gradient(1440, 9000), {
        mimeType: "image/png",
        width: 1440,
        height: 9000,
      });
      const thumb = derivatives.find((d) => d.kind === "thumbnail");
      assert.ok(thumb, "a thumbnail should still be produced");
      assert.equal(thumb!.width, 480, "the card must hold its width");
      assert.equal(thumb!.height, 300, "the card must hold its 16:10 shape");
    });

    it("keeps the preview readable rather than fitting it inside a height", async () => {
      // The regression. Under the old spec this was 1024 wide only if the page
      // was short; at 6.25:1 it collapsed to 655px, and real captures at 40:1
      // collapsed to 102px.
      const derivatives = await generateDerivatives(await gradient(1440, 9000), {
        mimeType: "image/png",
        width: 1440,
        height: 9000,
      });
      const preview = derivatives.find((d) => d.kind === "preview");
      assert.ok(preview);
      assert.equal(preview!.width, 1024, `preview collapsed to ${preview!.width}px`);
      // Height follows width; it is not clamped to some other budget.
      assert.equal(preview!.height, Math.round(9000 * (1024 / 1440)));
    });

    it("keeps the large rendition at 2048 wide", async () => {
      const derivatives = await generateDerivatives(await gradient(2880, 12000), {
        mimeType: "image/png",
        width: 2880,
        height: 12000,
      });
      const large = derivatives.find((d) => d.kind === "large");
      assert.ok(large, "a wide capture should produce a large rendition");
      assert.equal(large!.width, 2048);
    });

    it("crops at the encoder's height limit instead of shrinking to fit it", async () => {
      // WebP cannot encode past 16,383px. The choice at that point is to lose
      // the bottom of the page or to lose legibility everywhere; this keeps
      // the width and loses the footer.
      const derivatives = await generateDerivatives(await gradient(1024, 40000), {
        mimeType: "image/png",
        width: 1024,
        height: 40000,
      });
      const preview = derivatives.find((d) => d.kind === "preview");
      assert.ok(preview);
      assert.equal(preview!.width, 1024, "width survives the crop");
      assert.equal(preview!.height, 16383, "cropped to the encoder limit, not scaled down");
    });

    it("does not emit two identical renditions for a narrow capture", async () => {
      // A 780px mobile capture cannot fill either 1024 or 2048, so `preview`
      // and `large` would be the same file twice.
      const derivatives = await generateDerivatives(await gradient(780, 6000), {
        mimeType: "image/png",
        width: 780,
        height: 6000,
      });
      const widths = derivatives
        .filter((d) => d.kind !== "thumbnail")
        .map((d) => d.width);
      assert.equal(new Set(widths).size, widths.length, `duplicate widths: ${widths.join(", ")}`);
    });
  });

  it("does not upscale a small source", async () => {
    const derivatives = await generateDerivatives(await png(64, 48), {
      mimeType: "image/png",
      width: 64,
      height: 48,
    });
    for (const d of derivatives) {
      assert.ok(d.width <= 64 && d.height <= 48, `${d.kind} was upscaled to ${d.width}x${d.height}`);
    }
  });

  it("produces nothing for formats it cannot rasterise", async () => {
    const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    assert.deepEqual(
      await generateDerivatives(svgBytes, { mimeType: "image/svg+xml", width: null, height: null }),
      [],
      "untrusted SVG is not handed to a rasteriser",
    );
    assert.deepEqual(
      await generateDerivatives(new Uint8Array([1, 2, 3]), {
        mimeType: "video/mp4",
        width: null,
        height: null,
      }),
      [],
    );
  });
});

describe("storage keys", () => {
  it("builds date-partitioned keys with no user input in them", () => {
    const key = buildStorageKey({ extension: "png", at: new Date("2026-03-09T00:00:00Z") });
    assert.match(key, /^media\/2026\/03\/[0-9a-f-]{36}\.png$/);
  });

  it("sanitises the extension and variant", () => {
    const key = buildStorageKey({ extension: "../../etc/passwd", variant: "a/b../c" });
    assert.doesNotMatch(key, /\.\./);
    assert.doesNotMatch(key, /passwd\//);
    assert.doesNotThrow(() => assertSafeKey(key));
  });

  it("rejects traversal and absolute keys", () => {
    for (const key of [
      "../secrets.env",
      "media/../../etc/passwd",
      "/etc/passwd",
      "media//double.png",
      "media/a/../../b.png",
    ]) {
      assert.throws(() => assertSafeKey(key), `should reject ${key}`);
    }
  });

  it("accepts the keys it generates", () => {
    for (const ext of ["png", "jpg", "webp", "mp4"]) {
      assert.doesNotThrow(() => assertSafeKey(buildStorageKey({ extension: ext })));
      assert.doesNotThrow(() =>
        assertSafeKey(buildStorageKey({ extension: ext, variant: "thumbnail" })),
      );
    }
  });
});

describe("dispositionFor — nothing executes in our origin", () => {
  it("forces a download for anything a browser would run", () => {
    for (const type of ["image/svg+xml", "text/html", "application/pdf", "application/xml"]) {
      assert.match(dispositionFor(type), /^attachment/, type);
    }
  });

  it("serves ordinary images inline", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "video/mp4"]) {
      assert.match(dispositionFor(type), /^inline/, type);
    }
  });

  it("sanitises the filename it echoes back", () => {
    // A filename reaches a response header, so CR/LF in it is header
    // injection and a bare quote breaks out of the quoted-string.
    const disposition = dispositionFor("image/png", 'evil";\r\nX-Injected: 1');
    assert.doesNotMatch(disposition, /\r|\n/, "no CR/LF reaches the header");
    const value = /filename="([^"]*)"/.exec(disposition)?.[1];
    assert.ok(value !== undefined, "the header is a well-formed quoted string");
    assert.doesNotMatch(value!, /["\r\n;]/, "the quoted value contains no delimiters");
  });

  it("accepts a legitimate SVG that carries an XML prolog", async () => {
    // Regression: file-type sniffs this as application/xml, which used to be
    // refused as a disallowed type before the SVG screen ever ran.
    const withProlog = new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path d="M4 4h16v16H4z" fill="#111"/></svg>`,
    );
    const result = await validateMedia(withProlog, { filename: "icon.svg" });
    assert.equal(result.ok, true, "a static SVG with a prolog is a normal file");
    if (result.ok) assert.equal(result.media.mimeType, "image/svg+xml");
  });
});

describe("readStreamWithLimit", () => {
  it("reads a stream under the limit", async () => {
    const bytes = await readStreamWithLimit(Readable.from([Buffer.from("hello world")]), 1024);
    assert.equal(Buffer.from(bytes).toString(), "hello world");
  });

  it("aborts once the limit is passed, rather than trusting Content-Length", async () => {
    // A chunked upload declares no length at all, so the ceiling has to be
    // enforced while buffering.
    const chunks = Array.from({ length: 100 }, () => Buffer.alloc(1024, 0x41));
    await assert.rejects(
      () => readStreamWithLimit(Readable.from(chunks), 4096),
      (error: unknown) => (error as { status: number }).status === 413,
    );
  });
});
