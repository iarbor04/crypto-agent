import { getRuns } from "@/lib/agent";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ runs: await getRuns() });
}
