import { PASSWORD_RULES } from "@uxd/auth";
import { ROLE_META } from "@uxd/types";
import { Field, FieldList, PageHeader, Panel } from "@/components/ui/primitives";
import { getAdminContext } from "@/lib/server";
import { PasswordForm } from "./password-form";

export const metadata = { title: "Your account" };

/**
 * The signed-in user's own account.
 *
 * Reached from the user menu rather than the sidebar: it is about the person,
 * not the library, and every role has one. Needs no permission beyond being
 * signed in.
 */
export default async function AccountPage() {
  const { actor } = await getAdminContext("/account");
  const role = ROLE_META[actor.role];

  return (
    <>
      <PageHeader title="Your account" description="Who you are signed in as, and your password." />
      <div className="grid max-w-3xl gap-4 p-5 md:grid-cols-2">
        <Panel title="Profile">
          <FieldList>
            <Field label="Name">{actor.name}</Field>
            <Field label="Email" mono>
              {actor.email}
            </Field>
            <Field label="Role">
              <span className="font-medium">{role.label}</span> — {role.summary}
            </Field>
          </FieldList>
        </Panel>
        <Panel
          title="Change password"
          description="Your other signed-in browsers are signed out. This one stays signed in."
        >
          <PasswordForm rules={PASSWORD_RULES} />
        </Panel>
      </div>
    </>
  );
}
