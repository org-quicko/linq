import { LinkSummaryClient } from "./summary-client"

/**
 * Satisfies Next.js output: "export" requirement by pre-rendering a static template.
 * At runtime, the client extracts the live link ID from the route path.
 */
export function generateStaticParams() {
  return [{ id: "_summary" }]
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <LinkSummaryClient id={id} />
}
