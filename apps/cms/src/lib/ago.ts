/**
 * "just now", "5m ago", "3h ago", "2d ago", then a date.
 *
 * Called on the server with the request's clock, so the page the browser
 * hydrates says exactly what it was sent — a relative time computed again on
 * the client would differ by the seconds in between, and React would warn.
 */
export function ago(date: Date, now: number = Date.now()): string {
  const minutes = Math.round((now - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
