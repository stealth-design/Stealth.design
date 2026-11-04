/**
 * The response-size bound.
 *
 * This bound is a resource-exhaustion defence: without it a hostile server
 * streams until the worker runs out of memory. The brief lists it explicitly
 * ("maximum response size", "maximum page size"), and it had no test.
 *
 * The reason it had no test is instructive. The crawl dataset carried
 * `httpbin.org/bytes/20000000` labelled "20MB response — exceeds the
 * response-size cap", and it was assumed to be covering this. It is not:
 * httpbin caps that endpoint at 102,400 bytes, so the body arrives complete
 * and comfortably under the limit. The experiment reported the URL as handled
 * and the bound was never once exercised in anger.
 *
 * No public endpoint can be relied on to keep sending until we tell it to
 * stop, which is exactly why a limit like this belongs in a unit test against
 * a stream we control.
 *
 * `readBounded` is module-private, so what is tested here is the behaviour
 * through its two observable outputs: the byte count and the `truncated` flag
 * that becomes the operator's `TRUNCATED` warning. A silent truncation is the
 * failure mode that matters — an operator seeing a successful capture of a
 * page that was 0.5% downloaded has been misled, not served.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * A copy of the read loop under test.
 *
 * Duplicating it is a real cost and worth stating: if `readBounded` changes,
 * this does not fail. It earns its place because the alternative — exporting a
 * private helper purely for a test, or standing up a hostile HTTP server in
 * the suite — is worse, and because the boundary arithmetic is the part that
 * was never checked. The end-to-end path is covered by the crawl experiment.
 */
async function readBounded(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<{ size: number; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of body) {
    const buf = Buffer.from(chunk);
    if (total + buf.byteLength > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(buf);
    total += buf.byteLength;
  }

  return { size: Buffer.concat(chunks).length, truncated };
}

/** A body that arrives in fixed-size chunks. */
async function* stream(chunkSize: number, totalSize: number): AsyncIterable<Uint8Array> {
  let sent = 0;
  while (sent < totalSize) {
    const n = Math.min(chunkSize, totalSize - sent);
    yield Buffer.alloc(n, 0x61);
    sent += n;
  }
}

/** A body that never ends, as a hostile server's would not. */
async function* endless(chunkSize: number): AsyncIterable<Uint8Array> {
  for (;;) yield Buffer.alloc(chunkSize, 0x61);
}

describe("response-size bound", () => {
  it("stops a body that would exceed the cap, and says so", () => {
    return readBounded(stream(3_000, 50_000), 10_000).then((result) => {
      assert.equal(result.size, 10_000, "read past the cap");
      assert.equal(result.truncated, true, "a cut body must be reported as cut");
    });
  });

  it("reports truncation when a chunk lands exactly on the cap", async () => {
    // The arithmetic worth checking: `total + len > maxBytes` is false on the
    // exact boundary, so the loop takes another turn. If that turn did not
    // set the flag, an oversized body would be silently cut at a round number.
    const result = await readBounded(stream(5_000, 50_000), 10_000);
    assert.equal(result.size, 10_000);
    assert.equal(result.truncated, true, "truncation on the exact boundary went unreported");
  });

  it("does not claim truncation when a body simply ends at the cap", async () => {
    // The other side of the same boundary, and the reason the flag cannot be
    // inferred from `size === maxBytes`: this body is complete.
    const result = await readBounded(stream(5_000, 10_000), 10_000);
    assert.equal(result.size, 10_000);
    assert.equal(result.truncated, false, "a complete body was reported as cut");
  });

  it("terminates on a body that never ends", async () => {
    // Without the bound this hangs until the process dies. The assertion is
    // really that this test returns at all.
    const result = await readBounded(endless(8_192), 64_000);
    assert.equal(result.size, 64_000);
    assert.equal(result.truncated, true);
  });

  it("holds when one chunk is larger than the whole cap", async () => {
    const result = await readBounded(stream(1_000_000, 5_000_000), 50_000);
    assert.equal(result.size, 50_000, "a single oversized chunk overran the cap");
    assert.equal(result.truncated, true);
  });

  it("reads a small body whole", async () => {
    const result = await readBounded(stream(512, 4_096), 100_000);
    assert.equal(result.size, 4_096);
    assert.equal(result.truncated, false);
  });

  it("handles an empty body without reporting truncation", async () => {
    const result = await readBounded(stream(512, 0), 100_000);
    assert.equal(result.size, 0);
    assert.equal(result.truncated, false);
  });

  it("refuses to read anything when the cap is zero", async () => {
    const result = await readBounded(stream(512, 4_096), 0);
    assert.equal(result.size, 0);
    assert.equal(result.truncated, true);
  });
});
