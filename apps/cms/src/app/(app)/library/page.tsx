import Link from "next/link";
import { libraryWebsites } from "@uxd/api";
import { Empty, Page } from "@/components/page";
import { Count, WebsiteList } from "@/components/website-list";
import { ago } from "@/lib/ago";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Library" };

/**
 * The Library: what is live, by website — the same grouping as the public
 * site, where every screen sits under its website's one profile.
 */
export default async function LibraryPage() {
  const context = await getAdminContextWith("content.read");
  const websites = await libraryWebsites(context.db);
  const thumbnails = await resolveMediaUrls(websites.flatMap((website) => website.thumbnailKeys));
  const now = Date.now();
  const live = websites.reduce((sum, website) => sum + website.published, 0);

  return (
    <Page
      title="Library"
      description={
        websites.length === 0
          ? "Everything published lives here, grouped by website."
          : `${live} ${live === 1 ? "screen" : "screens"} live across ${websites.length} ${websites.length === 1 ? "website" : "websites"}.`
      }
    >
      {websites.length === 0 ? (
        <Empty
          action={
            <Link href="/inbox" className="text-xs text-ink-700 underline hover:text-ink-900">
              Go to the Inbox
            </Link>
          }
        >
          Nothing published yet. Publish from the Inbox.
        </Empty>
      ) : (
        <WebsiteList
          rows={websites.map((website) => ({
            id: website.id,
            href: `/library/${website.id}`,
            name: website.name,
            domain: website.domain,
            thumbnails: website.thumbnailKeys.map((key) => thumbnails.get(key) ?? null),
            detail: website.lastPublishedAt ? `Last published ${ago(website.lastPublishedAt, now)}` : null,
            counts: (
              <Count value={website.published} label="live" dot="bg-[var(--color-tone-success)]" />
            ),
          }))}
        />
      )}
    </Page>
  );
}
