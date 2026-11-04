import { EmptyState, LightLink } from "@/components/gallery";

export default function NotFound() {
  return (
    <EmptyState title="Not found" action={<LightLink href="/screens">Browse screens</LightLink>}>
      There is nothing published at this address. It may never have existed, or it may have been withdrawn.
    </EmptyState>
  );
}
