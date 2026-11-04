import { BlockLink, EmptyState } from "@/components/gallery";

export default function NotFound() {
  return (
    <div className="pt-24">
      <EmptyState
        title="Page not found"
        action={<BlockLink href="/screens">See all websites</BlockLink>}
      >
        There&apos;s nothing here. The link may be wrong, or the page may have
        moved.
      </EmptyState>
    </div>
  );
}
