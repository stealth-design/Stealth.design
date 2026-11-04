import { listTeam } from "@uxd/api";
import { can } from "@uxd/auth";
import { Page } from "@/components/page";
import { ago } from "@/lib/ago";
import { getAdminContext } from "@/lib/server";
import { Team } from "./team";

export const metadata = { title: "Settings" };

/**
 * Settings. For now one section — the team — because that is the one thing
 * an admin has to be able to change before Friday. More sections join it
 * here as they are rebuilt.
 */
export default async function SettingsPage() {
  // Asked rather than required: someone without access who types the address
  // gets a plain sentence, not an error page.
  const context = await getAdminContext();
  const canSeeTeam = can(context.actor, "settings.read") && can(context.actor, "users.read");
  const members = canSeeTeam ? await listTeam(context) : [];
  const now = Date.now();

  return (
    <Page title="Settings">
      {canSeeTeam ? (
        <Team
          currentUserId={context.actor.id}
          canManage={can(context.actor, "users.manage")}
          members={members.map((member) => ({
            id: member.id,
            name: member.name,
            email: member.email,
            role: member.role,
            status: member.status,
            lastSeen: member.lastLoginAt ? ago(member.lastLoginAt, now) : null,
          }))}
        />
      ) : (
        <p className="text-[13px] text-ink-500">Settings are for admins. Ask an admin if you need something changed.</p>
      )}
    </Page>
  );
}
