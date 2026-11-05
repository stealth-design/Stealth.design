import { permanentRedirect } from "next/navigation";
import { websitePath } from "@/lib/paths";

/**
 * An old screen address, /websites/<website>/<screen>. Screens are parts of
 * their website's page now, so this sends the reader there.
 */
export default async function OldScreenAddress({
  params,
}: {
  params: Promise<{ source: string; screen: string }>;
}) {
  const { source } = await params;
  permanentRedirect(websitePath(source));
}
