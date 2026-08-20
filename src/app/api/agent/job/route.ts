import { getJob } from "@/lib/agent";

export const dynamic = "force-dynamic";

/** Прогресс текущего или последнего разбора. */
export async function GET() {
  return Response.json({ job: await getJob() });
}
