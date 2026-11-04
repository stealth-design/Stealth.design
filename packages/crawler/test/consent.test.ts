/**
 * Cookie-banner handling.
 *
 * Two things can break silently on an upgrade of the pinned autoconsent
 * package, and both are pinned here without a browser or a network:
 *
 *   1. The standalone build is reached by path, next to the package's entry,
 *      because the `exports` map does not name it. A layout change would make
 *      every studio session fail to open.
 *   2. The outcome is parsed from the line the standalone build logs. A
 *      wording change would leave dismissal working but every capture
 *      recording `none` — wrong provenance, and nothing would notice.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { BrowserContext } from "playwright";
import { installConsentHandling } from "@uxd/crawler";

/** Just enough of a context: init scripts are recorded, pages emit console lines. */
function fakeContext() {
  const scripts: string[] = [];
  const context = Object.assign(new EventEmitter(), {
    pages: () => [],
    addInitScript: async ({ content }: { content: string }) => {
      scripts.push(content);
    },
  });
  const page = new EventEmitter();
  const log = (text: string) => page.emit("console", { text: () => text });
  return { context: context as unknown as BrowserContext, scripts, openPage: () => context.emit("page", page), log };
}

describe("installConsentHandling", () => {
  it("installs the standalone build as an init script", async () => {
    const { context, scripts } = fakeContext();
    await installConsentHandling(context);
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0]!.length > 10_000, "the bundled rules are inline");
    assert.ok(scripts[0]!.includes("autoconsent opt-out result"), "the line the tracker parses is still logged");
  });

  it("records what was dismissed, from the opt-out lines", async () => {
    const { context, openPage, log } = fakeContext();
    const tracker = await installConsentHandling(context);
    openPage();

    assert.deepEqual(tracker.outcome(), { outcome: "none", cmps: [] });
    log("autoconsent detected CMP: Onetrust");
    log("autoconsent opt-out result: Onetrust true");
    log("autoconsent opt-out result: Onetrust true");
    assert.deepEqual(tracker.outcome(), { outcome: "dismissed", cmps: ["Onetrust"] });
  });

  it("reports a failed opt-out, and ignores lines that do not match exactly", async () => {
    const { context, openPage, log } = fakeContext();
    const tracker = await installConsentHandling(context);
    openPage();

    log("autoconsent opt-out result: <img src=x> true");
    log("prefix autoconsent opt-out result: Cookiebot true");
    assert.deepEqual(tracker.outcome(), { outcome: "none", cmps: [] });

    log("autoconsent opt-out result: Cookiebot false");
    assert.deepEqual(tracker.outcome(), { outcome: "failed", cmps: [] });
  });

  it("resolves the pinned package's entry next to the standalone build", async () => {
    const entry = fileURLToPath(import.meta.resolve("@duckduckgo/autoconsent"));
    const source = await readFile(join(dirname(entry), "autoconsent.standalone.js"), "utf8");
    assert.ok(source.length > 0);
  });
});
