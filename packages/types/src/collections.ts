/** Collections (§10 of the CMS IA) — curated sets of content. */

export const COLLECTION_VISIBILITIES = ["private", "internal", "public"] as const;
export type CollectionVisibility = (typeof COLLECTION_VISIBILITIES)[number];

export const COLLECTION_VISIBILITY_META: Record<
  CollectionVisibility,
  { label: string; description: string }
> = {
  private: { label: "Private", description: "Only the curator can see it." },
  internal: { label: "Internal", description: "Visible to everyone in the CMS, not to the public." },
  public: {
    label: "Public",
    description:
      "Exposed on the public API. Only published items inside it are ever returned, whatever the collection contains.",
  },
};

export const COLLECTION_STATUSES = ["draft", "active", "archived"] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];
