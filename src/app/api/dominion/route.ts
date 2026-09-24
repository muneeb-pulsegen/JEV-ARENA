import { handleMatchRequest } from "@/lib/dominion/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleMatchRequest(req);
}
