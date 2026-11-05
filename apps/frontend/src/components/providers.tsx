"use client";

import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Client-side context for the whole site.
 *
 * The site is dark only: `<html class="dark">` is set in the layout, so there
 * is no theme to choose, store or flash between. `ThemeToggle` and
 * `next-themes` are kept unused for if light mode comes back.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return <TooltipProvider delayDuration={200}>{children}</TooltipProvider>;
}
