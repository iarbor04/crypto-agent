import { seedDemoPortfolio } from "@/lib/portfolio";

export const dynamic = "force-dynamic";

/** Демо-портфель по кнопке — чтобы на свежей установке было что посмотреть. */
export async function POST() {
  return Response.json(await seedDemoPortfolio());
}
