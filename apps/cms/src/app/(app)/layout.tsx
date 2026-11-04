import { capabilityMap } from "@uxd/auth";
import { ROLE_META } from "@uxd/types";
import { AppFrame, type SidebarBadges } from "@/components/sidebar";
import { UserMenu } from "@/components/user-menu";
import { GlobalSearch } from "@/components/global-search";
import { getAdminContext } from "@/lib/server";
import { loadSidebarBadges } from "@/lib/badges";

/**
 * The authenticated shell.
 *
 * Everything inside `(app)` requires a session; this layout is where that is
 * enforced, so no page underneath needs to remember to check. It also loads
 * the backlog counts once per navigation rather than per page, since they
 * appear in the sidebar on every screen.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const context = await getAdminContext();
  const capabilities = capabilityMap(context.actor);
  const role = ROLE_META[context.actor.role];
  const badges: SidebarBadges = await loadSidebarBadges(context.db);

  return (
    <AppFrame
      capabilities={capabilities}
      badges={badges}
      search={<GlobalSearch />}
      account={
        <UserMenu
          name={context.actor.name}
          email={context.actor.email}
          roleLabel={role.label}
          roleSummary={role.summary}
        />
      }
    >
      {children}
    </AppFrame>
  );
}
