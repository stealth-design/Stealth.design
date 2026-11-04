import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names, letting later Tailwind classes win over earlier ones.
 *
 * `clsx` + `tailwind-merge` rather than the newer single-package `cn`: the
 * pair has years of releases behind it, and this is the public site, where a
 * dependency is something every reader's browser runs.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
