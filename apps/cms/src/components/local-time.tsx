"use client";

import { useEffect, useState } from "react";

/**
 * A moment, in the time zone of whoever is looking.
 *
 * Someone in Dubai capturing at 14:00 their time is 15:30 in India, and the
 * person reading it in India should see 15:30. The server cannot know the
 * reader's zone, so the time is formatted in the browser — after it mounts,
 * because the server's render would otherwise disagree with the browser's and
 * React would warn about the mismatch.
 */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return;
    setLabel(
      date.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    );
  }, [iso]);

  return (
    <time dateTime={iso} title={iso} className={className}>
      {label ?? ""}
    </time>
  );
}
