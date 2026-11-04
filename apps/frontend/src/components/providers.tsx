"use client";

import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Client-side context for the whole site.
 *
 * `next-themes` writes the reader's choice to `<html class>` from an inline
 * script before first paint, so a reader who chose light never sees a dark
 * flash (or the reverse). Light is the default; "system" is kept as a real
 * option because following the OS is a preference, not an absence of one.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      storageKey="uxd-theme"
      disableTransitionOnChange
    >
      <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
    </ThemeProvider>
  );
}
