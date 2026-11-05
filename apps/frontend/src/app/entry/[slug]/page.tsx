import { notFound, permanentRedirect } from "next/navigation";
import { api } from "@/lib/api";
import { websitePath } from "@/lib/paths";

/**
 * The old address of a screen, /entry/<slug>. Kept so links already shared
 * (and the CMS's "View on site") still land: it sends the reader on to
 * the website's page, /websites/<website>.
 */
export default async function OldScreenAddress({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = await api.getContent(slug);
  // Every public screen belongs to a website; one that does not has no page.
  if (!entry?.source) notFound();
  permanentRedirect(websitePath(entry.source.slug));
}
