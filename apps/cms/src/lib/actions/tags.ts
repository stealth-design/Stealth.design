"use server";

/**
 * Tag actions. The rules — who may, no duplicate names in a group, what a
 * merge or a delete moves — live in the tags service.
 */
import { refreshAll as refresh } from "@/lib/public-site";
import { createTag, deleteTag, mergeTags, renameTag } from "@uxd/api";
import { AppError } from "@uxd/shared";
import { getAdminContext } from "@/lib/server";

export interface TagActionResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly message?: string;
}

const failed = (error: unknown, fallback: string): TagActionResult => ({
  ok: false,
  error: AppError.is(error) ? error.publicMessage : fallback,
});

export async function createTagAction(kind: string, name: string): Promise<TagActionResult> {
  try {
    await createTag(await getAdminContext(), { kind, name });
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return failed(error, "That tag couldn't be created.");
  }
}

export async function renameTagAction(tagId: string, name: string): Promise<TagActionResult> {
  try {
    await renameTag(await getAdminContext(), tagId, name);
    refresh();
    return { ok: true, error: null };
  } catch (error) {
    return failed(error, "That tag couldn't be renamed.");
  }
}

export async function deleteTagAction(tagId: string): Promise<TagActionResult> {
  try {
    const { removedFrom } = await deleteTag(await getAdminContext(), tagId);
    refresh();
    return {
      ok: true,
      error: null,
      message: removedFrom ? `Deleted, and taken off ${removedFrom} ${removedFrom === 1 ? "screen" : "screens"}.` : "Deleted.",
    };
  } catch (error) {
    return failed(error, "That tag couldn't be deleted.");
  }
}

export async function mergeTagsAction(fromId: string, intoId: string): Promise<TagActionResult> {
  try {
    const { moved } = await mergeTags(await getAdminContext(), fromId, intoId);
    refresh();
    return { ok: true, error: null, message: `Merged. ${moved} ${moved === 1 ? "screen" : "screens"} moved across.` };
  } catch (error) {
    return failed(error, "Those tags couldn't be merged.");
  }
}
