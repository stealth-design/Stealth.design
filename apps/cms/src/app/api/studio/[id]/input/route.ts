/**
 * Everything the studio sends to the live page.
 *
 * A route rather than server actions, because server actions from one page
 * run one at a time: a scroll in flight would hold up the click after it, and
 * a stream of pointer moves would queue behind each other. Plain `fetch`es run
 * side by side.
 *
 * Two kinds of input, deliberately treated differently:
 *
 *   - **Commands** (click, type, navigate, capture …) are things a person did.
 *     They are written to the command log through `enqueueCommand`, exactly as
 *     before, and wake the worker at once.
 *   - **Pointer and wheel** are how a hand moves. Only the latest position
 *     matters, so they go to the live relay and nowhere else.
 */
import { enqueueCommand, pushLivePointer, pushLiveWheel } from "@uxd/api";
import { AppError } from "@uxd/shared";
import { sessionCommandPayloadSchema, studioLiveInputSchema } from "@uxd/types";
import { z } from "zod";
import { getAdminContextWith } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.union([
  z.object({ kind: z.literal("command"), payload: sessionCommandPayloadSchema }),
  studioLiveInputSchema,
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  try {
    const context = await getAdminContextWith("content.create");
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "That input was not understood." }, { status: 400 });

    const input = parsed.data;
    if (input.kind === "pointer") {
      pushLivePointer(id, input.x, input.y);
      return Response.json({ ok: true });
    }
    if (input.kind === "wheel") {
      pushLiveWheel(id, input);
      return Response.json({ ok: true });
    }

    const { commandId } = await enqueueCommand(context, id, input.payload);
    return Response.json({ ok: true, commandId });
  } catch (error) {
    if (AppError.is(error)) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
