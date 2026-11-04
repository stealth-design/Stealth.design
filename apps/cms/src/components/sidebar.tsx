"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { Boxes, Inbox, Library, Menu, Settings, Tags, X, type LucideIcon } from "lucide-react";
import { NAVIGATION, isActive, type NavGroup, type NavIcon, type NavItem } from "@/lib/navigation";
import type { Permission } from "@uxd/types";
import { Logo } from "@/components/logo";

export interface SidebarBadges {
  readonly needsReview: number;
  readonly needsAttention: number;
  readonly activeJobs: number;
  readonly pendingSuggestions: number;
  readonly untriagedPages: number;
}

const ICONS: Record<NavIcon, LucideIcon> = {
  products: Boxes,
  inbox: Inbox,
  library: Library,
  tags: Tags,
  settings: Settings,
};

/**
 * The application frame: the sidebar on a desktop, a top bar and a drawer on
 * a phone. The sidebar holds everything that is not the page — the mark,
 * search, the sections and the account — so the page gets the full height.
 *
 * Renders only the sections the signed-in role can reach: `capabilities` is
 * the server-computed permission map, so a Viewer never sees a Settings link
 * that would 403. That is a convenience, not the control — every route
 * re-checks server side.
 */
export function AppFrame({
  capabilities,
  badges,
  search,
  account,
  children,
}: {
  capabilities: Record<string, boolean>;
  badges: SidebarBadges;
  search: React.ReactNode;
  account: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // A navigation closes the drawer, so a phone lands on the page it asked for.
  useEffect(() => setDrawerOpen(false), [pathname]);

  const panel = (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4">
        <Link href="/" aria-label="UX Disrupt CMS — home" className="flex items-center gap-2">
          <Logo />
          <span className="rounded-[4px] border border-ink-200 px-1 py-px text-[10px] leading-none text-ink-500">CMS</span>
        </Link>
      </div>
      <div className="px-2.5 pb-3">{search}</div>
      <nav aria-label="Sections" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5">
        <Sections placement="top" capabilities={capabilities} badges={badges} pathname={pathname} />
        <div className="mt-auto pb-2 pt-4">
          <Sections placement="bottom" capabilities={capabilities} badges={badges} pathname={pathname} />
        </div>
      </nav>
      <div className="border-t border-ink-200 p-2">{account}</div>
    </div>
  );

  return (
    <div className="flex min-h-svh">
      <aside className="sticky top-0 hidden h-svh w-[var(--sidebar-width)] shrink-0 border-r border-ink-200 bg-ink-50 md:block">
        {panel}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-ink-200 bg-ink-50/90 px-3 backdrop-blur md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="flex size-8 items-center justify-center rounded-md text-ink-600 hover:bg-ink-100 hover:text-ink-900"
          >
            <Menu className="size-4" />
          </button>
          <Link href="/" aria-label="UX Disrupt CMS — home">
            <Logo />
          </Link>
        </header>

        <main className="min-w-0 flex-1 overflow-x-hidden">{children}</main>
      </div>

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-[min(18rem,85vw)] border-r border-ink-200 bg-ink-50">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
              className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900"
            >
              <X className="size-4" />
            </button>
            {panel}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One block of sections. The only count with a colour is the inbox, because
 * it is the one that is somebody's job right now.
 */
function Sections({
  placement,
  capabilities,
  badges,
  pathname,
}: {
  placement: NavGroup["placement"];
  capabilities: Record<string, boolean>;
  badges: SidebarBadges;
  pathname: string;
}) {
  const visible = NAVIGATION.filter((group) => group.placement === placement)
    .flatMap((group) => group.items)
    .filter((item) => capabilities[item.permission as Permission]);
  if (visible.length === 0) return null;

  return (
    <ul className="space-y-px">
      {visible.map((item) => (
        <li key={item.href}>
          <NavLink item={item} active={isActive(item, pathname)} count={item.badge ? badges[item.badge] : 0} />
        </li>
      ))}
    </ul>
  );
}

function NavLink({ item, active, count }: { item: NavItem; active: boolean; count: number }) {
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={item.href}
      title={item.description}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
        active ? "bg-ink-100 text-ink-900" : "text-ink-600 hover:bg-ink-100/60 hover:text-ink-900",
      )}
    >
      <Icon
        aria-hidden
        strokeWidth={1.75}
        className={clsx("size-[15px] shrink-0", active ? "text-ink-900" : "text-ink-500 group-hover:text-ink-800")}
      />
      <span className="flex-1 truncate">{item.label}</span>
      {count > 0 ? (
        <span className="shrink-0 rounded-full bg-ink-200 px-1.5 py-px font-mono text-[11px] leading-4 text-ink-900 tabular-nums">
          {count > 999 ? "999+" : count}
        </span>
      ) : null}
    </Link>
  );
}
