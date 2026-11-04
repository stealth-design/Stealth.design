import type { Metadata } from "next";
import {
  ScreenCardA,
  ScreenCardB,
  ScreenCardC,
} from "@/components/screen-card-variants";
import { api } from "@/lib/api";

export const metadata: Metadata = { title: "Card options" };

/**
 * A temporary page for choosing the screen card: the same real screens in
 * each of the three designs. Not linked from anywhere; goes once one is
 * picked.
 */
export default async function CardOptionsPage() {
  const { items } = await api.listScreens({ sort: "recent", pageSize: 6 });

  const options = [
    {
      key: "A",
      name: "shadcn media card",
      note: "Image flush on top, name row underneath, button on the right.",
      Card: ScreenCardA,
    },
    {
      key: "B",
      name: "Cover card (HeroUI)",
      note: "The image is the card; a frosted bar over its bottom edge.",
      Card: ScreenCardB,
    },
    {
      key: "C",
      name: "No card",
      note: "Image in a thin ring with the name row beneath, the gallery way.",
      Card: ScreenCardC,
    },
  ];

  return (
    <div className="px-4 pt-12 pb-24 md:px-10">
      <p className="t-label text-muted-foreground">
        Hover a card to see “View website”
      </p>
      {options.map(({ key, name, note, Card }) => (
        <section key={key} className="mt-16 first-of-type:mt-8">
          <div className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b pb-4">
            <h2 className="text-2xl font-semibold tracking-[-0.03em]">
              {key} · {name}
            </h2>
            <p className="text-sm text-muted-foreground">{note}</p>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item, index) => (
              <Card
                key={item.id}
                item={item}
                priority={key === "A" && index < 3}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
