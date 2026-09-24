import { handleMatchRequest } from "@/lib/arena/serve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleMatchRequest(req);
}
