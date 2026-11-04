import Link from "next/link";
import { redirect } from "next/navigation";
import { inboxWebsites } from "@uxd/api";
import { Empty, Page } from "@/components/page";
import { Count, WebsiteList } from "@/components/website-list";
import { ago } from "@/lib/ago";
import { getAdminContextWith, resolveMediaUrls } from "@/lib/server";

export const metadata = { title: "Inbox" };

/**
 * The Inbox, by website.
 *
 * Every capture belongs to exactly one website's profile, so the Inbox is
 * grouped the same way: one row per website with captures waiting, and
 * inside it the queue for that website alone.
 */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ product?: string }> }) {
  const context = await getAdminContextWith("review.read");

  // Older links filtered one Inbox by product; that is now its own page.
  const { product } = await searchParams;
  if (product) redirect(`/inbox/${product}`);

  const websites = await inboxWebsites(context.db);
  const thumbnails = await resolveMediaUrls(websites.flatMap((website) => website.thumbnailKeys));
  const now = Date.now();
  const waiting = websites.reduce((sum, website) => sum + website.review, 0);

  return (
    <Page
      title="Inbox"
      description={
        websites.length === 0
          ? "Everything you capture lands here first, grouped by website."
          : `${waiting} ${waiting === 1 ? "capture" : "captures"} to review across ${websites.length} ${websites.length === 1 ? "website" : "websites"}.`
      }
    >
      {websites.length === 0 ? (
        <Empty
          action={
            <Link href="/products" className="text-xs text-ink-700 underline hover:text-ink-900">
              Go to Products
            </Link>
          }
        >
          Nothing waiting. Captures land here first.
        </Empty>
      ) : (
        <WebsiteList
          rows={websites.map((website) => ({
            id: website.id,
            href: `/inbox/${website.id}`,
            name: website.name,
            domain: website.domain,
            thumbnails: website.thumbnailKeys.map((key) => thumbnails.get(key) ?? null),
            detail: website.lastCapturedAt ? `Last capture ${ago(website.lastCapturedAt, now)}` : null,
            counts: (
              <>
                <Count value={website.review} label="to review" dot="bg-[var(--color-tone-warning)]" />
                <Count value={website.draft} label={website.draft === 1 ? "draft" : "drafts"} dot="bg-ink-500" />
              </>
            ),
          }))}
        />
      )}
    </Page>
  );
}
