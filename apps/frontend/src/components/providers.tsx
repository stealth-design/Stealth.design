"use client";

import { TooltipProvider } from "@/components/ui/tooltip";

/** Client-side context for the whole site. */
export function Providers({ children }: { children: React.ReactNode }) {
  return <TooltipProvider delayDuration={200}>{children}</TooltipProvider>;
}
