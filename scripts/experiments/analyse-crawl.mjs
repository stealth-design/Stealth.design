#!/usr/bin/env node
/**
 * Analyse a crawl experiment run.
 *
 *   node scripts/experiments/analyse-crawl.mjs                    # latest of each profile
 *   node scripts/experiments/analyse-crawl.mjs --file=<run.json>
 *   node scripts/experiments/analyse-crawl.mjs --compare           # http vs browser
 *
 * Separate from `run-crawl.mjs` on purpose: the analysis is the part that gets
 * rewritten as questions change, and it must be possible to ask a new question
 * without fetching anyone's website again.
 *
 * ## What it is trying to establish
 *
 * Not "what was the success rate" — that number on its own is useless. The
 * questions worth answering are:
 *
 *   - which *scenario* fails, so the fix has a target
 *   - what did capture actually extract, since a 200 with no title is not a
 *     usable content record
 *   - what does a page cost, in time and bytes
 *   - what does the HTTP path buy over the browser path, and where does it
 *     stop being enough
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@uxd/shared/env";
import { SCENARIOS } from "./dataset.mjs";

const DIR = join(repoRoot(), ".data", "experiments");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);

const D = "\u001b[90m";
const B = "\u001b[1m";
const G = "\u001b[32m";
const Y = "\u001b[33m";
const R = "\u001b[31m";
const X = "\u001b[0m";

function latest(profile) {
  const files = readdirSync(DIR)
    .filter((f) => f.startsWith(`${profile}-`) && f.endsWith(".json"))
    .sort();
  const file = files.pop();
  return file ? JSON.parse(readFileSync(join(DIR, file), "utf8")) : null;
}

const pct = (n, total) => (total === 0 ? "—" : `${((n / total) * 100).toFixed(0)}%`);
const ms = (n) => (n === null || n === undefined ? "—" : `${n}ms`);

function quantiles(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return {
    n: s.length,
    min: s[0],
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

const table = (rows, headers) => {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  console.log("  " + headers.map((h, i) => `${D}${h.padEnd(widths[i])}${X}`).join("  "));
  for (const row of rows) {
    console.log("  " + row.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  "));
  }
};

// =========================================================================

function analyse(run) {
  console.log(`\n${B}═══ ${run.profile} ═══${X} ${D}${run.startedAt} · ${Math.round(run.totalMs / 1000)}s wall clock${X}`);
  console.log(`${D}${run.profileDescription}${X}`);

  const all = run.results;
  const attempted = all.filter((r) => r.queue);

  // --- Outcomes ---------------------------------------------------------
  console.log(`\n${B}Outcomes${X}`);
  const byQueue = {};
  for (const r of attempted) byQueue[r.queue.status] = (byQueue[r.queue.status] ?? 0) + 1;
  const notAttempted = all.length - attempted.length;

  table(
    [
      ...Object.entries(byQueue)
        .sort((a, b) => b[1] - a[1])
        .map(([status, n]) => [status, n, pct(n, attempted.length)]),
      [`${D}(never queued)${X}`, notAttempted, pct(notAttempted, all.length)],
    ],
    ["status", "n", "of attempted"],
  );

  const succeeded = attempted.filter((r) => r.queue.status === "succeeded");
  const failed = attempted.filter((r) => ["failed", "dead_letter"].includes(r.queue.status));
  const blocked = attempted.filter((r) => r.queue.status === "blocked");

  // A re-crawl of a page whose content has not changed is reported as
  // `skipped_duplicate`. That is the dedupe working, not the capture failing,
  // so counting it against the success rate makes a second run of the same
  // dataset look like a catastrophic regression — the first version of this
  // script reported 16% for a run in which almost everything worked and 54
  // pages were simply unchanged since the previous run.
  const duplicates = attempted.filter((r) => r.queue.status === "skipped_duplicate");

  // The honest success rate excludes URLs we deliberately included in order
  // to see them fail. A rate that counts `httpbin.org/status/500` as a
  // failure of the pipeline is measuring the dataset, not the system.
  const genuine = attempted.filter((r) => !r.expectedFail && r.queue.status !== "skipped_duplicate");
  const genuineOk = genuine.filter((r) => r.queue.status === "succeeded");
  console.log(
    `\n  ${B}success rate${X}  ${G}${pct(genuineOk.length, genuine.length)}${X} of ${genuine.length} URLs expected to work` +
      `   ${D}(${pct(succeeded.length, attempted.length)} of all ${attempted.length} attempted, including ${attempted.length - genuine.length - duplicates.length} expected to fail)${X}`,
  );
  if (duplicates.length > 0) {
    console.log(
      `  ${D}${duplicates.length} excluded as unchanged since a previous run — the dedupe recognised them,${X}`,
    );
    console.log(`  ${D}which is a pass for the pipeline and tells us nothing about capture quality.${X}`);
  }

  // --- Did the expected failures fail? ----------------------------------
  const expectedFails = attempted.filter((r) => r.expectedFail);
  const wronglySucceeded = expectedFails.filter((r) => r.queue.status === "succeeded");
  if (expectedFails.length > 0) {
    console.log(
      `  ${B}error handling${X}  ${expectedFails.length - wronglySucceeded.length}/${expectedFails.length} URLs expected to fail did fail` +
        (wronglySucceeded.length
          ? `  ${Y}${wronglySucceeded.length} unexpectedly succeeded: ${wronglySucceeded.map((r) => r.label).join(", ")}${X}`
          : ""),
    );
  }

  // --- Per-scenario ------------------------------------------------------
  console.log(`\n${B}By scenario${X} ${D}— which kind of site fails, so a fix has a target${X}`);
  const rows = [];
  for (const scenario of Object.keys(SCENARIOS)) {
    const inScenario = attempted.filter((r) => r.scenarios.includes(scenario));
    if (inScenario.length === 0) continue;
    // A scenario's rate excludes its expected failures for the same reason.
    const real = inScenario.filter((r) => !r.expectedFail);
    if (real.length === 0) continue;
    const ok = real.filter((r) => r.queue.status === "succeeded");
    const rate = ok.length / real.length;
    const durations = ok.map((r) => r.capture?.durationMs).filter((n) => typeof n === "number");
    const q = quantiles(durations);
    rows.push([
      scenario,
      `${ok.length}/${real.length}`,
      `${rate === 1 ? G : rate >= 0.8 ? "" : R}${pct(ok.length, real.length)}${X}`,
      q ? ms(q.p50) : "—",
      q ? ms(q.max) : "—",
    ]);
  }
  rows.sort((a, b) => {
    const rate = (s) => Number(String(s[2]).replace(/\u001b\[[0-9;]*m/g, "").replace("%", ""));
    return rate(a) - rate(b);
  });
  table(rows, ["scenario", "ok", "rate", "p50", "max"]);

  // --- Failures, in detail ----------------------------------------------
  if (failed.length > 0 || blocked.length > 0) {
    console.log(`\n${B}Failures and blocks${X}`);
    const byCode = {};
    for (const r of [...failed, ...blocked]) {
      const code = r.queue.errorCode ?? r.queue.status;
      byCode[code] = byCode[code] ?? [];
      byCode[code].push(r);
    }
    for (const [code, group] of Object.entries(byCode).sort((a, b) => b[1].length - a[1].length)) {
      const expected = group.filter((r) => r.expectedFail).length;
      console.log(
        `\n  ${code}  ${D}${group.length}${expected ? ` (${expected} expected)` : ""}${X}`,
      );
      for (const r of group.slice(0, 8)) {
        const marker = r.expectedFail ? `${D}expected${X}` : `${R}unexpected${X}`;
        console.log(
          `    ${marker}  ${(r.label ?? r.url).slice(0, 40).padEnd(40)} ${D}${(r.queue.errorMessage ?? "").slice(0, 90)}${X}`,
        );
      }
      if (group.length > 8) console.log(`    ${D}… ${group.length - 8} more${X}`);
    }
  }

  // --- What was actually extracted --------------------------------------
  //
  // The question a 200 does not answer. A capture that produced no title and
  // no text is a row in the database and nothing a researcher can use.
  if (succeeded.length > 0) {
    console.log(`\n${B}Extraction quality${X} ${D}— a 200 is not a usable record${X}`);
    const withContent = succeeded.filter((r) => r.discovered);
    const has = (fn) => withContent.filter(fn).length;
    table(
      [
        ["content record created", has((r) => true), pct(withContent.length, succeeded.length)],
        ["candidate title", has((r) => r.discovered.title), pct(has((r) => r.discovered.title), succeeded.length)],
        ["description", has((r) => r.discovered.description), pct(has((r) => r.discovered.description), succeeded.length)],
        ["h1", has((r) => r.discovered.h1), pct(has((r) => r.discovered.h1), succeeded.length)],
        ["lang attribute", has((r) => r.discovered.langAttr), pct(has((r) => r.discovered.langAttr), succeeded.length)],
        ["word count > 50", has((r) => (r.discovered.wordCount ?? 0) > 50), pct(has((r) => (r.discovered.wordCount ?? 0) > 50), succeeded.length)],
        ["content hash", succeeded.filter((r) => r.capture?.contentHash).length, pct(succeeded.filter((r) => r.capture?.contentHash).length, succeeded.length)],
        ["final URL recorded", succeeded.filter((r) => r.capture?.finalUrl).length, pct(succeeded.filter((r) => r.capture?.finalUrl).length, succeeded.length)],
      ],
      ["field", "n", "of succeeded"],
    );

    const titleless = withContent.filter((r) => !r.discovered.title);
    if (titleless.length > 0) {
      console.log(`\n  ${Y}no page title${X} ${D}(${titleless.length})${X}`);
      for (const r of titleless.slice(0, 10)) {
        console.log(`    ${(r.label ?? r.url).slice(0, 44).padEnd(44)} ${D}words=${r.discovered.wordCount ?? 0}${X}`);
      }
    }

    const thin = withContent.filter((r) => (r.discovered.wordCount ?? 0) < 50);
    if (thin.length > 0) {
      console.log(`\n  ${Y}under 50 words extracted${X} ${D}(${thin.length}) — the signature of a page whose content is client-rendered${X}`);
      for (const r of thin.slice(0, 12)) {
        console.log(
          `    ${(r.label ?? r.url).slice(0, 36).padEnd(36)} ${D}words=${String(r.discovered.wordCount ?? 0).padStart(4)}  ${r.scenarios.join(" ")}${X}`,
        );
      }
    }
  }

  // --- Redirects ---------------------------------------------------------
  const redirected = succeeded.filter((r) => (r.capture?.redirectChain ?? []).length > 0);
  if (redirected.length > 0) {
    console.log(`\n${B}Redirects followed${X} ${D}${redirected.length}${X}`);
    for (const r of redirected.slice(0, 10)) {
      const chain = r.capture.redirectChain;
      console.log(
        `  ${(r.label ?? r.url).slice(0, 30).padEnd(30)} ${chain.length} hop(s) → ${D}${(r.capture.finalUrl ?? "").slice(0, 60)}${X}`,
      );
    }
  }

  // --- Timing and cost ---------------------------------------------------
  console.log(`\n${B}Timing${X}`);
  const captureMs = quantiles(succeeded.map((r) => r.capture?.durationMs).filter((n) => typeof n === "number"));
  const loadMs = quantiles(succeeded.map((r) => r.capture?.loadTimeMs).filter((n) => typeof n === "number"));
  const queueMs = quantiles(succeeded.map((r) => r.queue?.durationMs).filter((n) => typeof n === "number"));
  table(
    [
      ["capture (browser/fetch)", captureMs?.n ?? 0, ms(captureMs?.min), ms(captureMs?.p50), ms(captureMs?.p90), ms(captureMs?.max), ms(captureMs?.mean)],
      ["page load", loadMs?.n ?? 0, ms(loadMs?.min), ms(loadMs?.p50), ms(loadMs?.p90), ms(loadMs?.max), ms(loadMs?.mean)],
      ["whole queue item", queueMs?.n ?? 0, ms(queueMs?.min), ms(queueMs?.p50), ms(queueMs?.p90), ms(queueMs?.max), ms(queueMs?.mean)],
    ],
    ["stage", "n", "min", "p50", "p90", "max", "mean"],
  );

  // --- Bytes and storage -------------------------------------------------
  const media = succeeded.flatMap((r) => r.media);
  if (media.length > 0) {
    const bytes = media.reduce((a, m) => a + (m.byteSize ?? 0), 0);
    const perPage = quantiles(
      succeeded.map((r) => r.media.reduce((a, m) => a + (m.byteSize ?? 0), 0)).filter((n) => n > 0),
    );
    console.log(`\n${B}Media and storage${X}`);
    console.log(
      `  ${media.length} files across ${succeeded.filter((r) => r.media.length > 0).length} pages · ${(bytes / 1024 / 1024).toFixed(1)}MB total`,
    );
    if (perPage) {
      console.log(
        `  per page  p50 ${(perPage.p50 / 1024).toFixed(0)}KB · p90 ${(perPage.p90 / 1024).toFixed(0)}KB · max ${(perPage.max / 1024 / 1024).toFixed(1)}MB · mean ${(perPage.mean / 1024).toFixed(0)}KB`,
      );
    }
    const byRole = {};
    for (const m of media) byRole[m.role] = (byRole[m.role] ?? 0) + 1;
    console.log(`  roles  ${Object.entries(byRole).map(([k, v]) => `${k}=${v}`).join(" ")}`);

    const distinctHashes = new Set(media.map((m) => m.sha256)).size;
    console.log(
      `  deduplication  ${media.length} usages → ${distinctHashes} distinct files ${D}(${(media.length / Math.max(1, distinctHashes)).toFixed(2)} usages per file)${X}`,
    );

    const tallest = succeeded
      .filter((r) => r.capture?.pageHeight)
      .sort((a, b) => b.capture.pageHeight - a.capture.pageHeight)
      .slice(0, 5);
    if (tallest.length > 0) {
      console.log(`  tallest pages  ${tallest.map((r) => `${r.label}=${r.capture.pageHeight}px`).join(" · ")}`);
    }
  }

  // --- Bytes transferred, which is the network cost ----------------------
  const transferred = quantiles(
    succeeded.map((r) => r.capture?.bytesTransferred).filter((n) => typeof n === "number" && n > 0),
  );
  if (transferred) {
    console.log(
      `\n  ${B}bytes fetched${X}  p50 ${(transferred.p50 / 1024).toFixed(0)}KB · p90 ${(transferred.p90 / 1024).toFixed(0)}KB · max ${(transferred.max / 1024 / 1024).toFixed(1)}MB · total ${((transferred.mean * transferred.n) / 1024 / 1024).toFixed(1)}MB`,
    );
  }

  return {
    profile: run.profile,
    attempted: attempted.length,
    genuine: genuine.length,
    genuineOk: genuineOk.length,
    successRate: genuine.length ? genuineOk.length / genuine.length : 0,
    failed: failed.length,
    blocked: blocked.length,
    captureMs,
    media: media.length,
    bytes: media.reduce((a, m) => a + (m.byteSize ?? 0), 0),
    wallClockMs: run.totalMs,
    extraction: {
      titles: succeeded.filter((r) => r.content?.pageTitle).length,
      thin: succeeded.filter((r) => r.content && (r.discovered.wordCount ?? 0) < 50).length,
      succeeded: succeeded.length,
    },
  };
}

// =========================================================================

const summaries = [];
if (args.file) {
  summaries.push(analyse(JSON.parse(readFileSync(String(args.file), "utf8"))));
} else {
  for (const profile of ["http", "browser"]) {
    const run = latest(profile);
    if (run) summaries.push(analyse(run));
    else console.log(`\n${D}no ${profile} run yet${X}`);
  }
}

// --- The comparison Phase 17 asks for ------------------------------------
if (summaries.length === 2) {
  const [http, browser] = summaries;
  console.log(`\n${B}═══ HTTP vs browser ═══${X}`);
  table(
    [
      ["success rate", pct(http.genuineOk, http.genuine), pct(browser.genuineOk, browser.genuine)],
      ["pages with a title", pct(http.extraction.titles, http.extraction.succeeded), pct(browser.extraction.titles, browser.extraction.succeeded)],
      ["pages under 50 words", pct(http.extraction.thin, http.extraction.succeeded), pct(browser.extraction.thin, browser.extraction.succeeded)],
      ["capture p50", ms(http.captureMs?.p50), ms(browser.captureMs?.p50)],
      ["capture p90", ms(http.captureMs?.p90), ms(browser.captureMs?.p90)],
      ["media files", http.media, browser.media],
      ["storage", `${(http.bytes / 1024 / 1024).toFixed(1)}MB`, `${(browser.bytes / 1024 / 1024).toFixed(1)}MB`],
      ["wall clock", `${Math.round(http.wallClockMs / 1000)}s`, `${Math.round(browser.wallClockMs / 1000)}s`],
    ],
    ["metric", "http", "browser"],
  );

  const ratio = browser.captureMs && http.captureMs ? browser.captureMs.p50 / http.captureMs.p50 : null;
  if (ratio) {
    console.log(
      `\n  A browser capture costs ${B}${ratio.toFixed(1)}×${X} the time of an HTTP fetch at p50, and ` +
        // A ratio against zero is not a large number, it is a category
        // difference: level 1 stores no media at all.
        (http.bytes > 0
          ? `${D}${(browser.bytes / http.bytes).toFixed(0)}× the storage${X}.`
          : `${D}takes storage from nothing to ${(browser.bytes / 1024 / 1024).toFixed(0)}MB — level 1 stores no media at all.${X}`),
    );
  }

  // --- Projections -------------------------------------------------------
  console.log(`\n${B}Projections${X} ${D}— single worker, ${browser.captureMs ? `${browser.captureMs.p50}ms` : "?"} median browser capture, one page per site${X}`);
  const perPageMs = browser.captureMs?.p50 ?? 0;
  const perPageBytes = browser.media ? browser.bytes / Math.max(1, browser.extraction.succeeded) : 0;
  const projRows = [];
  for (const n of [1_000, 10_000, 100_000]) {
    const serialHours = (n * perPageMs) / 1000 / 3600;
    projRows.push([
      n.toLocaleString("en-US"),
      `${serialHours.toFixed(1)}h`,
      `${(serialHours / 4).toFixed(1)}h`,
      `${(serialHours / 16).toFixed(1)}h`,
      `${((n * perPageBytes) / 1024 / 1024 / 1024).toFixed(1)}GB`,
    ]);
  }
  table(projRows, ["sites", "1 worker", "4 workers", "16 workers", "storage"]);
  console.log(
    `  ${D}Rate limiting is per host, so with one page per site the ceiling is worker concurrency, not politeness.${X}`,
  );
  console.log(
    `  ${D}Storage assumes ${(perPageBytes / 1024).toFixed(0)}KB per page at the current derivative settings.${X}`,
  );
}
console.log("");
