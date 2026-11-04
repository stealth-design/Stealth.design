import { redirect } from "next/navigation";
import { getActor } from "@/lib/server";
import { Logo } from "@/components/logo";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

/**
 * Sign-in.
 *
 * Deliberately plain, and deliberately says nothing about what exists: the
 * failure message is identical for a wrong password, an unknown address, a
 * suspended account and an invited-but-unset password, so the form is not an
 * account-enumeration oracle. The real reason is in the audit log, where an
 * operator can see it.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const actor = await getActor();
  const params = await searchParams;
  if (actor) redirect(params.next ?? "/");

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-5">
          <Logo size={24} />
          <p className="mt-1.5 text-xs text-ink-500">
            Design research content management and ingestion control.
          </p>
        </div>
        <LoginForm next={params.next ?? "/"} />
      </div>
    </main>
  );
}
