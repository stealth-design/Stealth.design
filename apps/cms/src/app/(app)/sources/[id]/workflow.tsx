"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { StudioProfile } from "@uxd/types";
import { Button, Note } from "@/components/ui/primitives";
import { captureScreenAction } from "@/lib/actions/discovery";
import { createFlowAction } from "@/lib/actions/flows";

/**
 * The pipeline for one product (§14).
 *
 * Discovery, screens, flows — the three stages, with the count at each and the
 * action that moves work to the next one. The order is the workflow's own, and
 * that is the point: a researcher opening a source is deciding where to spend
 * the next hour, and "83 untriaged, 12 screens, 2 flows" answers it in a
 * glance.
 *
 * Capture and Create flow both take a URL and open the studio, because both are
 * really the same gesture — go look at the product — differing only in where
 * the screens land.
 */
export function SourceWorkflow({
  sourceId,
  sourceName,
  homeUrl,
  discovery,
  screenCount,
  flowCount,
}: {
  sourceId: string;
  sourceName: string;
  homeUrl: string | null;
  discovery: { total: number; untriaged: number; captured: number; ignored: number };
  screenCount: number;
  flowCount: number;
}) {
  const [mode, setMode] = useState<"none" | "capture" | "flow">("none");
  const [url, setUrl] = useState(homeUrl ?? "");
  const [flowName, setFlowName] = useState("");
  const [profile, setProfile] = useState<StudioProfile>("desktop_1440");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <section className="rounded-md border border-ink-200 bg-surface">
      <div className="grid divide-ink-200 sm:grid-cols-3 sm:divide-x">
        <Stage
          label="Discovery"
          value={discovery.untriaged}
          unit="untriaged"
          detail={`${discovery.total} found · ${discovery.captured} captured from · ${discovery.ignored} set aside`}
          href={`/discovered?source=${sourceId}`}
        />
        <Stage
          label="Screens"
          value={screenCount}
          unit={screenCount === 1 ? "screen" : "screens"}
          detail="Deliberately captured states"
          href={`/screens?source=${sourceId}`}
        />
        <Stage
          label="Flows"
          value={flowCount}
          unit={flowCount === 1 ? "flow" : "flows"}
          detail="Ordered journeys through them"
          href={`/flows?source=${sourceId}`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-ink-200 px-3 py-2">
        <Link
          href={`/ingestion?source=${sourceId}`}
          className="inline-flex h-7 items-center rounded-[4px] border border-ink-300 px-2.5 text-xs font-medium hover:bg-ink-100"
        >
          Discover
        </Link>
        <Button onClick={() => setMode(mode === "capture" ? "none" : "capture")}>
          Capture screen
        </Button>
        <Button onClick={() => setMode(mode === "flow" ? "none" : "flow")}>Create flow</Button>
      </div>

      {mode !== "none" ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-ink-200 bg-ink-50 px-3 py-2">
          {mode === "flow" ? (
            <input
              value={flowName}
              autoFocus
              placeholder="Signup"
              onChange={(event) => setFlowName(event.target.value)}
              className="h-7 w-40 rounded-[4px] border border-ink-300 px-2 text-xs"
              aria-label="Flow name"
            />
          ) : null}
          <input
            type="url"
            value={url}
            autoFocus={mode === "capture"}
            placeholder={homeUrl ?? "Paste the URL to open"}
            onChange={(event) => setUrl(event.target.value)}
            className="h-7 w-72 rounded-[4px] border border-ink-300 px-2 text-xs"
            aria-label="URL to open"
          />
          <select
            value={profile}
            onChange={(event) => setProfile(event.target.value as StudioProfile)}
            className="h-7 rounded-[4px] border border-ink-300 bg-surface px-2 text-xs"
            aria-label="Capture device"
          >
            <option value="desktop_1440">Desktop</option>
            <option value="mobile_390">Mobile</option>
          </select>
          <Button
            variant="primary"
            disabled={
              pending ||
              url.trim().length === 0 ||
              (mode === "flow" && flowName.trim().length === 0)
            }
            onClick={() =>
              startTransition(async () => {
                setError(null);
                if (mode === "flow") {
                  // Creating a flow redirects to it; the researcher opens the
                  // studio from there with the flow already attached, so every
                  // capture lands as a step.
                  const created = await createFlowAction({
                    name: flowName.trim(),
                    sourceId,
                  });
                  if (created.error) setError(created.error);
                  return;
                }
                const result = await captureScreenAction({
                  url: url.trim(),
                  profile,
                  sourceId,
                });
                if (result.error) setError(result.error);
              })
            }
          >
            {mode === "flow" ? `Create and open` : `Open the studio`}
          </Button>
          <span className="text-2xs text-ink-500">
            {mode === "flow"
              ? `A new flow on ${sourceName}. Walk it from the flow page.`
              : "Opens a live browser. Nothing is created until you press Capture."}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="px-3 pb-2">
          <Note tone="danger">{error}</Note>
        </div>
      ) : null}
    </section>
  );
}

function Stage({
  label,
  value,
  unit,
  detail,
  href,
}: {
  label: string;
  value: number;
  unit: string;
  detail: string;
  href: string;
}) {
  return (
    <Link href={href} className="block px-3 py-2.5 hover:bg-ink-100">
      <div className="text-2xs font-medium uppercase tracking-wide text-ink-500">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums text-ink-900">
          {value.toLocaleString("en-US")}
        </span>
        <span className="text-2xs text-ink-500">{unit}</span>
      </div>
      <p className="mt-0.5 text-2xs text-ink-500">{detail}</p>
    </Link>
  );
}
