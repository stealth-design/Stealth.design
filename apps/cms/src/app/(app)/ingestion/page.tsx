import { PageHeader } from "@/components/ui/primitives";
import { getAdminContextWith } from "@/lib/server";
import { IngestionWizard } from "./wizard";

export const metadata = { title: "Ingestion" };

/**
 * Bulk ingestion (§4, §5).
 *
 * The screen §5 asks for: paste, validate, configure, start. It is split into
 * three visible steps because the validation result has to be *seen* before a
 * job is committed — an operator pasting 250 URLs needs to know that 42 are
 * already captured and 3 are blocked while they still have the choice of what
 * to include.
 *
 * The permission check is here rather than only in the action, so a Reviewer
 * who cannot create jobs sees a clear message instead of a form that fails on
 * submit.
 */
export default async function IngestionPage() {
  await getAdminContextWith("ingestion.create");

  return (
    <>
      <PageHeader
        title="Ingestion"
        description="Submit URLs for capture. Nothing is fetched until you review what is valid and start the job."
      />
      <div className="p-4">
        <IngestionWizard />
      </div>
    </>
  );
}
