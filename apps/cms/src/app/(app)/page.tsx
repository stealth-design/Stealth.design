import { redirect } from "next/navigation";

/** There is no home screen: the work starts at Products. */
export default function HomePage() {
  redirect("/products");
}
