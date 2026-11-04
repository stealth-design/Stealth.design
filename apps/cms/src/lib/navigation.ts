/**
 * The CMS information architecture.
 *
 * Three places and a back room. The sidebar holds nouns — where things are —
 * and the pages hold the verbs, each one pointing at the next step:
 *
 *   Products  where you start: pick a website, capture its screens
 *   Inbox     what you captured, waiting to be tagged and published
 *   Library   what is done
 *   Settings  the machinery — crawls, vocabularies, the audit log
 *
 * Declared as data with the permission each section requires, so the sidebar
 * renders only what the signed-in role can reach, and the description is the
 * same string used as the page description and the search hint.
 *
 * The previous sections' screens are not linked from here any more, but their
 * routes still work by URL and their code is untouched.
 */
import type { Permission } from "@uxd/types";

export type NavIcon = "products" | "inbox" | "library" | "tags" | "settings";

export interface NavItem {
  readonly label: string;
  readonly href: string;
  /** Shown as the page description and the search hint. */
  readonly description: string;
  /** Hidden from the sidebar unless the actor holds this. */
  readonly permission: Permission;
  /** Other routes that belong to this section, for active highlighting. */
  readonly alsoMatch?: readonly string[];
  /** The sidebar icon, by name — resolved in the sidebar, so this stays data. */
  readonly icon: NavIcon;
  /** A live count to show beside the label, resolved by the shell. */
  readonly badge?:
    | "needsReview"
    | "needsAttention"
    | "activeJobs"
    | "pendingSuggestions"
    | "untriagedPages";
}

export interface NavGroup {
  /** `bottom` pins the group to the foot of the sidebar, above the account. */
  readonly placement: "top" | "bottom";
  readonly items: readonly NavItem[];
}

export const NAVIGATION: readonly NavGroup[] = [
  {
    placement: "top",
    items: [
      {
        label: "Products",
        href: "/products",
        icon: "products",
        description: "The websites and apps we study. Pick one to capture its screens.",
        permission: "source.read",
        alsoMatch: ["/studio"],
      },
      {
        label: "Inbox",
        href: "/inbox",
        icon: "inbox",
        description: "Everything you captured, waiting to be tagged. Save it as a draft, or publish it.",
        permission: "review.read",
        badge: "needsReview",
      },
      {
        label: "Library",
        href: "/library",
        icon: "library",
        description: "Everything that is live, by website.",
        permission: "content.read",
      },
      {
        label: "Tags",
        href: "/tags",
        icon: "tags",
        description: "The tags screens are filed under: industries and design types.",
        permission: "taxonomy.read",
      },
    ],
  },
  {
    placement: "bottom",
    items: [
      {
        label: "Settings",
        href: "/settings",
        icon: "settings",
        description: "Crawls, vocabularies, workers and the audit log.",
        permission: "settings.read",
      },
    ],
  },
];

/** Flat list, for the command palette and for resolving a page's description. */
export const NAV_ITEMS: readonly NavItem[] = NAVIGATION.flatMap((group) => group.items);

function prefixes(item: NavItem): string[] {
  return [item.href, ...(item.alsoMatch ?? [])];
}

function under(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname === "/";
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function navItemFor(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => isActive(item, pathname));
}

export function isActive(item: NavItem, pathname: string): boolean {
  return prefixes(item).some((prefix) => under(pathname, prefix));
}
