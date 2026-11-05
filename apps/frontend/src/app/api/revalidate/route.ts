/**
 * Refresh the whole site now, because something changed in the CMS.
 *
 * Pages and the data behind them are cached for a minute; without this a
 * publish takes a couple of refresh cycles to show. The CMS calls this after
 * any change the public can see. It answers only to
 * `Authorization: Bearer <PUBLIC_SITE_REVALIDATE_SECRET>` and otherwise does
 * not exist (404).
 *
 * `revalidatePath("/", "layout")` marks every page and its cached data stale;
 * each is rebuilt fresh on its next visit.
 */
import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.PUBLIC_SITE_REVALIDATE_SECRET ?? "";
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (secret.length < 32 || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return new Response("Not found", { status: 404 });
  }
  revalidatePath("/", "layout");
  return Response.json({ revalidated: true }, { headers: { "cache-control": "no-store" } });
}
